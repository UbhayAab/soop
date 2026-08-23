-- Org join requests: users requesting to join an organisation, with an approval queue
-- mirroring the workspace_join_requests pattern (phase 2 self-onboarding).
--
-- WHAT THIS SOLVES. When --open-signup is enabled (phase 1), anybody can sign up
-- and request to join an org. Admins need a queue to review and approve/reject
-- these requests. This table + RPC family provides that.
--
-- idempotent: create table if not exists, functions replace-if-exist.

-- ---------------------------------------------------------------- table
create table if not exists public.org_join_requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  user_id      uuid not null,
  status       text not null check (status in ('pending', 'approved', 'rejected')),
  created_at   timestamptz not null default now()
);

alter table public.org_join_requests enable row level security;

-- ---------------------------------------------------------------- read policy
-- Admins of the org can see pending requests. We check membership via
-- workspace_members on the org's server(s). Good enough for phase 2.
drop policy if exists org_join_requests_read on public.org_join_requests;
create policy org_join_requests_read on public.org_join_requests for select
  using (exists (select 1 from public.workspace_members m
                 where m.workspace_id in (
                   select id from public.workspaces where org_id = org_join_requests.org_id
                 )
                   and m.user_id = auth.uid())
       and auth.role() = 'authenticated');

-- ---------------------------------------------------------------- RPC: list
create or replace function public.list_org_join_requests(p_org uuid)
returns setof public.org_join_requests
language sql security definer set search_path = public stable as $$
  select * from public.org_join_requests
   where org_id = p_org and status = 'pending'
   order by created_at asc;
$$;

drop policy if exists list_org_join_requests on public.org_join_requests;
create policy list_org_join_requests on public.org_join_requests for select
  using (true);

-- ---------------------------------------------------------------- RPC: count
create or replace function public.count_org_join_requests(p_org uuid)
returns integer
language sql security definer set search_path = public stable as $$
  select count(*) from public.org_join_requests where org_id = p_org and status = 'pending';
$$;

drop policy if exists count_org_join_requests on public.org_join_requests;
create policy count_org_join_requests on public.org_join_requests for select using (true);

-- ---------------------------------------------------------------- RPC: approve
create or replace function public.approve_org_join_request(p_request uuid)
returns text
language plpgsql security definer set search_path = public as
declare
  v_org_id uuid;
  v_user_id uuid;
  v_status text;
begin
  select org_id, user_id, status into v_org_id, v_user_id, v_status
  from public.org_join_requests where id = p_request;

  if not found then
    return 'not_found';
  end if;

  if v_status = 'approved' then
    return 'already_approved';
  end if;

  -- Mark as approved
  update public.org_join_requests set status = 'approved' where id = p_request;

  -- Add user as member of the org's primary workspace (first server)
  insert into public.workspace_members (workspace_id, user_id)
  select id, v_user_id from public.workspaces
   where org_id = v_org_id
   on conflict (workspace_id, user_id) do nothing;

  return 'approved';
end;
$$;

drop policy if exists approve_org_join_request on public.org_join_requests;
create policy approve_org_join_request on public.org_join_requests for update using (true);

-- ---------------------------------------------------------------- RPC: reject
create or replace function public.reject_org_join_request(p_request uuid)
returns text
language plpgsql security definer set search_path = public as
declare
  v_status text;
begin
  select status into v_status from public.org_join_requests where id = p_request;

  if not found then
    return 'not_found';
  end if;

  if v_status = 'rejected' then
    return 'already_rejected';
  end if;

  -- Mark as rejected
  update public.org_join_requests set status = 'rejected' where id = p_request;

  return 'rejected';
end;
$$;

drop policy if exists reject_org_join_request on public.org_join_requests;
create policy reject_org_join_request on public.org_join_requests for update using (true);

-- ---------------------------------------------------------------- grant execute
grant execute on function public.list_org_join_requests(uuid) to authenticated;
grant execute on function public.count_org_join_requests(uuid) to authenticated;
grant execute on function public.approve_org_join_request(uuid) to authenticated;
grant execute on function public.reject_org_join_request(uuid) to authenticated;

comment on table public.org_join_requests is
  'Requests to join an organisation. Admins review and approve/reject via RPCs.';

comment on function public.list_org_join_requests(uuid) is
  'List pending join requests for an org. Mirrors list_join_requests.';

comment on function public.count_org_join_requests(uuid) is
  'Count pending join requests for an org. Mirrors count_join_requests.';

comment on function public.approve_org_join_request(uuid) is
  'Approve a join request, adding user as org member. Mirrors approve_join_request.';

comment on function public.reject_org_join_request(uuid) is
  'Reject a join request. Mirrors reject_join_request.';