-- RENUMBERED from 0120, for the reason given at the top of 0121.
--
-- list_space_admins answers the same question as get_member_badges (0120) and
-- knows one thing that function did not: an admin made through the organisation
-- console holds no Space role at all, so a member_roles-only derivation cannot
-- see them. Verified on the live project - "Aashika" is an org admin of Jarurat
-- Care with no ADMINISTRATOR-carrying Space role, which is exactly the person
-- whose missing badge was reported. 0123 folds that rule into
-- get_member_badges and get_bootstrap, which is what the client reads; this
-- function stays because it is the narrower, cheaper answer and nothing is
-- served by deleting a correct read.
--
-- Who runs this Space, readable by everyone in it.
--
-- "I made Aashika and Sourabh admins, and nothing beside their names says so."
-- Two reasons, and a member could only ever see through one of them:
--
--   1. The Members panel (js/features/uxfix.js) derived its Admin pill from
--      member_roles + roles, i.e. from holding a Space role that carries the
--      ADMINISTRATOR bit. Admins made through the organisation console -
--      set_org_role(..., 'admin'), which is what "People and roles" does - hold
--      no Space role at all, so the derivation never saw them.
--   2. member_roles_select (0003) is readable only by people who can manage
--      roles. An ordinary member reads zero rows there, so even role-carried
--      admins were unmarked for everybody except other admins.
--
-- One read that answers the question the panel is actually asking, gated on
-- membership rather than on the ability to change roles. Returns a flat object
-- keyed by user id so the client builds its Map in one step:
--   { "<user_id>": "owner" | "admin", ... }
-- 'owner' is workspaces.created_by, when they are still a member. 'admin' is an
-- organisation admin of the Space's org who is a member here, or a member
-- holding any role (the @everyone role included) that carries ADMINISTRATOR.
-- Deliberately not moderators: member_type is already readable through
-- wm_select and the panel marks those itself.

create or replace function public.list_space_admins(p_workspace uuid)
returns jsonb
language plpgsql stable security definer set search_path to '' as $fn$
declare
  v_uid   uuid   := (select auth.uid());
  v_org   uuid;
  v_owner uuid;
  v_admin bigint := (1::bigint << 40);
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_workspace is null then raise exception 'invalid_workspace' using errcode = '22023'; end if;
  -- uniform message: never leak whether the workspace exists
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;

  select w.org_id, w.created_by into v_org, v_owner
    from public.workspaces w where w.id = p_workspace;

  return coalesce((
    select jsonb_object_agg(x.user_id::text, x.kind)
      from (
        select wm.user_id,
               case when wm.user_id = v_owner then 'owner' else 'admin' end as kind
          from public.workspace_members wm
         where wm.workspace_id = p_workspace
           and ( wm.user_id = v_owner
              or exists (select 1 from public.org_members om
                          where om.org_id = v_org
                            and om.user_id = wm.user_id
                            and om.org_role = 'admin')
              or exists (select 1 from public.member_roles mr
                          join public.roles r on r.id = mr.role_id
                         where mr.workspace_id = p_workspace
                           and mr.user_id = wm.user_id
                           and (r.permissions & v_admin) <> 0)
              or exists (select 1 from public.roles r
                          where r.workspace_id = p_workspace
                            and r.is_everyone
                            and (r.permissions & v_admin) <> 0) )
      ) x), '{}'::jsonb);
end;
$fn$;

revoke all on function public.list_space_admins(uuid) from public, anon;
grant execute on function public.list_space_admins(uuid) to authenticated;
grant execute on function public.list_space_admins(uuid) to service_role;
