-- One place a message is created by the server rather than by a signed-in browser.
--
-- Extracted verbatim from app.dispatch_scheduled, which is the most complete of
-- the several hand-rolled copies in this database: it is the only one that locks
-- the channel row before reading last_seq, honours broadcast_mode, and writes the
-- channel_events row that the heal path reads. Anything that posts on behalf of
-- something that is not a browser session should call this.
--
-- It deliberately does NOT authorize. Authorization belongs to the caller,
-- because a scheduled message re-checks private.why_cannot_post for a human
-- author while an app checks token scopes instead. Two different questions.

create or replace function app.post_message(
  p_channel       uuid,
  p_author        uuid,
  p_body          jsonb,
  p_body_text     text,
  p_attachments   jsonb    default '[]'::jsonb,
  p_thread        uuid     default null,
  p_client_msg_id uuid     default null,
  p_mentions      uuid[]   default '{}'::uuid[]
) returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_ws uuid; v_bmode text; v_archived timestamptz;
  v_row public.messages; v_cmid uuid;
begin
  select workspace_id, broadcast_mode, archived_at
    into v_ws, v_bmode, v_archived
    from public.channels where id = p_channel;
  if v_ws is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_archived is not null then raise exception 'channel_archived' using errcode = '42501'; end if;

  v_cmid := coalesce(p_client_msg_id, util.uuidv7());

  -- The "for update" is the whole point of routing through here: two concurrent
  -- posters reading last_seq without it will both write the same seq.
  insert into public.messages(channel_id, workspace_id, thread_id, author_id, seq,
                              client_msg_id, body, body_text, attachments,
                              mention_user_ids, mention_scope)
  select p_channel, v_ws, p_thread, p_author, c.last_seq + 1,
         v_cmid, coalesce(p_body, '{}'::jsonb), coalesce(p_body_text, ''),
         coalesce(p_attachments, '[]'::jsonb),
         coalesce(p_mentions, '{}'::uuid[]), 'none'
  from public.channels c where c.id = p_channel for update
  on conflict (channel_id, author_id, client_msg_id) do nothing
  returning * into v_row;

  -- A retried call with the same client_msg_id is a replay, not an error. Hand
  -- back the id that already exists so a cron job that lost its response and
  -- retried does not double-post.
  if v_row.id is null then
    select * into v_row from public.messages
     where channel_id = p_channel
       and author_id is not distinct from p_author
       and client_msg_id = v_cmid;
    return v_row.id;
  end if;

  update public.channels
     set last_seq = v_row.seq, last_message_at = now()
   where id = p_channel;

  insert into public.channel_events(channel_id, workspace_id, seq, kind,
                                    message_id, actor_id, data)
  values (p_channel, v_ws, v_row.seq, 'msg', v_row.id, p_author, '{}'::jsonb);

  if v_bmode = 'full' then
    perform app.emit('ch:' || p_channel::text, 'msg', to_jsonb(v_row));
  else
    update public.channels set last_nudge_at = now()
     where id = p_channel
       and (last_nudge_at is null or last_nudge_at < now() - interval '2 seconds');
    if found then
      perform app.emit('ch:' || p_channel::text, 'nudge',
                       jsonb_build_object('last_seq', v_row.seq));
    end if;
  end if;

  return v_row.id;
end;
$fn$;

revoke all on function app.post_message(uuid, uuid, jsonb, text, jsonb, uuid, uuid, uuid[]) from public;
