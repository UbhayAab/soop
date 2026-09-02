-- Two access-control fixes and one backfill, all from reported behaviour.

-- 1 ---------------------------------------------------------------------------
-- Leaving an organisation must revoke the channels too.
--
-- leave_workspace deletes member_roles, channel_members and workspace_members.
-- leave_org deleted member_roles and workspace_members and forgot channel_members,
-- and private.can_view_channel grants access on a channel_members row ALONE with
-- no workspace check on that branch. So every private channel somebody had an
-- explicit row in stayed readable after they left the organisation entirely.
--
-- There are zero such rows in this database today, so nothing has leaked yet.
-- It would have leaked the first time an admin removed somebody from an org
-- rather than from a server.

create or replace function public.leave_org(p_org uuid)
returns void
language plpgsql security definer set search_path to '' as $fn$
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
  -- THE FIX. Without this the private channels survive the departure.
  delete from public.channel_members cm using public.workspaces w
   where w.org_id = p_org and cm.workspace_id = w.id and cm.user_id = v_uid;
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

  -- Tell this person's other tabs and devices that their claims changed, the
  -- way leave_workspace already does. Without it a second tab kept the Space
  -- on screen and kept answering from cache.
  perform app.emit('user:' || v_uid::text, 'claims_changed',
                   jsonb_build_object('org_id', p_org));
end;
$fn$;

-- 2 ---------------------------------------------------------------------------
-- Defence in depth: a channel_members row must never outlive Space membership.
--
-- Deleting the rows on the way out is the fix; this is the guarantee. Any future
-- path that forgets to clean up cannot produce a readable channel, because the
-- private branch now asks the same membership question the public branch does.
-- Verified safe first: zero channel_members rows in this database belong to
-- somebody who is not a member of that channel's Space.

create or replace function private.can_view_channel(ch uuid)
returns boolean
language sql stable security definer set search_path to '' as $fn$
  select (select private.pw_ok())
     and exists (
       select 1 from public.channels c
       join public.workspace_members m
         on m.workspace_id = c.workspace_id and m.user_id = (select auth.uid())
       where c.id = ch and (
         not c.is_private
         or exists (select 1 from public.channel_members cm
                     where cm.channel_id = ch and cm.user_id = (select auth.uid())) ))
     and not private.channel_view_denied((select auth.uid()), ch);
$fn$;

-- 3 ---------------------------------------------------------------------------
-- Ask the OTP accounts to choose a password. ONLY the OTP accounts.
--
-- The tempting predicate is "password_set_at is null", on the reasoning that
-- complete_password_setup only ever runs for a latched account, so a null there
-- means nobody ever chose one. That is wrong, and it was caught by latching 53
-- accounts and watching the probe suite stop signing in: demo@dek.app has a
-- working seeded password and a null password_set_at. Passwords set out of band
-- leave no trace in that column. 53 people would have been locked out of an
-- account that worked.
--
-- The signature that IS reliable is the one mail-otp itself writes. Its
-- createUser call sets exactly {display_name: <local part>, email_verified:true}
-- and nothing else - no "sub", which every other creation path leaves behind.
-- That identifies 10 accounts, all created since 24 August, which matches the
-- day-by-day pattern of accounts that signed in but never set a password.
--
-- auth.users.encrypted_password is no help here either: Supabase writes a random
-- hash on createUser even when no password is supplied, so all 146 rows look
-- identical. That is exactly why these accounts feel passwordless to the person
-- using them without being detectably so from the schema.

update public.profiles p
   set must_set_password = true
  from auth.users u
 where u.id = p.id
   and not p.is_app
   and u.banned_until is null
   and not p.must_set_password
   and p.password_set_at is null
   and u.raw_user_meta_data ? 'display_name'
   and not (u.raw_user_meta_data ? 'sub')
   and u.raw_user_meta_data->>'display_name' = split_part(u.email, '@', 1)
   and (u.raw_user_meta_data->>'email_verified')::boolean is true;
