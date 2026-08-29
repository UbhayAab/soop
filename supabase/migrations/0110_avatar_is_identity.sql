-- 0110 - a face is identity, not a workspace attachment.
--
-- Reported as "I can see the person has put in a DP, but it does not load for
-- me". Traced to can_read_attachment, which is the sole gate on the private
-- attachments bucket. Its rule is: the object key is 'ws/{workspace_id}/...',
-- so you may read it if private.is_member(workspace_id).
--
-- That rule is exactly right for a message attachment. A photo of a loading
-- sheet posted in one Space must not be readable from another, and this is the
-- only thing standing between the two.
--
-- It is wrong for an avatar, because an avatar is not a thing that lives in a
-- Space. mint-upload puts it under whichever workspace its owner happened to
-- have open when they chose the picture, and from then on the app renders it
-- everywhere that person appears: the DM list, member pickers, profile cards,
-- forum bylines, message rows in entirely different organisations. Judged by
-- membership of that one workspace, a face loaded for the colleagues who
-- happened to share it and was a blank box for the same person's DMs
-- everywhere else. Measured on the live database: exactly one profile of 144
-- has a picture, which is why nobody had hit this until somebody finally set
-- one.
--
-- The honest boundary for a face is the one the product already uses for
-- knowing a person exists at all: you share an organisation with them. Note
-- what this does NOT do - it grants nothing for arbitrary keys under that
-- person's workspaces, only for the exact key that is currently their
-- avatar_key. Change your picture and the old object stops being readable
-- through this branch immediately.

create or replace function public.can_read_attachment(p_object_key text)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_uid     uuid := (select auth.uid());
  v_ws_text text;
  v_ws      uuid;
begin
  if v_uid is null or p_object_key is null then
    return false;
  end if;
  -- key shape must be 'ws/{workspace_id}/...'
  if split_part(p_object_key, '/', 1) <> 'ws' then
    return false;
  end if;
  v_ws_text := split_part(p_object_key, '/', 2);
  if v_ws_text = '' then
    return false;
  end if;
  begin
    v_ws := v_ws_text::uuid;
  exception when others then
    return false;   -- second segment is not a uuid
  end;

  -- The original rule, unchanged and still first: membership of the workspace
  -- the object lives under.
  if private.is_member(v_ws) then
    return true;
  end if;

  -- Otherwise the only thing that may still be read is somebody's CURRENT
  -- avatar, and only by somebody who shares an organisation with them.
  return exists (
    select 1
      from public.profiles pr
      join public.org_members them on them.user_id = pr.id
      join public.org_members me   on me.org_id = them.org_id
     where pr.avatar_key = p_object_key
       and me.user_id = v_uid
  );
end;
$function$;

grant execute on function public.can_read_attachment(text) to public, authenticated, service_role;
