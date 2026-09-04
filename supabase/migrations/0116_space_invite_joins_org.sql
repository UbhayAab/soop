-- Being in a server means being in its organisation.
--
-- redeem_invite - the SERVER-level invite link - inserted workspace_members and
-- member_roles and never touched org_members. So somebody handed a server link
-- could sign in, read, post and appear in the channel's member list, while being
-- invisible in Organisation settings -> People. There was no row to promote, so
-- no admin could give them a role, and nothing on screen explained why the
-- person they could plainly see in Members could not be found in People.
--
-- Reported exactly that way: two accounts named Sourabh in the member list, one
-- online with no badge, and a search for "Sou" under People returning only the
-- other one.
--
-- redeem_org_invite has always inserted both rows. join_team_space cannot hit
-- this because it refuses anybody who is not already an org member. It was only
-- ever this one path, which is also the path most people arrive through.

create or replace function public.redeem_invite(p_token text)
returns public.workspaces
language plpgsql security definer set search_path to '' as $fn$
declare v_uid uuid := (select auth.uid()); v_inv public.invites; v_ws public.workspaces; v_hash bytea;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  perform private.rate_limit('redeem', v_uid, null, 10, interval '60 seconds');
  v_hash := extensions.digest(p_token, 'sha256');
  select * into v_inv from public.invites where token_sha256 = v_hash for update;
  if v_inv is null then raise exception 'invalid_invite' using errcode = '42501'; end if;
  if v_inv.revoked_at is not null then raise exception 'invite_revoked' using errcode = '42501'; end if;
  if v_inv.expires_at is not null and v_inv.expires_at < now() then raise exception 'invite_expired' using errcode = '42501'; end if;
  if v_inv.max_uses is not null and v_inv.uses >= v_inv.max_uses then raise exception 'invite_exhausted' using errcode = '42501'; end if;
  if exists (select 1 from public.bans b where b.workspace_id = v_inv.workspace_id and b.user_id = v_uid) then
    raise exception 'banned' using errcode = '42501';
  end if;

  select * into v_ws from public.workspaces where id = v_inv.workspace_id;

  -- THE FIX. Joining a server joins the organisation that owns it, as a plain
  -- member. An existing membership is never downgraded: 'do nothing' rather than
  -- 'do update', so redeeming a server link cannot demote an admin.
  if v_ws.org_id is not null then
    insert into public.org_members(org_id, user_id, org_role)
    values (v_ws.org_id, v_uid, 'member')
    on conflict (org_id, user_id) do nothing;
  end if;

  insert into public.workspace_members(workspace_id, user_id, member_type)
  values (v_inv.workspace_id, v_uid, 'member')
  on conflict do nothing;

  if v_inv.grant_role_id is not null then
    insert into public.member_roles(workspace_id, user_id, role_id)
    values (v_inv.workspace_id, v_uid, v_inv.grant_role_id)
    on conflict do nothing;
  end if;

  update public.invites set uses = uses + 1 where id = v_inv.id;
  return v_ws;
end;
$fn$;

-- Everybody already stranded by it. 8 people in Jarurat Care alone, all of whom
-- joined on 2 and 3 September and have been sitting in the member list ever
-- since with no way for an admin to reach them.
insert into public.org_members (org_id, user_id, org_role)
select distinct w.org_id, wm.user_id, 'member'
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
 where w.org_id is not null
   and not exists (select 1 from public.org_members m
                    where m.org_id = w.org_id and m.user_id = wm.user_id)
on conflict (org_id, user_id) do nothing;
