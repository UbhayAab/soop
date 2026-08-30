-- Apps: identity, install, token.
--
-- Identity decision: an app IS a profile with is_app = true, and it is a real
-- workspace_member of every Space it is installed in. That one choice deletes a
-- whole category of work. Avatars, the member list, mentions, search, the
-- profile popover and profiles RLS all already key off a profile that shares a
-- workspace with you, so an app message renders with a name and a face on every
-- path - cold load, realtime and heal - without any of those paths learning a
-- second identity shape.
--
-- The alternative that was already half-built here (identity stuffed into the
-- message body jsonb, author_id left null) is why every automated message this
-- product could ever have sent would have rendered as the literal word
-- "someone": js/core/messages.js tested m.bot_id, which is not a column.

-- ---------------------------------------------------------------- identity

alter table public.profiles add column if not exists is_app boolean not null default false;
alter table public.profiles add column if not exists app_id uuid;

-- An app is an ORG-level identity. Jarurat runs several Spaces and would
-- otherwise re-create the same app once per Space, each with its own token,
-- which is exactly the sprawl that makes revocation a guess a year later.
create table if not exists public.apps (
  id          uuid primary key default util.uuidv7(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete restrict,
  name        text not null check (length(btrim(name)) between 1 and 80),
  description text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  disabled_at timestamptz          -- org-wide kill switch; every install dies at once
);
create index if not exists apps_org_idx on public.apps (org_id) where disabled_at is null;

do $$ begin
  alter table public.profiles
    add constraint profiles_app_fk foreign key (app_id)
    references public.apps(id) on delete cascade;
exception when duplicate_object then null; end $$;

-- The install is the one OAuth idea worth keeping: a record that this app was
-- deliberately granted a specific reach inside one Space by one named admin.
-- What is dropped is the redirect dance that produces it, not the record.
create table if not exists public.app_installs (
  id             uuid primary key default util.uuidv7(),
  app_id         uuid not null references public.apps(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  scopes         bigint not null default 0,
  channel_scope  text not null default 'listed'
                   check (channel_scope in ('listed', 'all')),
  installed_by   uuid references public.profiles(id),
  installed_at   timestamptz not null default now(),
  uninstalled_at timestamptz,
  unique (app_id, workspace_id)
);

create table if not exists public.app_install_channels (
  install_id uuid not null references public.app_installs(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  primary key (install_id, channel_id)
);

-- Tokens are a separate table from the install for exactly one reason: rotation
-- without downtime. A cron job on a Windows box in Bhiwandi cannot be redeployed
-- at the same instant an admin clicks Rotate, so two tokens must be live at once
-- and the old one must die on a timer rather than on a click.
create table if not exists public.app_tokens (
  id           uuid primary key default util.uuidv7(),
  install_id   uuid not null references public.app_installs(id) on delete cascade,
  token_sha256 bytea not null unique,
  token_hint   text  not null,   -- last 6 chars, so two live tokens are tellable apart
  label        text,             -- "dispatch PC", "Rakesh laptop"
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,      -- the single most valuable column in this table
  expires_at   timestamptz,      -- set by rotate; null means no expiry
  revoked_at   timestamptz
);
create index if not exists app_tokens_live_idx on public.app_tokens (install_id)
  where revoked_at is null;

-- Readable, not hashed, because Dek SENDS this when it signs an outbound call
-- rather than verifying it. No RLS policy at all, so it is invisible to anon and
-- authenticated alike and only the service role inside an edge function reads it.
create table if not exists private.app_secrets (
  app_id         uuid primary key references public.apps(id) on delete cascade,
  signing_secret text not null
);

-- Every one of these is reachable only through a security-definer RPC. RLS on
-- with no policy is the leanest correct answer: clients get nothing directly,
-- and there is no column grant to get subtly wrong on token_sha256.
alter table public.apps                enable row level security;
alter table public.app_installs        enable row level security;
alter table public.app_install_channels enable row level security;
alter table public.app_tokens          enable row level security;
alter table private.app_secrets        enable row level security;

-- ---------------------------------------------------------------- scope bits
--   1 post   2 read   4 react   8 tasks   16 files
--  32 directory   64 canvas   128 forms
-- All eight numbered now so nothing renumbers later. Only 1, 8 and 16 are
-- enforced today; the rest exist so an admin who ticks them is not lied to
-- later by a renumbering.

create or replace function private.app_scope_name(p_bit bigint)
returns text language sql immutable set search_path to '' as $fn$
  select case p_bit
    when 1   then 'Post messages'
    when 2   then 'Read messages'
    when 4   then 'Add reactions'
    when 8   then 'Create tasks'
    when 16  then 'Attach files'
    when 32  then 'Read the member directory'
    when 64  then 'Edit canvases'
    when 128 then 'Create forms'
    else 'scope ' || p_bit::text end;
$fn$;

-- ---------------------------------------------------------------- app context

do $$ begin
  create type private.app_ctx_t as (
    app_id       uuid,
    install_id   uuid,
    token_id     uuid,
    workspace_id uuid,
    profile_id   uuid,
    scopes       bigint,
    channel_scope text,
    app_name     text
  );
exception when duplicate_object then null; end $$;

-- Every app-facing RPC in every later phase starts here and nowhere else. One
-- function that decides "who is this, and may it" is the difference between an
-- auditable surface and seven copies of a hash comparison that drift apart.
create or replace function private.app_ctx(p_token text)
returns private.app_ctx_t
language plpgsql stable security definer set search_path to '' as $fn$
declare v private.app_ctx_t;
begin
  if p_token is null or length(p_token) < 16 then
    raise exception 'invalid_app_token' using errcode = '42501';
  end if;

  select a.id, i.id, t.id, i.workspace_id, a.profile_id, i.scopes, i.channel_scope, a.name
    into v.app_id, v.install_id, v.token_id, v.workspace_id, v.profile_id,
         v.scopes, v.channel_scope, v.app_name
    from public.app_tokens t
    join public.app_installs i on i.id = t.install_id
    join public.apps a         on a.id = i.app_id
   where t.token_sha256 = extensions.digest(p_token, 'sha256')
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > now())
     and i.uninstalled_at is null
     and a.disabled_at is null;

  -- All five rejection reasons - unknown hash, revoked, expired, uninstalled,
  -- app disabled - raise the identical error. Telling a caller which one it hit
  -- turns this into an oracle for probing which tokens once existed.
  if v.app_id is null then
    raise exception 'invalid_app_token' using errcode = '42501';
  end if;
  return v;
end;
$fn$;

create or replace function private.app_require(p_ctx private.app_ctx_t, p_bit bigint)
returns void language plpgsql immutable set search_path to '' as $fn$
begin
  if (coalesce(p_ctx.scopes, 0) & p_bit) <> p_bit then
    raise exception 'app_scope_denied: %', private.app_scope_name(p_bit)
      using errcode = '42501';
  end if;
end;
$fn$;

-- Accepts a UUID or a channel NAME, because the whole point of this surface is
-- that a Python script written by one person at a namkeen factory does not have
-- to carry a table of UUIDs. Raises the same error for "no such channel" and
-- "not granted", so an app cannot map a Space's private channels by probing.
create or replace function private.app_channel(p_ctx private.app_ctx_t, p_channel text)
returns uuid language plpgsql stable security definer set search_path to '' as $fn$
declare v_id uuid; v_name text;
begin
  if p_channel is null or btrim(p_channel) = '' then
    raise exception 'channel_not_available' using errcode = 'P0002';
  end if;
  v_name := trim(leading '#' from btrim(p_channel));

  begin
    v_id := v_name::uuid;
  exception when others then v_id := null;
  end;

  if v_id is not null then
    select c.id into v_id from public.channels c
     where c.id = v_id and c.workspace_id = p_ctx.workspace_id and c.archived_at is null;
  else
    select c.id into v_id from public.channels c
     where c.workspace_id = p_ctx.workspace_id
       and c.name = v_name::public.citext
       and c.archived_at is null;
  end if;

  if v_id is null then
    raise exception 'channel_not_available' using errcode = 'P0002';
  end if;

  if p_ctx.channel_scope = 'listed'
     and not exists (select 1 from public.app_install_channels ic
                      where ic.install_id = p_ctx.install_id and ic.channel_id = v_id) then
    raise exception 'channel_not_available' using errcode = 'P0002';
  end if;

  return v_id;
end;
$fn$;

-- At most one write a minute per token. A write on every call would make a
-- read-mostly table the hottest row in the database for no gain.
create or replace function private.app_touch(p_token_id uuid)
returns void language sql security definer set search_path to '' as $fn$
  update public.app_tokens set last_used_at = now()
   where id = p_token_id
     and (last_used_at is null or last_used_at < now() - interval '1 minute');
$fn$;
