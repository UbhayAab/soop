-- 0124_push_drain_actually_sends.sql
--
-- Push notifications have never been delivered. Not "sometimes", not "on some
-- browsers" - never, since the day the sender was deployed.
--
-- The enqueue half is complete and always was: triggers on messages, DMs, tasks
-- and calls all call app.enqueue_notification, and 10,804 notifications have
-- gone into the pgmq queue. The drain half posts to the web-push Edge Function
-- every fifteen seconds. It authenticated with the PUBLISHABLE key, and that
-- function - correctly - refuses anything that is not the service role:
--
--   select status_code, count(*) from net._http_response group by 1;
--     403 | 1438      <- six hours' worth, one every fifteen seconds
--     (no other status code has ever been recorded)
--
-- It also sent `{}` as the body, while the function's contract is
-- {user_ids, title, body, url}. So even with the right credential it would have
-- sent nothing: the two halves were written to two different designs and never
-- met. 82 notifications are sitting in the queue with read_ct = 0, the oldest
-- from 25 August.
--
-- Three things wrong, three things fixed:
--
--   1. THE CREDENTIAL. Not by putting the service-role key in SQL - that is a
--      full-access credential and it would then live in a function body for the
--      sake of triggering a push. A dedicated secret (vault: push_drain_key,
--      function env: PUSH_DRAIN_SECRET) can do exactly one thing, and the
--      function now accepts it on the x-drain-key header.
--
--   2. THE BODY. This function resolves each queued notification into a real
--      title and body - who, where, and the first line of what they said -
--      because Postgres is where the message, the channel and the sender's name
--      already are. The Edge Function keeps its existing contract.
--
--   3. THE STALE ONES. "Somebody mentioned you sixteen days ago" is not a
--      notification, it is noise, and delivering 82 of them at once the moment
--      this is fixed would be worse than never delivering them. Anything older
--      than an hour is dropped on the way out.

-- ---------------------------------------------------------------------------
-- Resolve one queued notification into something a person can read.
-- ---------------------------------------------------------------------------
-- Returns null when the thing it refers to is gone (deleted message, deleted
-- channel), which the drain treats as "discard, do not retry".
create or replace function app.notification_content(p_msg jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_kind text := coalesce(p_msg->'payload'->>'kind', 'message');
  v_mid  uuid := nullif(p_msg->'payload'->>'message_id', '')::uuid;
  v_cid  uuid := nullif(p_msg->'payload'->>'channel_id', '')::uuid;
  v_conv uuid := nullif(p_msg->'payload'->>'conversation_id', '')::uuid;
  v_who  text;
  v_txt  text;
  v_name text;
begin
  if v_kind = 'dm' then
    select coalesce(p.display_name, p.username::text, 'Someone'),
           left(coalesce(nullif(btrim(d.body_text), ''),
                         case when jsonb_array_length(coalesce(d.attachments, '[]'::jsonb)) > 0
                              then 'Sent an attachment' else 'Sent a message' end), 140)
      into v_who, v_txt
      from public.dm_messages d
      left join public.profiles p on p.id = d.author_id
     where d.id = v_mid and d.deleted_at is null;
    if v_who is null then return null; end if;
    return jsonb_build_object(
      'title', v_who,
      'body',  v_txt,
      -- #/d/<conversation> is a route js/main.js only learned in this change.
      -- A notification you cannot tap through to is half a notification.
      'url',   './#/d/' || coalesce(v_conv::text, ''),
      'tag',   'dm:' || coalesce(v_conv::text, v_mid::text));
  end if;

  if v_kind in ('message', 'broadcast') or v_mid is not null then
    select coalesce(p.display_name, p.username::text, 'Someone'),
           left(coalesce(nullif(btrim(m.body_text), ''),
                         case when jsonb_array_length(coalesce(m.attachments, '[]'::jsonb)) > 0
                              then 'Sent an attachment' else 'Sent a message' end), 140),
           c.name::text
      into v_who, v_txt, v_name
      from public.messages m
      left join public.profiles p on p.id = m.author_id
      left join public.channels c on c.id = m.channel_id
     where m.id = v_mid and m.deleted_at is null;
    if v_who is null then return null; end if;
    return jsonb_build_object(
      'title', case when v_name is null then v_who else v_who || ' in #' || v_name end,
      'body',  v_txt,
      'url',   './#/c/' || coalesce(v_cid::text, ''),
      'tag',   'ch:' || coalesce(v_cid::text, v_mid::text));
  end if;

  -- Tasks, calls and anything added later. The payload is the only thing that
  -- knows what it means, so a generic line beats guessing wrong - and beats
  -- silently dropping it, which is what happened to all of them until now.
  return jsonb_build_object(
    'title', 'Dek',
    'body',  case v_kind
               when 'task_assigned' then 'A task was assigned to you'
               when 'task_due'      then 'A task is due'
               when 'call'          then 'Somebody is calling you'
               else 'You have a new notification' end,
    'url',   './',
    'tag',   v_kind);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- The drain.
-- ---------------------------------------------------------------------------
create or replace function app.drain_notifications()
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  v_key text;
  v_batch int := 60;
  r     record;
begin
  -- One drainer at a time. The cron fires every fifteen seconds and a slow batch
  -- must not overlap the next one.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('hearth_notif_drain')) then
    return;
  end if;

  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'push_drain_key';
  -- No key means the deploy is half done. Say so in the log rather than
  -- hammering the function with something it will refuse, which is exactly the
  -- failure this migration exists to end.
  if v_key is null then
    raise warning 'drain_notifications: vault secret push_drain_key is missing; not draining';
    return;
  end if;

  -- ONE claim, held in a temp table for the rest of the transaction. Reading the
  -- queue twice would claim two different batches - pgmq.read hides what it
  -- returns for vt seconds and bumps read_ct - so the second read would neither
  -- see nor be able to clean up the first.
  create temporary table if not exists _drain_batch (
    msg_id bigint primary key, user_id uuid, content jsonb, sendable boolean) on commit drop;
  delete from _drain_batch;

  insert into _drain_batch (msg_id, user_id, content, sendable)
  select q.msg_id,
         (q.message->>'user_id')::uuid,
         app.notification_content(q.message),
         -- Sendable is everything the queue exists for. The rest is dropped on
         -- the way out rather than retried: a message that has been deleted is
         -- never coming back, "somebody mentioned you sixteen days ago" is noise
         -- and not news, and a payload that has failed six times is not going to
         -- work on the seventh.
         app.notification_content(q.message) is not null
           and q.enqueued_at > now() - interval '1 hour'
           and q.read_ct <= 5
    from pgmq.read('notifications', 120, v_batch) q;

  -- Group identical notifications so ten people mentioned in one message cost
  -- one call rather than ten.
  for r in
    select content->>'title' as title, content->>'body' as body,
           content->>'url' as url, content->>'tag' as tag,
           array_agg(distinct user_id) as user_ids
      from _drain_batch
     where sendable and user_id is not null
     group by 1, 2, 3, 4
  loop
    perform net.http_post(
      url     := 'https://ybddogqphinruyunnuwx.supabase.co/functions/v1/web-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        -- The gateway wants a valid project key before the function is reached;
        -- the function itself is authorised by x-drain-key. The publishable key
        -- is client-safe and grants nothing here.
        'Authorization', 'Bearer sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD',
        'x-drain-key', v_key),
      body    := jsonb_build_object(
        'user_ids', to_jsonb(r.user_ids),
        'title',    r.title,
        'body',     r.body,
        'url',      r.url,
        'tag',      r.tag));
  end loop;

  -- Everything claimed leaves the queue, sent or discarded. pg_net is
  -- fire-and-forget, so there is no receipt to wait for - and a queue that only
  -- ever grows is how this reached 10,804 undelivered in the first place.
  perform pgmq.delete('notifications', array_agg(msg_id)) from _drain_batch;
end;
$fn$;
