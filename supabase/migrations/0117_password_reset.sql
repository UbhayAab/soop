-- "I forgot my password" needs to be a door, not a favour.
--
-- Until now the only way back into an account whose password was lost was to ask
-- an operator to run admin_require_password_reset and hand over a temporary one.
-- The whole machine for doing it yourself already existed - a code by email, a
-- set-password screen, a latch that forces it - and nothing connected them.
--
-- This is the missing link: latch YOURSELF. It is safe precisely because it can
-- only ever affect the caller, and because the only thing being "granted" is an
-- obligation. Reaching it at all requires having already proved control of the
-- mailbox by signing in with a code, so it grants no reach that the code did
-- not already grant.

create or replace function public.start_password_reset()
returns void
language plpgsql security definer set search_path to '' as $fn$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  -- Rate limited like every other self-service verb here. Not because the write
  -- is dangerous, but because private.password_latch arms a baseline row on the
  -- trigger and there is no reason to let anybody churn it.
  perform private.rate_limit('pwreset', v_uid, null, 10, interval '10 minutes');
  update public.profiles set must_set_password = true where id = v_uid;
end;
$fn$;

grant execute on function public.start_password_reset() to authenticated;
