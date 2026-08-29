-- 0108 - see the links you have handed out.
--
-- create_org_invite mints a token and revoke_org_invite kills one by id, but
-- there was nothing in between: no way to find out how many live links exist,
-- how many people had used one, or what the id of the link you wanted to revoke
-- actually was. So "revoke" was a function nobody could reach, and the only
-- honest advice for a link that had leaked was to delete the organisation.
--
-- The token itself is stored only as a sha256 digest and that does not change
-- here. A listing cannot show you the URL of a link you made last week, and it
-- should not be able to - anyone who can read the table would otherwise be able
-- to join every organisation in it. The listing shows the link's SHAPE (role,
-- uses, expiry, who made it) so it can be judged and revoked; re-sharing means
-- minting a new one, which is one click.
--
-- Who sees what: an admin sees every link into the org, because revoking a
-- colleague's leaked link is exactly the job. A plain member - who may now mint
-- links, since 0107 - sees only their own.

create or replace function public.list_org_invites(p_org uuid)
 returns table(id uuid, grant_role text, max_uses integer, uses integer,
               expires_at timestamptz, revoked_at timestamptz, created_at timestamptz,
               created_by uuid, created_by_name text, mine boolean)
 language sql
 stable security definer
 set search_path to ''
as $function$
  select i.id, i.grant_role, i.max_uses, i.uses,
         i.expires_at, i.revoked_at, i.created_at,
         i.created_by,
         -- username is a domain type, not text, so it is cast before the
         -- coalesce rather than after it.
         coalesce(p.display_name, p.username::text, 'someone')::text,
         i.created_by = (select auth.uid())
    from public.org_invites i
    left join public.profiles p on p.id = i.created_by
   where i.org_id = p_org
     and exists (select 1 from public.org_members m
                  where m.org_id = p_org and m.user_id = (select auth.uid()))
     and (i.created_by = (select auth.uid()) or private.is_org_admin(p_org))
   order by i.created_at desc;
$function$;

grant execute on function public.list_org_invites(uuid) to public, authenticated, service_role;

-- revoke_org_invite exists but never checked WHICH org the invite belonged to
-- before trusting the caller, so it is re-stated here with the same rule the
-- listing uses: your own link, or any link if you administer the org.
create or replace function public.revoke_org_invite(p_invite uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := (select auth.uid()); v_org uuid; v_owner uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select org_id, created_by into v_org, v_owner from public.org_invites where id = p_invite;
  if v_org is null then raise exception 'invalid_invite' using errcode = 'P0002'; end if;
  if v_owner <> v_uid and not private.is_org_admin(v_org) then
    raise exception 'forbidden' using
      errcode = '42501', hint = 'You can only revoke a link you made.';
  end if;
  update public.org_invites set revoked_at = coalesce(revoked_at, now()) where id = p_invite;
end;
$function$;

revoke execute on function public.revoke_org_invite(uuid) from public;
grant execute on function public.revoke_org_invite(uuid) to authenticated, service_role;
