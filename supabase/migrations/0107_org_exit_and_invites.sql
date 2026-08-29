-- 0107 - the org you cannot leave, the org you cannot delete, and the invite
-- only an admin could send.
--
-- 0105 fixed half of the ghost: my_orgs() started hiding orgs where the caller
-- holds no live Space membership. It exempted admins, on the reasoning that an
-- admin administers from the console without sitting in a Space. That exemption
-- is why the bug survived for the only person who ever hits it - whoever
-- CREATED the org is its sole admin, so the exemption always fires, and no
-- amount of leaving Spaces ever takes the tile off their rail.
--
-- Three separate dead ends met at that tile:
--
--   1. Delete did nothing you could see. delete_organization() only sets
--      organizations.scheduled_delete_at, and my_orgs() never looked at that
--      column, so the org kept coming back in the rail for the full seven days.
--      You typed the org name to confirm and the bar was identical afterwards.
--      my_orgs() now returns the column so the rail can paint it dying, the way
--      it already paints a dying Space, and purge_org_now() lets an admin who
--      means it skip the seven days.
--
--   2. Leave was refused forever. leave_org() blocks the last admin with
--      "Make somebody else an admin before you leave." In a one-person org there
--      IS nobody else, so the guard could never be satisfied. It now applies
--      only when somebody would actually be orphaned; the last member out
--      schedules the empty org for deletion behind them.
--
--   3. Only admins could invite. create_org_invite() required is_org_admin, so
--      a member could not bring in a colleague. Members may now mint a
--      member-role link; minting an ADMIN link is still admin-only.
--
-- my_orgs() changes its return shape, so it has to be dropped and recreated
-- rather than replaced. Grants are restored explicitly below.

-- ---------------------------------------------------------------- 1. my_orgs
drop function if exists public.my_orgs();

create function public.my_orgs()
 returns table(org_id uuid, name text, slug text, org_role text, spaces integer,
               my_spaces integer, scheduled_delete_at timestamptz)
 language sql
 stable security definer
 set search_path to ''
as $function$
  select o.id, o.name, o.slug::text, m.org_role,
         (select count(*)::int from public.workspaces w
           where w.org_id = o.id and w.archived_at is null),
         -- How many live Spaces in this org the caller is actually in. Zero is
         -- what the rail needs in order to stop drawing a heading over nothing.
         (select count(*)::int from public.workspaces w
            join public.workspace_members wm
              on wm.workspace_id = w.id and wm.user_id = (select auth.uid())
           where w.org_id = o.id and w.archived_at is null),
         o.scheduled_delete_at
    from public.org_members m
    join public.organizations o on o.id = m.org_id
   where m.user_id = (select auth.uid())
     and (select private.pw_ok())
     and (
       m.org_role = 'admin'
       or exists (
         select 1 from public.workspaces w
         join public.workspace_members wm on wm.workspace_id = w.id and wm.user_id = auth.uid()
        where w.org_id = o.id and w.archived_at is null
       )
     )
   order by o.name;
$function$;

grant execute on function public.my_orgs() to public, authenticated, service_role;

-- ------------------------------------------------------------- 2. leave_org
create or replace function public.leave_org(p_org uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := (select auth.uid()); v_admins int; v_members int;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.org_members m
                 where m.org_id = p_org and m.user_id = v_uid) then
    raise exception 'not_a_member' using errcode = 'P0002';
  end if;

  select count(*) into v_members from public.org_members m where m.org_id = p_org;

  -- The guard exists to stop an org being left with members and no admin. When
  -- the person leaving is the LAST member there is nobody to orphan, so it does
  -- not apply - it only ever trapped them.
  if v_members > 1
     and exists (select 1 from public.org_members m
                 where m.org_id = p_org and m.user_id = v_uid and m.org_role = 'admin') then
    select count(*) into v_admins from public.org_members m2
     where m2.org_id = p_org and m2.org_role = 'admin';
    if v_admins <= 1 then
      raise exception 'last_admin' using
        errcode = '42501',
        hint = 'Make somebody else an admin before you leave.';
    end if;
  end if;

  delete from public.member_roles mr using public.workspaces w
   where w.org_id = p_org and mr.workspace_id = w.id and mr.user_id = v_uid;
  delete from public.workspace_members wm using public.workspaces w
   where w.org_id = p_org and wm.workspace_id = w.id and wm.user_id = v_uid;
  delete from public.org_members where org_id = p_org and user_id = v_uid;

  -- Last one out. Nobody is left who could ever open its console again, so an
  -- org left standing here is unreachable rather than shared. Put it on the same
  -- seven-day clock a deliberate delete uses, so an operator can still get it
  -- back, and let the purge cron take it.
  if v_members = 1 then
    update public.organizations
       set scheduled_delete_at = coalesce(scheduled_delete_at, now() + interval '7 days')
     where id = p_org;
    update public.workspaces
       set scheduled_delete_at = coalesce(scheduled_delete_at, now() + interval '7 days'),
           archived_at = coalesce(archived_at, now())
     where org_id = p_org;
  end if;
end;
$function$;

revoke execute on function public.leave_org(uuid) from public;
grant execute on function public.leave_org(uuid) to authenticated, service_role;

-- ---------------------------------------------------------- 3. purge_org_now
-- The seven days are a mercy, not a sentence. This is the same escape hatch
-- purge_workspace_now() already gives a Space: an admin who has already
-- scheduled the deletion and does not want to wait. Requiring it to be
-- scheduled first is deliberate - it keeps typeToConfirm as the only way in.
create or replace function public.purge_org_now(p_org uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_admin(p_org) then
    raise exception 'forbidden' using
      errcode = '42501',
      hint = 'Only an organisation admin can delete the organisation.';
  end if;
  if not exists (select 1 from public.organizations o
                 where o.id = p_org and o.scheduled_delete_at is not null) then
    raise exception 'not_scheduled' using
      errcode = '22023',
      hint = 'Schedule the deletion first, then it can be finished early.';
  end if;
  delete from public.organizations where id = p_org;
end;
$function$;

revoke execute on function public.purge_org_now(uuid) from public;
grant execute on function public.purge_org_now(uuid) to authenticated, service_role;

-- ------------------------------------------------------- 4. create_org_invite
create or replace function public.create_org_invite(p_org uuid, p_role text default 'member',
                                                    p_max_uses integer default null,
                                                    p_expires_at timestamptz default null)
 returns text
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := (select auth.uid()); v_token text; v_role text := coalesce(p_role, 'member');
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if v_role not in ('admin','member') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  -- Any member may bring in another member: an org nobody can grow is an org
  -- that stays one person. Handing out ADMIN is still an admin decision.
  if not exists (select 1 from public.org_members m
                 where m.org_id = p_org and m.user_id = v_uid) then
    raise exception 'forbidden' using
      errcode = '42501', hint = 'Join the organisation before inviting to it.';
  end if;
  if v_role = 'admin' and not private.is_org_admin(p_org) then
    raise exception 'forbidden' using
      errcode = '42501', hint = 'Only an admin can invite somebody as an admin.';
  end if;
  -- An org on its way out does not get new arrivals.
  if exists (select 1 from public.organizations o
             where o.id = p_org and o.scheduled_delete_at is not null) then
    raise exception 'org_deleted' using
      errcode = '42501', hint = 'This organisation is scheduled for deletion.';
  end if;

  -- 32 hex characters, 128 bits. Stored only as a digest, exactly like invites.
  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into public.org_invites(org_id, token_sha256, grant_role, max_uses, created_by, expires_at)
    values (p_org, extensions.digest(v_token, 'sha256'), v_role,
            p_max_uses, v_uid, p_expires_at);
  return v_token;
end;
$function$;

grant execute on function public.create_org_invite(uuid, text, integer, timestamptz)
  to public, authenticated, service_role;

-- ------------------------------------------------------- 5. redeem_org_invite
-- A live link into an org that is being deleted would hand somebody a seat on a
-- chair that is already being taken away.
create or replace function public.redeem_org_invite(p_token text)
 returns public.organizations
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := (select auth.uid()); v_inv public.org_invites; v_org public.organizations; v_hash bytea;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  perform private.rate_limit('redeem', v_uid, null, 10, interval '60 seconds');
  v_hash := extensions.digest(p_token, 'sha256');
  select * into v_inv from public.org_invites where token_sha256 = v_hash for update;
  if v_inv is null then raise exception 'invalid_invite' using errcode = '42501'; end if;
  if v_inv.revoked_at is not null then raise exception 'invite_revoked' using errcode = '42501'; end if;
  if v_inv.expires_at is not null and v_inv.expires_at < now() then raise exception 'invite_expired' using errcode = '42501'; end if;
  if v_inv.max_uses is not null and v_inv.uses >= v_inv.max_uses then raise exception 'invite_exhausted' using errcode = '42501'; end if;
  if exists (select 1 from public.organizations o
             where o.id = v_inv.org_id and o.scheduled_delete_at is not null) then
    raise exception 'org_deleted' using errcode = '42501';
  end if;

  insert into public.org_members(org_id, user_id, org_role)
    values (v_inv.org_id, v_uid, v_inv.grant_role)
    on conflict (org_id, user_id) do nothing;
  update public.org_invites set uses = uses + 1 where id = v_inv.id;

  -- Land them somewhere rather than in an empty org: every OPEN server in the
  -- organisation. An invite-only server stays invite-only - it shows in the
  -- directory and they can ask.
  insert into public.workspace_members(workspace_id, user_id, member_type)
  select w.id, v_uid, 'member'
    from public.workspaces w
   where w.org_id = v_inv.org_id
     and w.archived_at is null
     and w.join_policy = 'open'
     and not exists (select 1 from public.bans b where b.workspace_id = w.id and b.user_id = v_uid)
   on conflict do nothing;

  select * into v_org from public.organizations where id = v_inv.org_id;
  return v_org;
end;
$function$;

grant execute on function public.redeem_org_invite(text) to public, authenticated, service_role;
