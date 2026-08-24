-- 0105 - ghost org memberships, killed at both roots.
--
-- Symptom: after leaving every Space in an org, the org still rendered as a
-- tile in the rail - my_orgs() read org_members alone, and nothing ever wrote
-- the row off when the last Space membership went.
--
-- 1. my_orgs() now hides orgs where the caller holds no live Space membership,
--    unless they are the org admin (admins administer from the console without
--    sitting in a Space).
-- 2. One-time purge of existing ghost rows: org_members with zero live
--    workspace_members in that org and no admin role.
--
-- Applied to the live database 2026-08-24 via Management API before being
-- committed here; this file is the versioned copy.

create or replace function public.my_orgs()
 returns table(org_id uuid, name text, slug text, org_role text, spaces integer)
 language sql
 stable security definer
 set search_path to ''
as $function$
  select o.id, o.name, o.slug::text, m.org_role,
         (select count(*)::int from public.workspaces w where w.org_id = o.id and w.archived_at is null)
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

delete from public.org_members om
 where not exists (
   select 1 from public.workspaces w
   join public.workspace_members wm on wm.workspace_id = w.id and wm.user_id = om.user_id
  where w.org_id = om.org_id and w.archived_at is null)
   and om.org_role <> 'admin';
