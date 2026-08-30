-- get_bootstrap must carry is_app on every member it returns.
--
-- Found by probe-apps.mjs, not by reading: the app message rendered with the
-- right NAME but never got its APP pill. The reason is that store.profiles is
-- not filled from the profiles table at all on a cold load - get_bootstrap
-- builds each member with an explicit jsonb_build_object of nine keys, and a
-- column that is not in that list simply does not exist as far as the client is
-- concerned, silently. reloadMembers() does select * and would have carried it,
-- which is exactly why reading the client code suggested this already worked.
--
-- Only the two member payloads change. The rest of the function is reproduced
-- verbatim from the live definition.

CREATE OR REPLACE FUNCTION public.get_bootstrap(p_workspace uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid   uuid := (select auth.uid());
  v_perms bigint;
  v_ws    jsonb;
  v_me    jsonb;
  v_cats  jsonb;
  v_chans jsonb;
  v_mem   jsonb;
  v_unrd  jsonb;
  v_notif jsonb;
  v_dms   jsonb;
  v_draft jsonb;
  v_voice jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_workspace is null then raise exception 'invalid_workspace' using errcode = '22023'; end if;
  -- uniform message: never leak whether the workspace exists
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;

  v_perms := private.member_perms(p_workspace);

  select jsonb_build_object(
           'id', w.id, 'name', w.name, 'slug', w.slug::text,
           'icon_key', w.icon_key, 'retention_days', w.retention_days)
    into v_ws
    from public.workspaces w where w.id = p_workspace;

  -- permissions is returned as TEXT: it is a bigint bitfield with the ADMINISTRATOR
  -- bit at 1<<40, which does not survive a JS number round trip safely.
  -- status_text/status_emoji honour the TTL (FIX 3).
  select jsonb_build_object(
           'user_id',      p.id,
           'display_name', p.display_name,
           'username',     p.username::text,
           'avatar_key',   p.avatar_key,
           'status_text',  case when p.status_expires_at is not null and p.status_expires_at <= now()
                                then null else p.status_text end,
           'status_emoji', case when p.status_expires_at is not null and p.status_expires_at <= now()
                                then null else p.status_emoji end,
           'permissions',  v_perms::text,
           'member_type',  wm.member_type,
           'is_app',       p.is_app,
           'is_admin',     ((v_perms & (1::bigint << 40)) <> 0) or private.is_platform_admin())
    into v_me
    from public.workspace_members wm
    left join public.profiles p on p.id = wm.user_id
   where wm.workspace_id = p_workspace and wm.user_id = v_uid;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'name', c.name, 'position', c.position)
           order by c.position, c.name), '[]'::jsonb)
    into v_cats
    from public.categories c where c.workspace_id = p_workspace;

  -- viewable channels only (private channels require an explicit channel_members row)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',               ch.id,
           'name',             ch.name::text,
           'kind',             ch.kind,
           'topic',            ch.topic,
           'category_id',      ch.category_id,
           'position',         ch.position,
           'is_private',       ch.is_private,
           'archived_at',      ch.archived_at,
           'last_seq',         ch.last_seq,
           'slowmode_seconds', ch.slowmode_seconds,
           'is_readonly',      ch.readonly)
           order by ch.position, ch.name), '[]'::jsonb)
    into v_chans
    from public.channels ch
   where ch.workspace_id = p_workspace
     and ( not ch.is_private
           or exists (select 1 from public.channel_members cm
                       where cm.channel_id = ch.id and cm.user_id = v_uid) )
     -- 0050: an explicit VIEW_CHANNEL deny removes the channel from the sidebar
     and not private.channel_view_denied(v_uid, ch.id);

  -- online = a presence row that is not 'offline' and was refreshed in the last 90s
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id',      wm.user_id,
           'display_name', p.display_name,
           'username',     p.username::text,
           'avatar_key',   p.avatar_key,
           'status_text',  case when p.status_expires_at is not null and p.status_expires_at <= now()
                                then null else p.status_text end,
           'status_emoji', case when p.status_expires_at is not null and p.status_expires_at <= now()
                                then null else p.status_emoji end,
           'member_type',  wm.member_type,
           'is_app',       p.is_app,
           'online',       coalesce(up.status is not null and up.status <> 'offline'
                                    and up.last_seen_at > now() - interval '90 seconds', false))
           order by p.display_name), '[]'::jsonb)
    into v_mem
    from public.workspace_members wm
    left join public.profiles p      on p.id = wm.user_id
    left join public.user_presence up on up.user_id = wm.user_id
   where wm.workspace_id = p_workspace;

  -- unread: every viewable, non-archived channel. The last_seq comparison is only a
  -- short-circuit; the authoritative test is a live message past the cursor, because
  -- channels.last_seq also advances on pin/edit/delete channel events (FIX 1 and 2).
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_unrd from (
    select jsonb_build_object(
             'scope_type',    'channel',
             'scope_id',      ch.id,
             'unread',        coalesce(ch.last_seq, 0) > coalesce(rs.last_read_seq, 0)
                              and exists (select 1 from public.messages m
                                           where m.channel_id = ch.id and m.deleted_at is null
                                             and m.seq > coalesce(rs.last_read_seq, 0)),
             'mention_count', coalesce(rs.mention_count, 0)) as x
      from public.channels ch
      left join public.read_state rs
        on rs.user_id = v_uid and rs.scope_type = 'channel' and rs.scope_id = ch.id
     where ch.workspace_id = p_workspace
       and ch.archived_at is null
       and ( not ch.is_private
             or exists (select 1 from public.channel_members cm
                         where cm.channel_id = ch.id and cm.user_id = v_uid) )
       -- 0050: same VIEW deny, so a hidden channel cannot surface as an unread badge
       and not private.channel_view_denied(v_uid, ch.id)
    union all
    select jsonb_build_object(
             'scope_type',    'thread',
             'scope_id',      t.id,
             'unread',        exists (select 1 from public.messages m
                                       where m.thread_id = t.id and m.deleted_at is null
                                         and m.seq > coalesce(rs.last_read_seq, 0)),
             'mention_count', coalesce(rs.mention_count, 0)) as x
      from public.read_state rs
      join public.threads t on t.id = rs.scope_id
      join public.channels ch on ch.id = t.channel_id
     where rs.user_id = v_uid and rs.scope_type = 'thread' and t.workspace_id = p_workspace
       and ( not ch.is_private
             or exists (select 1 from public.channel_members cm
                         where cm.channel_id = ch.id and cm.user_id = v_uid) )
  ) s;

  -- notify settings, restricted to channels the caller can still see (FIX 4)
  select coalesce(jsonb_agg(jsonb_build_object(
           'scope_id',     rs.scope_id,
           'notify_level', rs.notify_level,
           'muted_until',  rs.muted_until)), '[]'::jsonb)
    into v_notif
    from public.read_state rs
    join public.channels ch on ch.id = rs.scope_id and ch.workspace_id = p_workspace
   where rs.user_id = v_uid and rs.scope_type = 'channel'
     and ( not ch.is_private
           or exists (select 1 from public.channel_members cm
                       where cm.channel_id = ch.id and cm.user_id = v_uid) );

  select coalesce(jsonb_agg(jsonb_build_object(
           'conversation_id', cv.id,
           'kind',            cv.kind,
           'other_user_ids',  coalesce((select jsonb_agg(o.user_id)
                                          from public.conversation_members o
                                         where o.conversation_id = cv.id and o.user_id <> v_uid),
                                       '[]'::jsonb),
           'last_message_at', cv.last_message_at,
           'unread',          coalesce(cv.last_seq, 0) > coalesce(me.last_read_seq, 0))
           order by cv.last_message_at desc nulls last), '[]'::jsonb)
    into v_dms
    from public.conversations cv
    join public.conversation_members me
      on me.conversation_id = cv.id and me.user_id = v_uid
   where cv.workspace_id = p_workspace;

  -- drafts scoped to this workspace AND to scopes the caller can still reach (FIX 4)
  select coalesce(jsonb_agg(jsonb_build_object(
           'scope_type', d.scope_type,
           'scope_id',   d.scope_id,
           'body_text',  d.body_text)), '[]'::jsonb)
    into v_draft
    from public.drafts d
   where d.user_id = v_uid and length(btrim(coalesce(d.body_text, ''))) > 0
     and ( (d.scope_type = 'channel' and exists (
              select 1 from public.channels c
               where c.id = d.scope_id and c.workspace_id = p_workspace
                 and ( not c.is_private
                       or exists (select 1 from public.channel_members cm
                                   where cm.channel_id = c.id and cm.user_id = v_uid) )))
        or (d.scope_type = 'thread'  and exists (
              select 1 from public.threads t
               join public.channels c on c.id = t.channel_id
               where t.id = d.scope_id and t.workspace_id = p_workspace
                 and ( not c.is_private
                       or exists (select 1 from public.channel_members cm
                                   where cm.channel_id = c.id and cm.user_id = v_uid) )))
        or (d.scope_type = 'dm'      and exists (
              select 1 from public.conversations cv
               join public.conversation_members cm2
                 on cm2.conversation_id = cv.id and cm2.user_id = v_uid
               where cv.id = d.scope_id and cv.workspace_id = p_workspace)) );

  select coalesce(jsonb_agg(jsonb_build_object(
           'channel_id', vp.channel_id, 'user_id', vp.user_id)), '[]'::jsonb)
    into v_voice
    from public.voice_participants vp
    join public.channels ch on ch.id = vp.channel_id
   where vp.workspace_id = p_workspace
     and ( not ch.is_private
           or exists (select 1 from public.channel_members cm
                       where cm.channel_id = ch.id and cm.user_id = v_uid) );

  return jsonb_build_object(
    'workspace',  coalesce(v_ws, '{}'::jsonb),
    'me',         coalesce(v_me, '{}'::jsonb),
    'categories', v_cats,
    'channels',   v_chans,
    'members',    v_mem,
    'unread',     v_unrd,
    'notify',     v_notif,
    'dms',        v_dms,
    'drafts',     v_draft,
    'voice',      v_voice);
end;
$function$
;
