-- 0123_reconcile_dm_reactions_and_admins.sql
--
-- Two branches fixed the same three reports at the same time. 0119/0120 landed
-- on the live project first; 0121/0122 arrived from the other branch carrying
-- two rules the first pair did not have. This is the merge, applied to the
-- functions the client actually calls.
--
--   1. toggle_reaction's DM branch (0120) let you react to a message that had
--      been deleted, and knew nothing about personal blocks. send_dm has
--      honoured public.user_blocks since 0013: somebody who has blocked you
--      cannot be written to, and a reaction is writing to them. 0121's
--      toggle_dm_reaction had both rules. They belong in the function the app
--      calls, not only in the one beside it.
--
--   2. get_member_badges and get_bootstrap (0120) derived "admin" from
--      member_roles alone. An admin made through the organisation console -
--      set_org_role(..., 'admin'), which is what "People and roles" does -
--      holds no Space role at all, so that derivation cannot see them. Measured
--      on the live project before writing this: of the two organisation admins
--      of Jarurat Care, one carries an ADMINISTRATOR role and one does not, and
--      the one who does not is "Aashika" - one of the two people whose missing
--      badge started all of this. 0122's list_space_admins had the rule.
--
-- Both are corrections to functions this repo already defines in full, so both
-- are rewritten in full. Nothing here is new surface area.

-- ============================================================================
-- 1. One shared answer to "who runs this Space"
-- ============================================================================
-- Extracted because three callers now need exactly the same set and a fourth
-- would otherwise copy it a fourth time. Owner is workspaces.created_by, when
-- they are still a member. Admin is an ADMINISTRATOR-carrying role (including
-- @everyone, if somebody has done that), OR org_role='admin' in the Space's
-- organisation.
create or replace function private.space_admin_ids(p_workspace uuid)
returns uuid[] language sql stable security definer set search_path = '' as $fn$
  select coalesce(array_agg(distinct wm.user_id), '{}'::uuid[])
    from public.workspace_members wm
   where wm.workspace_id = p_workspace
     and ( exists (select 1
                     from public.member_roles mr
                     join public.roles r on r.id = mr.role_id
                    where mr.workspace_id = p_workspace
                      and mr.user_id = wm.user_id
                      and r.workspace_id = p_workspace
                      and (r.permissions & (1::bigint << 40)) <> 0)
        or exists (select 1
                     from public.roles r
                    where r.workspace_id = p_workspace
                      and r.is_everyone
                      and (r.permissions & (1::bigint << 40)) <> 0)
        or exists (select 1
                     from public.org_members om
                     join public.workspaces w on w.org_id = om.org_id
                    where w.id = p_workspace
                      and om.user_id = wm.user_id
                      and om.org_role = 'admin') );
$fn$;

-- ============================================================================
-- 2. get_member_badges, now including organisation admins
-- ============================================================================
create or replace function public.get_member_badges(p_workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_admins uuid[];
  v_owner  uuid;
  v_out    jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;

  v_admins := private.space_admin_ids(p_workspace);
  select w.created_by into v_owner from public.workspaces w where w.id = p_workspace;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id',     wm.user_id,
           'member_type', wm.member_type,
           'is_admin',    wm.user_id = any(v_admins),
           'is_owner',    v_owner is not null and wm.user_id = v_owner)), '[]'::jsonb)
    into v_out
    from public.workspace_members wm
   where wm.workspace_id = p_workspace;

  return v_out;
end;
$fn$;

grant execute on function public.get_member_badges(uuid) to authenticated;

-- ============================================================================
-- 3. toggle_reaction: deleted messages and personal blocks
-- ============================================================================
-- The channel branch is unchanged from 0120. The DM branch gains
-- `deleted_at is null` and the user_blocks test, which is the whole point of
-- this file.
create or replace function public.toggle_reaction(p_message uuid, p_emoji text)
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_ch    uuid;
  v_conv  uuid;
  v_added boolean;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_emoji is null or btrim(p_emoji) = '' or length(p_emoji) > 64 then
    raise exception 'invalid_emoji' using errcode = '22023';
  end if;

  select m.channel_id into v_ch from public.messages m where m.id = p_message;

  if v_ch is not null then
    if not private.can_view_channel(v_ch) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    perform private.rate_limit('react', v_uid, v_ch, 30, interval '10 seconds');
    delete from public.message_reactions
     where message_id = p_message and user_id = v_uid and emoji = p_emoji;
    if found then v_added := false;
    else
      insert into public.message_reactions(message_id, user_id, emoji, channel_id)
      values (p_message, v_uid, p_emoji, v_ch) on conflict do nothing;
      v_added := true;
    end if;
    perform app.emit('ch:'||v_ch::text, 'reaction',
      jsonb_build_object('message_id', p_message, 'emoji', p_emoji,
                         'user_id', v_uid, 'added', v_added));
    return v_added;
  end if;

  -- Not a channel message. Before 0120 this fell straight into the 'forbidden'
  -- above, which is why the reaction bar on a DM had never once worked.
  --
  -- deleted_at is null: a soft-deleted message still has its row, and reacting
  -- to something whose body has been withdrawn is not a thing to offer.
  select d.conversation_id into v_conv
    from public.dm_messages d
   where d.id = p_message and d.deleted_at is null;
  -- One word for a missing message, a deleted one, and one in a conversation the
  -- caller is not part of: the error must not say which.
  if v_conv is null or not private.is_conversation_member(v_conv) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The personal-block rule send_dm has applied since 0013. Somebody who has
  -- blocked you does not get your messages, and a reaction is a message with
  -- fewer characters.
  if exists (select 1
               from public.conversation_members cm
               join public.user_blocks ub on ub.blocker_id = cm.user_id
              where cm.conversation_id = v_conv
                and cm.user_id <> v_uid
                and ub.blocked_id = v_uid) then
    raise exception 'blocked' using errcode = '42501';
  end if;

  perform private.rate_limit('react', v_uid, v_conv, 30, interval '10 seconds');
  delete from public.dm_message_reactions
   where message_id = p_message and user_id = v_uid and emoji = p_emoji;
  if found then v_added := false;
  else
    insert into public.dm_message_reactions(message_id, user_id, emoji, conversation_id)
    values (p_message, v_uid, p_emoji, v_conv) on conflict do nothing;
    v_added := true;
  end if;
  -- The topic js/core/dms.js already subscribes to, with the event name its
  -- handler already listens for. conversation_id rides along because the other
  -- branch's client reads it and a broadcast costs nothing extra to widen.
  perform app.emit('dm:'||v_conv::text, 'reaction',
    jsonb_build_object('message_id', p_message, 'emoji', p_emoji,
                       'user_id', v_uid, 'added', v_added,
                       'conversation_id', v_conv));
  return v_added;
end;
$fn$;

grant execute on function public.toggle_reaction(uuid, text) to authenticated;
revoke all on public.dm_message_reactions from anon;

-- ============================================================================
-- 4. get_bootstrap reads the same shared set
-- ============================================================================
-- Otherwise the first paint and every refresh after it disagree about who is an
-- admin, which is worse than either answer alone: the badge would appear on a
-- cold start and vanish the moment somebody opened Members. Same function as
-- 0120 with the inlined derivation replaced by private.space_admin_ids.

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
  -- 0120: who wears an Admin badge in this Space. Set-wise, not one
  -- private.user_perms() call per member: that helper is a bit_or across every
  -- role in the Space and running it per row turns a 300-volunteer NGO into 300
  -- of them on every cold start.
  v_admins uuid[];
  v_owner  uuid;
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
           'is_admin',     ((v_perms & (1::bigint << 40)) <> 0) or private.is_platform_admin(),
           'is_owner',     exists (select 1 from public.workspaces w
                                    where w.id = p_workspace and w.created_by = v_uid))
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

  -- 0123: one shared answer, which also counts organisation admins. See
  -- private.space_admin_ids - an admin made in the org console holds no Space
  -- role at all, so the member_roles derivation this used to inline could not
  -- see them.
  v_admins := private.space_admin_ids(p_workspace);
  select w.created_by into v_owner from public.workspaces w where w.id = p_workspace;

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
           'is_admin',     wm.user_id = any(v_admins),
           'is_owner',     v_owner is not null and wm.user_id = v_owner,
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
