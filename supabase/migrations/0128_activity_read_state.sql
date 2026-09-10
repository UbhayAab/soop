-- 0128_activity_read_state.sql
--
-- The Activity tab is a list you can read and nothing else. There is no unread
-- state on it at all: no dot, no way to say "I have seen that one", no way to
-- clear it, and no count on the tab itself - so the only way to make an item
-- stop nagging you is to open it, and the only way to know whether anything is
-- there is to open the tab and read the whole thing.
--
-- Three things this adds.
--
--   1. PER-ITEM READ STATE. Not a watermark. A watermark means seeing one thing
--      marks everything older read, which for somebody who opens the app twice a
--      day on a phone is the same as having no unread state: the one message
--      that was actually for them gets cleared by the four that were not.
--
--   2. A TAG IN A DIRECT MESSAGE IS A MENTION. dm_messages has no
--      mention_user_ids column - the channel table has one and the DM table
--      never did - so "@Neha can you take this" in a group DM was recorded as an
--      ordinary DM and read exactly like the other forty. It is filled by a
--      trigger rather than by editing send_dm, which lives outside this repo:
--      additive, and it backfills the rows that already exist.
--
--   3. FILTERS. get_activity returned everything or nothing. The whole point of
--      the tab for somebody who is not a power user is "show me only the things
--      that were addressed to me", and that was the one question it could not
--      answer.

-- ============================================================================
-- 1. A tag in a direct message
-- ============================================================================
alter table public.dm_messages
  add column if not exists mention_user_ids uuid[] not null default '{}';

create index if not exists dm_messages_mentions_idx
  on public.dm_messages using gin (mention_user_ids)
  where cardinality(mention_user_ids) > 0;

-- Which members of this conversation were named in this body.
--
-- Matches @username, because that is what the client inserts: the mention
-- autocomplete in js/core/composer.js puts `'@' + p.username` into the box, and
-- username is citext so the comparison is already case-insensitive. Display
-- names are deliberately NOT matched here - they contain spaces and emoji, they
-- are not unique, and a substring match on one would tag somebody every time
-- their first name appeared in a sentence.
create or replace function app.dm_mentions_in(p_conversation uuid, p_body text)
returns uuid[] language sql stable security definer set search_path = '' as $fn$
  select coalesce(array_agg(distinct cm.user_id), '{}'::uuid[])
    from public.conversation_members cm
    join public.profiles p on p.id = cm.user_id
   where cm.conversation_id = p_conversation
     and p.username is not null
     and coalesce(p_body, '') ~* ('(^|[^a-z0-9_.-])@' ||
           regexp_replace(p.username::text, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') ||
           '($|[^a-z0-9_.-])');
$fn$;

create or replace function app.fill_dm_mentions()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  -- Only when the client did not say. A future send_dm that fills the column
  -- itself must win over this.
  if new.mention_user_ids is null or cardinality(new.mention_user_ids) = 0 then
    new.mention_user_ids := app.dm_mentions_in(new.conversation_id, new.body_text);
  end if;
  return new;
end;
$fn$;

drop trigger if exists fill_dm_mentions on public.dm_messages;
create trigger fill_dm_mentions
  before insert or update of body_text on public.dm_messages
  for each row execute function app.fill_dm_mentions();

-- The conversations that already exist. Bounded to the last ninety days: a tag
-- from March is not something anybody needs surfaced as new today, and this runs
-- inside the migration.
update public.dm_messages d
   set mention_user_ids = app.dm_mentions_in(d.conversation_id, d.body_text)
 where d.deleted_at is null
   and d.created_at > now() - interval '90 days'
   and cardinality(d.mention_user_ids) = 0
   and d.body_text like '%@%';

-- ============================================================================
-- 2. Per-item read state
-- ============================================================================
-- Keyed by a TEXT item key rather than a message id, because one message can
-- produce several activity items - two people reacting to the same message of
-- yours is two things that happened, and marking one read must not clear the
-- other. get_activity below builds the same key.
create table if not exists public.activity_reads (
  user_id  uuid not null references auth.users(id) on delete cascade,
  item_key text not null,
  read_at  timestamptz not null default now(),
  primary key (user_id, item_key)
);
create index if not exists activity_reads_user_idx on public.activity_reads (user_id, read_at desc);

alter table public.activity_reads enable row level security;
drop policy if exists activity_reads_self on public.activity_reads;
create policy activity_reads_self on public.activity_reads
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select, insert, delete on public.activity_reads to authenticated;

-- ============================================================================
-- 3. get_activity: keys, read state, filters, and tasks
-- ============================================================================
-- p_filter is the question somebody is actually asking:
--   unread    the default, and the reason: the single most repeated complaint
--             about Slack's own version of this tab is that it does not default
--             to unread. Somebody opening a phone twice a day wants the things
--             they have not dealt with, not a scrollback.
--   all       everything below, read or not
--   mentions  somebody typed your name, in a channel or in a DM
--   dms       a direct message
--   tasks     work handed to you
--   replies   a reaction to something you wrote, or a reply in your thread
create or replace function public.get_activity(
  p_workspace uuid,
  p_limit integer default 50,
  p_filter text default 'unread')
returns table(kind text, channel_id uuid, message_id uuid, actor_id uuid,
              created_at timestamptz, snippet text, conversation_id uuid,
              item_key text, is_read boolean, task_id uuid, title text)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_f   text := lower(coalesce(p_filter, 'unread'));
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_f not in ('unread', 'all', 'mentions', 'dms', 'tasks', 'replies') then
    raise exception 'invalid_filter:%', v_f using errcode = '22023',
      hint = 'unread, all, mentions, dms, tasks or replies.';
  end if;

  return query
  with feed as (
    -- (a) somebody typed your name in a channel
    (
      select 'mention'::text as kind, m.channel_id, m.id as message_id,
             m.author_id as actor_id, m.created_at,
             left(m.body_text, 140) as snippet, null::uuid as conversation_id,
             null::uuid as task_id, null::text as title
      from public.messages m
      where m.workspace_id = p_workspace and m.deleted_at is null
        and m.mention_user_ids @> array[v_uid]::uuid[]
        and m.author_id is distinct from v_uid
        and (select private.can_view_channel(m.channel_id))
      order by m.created_at desc limit v_lim
    )
    union all
    -- (b) somebody reacted to something you wrote in a channel
    (
      select 'reaction'::text, m.channel_id, m.id, r.user_id, r.created_at,
             left(m.body_text, 140), null::uuid, null::uuid, null::text
      from public.message_reactions r
      join public.messages m on m.id = r.message_id
      where m.workspace_id = p_workspace and m.author_id = v_uid
        and m.deleted_at is null and r.user_id <> v_uid
        and (select private.can_view_channel(m.channel_id))
      order by r.created_at desc limit v_lim
    )
    union all
    -- (c) a reply in a thread you started, rooted or joined
    (
      select 'thread_reply'::text, m.channel_id, m.id, m.author_id, m.created_at,
             left(m.body_text, 140), null::uuid, null::uuid, null::text
      from public.messages m
      join public.threads t on t.id = m.thread_id
      left join public.messages root on root.id = t.root_message_id
      where m.workspace_id = p_workspace and m.thread_id is not null
        and m.deleted_at is null and m.author_id is distinct from v_uid
        and ( t.created_by = v_uid or root.author_id = v_uid
           or exists (select 1 from public.messages me
                       where me.thread_id = t.id and me.author_id = v_uid) )
        and (select private.can_view_channel(m.channel_id))
      order by m.created_at desc limit v_lim
    )
    union all
    -- (d) a direct message. Split in two so a TAG in a DM is its own thing: in a
    --     group DM "@Neha can you take this" is addressed to one person and the
    --     other forty messages are not, and reading them the same way is how the
    --     one that was for you gets lost.
    (
      select case when d.mention_user_ids @> array[v_uid]::uuid[]
                  then 'dm_mention'::text else 'dm'::text end,
             null::uuid, d.id, d.author_id, d.created_at,
             left(coalesce(nullif(btrim(d.body_text), ''),
                  case when jsonb_array_length(coalesce(d.attachments, '[]'::jsonb)) > 0
                       then '(attachment)' else '' end), 140),
             d.conversation_id, null::uuid, null::text
      from public.dm_messages d
      join public.conversations cv on cv.id = d.conversation_id
      join public.conversation_members cm
        on cm.conversation_id = d.conversation_id and cm.user_id = v_uid
      where cv.workspace_id = p_workspace and d.deleted_at is null
        and d.author_id is distinct from v_uid
      order by d.created_at desc limit v_lim
    )
    union all
    -- (e) a reaction on one of YOUR direct messages
    (
      select 'dm_reaction'::text, null::uuid, d.id, r.user_id, r.created_at,
             left(d.body_text, 140), d.conversation_id, null::uuid, null::text
      from public.dm_message_reactions r
      join public.dm_messages d on d.id = r.message_id
      join public.conversations cv on cv.id = d.conversation_id
      where cv.workspace_id = p_workspace and d.author_id = v_uid
        and d.deleted_at is null and r.user_id <> v_uid
        and (select private.is_conversation_member(d.conversation_id))
      order by r.created_at desc limit v_lim
    )
    union all
    -- (f) work somebody handed you. It already raises a push (create_task
    --     enqueues one) and it already lands in Later, and it was the one of the
    --     three that had nowhere to be seen in between.
    (
      select 'task'::text, t.channel_id, t.message_id,
             coalesce(t.assigned_by, t.created_by), t.created_at,
             left(t.title, 140), null::uuid, t.id, t.title
      from public.tasks t
      where t.workspace_id = p_workspace
        and t.assignee_id = v_uid
        and t.done_at is null
        and t.state not in ('proposed', 'rejected', 'cancelled')
        and coalesce(t.assigned_by, t.created_by) is distinct from v_uid
        and (select private.can_view_channel(t.channel_id))
      order by t.created_at desc limit v_lim
    )
  ),
  keyed as (
    select f.*,
           -- One message can produce several items: two people reacting to the
           -- same message of yours is two things. The actor is part of the key.
           f.kind || ':' || coalesce(f.message_id::text, f.task_id::text, '')
                  || ':' || coalesce(f.actor_id::text, '') as item_key
      from feed f
  )
  select k.kind, k.channel_id, k.message_id, k.actor_id, k.created_at, k.snippet,
         k.conversation_id, k.item_key, (ar.item_key is not null) as is_read,
         k.task_id, k.title
    from keyed k
    left join public.activity_reads ar
      on ar.user_id = v_uid and ar.item_key = k.item_key
   where case v_f
           when 'unread'   then ar.item_key is null
           when 'all'      then true
           when 'mentions' then k.kind in ('mention', 'dm_mention')
           when 'dms'      then k.kind in ('dm', 'dm_mention', 'dm_reaction')
           when 'tasks'    then k.kind = 'task'
           when 'replies'  then k.kind in ('reaction', 'thread_reply', 'dm_reaction')
           else true
         end
   order by k.created_at desc
   limit v_lim;
end;
$fn$;

grant execute on function public.get_activity(uuid, integer, text) to authenticated;

-- ============================================================================
-- 4. Marking one, or all
-- ============================================================================
-- The verb the tab did not have. Marking read is not opening: somebody scanning
-- a phone queue wants to clear the four that were not for them without visiting
-- four channels, and that is the whole reason a feed has a read state.
create or replace function public.mark_activity_read(p_keys text[], p_read boolean default true)
returns integer language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_n   integer := 0;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_keys is null or cardinality(p_keys) = 0 then return 0; end if;
  if cardinality(p_keys) > 200 then raise exception 'too_many' using errcode = '22023'; end if;

  if coalesce(p_read, true) then
    insert into public.activity_reads(user_id, item_key)
    select v_uid, k from unnest(p_keys) k
    on conflict (user_id, item_key) do nothing;
    get diagnostics v_n = row_count;
  else
    -- Marking something UNREAD again is half the point of a per-item read state:
    -- "I have seen it and I still have to do something about it" is a real
    -- answer and a watermark cannot express it.
    delete from public.activity_reads
     where user_id = v_uid and item_key = any(p_keys);
    get diagnostics v_n = row_count;
  end if;
  return v_n;
end;
$fn$;

grant execute on function public.mark_activity_read(text[], boolean) to authenticated;

create or replace function public.mark_all_activity_read(p_workspace uuid)
returns integer language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_n   integer := 0;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;
  -- Everything the feed would show right now, which is the honest meaning of
  -- "mark all read" - not "every item that has ever existed".
  insert into public.activity_reads(user_id, item_key)
  select v_uid, a.item_key from public.get_activity(p_workspace, 100, 'all') a
  on conflict (user_id, item_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

grant execute on function public.mark_all_activity_read(uuid) to authenticated;

-- The number on the tab. Cheap enough to ask on the same beat as the unread
-- rollup, and it is what turns Activity from a place you have to remember to
-- visit into one that tells you when it is worth visiting.
create or replace function public.activity_unread(p_workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_out jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;
  -- A REACTION NEVER MARKS THE TAB. It is in the feed, because seeing that
  -- somebody liked what you wrote is pleasant; it is not in either count,
  -- because nobody is waiting on you. Slack draws the same line and it is the
  -- cleanest thing about their model - the moment "somebody reacted" marks the
  -- tab as loudly as "somebody is waiting on you", the mark stops meaning
  -- anything, which is the state the tab was in here.
  select jsonb_build_object(
           'total',    count(*) filter (where not a.is_read
                                          and a.kind not in ('reaction', 'dm_reaction')),
           -- Addressed to you BY NAME. This is the number; everything else in
           -- `total` is worth a dot and no more.
           'mentions', count(*) filter (where not a.is_read and a.kind in ('mention', 'dm_mention')),
           'dms',      count(*) filter (where not a.is_read and a.kind in ('dm', 'dm_mention')),
           'tasks',    count(*) filter (where not a.is_read and a.kind = 'task'),
           -- Everything unread, reactions included, for the count inside the
           -- panel where "4 unread" should mean four rows.
           'in_feed',  count(*) filter (where not a.is_read))
    into v_out
    from public.get_activity(p_workspace, 100, 'all') a;
  return v_out;
end;
$fn$;

grant execute on function public.activity_unread(uuid) to authenticated;
