-- 0120_dm_reactions_and_admin_badges.sql
--
-- Two reports from the people actually running this, and both are the same
-- shape: the UI offers something the database has no way to do.
--
--   1. Every message in a DM paints the quick-reaction bar and the picker,
--      because DMs deliberately share buildMessage() with channels. Pressing any
--      of them raised "forbidden". public.toggle_reaction only ever looked in
--      public.messages; a DM message id lives in public.dm_messages, so the
--      lookup found nothing, v_ch came back null, and the null branch is the
--      same branch as "you may not see that channel". Reactions in a direct
--      message have never worked, in any build, and the button has been there
--      the whole time. public.message_reactions cannot hold the row either:
--      message_id is a foreign key onto public.messages and channel_id is NOT
--      NULL. So this needs a table, not a policy tweak.
--
--   2. Two people were made admins and nothing beside their names says so. No
--      surface in the client knows: get_bootstrap tells you whether YOU are an
--      admin and says nothing about anybody else, and the one place that tried
--      to work it out - the Members panel - reads public.member_roles directly,
--      which RLS hides from ordinary members. So the pill it draws is invisible
--      to exactly the people who need to know who to ask.
--
-- Both are additive. Nothing here changes an existing row or an existing
-- signature; the bootstrap gains two fields per member, and there is one new
-- table that only a SECURITY DEFINER function may write.

-- ============================================================================
-- 1. Reactions on a direct message
-- ============================================================================

-- Deliberately a second table rather than a nullable channel_id on the first.
-- message_reactions.message_id references public.messages(id) ON DELETE CASCADE,
-- and that cascade is the only thing that cleans reactions up when a message is
-- hard-deleted. A message id column that points at either of two tables cannot
-- carry a foreign key, so widening the existing table would trade a working
-- reaction for a permanent leak.
create table if not exists public.dm_message_reactions (
  message_id      uuid not null references public.dm_messages(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  emoji           text not null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists dm_reactions_msg_idx on public.dm_message_reactions (message_id);
create index if not exists dm_reactions_user_idx on public.dm_message_reactions (user_id);

alter table public.dm_message_reactions enable row level security;

-- Read: anyone in the conversation, the same predicate dm_messages itself uses.
-- Write: nobody. Every insert and delete goes through toggle_reaction below,
-- which is SECURITY DEFINER and does its own check, so the absence of an
-- INSERT/UPDATE/DELETE policy here is the point.
drop policy if exists dm_reactions_select on public.dm_message_reactions;
create policy dm_reactions_select on public.dm_message_reactions
  for select to authenticated
  using ((select private.is_conversation_member(conversation_id)));

grant select on public.dm_message_reactions to authenticated;

-- One RPC for both kinds of message, because the client has one reaction path.
-- js/core/messages.js toggleReaction() is shared by the channel, thread and DM
-- renderers and holds nothing but a message id; asking it to work out which
-- table that id lives in would mean threading a context argument through every
-- caller, including the ones that rebuild a row from cache.
create or replace function public.toggle_reaction(p_message uuid, p_emoji text)
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_ch    uuid;
  v_conv  uuid;
  v_added boolean;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  -- The column is bare text and always has been. A reaction is one grapheme or
  -- one :shortcode:; 64 bytes is generous for a ZWJ family sequence and stops
  -- the table being used as free storage.
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

  -- Not a channel message. Before this migration that fell straight into the
  -- 'forbidden' above, and that was the whole bug.
  select d.conversation_id into v_conv from public.dm_messages d where d.id = p_message;
  if v_conv is null then
    -- Same wording as an unreadable channel on purpose: whether a message id
    -- exists is not something a stranger gets to learn.
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not private.is_conversation_member(v_conv) then
    raise exception 'forbidden' using errcode = '42501';
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
  -- handler already listens for. The client side of this has been waiting.
  perform app.emit('dm:'||v_conv::text, 'reaction',
    jsonb_build_object('message_id', p_message, 'emoji', p_emoji,
                       'user_id', v_uid, 'added', v_added));
  return v_added;
end;
$fn$;

grant execute on function public.toggle_reaction(uuid, text) to authenticated;

-- ============================================================================
-- 2. Who is an admin, answerable by anybody in the Space
-- ============================================================================
--
-- An ordinary member cannot read public.member_roles or public.roles, and they
-- should not be able to: those rows carry the whole permission bitfield for the
-- Space. But "is this person an admin" is not a secret. It is the answer to
-- "who do I ask", which is the reason the badge was asked for in the first
-- place. This returns exactly that one bit per member, and nothing else.
create or replace function public.get_member_badges(p_workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_admins    uuid[];
  v_all_admin boolean;
  v_owner     uuid;
  v_out       jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;

  select coalesce(bool_or((r.permissions & (1::bigint << 40)) <> 0), false)
    into v_all_admin
    from public.roles r
   where r.workspace_id = p_workspace and r.is_everyone;

  select coalesce(array_agg(distinct mr.user_id), '{}'::uuid[])
    into v_admins
    from public.member_roles mr
    join public.roles r on r.id = mr.role_id
   where mr.workspace_id = p_workspace
     and r.workspace_id = p_workspace
     and not r.is_everyone
     and (r.permissions & (1::bigint << 40)) <> 0;

  select w.created_by into v_owner from public.workspaces w where w.id = p_workspace;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id',     wm.user_id,
           'member_type', wm.member_type,
           'is_admin',    v_all_admin or wm.user_id = any(v_admins),
           'is_owner',    v_owner is not null and wm.user_id = v_owner)), '[]'::jsonb)
    into v_out
    from public.workspace_members wm
   where wm.workspace_id = p_workspace;

  return v_out;
end;
$fn$;

grant execute on function public.get_member_badges(uuid) to authenticated;

-- ============================================================================
-- 3. get_bootstrap carries the badge on the first paint
-- ============================================================================
-- The same function, taken verbatim from the live definition, plus is_admin and
-- is_owner per member and is_owner on `me`. Reproduced in full rather than
-- patched because there is no other way to change a plpgsql body, and because a
-- badge that arrives one round trip after the names would repaint every row on
-- every cold start.

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
  v_admins   uuid[];
  v_all_admin boolean;
  v_owner    uuid;
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

  -- 0120: the three facts a name badge needs, computed once for the whole Space.
  -- ADMINISTRATOR is the bit that decides it, whatever the role is called locally.
  select coalesce(bool_or((r.permissions & (1::bigint << 40)) <> 0), false)
    into v_all_admin
    from public.roles r
   where r.workspace_id = p_workspace and r.is_everyone;

  select coalesce(array_agg(distinct mr.user_id), '{}'::uuid[])
    into v_admins
    from public.member_roles mr
    join public.roles r on r.id = mr.role_id
   where mr.workspace_id = p_workspace
     and r.workspace_id = p_workspace
     and not r.is_everyone
     and (r.permissions & (1::bigint << 40)) <> 0;

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
           'is_admin',     v_all_admin or wm.user_id = any(v_admins),
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

-- ============================================================================
-- 4. Account deletion sweeps the new table
-- ============================================================================
-- The DPDP runbook promises erasure leaves no per-user rows behind. A new
-- per-user table is a new way to break that promise, so it goes into the same
-- sweep as the one it sits beside.

CREATE OR REPLACE FUNCTION public.anonymize_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;

  update public.profiles set
    is_ghost     = true,
    display_name = 'Deleted User',
    username     = null,
    avatar_key   = null,
    pronouns     = null,
    status_text  = null,
    status_emoji = null,
    updated_at   = now()
  where id = v_uid;

  update public.messages set
    deleted_at  = coalesce(deleted_at, now()),
    body        = '{}'::jsonb,
    body_text   = '',
    attachments = '[]'::jsonb
  where author_id = v_uid;

  update public.dm_messages set
    deleted_at  = coalesce(deleted_at, now()),
    body        = '{}'::jsonb,
    body_text   = '',
    attachments = '[]'::jsonb
  where author_id = v_uid;

  -- additional per-user data that anonymize previously left behind
  delete from public.message_reactions    where user_id = v_uid;
  delete from public.dm_message_reactions where user_id = v_uid;
  delete from public.saved_items          where user_id = v_uid;
  delete from public.read_state           where user_id = v_uid;
  delete from public.notification_overrides where user_id = v_uid;
  delete from public.user_presence        where user_id = v_uid;

  -- mark uploads failed so app.sweep can delete the storage objects
  update public.attachments set status = 'failed' where uploader_id = v_uid;
end;
$function$
;
