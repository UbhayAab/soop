-- Data retention cron: sweeps old data per the retention policy.
-- Runs as a nightly cron job via Supabase Edge Function or cron service.
--
-- WHAT THIS SOLVES. Enforces data retention limits so personal data is not
-- retained longer than necessary, satisfying DPDP Act requirement to retain
-- personal data only as long as necessary for the purpose it was collected.
--
-- IDempotent: safe to run repeatedly.

-- ---------------------------------------------------------------- sweep function
-- Sweep old messages, invites, and their associated artifacts older than
-- the configured retention window. Runs as a nightly Edge Function.
create or replace function public.retention_sweep()
returns void language sql security definer set search_path = public as $$
begin
  -- Sweep old messages past the retention floor.
  -- Messages older than 90 days with no activity are removed.
  delete from public.messages
   where created_at < now() - interval '90 days'
     and not exists (
       select 1 from public.task_events ne
       where ne.message_id = messages.id
         and ne.created_at > now() - interval '90 days'
     );

  -- Sweep old org_join_requests older than 30 days if still pending.
  delete from public.org_join_requests
   where created_at < now() - interval '30 days'
     and status = 'pending';

  -- Sweep old embed tickets past their expiry (belt-and-braines with the
  -- embed_sweep_tickets function already defined in 0100).
  delete from public.embed_tickets
   where expires_at < now() - interval '1 hour';

  -- Update workspace last_seen_at to suppress stale entries.
  update public.workspaces
   set last_seen_at = now()
 where last_seen_at < now() - interval '365 days';

  -- Record the sweep run for auditability.
  insert into public.audit_log (kind, detail, created_at)
  values ('retention_sweep', jsonb_build_object('ran_at', now()), now());
end;
$$;

-- ---------------------------------------------------------------- grant execute
grant execute on function public.retention_sweep() to authenticated;

-- ---------------------------------------------------------------- audit log (if missing)
-- A minimal audit log to record retention sweeps for compliance auditing.
create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  kind       text not null,
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

comment on table public.audit_log is
  'Audit log recording retention sweeps and other compliance events.';

-- Index for querying by kind and time.
create index if not exists audit_log_kind_idx on public.audit_log (kind, created_at desc);

-- ---------------------------------------------------------------- helpful comments
comment on function public.retention_sweep() is
  'Sweeps old messages, invites, and embed tickets past retention windows.
  Intended to be called nightly as a cron job. Retains data only as long as
  necessary per DPDP Act s.4(2).';

comment on public.audit_log is
  'Audit log recording retention sweeps and other compliance events for
  DPDP Act audit trail requirements.';