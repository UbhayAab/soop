-- 0109 - the invite that led into an empty room.
--
-- workspaces.join_policy defaults to 'invite'. org_create_server(), which makes
-- the SECOND and every later server in an organisation, overrides that to 'open'
-- explicitly. create_space(), which makes a brand new organisation AND its
-- founding server, does not - so the first server of every organisation ever
-- created is invite-only and every one after it is open.
--
-- That single missing column is what made the org invite link useless on a new
-- organisation. redeem_org_invite() deliberately drops an arriving person into
-- "every OPEN server in the organisation"; on a fresh org there are none, so the
-- sequence was: scan the QR, join the organisation, land nowhere, see an empty
-- app. Measured on the live database before this ran: Misho Demo and Nashik
-- Traders Co each had exactly one server and it was invite-only, while every
-- multi-server org had open ones.
--
-- Two halves: stop making new orgs that way, and give the client a supported way
-- to open a server that is already wrong, since silently rewriting the join
-- policy of somebody's existing private server is not a migration's business.

-- ------------------------------------------------------- 1. new orgs, fixed
create or replace function public.create_space(p_name text)
 returns public.workspaces
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_org public.organizations; v_ws public.workspaces;
  v_everyone uuid; v_admin uuid; v_cat uuid; v_slug text; v_name text;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  v_name := trim(coalesce(p_name, ''));
  if length(v_name) = 0 or length(v_name) > 60 then raise exception 'invalid_name' using errcode = '22023'; end if;
  perform private.rate_limit('create_space', v_uid, null, 8, interval '1 hour');

  v_slug := nullif(lower(regexp_replace(v_name, '[^a-zA-Z0-9]+', '-', 'g')), '-');
  v_slug := coalesce(v_slug, 'space') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.organizations(slug, name) values (v_slug, v_name) returning * into v_org;
  -- join_policy 'open', stated rather than defaulted. The founding server is the
  -- one the organisation's own invite link has to land people in; leaving it on
  -- the column default made that link a dead end. A server that should be
  -- private can be closed afterwards, which is the safe direction to be wrong in
  -- for a server that is one person old.
  insert into public.workspaces(org_id, slug, name, join_policy, created_by)
    values (v_org.id, 'main', v_name, 'open', v_uid) returning * into v_ws;
  insert into public.roles(workspace_id, name, permissions, is_everyone, position)
    values (v_ws.id, '@everyone', 1 | (1::bigint << 7), true, 0) returning id into v_everyone;   -- SEND + CREATE_INVITE
  insert into public.roles(workspace_id, name, permissions, position)
    values (v_ws.id, 'Admin', (1::bigint << 40), 100) returning id into v_admin;                 -- ADMINISTRATOR
  update public.workspaces set everyone_role_id = v_everyone where id = v_ws.id;
  insert into public.workspace_members(workspace_id, user_id, member_type) values (v_ws.id, v_uid, 'moderator');
  insert into public.member_roles(workspace_id, user_id, role_id) values (v_ws.id, v_uid, v_admin);
  insert into public.categories(workspace_id, name, position) values (v_ws.id, 'General', 1000) returning id into v_cat;
  insert into public.channels(workspace_id, category_id, name, position) values (v_ws.id, v_cat, 'general', 1000);
  insert into public.channels(workspace_id, category_id, name, position) values (v_ws.id, v_cat, 'random', 2000);
  insert into public.channels(workspace_id, category_id, kind, name, position) values (v_ws.id, v_cat, 'voice', 'Lounge', 3000);
  return v_ws;
end;
$function$;

grant execute on function public.create_space(text) to public, authenticated, service_role;

-- --------------------------------------------- 2. repairing an existing one
-- There was no supported way to change a server's join policy at all: the admin
-- console can rename a server, set its icon and archive it, but the one setting
-- that decides whether an invited colleague can actually get in was reachable
-- only by editing the row. Org admins get it here, because the share sheet needs
-- to offer "people who join cannot see any server - open one" as a button rather
-- than as a sentence of advice.
create or replace function public.set_workspace_join_policy(p_workspace uuid, p_policy text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := (select auth.uid()); v_org uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if coalesce(p_policy,'') not in ('open','invite') then
    raise exception 'invalid_policy' using errcode = '22023';
  end if;
  select org_id into v_org from public.workspaces where id = p_workspace;
  if v_org is null then raise exception 'no_such_workspace' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then
    raise exception 'forbidden' using
      errcode = '42501',
      hint = 'Only an organisation admin can change who may join a server.';
  end if;
  update public.workspaces set join_policy = p_policy where id = p_workspace;
end;
$function$;

revoke execute on function public.set_workspace_join_policy(uuid, text) from public;
grant execute on function public.set_workspace_join_policy(uuid, text) to authenticated, service_role;
