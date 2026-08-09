-- Embedding Soop in a dashboard: the registry, the ticket table, and the one
-- idempotent call that makes a dashboard's server exist.
--
-- WHAT THIS SOLVES. A dashboard is team-specific: the tech dashboard should show
-- the tech server, and somebody opening it for the first time should already be
-- in it. Nobody should type a password, because the dashboard already knows who
-- they are, and nobody should have to create the server by hand, because the
-- dashboard already knows which team it is for.
--
-- WHAT AUTHENTICATES WHAT. Each dashboard gets a key and a secret. The secret
-- lives on the dashboard's BACKEND and never anywhere else - not in its page, not
-- in Soop's client, not in this file (only a hash of it is stored). The backend
-- signs a short assertion naming the person; the Edge Function verifies it and
-- issues a single-use ticket; the browser spends the ticket for a session. Three
-- steps rather than one, and the reason is that any design where the browser
-- holds the secret is a design where every user of the dashboard can mint any
-- identity in Soop.
--
-- THE TENANT IS NEVER TAKEN FROM THE PAYLOAD. It is read from the row whose
-- secret verified the signature. A leaked secret is then contained to the one
-- organisation that key belongs to, instead of being able to mint users
-- anywhere.
--
-- BEFORE RUNNING THIS, check the three table names it depends on. They were read
-- off the client (js/core/workspace.js, js/features/tasks.js) rather than out of
-- a schema file, because the schema is not in that repo:
--
--   select table_name from information_schema.tables
--    where table_schema = 'public'
--      and table_name in ('organizations','workspaces','workspace_members','channels');
--
-- Note the American spelling of organizations, which is what the client uses.

-- ---------------------------------------------------------------- the registry
create table if not exists public.embed_hosts (
  key              text primary key,
  name             text not null,
  org_id           uuid not null references public.organizations(id) on delete cascade,

  -- sha256 of the shared secret, hex. There is no way to read the secret back
  -- out, by design and for the same reason integrations.js stores webhook tokens
  -- this way: a "reveal" endpoint is a thing that can be called by the wrong
  -- person, and a secret you can only show once is a secret you have to store
  -- properly at the other end.
  secret_sha256    text not null,

  -- Belt and braces with EMBED_ORIGINS in js/config.js and frame-ancestors in
  -- _headers. Three places, three different failure modes: this one stops a
  -- stolen secret being spent from somewhere unexpected.
  allowed_origins  text[] not null default '{}',

  -- Which server this dashboard shows. space_id is filled in the first time
  -- anybody opens the dashboard and is what every later call short-circuits on.
  space_name       text not null,
  space_id         uuid references public.workspaces(id) on delete set null,
  default_channel  text not null default 'general',

  -- Turning an integration off has to be one UPDATE, not a delete that cascades
  -- into somebody's message history.
  disabled_at      timestamptz,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz
);

comment on table public.embed_hosts is
  'One row per dashboard allowed to embed Soop. The secret is stored hashed and is used only by the soop-handoff Edge Function.';

-- Nothing in the browser may read this table: it names every integration and
-- their origins. RLS on, and no policy at all, which denies everyone. The Edge
-- Function uses the service role and bypasses it.
alter table public.embed_hosts enable row level security;
revoke all on public.embed_hosts from anon, authenticated;

-- ---------------------------------------------------------------- the tickets
-- A ticket is what the browser spends. Short-lived, single-use, bound to the
-- origin it was issued for.
create table if not exists public.embed_tickets (
  token_sha256 text primary key,
  host_key     text not null references public.embed_hosts(key) on delete cascade,
  user_id      uuid not null,
  origin       text not null,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists embed_tickets_expiry on public.embed_tickets (expires_at);

alter table public.embed_tickets enable row level security;
revoke all on public.embed_tickets from anon, authenticated;

-- Spent and expired tickets are noise after a minute. Called by the Edge
-- Function on the way past rather than scheduled, so there is nothing to
-- forget to set up.
create or replace function public.embed_sweep_tickets()
returns void language sql security definer set search_path = public as $$
  delete from public.embed_tickets
   where expires_at < now() - interval '1 hour';
$$;

-- ------------------------------------------------------- ensure_embed_space
-- Called on EVERY handoff, so it has to be cheap when there is nothing to do and
-- correct when fifty people open the dashboard in the same second at 9am.
--
-- ON CONFLICT DO NOTHING ... RETURNING RETURNS ZERO ROWS. Postgres documents it:
-- only rows actually inserted or updated come back. Written the obvious way this
-- passes every test one person can run and then, the first morning it is used
-- for real, hands 49 of 50 people a null workspace id and drops them into the
-- error path. DO UPDATE with a no-op assignment forces the row to be returned.
create or replace function public.ensure_embed_space(p_key text, p_user uuid)
returns table (space_id uuid, org_id uuid, created boolean)
language plpgsql security definer set search_path = public as $$
declare
  h        public.embed_hosts;
  v_space  uuid;
  v_new    boolean := false;
begin
  select * into h from public.embed_hosts where key = p_key and disabled_at is null;
  if not found then
    raise exception 'unknown_embed_host' using errcode = '42501';
  end if;

  -- Fast path. The common case by an enormous margin is "the server exists and
  -- this person is already in it", and it must not take a row lock: DO UPDATE
  -- locks, DO NOTHING does not, and at 9am the difference is a lock convoy on
  -- one row.
  if h.space_id is not null then
    select h.space_id into v_space;
    if exists (select 1 from public.workspace_members
                where workspace_id = v_space and user_id = p_user) then
      return query select v_space, h.org_id, false;
      return;
    end if;
  end if;

  -- The server itself. Keyed on the host key so two dashboards cannot fight over
  -- one name, and so renaming the server later does not orphan the mapping.
  if h.space_id is null then
    insert into public.workspaces (org_id, name, slug)
    values (h.org_id, h.space_name,
            lower(regexp_replace(h.space_name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(p_key, 1, 8))
    on conflict (org_id, slug) do update set name = excluded.name
    returning id into v_space;

    update public.embed_hosts set space_id = v_space where key = p_key;
    v_new := true;

    -- An empty room is the most reliable way to lose somebody on their first
    -- visit, so the server is never handed over empty.
    insert into public.channels (workspace_id, name, kind, position)
    values (v_space, h.default_channel, 'text', 0)
    on conflict do nothing;
  else
    v_space := h.space_id;
  end if;

  -- Membership. DO UPDATE, not DO NOTHING, for the RETURNING reason above - and
  -- the no-op assignment is deliberate rather than a leftover.
  insert into public.workspace_members (workspace_id, user_id)
  values (v_space, p_user)
  on conflict (workspace_id, user_id) do update set workspace_id = excluded.workspace_id;

  update public.embed_hosts set last_seen_at = now() where key = p_key;
  return query select v_space, h.org_id, v_new;
end;
$$;

revoke all on function public.ensure_embed_space(text, uuid) from anon, authenticated;

-- ---------------------------------------------------------------- registering
-- Convenience for the operator. Run it once per dashboard, keep the secret it
-- prints, and never ask for it again because it cannot be printed twice.
--
--   select * from public.register_embed_host(
--     'tech-dashboard', 'Tech dashboard', '<org uuid>', 'Tech',
--     array['https://dash.yourcompany.com']);
create or replace function public.register_embed_host(
  p_key text, p_name text, p_org uuid, p_space_name text,
  p_origins text[], p_default_channel text default 'general')
returns table (key text, secret text)
language plpgsql security definer set search_path = public as $$
declare v_secret text;
begin
  v_secret := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.embed_hosts (key, name, org_id, secret_sha256, allowed_origins,
                                  space_name, default_channel)
  values (p_key, p_name, p_org, encode(extensions.digest(v_secret, 'sha256'), 'hex'),
          p_origins, p_space_name, p_default_channel)
  on conflict (key) do update
    set name = excluded.name,
        secret_sha256 = excluded.secret_sha256,
        allowed_origins = excluded.allowed_origins,
        space_name = excluded.space_name,
        default_channel = excluded.default_channel,
        disabled_at = null;
  return query select p_key, v_secret;
end;
$$;

revoke all on function public.register_embed_host(text, text, uuid, text, text[], text) from anon, authenticated;
