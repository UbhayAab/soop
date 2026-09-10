-- 0125_activity_includes_dms.sql
--
-- "The notification tab is right now not at all working, nothing is there."
--
-- It was not broken. It was correctly empty, which is worse, because there is
-- nothing to look at that says so. get_activity covered three things and all
-- three were about CHANNELS: mentions of you in a channel, reactions on your
-- channel messages, replies in a channel thread. Measured on the live database
-- before writing this: across every workspace and every message ever sent, 126
-- messages have contained a mention at all, and 116 of those name one person.
-- For everybody else the feed had, correctly, nothing in it.
--
-- Meanwhile the thing people actually use is direct messages, and a DM was not
-- in the feed at all - not the message, not a reaction on one. So the tab was
-- blank for exactly the people with the most waiting for them.
--
-- Two more legs, and one correction to an old one:
--
--   (d) a direct message somebody sent you. Every DM is about you by
--       construction, which is the whole argument for it being here.
--   (e) a reaction on one of YOUR direct messages. 0120 gave DM reactions a
--       table; this is the half that tells you one happened.
--   (b) reactions now also count the DM table, so the two kinds of reaction
--       behave the same way rather than one being invisible.
--
-- The shape of the return does not change: kind / channel_id / message_id /
-- actor_id / created_at / snippet, ordered newest first, one clamp on the limit.
-- The client keys off `kind`, and the two new ones carry channel_id = null,
-- which is how it knows to route to the conversation rather than a channel.

create or replace function public.get_activity(p_workspace uuid, p_limit integer default 50)
returns table(kind text, channel_id uuid, message_id uuid, actor_id uuid,
              created_at timestamptz, snippet text, conversation_id uuid)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 100);   -- clamp 1..100
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;

  return query
  with feed as (
    -- (a) mentions of the caller in a channel (never self-authored)
    (
      select 'mention'::text        as kind,
             m.channel_id           as channel_id,
             m.id                   as message_id,
             m.author_id            as actor_id,
             m.created_at           as created_at,
             left(m.body_text, 140) as snippet,
             null::uuid             as conversation_id
      from public.messages m
      where m.workspace_id = p_workspace
        and m.deleted_at is null
        and m.mention_user_ids @> array[v_uid]::uuid[]
        and m.author_id is distinct from v_uid
        and (select private.can_view_channel(m.channel_id))
      order by m.created_at desc
      limit v_lim
    )
    union all
    -- (b) reactions on the caller's own channel messages, by someone else
    (
      select 'reaction'::text, m.channel_id, m.id, r.user_id, r.created_at,
             left(m.body_text, 140), null::uuid
      from public.message_reactions r
      join public.messages m on m.id = r.message_id
      where m.workspace_id = p_workspace
        and m.author_id = v_uid
        and m.deleted_at is null
        and r.user_id <> v_uid
        and (select private.can_view_channel(m.channel_id))
      order by r.created_at desc
      limit v_lim
    )
    union all
    -- (c) replies by others in threads the caller started, rooted or joined
    (
      select 'thread_reply'::text, m.channel_id, m.id, m.author_id, m.created_at,
             left(m.body_text, 140), null::uuid
      from public.messages m
      join public.threads t on t.id = m.thread_id
      left join public.messages root on root.id = t.root_message_id
      where m.workspace_id = p_workspace
        and m.thread_id is not null
        and m.deleted_at is null
        and m.author_id is distinct from v_uid
        and ( t.created_by = v_uid
           or root.author_id = v_uid
           or exists (select 1 from public.messages me
                       where me.thread_id = t.id and me.author_id = v_uid) )
        and (select private.can_view_channel(m.channel_id))
      order by m.created_at desc
      limit v_lim
    )
    union all
    -- (d) NEW: a direct message somebody sent you, in this workspace's
    --     conversations. Membership of the conversation is the whole check;
    --     there is no channel to be allowed to see.
    (
      select 'dm'::text, null::uuid, d.id, d.author_id, d.created_at,
             left(coalesce(nullif(btrim(d.body_text), ''),
                           case when jsonb_array_length(coalesce(d.attachments, '[]'::jsonb)) > 0
                                then '(attachment)' else '' end), 140),
             d.conversation_id
      from public.dm_messages d
      join public.conversations cv on cv.id = d.conversation_id
      join public.conversation_members cm
        on cm.conversation_id = d.conversation_id and cm.user_id = v_uid
      where cv.workspace_id = p_workspace
        and d.deleted_at is null
        and d.author_id is distinct from v_uid
      order by d.created_at desc
      limit v_lim
    )
    union all
    -- (e) NEW: a reaction on one of YOUR direct messages. 0120 made these
    --     possible; without this leg they happen and nobody is ever told.
    (
      select 'dm_reaction'::text, null::uuid, d.id, r.user_id, r.created_at,
             left(d.body_text, 140), d.conversation_id
      from public.dm_message_reactions r
      join public.dm_messages d on d.id = r.message_id
      join public.conversations cv on cv.id = d.conversation_id
      where cv.workspace_id = p_workspace
        and d.author_id = v_uid
        and d.deleted_at is null
        and r.user_id <> v_uid
        and (select private.is_conversation_member(d.conversation_id))
      order by r.created_at desc
      limit v_lim
    )
  )
  select f.kind, f.channel_id, f.message_id, f.actor_id, f.created_at, f.snippet, f.conversation_id
  from feed f
  order by f.created_at desc
  limit v_lim;
end;
$fn$;

grant execute on function public.get_activity(uuid, integer) to authenticated;
