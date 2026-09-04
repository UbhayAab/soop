-- A name you give somebody, that only you see.
--
-- Asked for exactly this way: "I want to change someone's name just for myself.
-- Like put a skull emoji after Utkarsh's name, and I see it but he does not."
--
-- workspace_members.nickname looks like the answer and is not. It is keyed on
-- the SUBJECT (workspace_id, user_id), so there is one value per person rather
-- than one per person per viewer; it is readable by every co-member through
-- wm_select, so it could never be private; and it has no write grant or write
-- policy, so no client can set it. It has 0 rows and no code reads it. It is
-- dropped here rather than left in place, because a column that looks like a
-- feature and is not is how the phantom bot_id/webhook_id reads happened.

create table if not exists public.user_nicknames (
  viewer_id  uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.profiles(id) on delete cascade,
  nickname   text not null check (length(btrim(nickname)) between 1 and 40),
  updated_at timestamptz not null default now(),
  primary key (viewer_id, subject_id)
);

alter table public.user_nicknames enable row level security;

-- Modelled on notif_prefs_self, which is the only per-user table here with full
-- client read and write. Both halves matter: TO authenticated, and the
-- (select auth.uid()) initplan wrapper rather than a bare call, which is the
-- difference between one evaluation and one per row on a table that gets joined
-- into name lookups.
do $$ begin
  create policy nick_self on public.user_nicknames
    for all to authenticated
    using (viewer_id = (select auth.uid()))
    with check (viewer_id = (select auth.uid()));
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.user_nicknames to authenticated;

alter table public.workspace_members drop column if exists nickname;

-- ---------------------------------------------------------------- the writes

-- Through an RPC rather than a direct table write, for one reason: the lock.
-- private.identity_rule is in the private schema and PostgREST cannot reach it,
-- so a client-side check would be advice rather than a rule. Deciding here means
-- an organisation that turns nicknames off has actually turned them off.
create or replace function public.set_nickname(p_subject uuid, p_nickname text)
returns void
language plpgsql security definer set search_path to '' as $fn$
declare v_uid uuid := (select auth.uid()); v_name text := btrim(coalesce(p_nickname, ''));
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;

  if private.identity_rule(v_uid, 'nicknames') <> 'anyone' then
    raise exception 'field_locked:nicknames' using
      errcode = '42501',
      hint = 'Your organisation does not allow personal nicknames.';
  end if;

  -- You can only rename somebody you actually share a Space with. Without this
  -- the table doubles as a way to confirm that any given profile id exists.
  if p_subject <> v_uid and not exists (
       select 1 from public.workspace_members a
       join public.workspace_members b on b.workspace_id = a.workspace_id
      where a.user_id = v_uid and b.user_id = p_subject) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if length(v_name) = 0 then
    delete from public.user_nicknames where viewer_id = v_uid and subject_id = p_subject;
    return;
  end if;
  if length(v_name) > 40 then raise exception 'too_long' using errcode = '22023'; end if;

  insert into public.user_nicknames (viewer_id, subject_id, nickname)
  values (v_uid, p_subject, v_name)
  on conflict (viewer_id, subject_id)
    do update set nickname = excluded.nickname, updated_at = now();
end;
$fn$;

grant execute on function public.set_nickname(uuid, text) to authenticated;

-- Everything this viewer has renamed, in one round trip at boot. Returning a
-- flat object keyed by id means the client can build its Map without a loop and
-- without a second RLS-filtered select.
create or replace function public.my_nicknames()
returns jsonb
language sql stable security definer set search_path to '' as $fn$
  select coalesce(jsonb_object_agg(n.subject_id::text, n.nickname), '{}'::jsonb)
    from public.user_nicknames n
   where n.viewer_id = (select auth.uid());
$fn$;

grant execute on function public.my_nicknames() to authenticated;

-- ---------------------------------------------------------------- the lock

-- 'nicknames' joins the fields an org can lock. set_org_identity_policy already
-- drops keys it does not recognise, so adding it here and in my_identity_rules
-- lets the database and the client ship in either order. All 43 organisations
-- have an empty identity_policy today, and private.identity_rule already
-- defaults an unknown key to 'anyone', so nothing changes for anybody until an
-- admin decides otherwise.
-- Reproduced from the live definition with ONE word added to the key list.
-- Rewriting it from the design's sketch would have broken three things: the real
-- function returns the cleaned policy rather than void, it also whitelists
-- email_visible and phone_visible with a different value set, and it RAISES on a
-- bad value for a known key while dropping unknown keys silently - a distinction
-- with a test on it, because the client and the database deploy separately.
create or replace function public.set_org_identity_policy(p_org uuid, p_policy jsonb)
returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare v_clean jsonb := '{}'::jsonb; k text; v text;
begin
  if not private.is_org_admin(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for k in select jsonb_object_keys(coalesce(p_policy, '{}'::jsonb)) loop
    v := p_policy ->> k;
    if k in ('name', 'title', 'pronouns', 'avatar', 'bio', 'nicknames') then
      -- who may CHANGE it
      if v not in ('anyone', 'admins', 'locked') then
        raise exception 'bad_policy_value:%', v using errcode = '22023';
      end if;
      v_clean := v_clean || jsonb_build_object(k, v);
    elsif k in ('email_visible', 'phone_visible') then
      -- who may SEE it
      if v not in ('everyone', 'members', 'admins') then
        raise exception 'bad_policy_value:%', v using errcode = '22023';
      end if;
      v_clean := v_clean || jsonb_build_object(k, v);
    end if;
    -- An unknown key is DROPPED, not refused. That is the behaviour this call
    -- has always had and there is a test asserting it, for a good reason: the
    -- client and the database are deployed separately, so a browser holding a
    -- key this version has never heard of must not be an error. A bad VALUE for
    -- a key that does exist is still refused - that is a typo, not version skew.
  end loop;

  update public.organizations set identity_policy = v_clean where id = p_org;
  return v_clean;
end;
$fn$;

create or replace function public.my_identity_rules()
returns jsonb
language sql stable security definer set search_path to '' as $fn$
  select jsonb_build_object(
    'name',      private.identity_rule((select auth.uid()), 'name'),
    'title',     private.identity_rule((select auth.uid()), 'title'),
    'pronouns',  private.identity_rule((select auth.uid()), 'pronouns'),
    'avatar',    private.identity_rule((select auth.uid()), 'avatar'),
    'bio',       private.identity_rule((select auth.uid()), 'bio'),
    'nicknames', private.identity_rule((select auth.uid()), 'nicknames'));
$fn$;
