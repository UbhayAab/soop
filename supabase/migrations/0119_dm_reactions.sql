-- Reactions in direct messages.
--
-- The smiley on a DM row has always been painted: js/core/messages.js builds a
-- DM row through the same buildMessage() a channel row uses, so the hover bar,
-- the quick-react buttons and the + picker were all offered. Pressing any of
-- them called toggle_reaction(), which resolves the message through
-- public.messages - and a DM lives in public.dm_messages, so the lookup found
-- nothing, v_ch stayed null and the function raised 'forbidden' (42501). What
-- the person saw was "not allowed to perform this action" on a button the app
-- had just shown them.
--
-- It cannot be fixed inside message_reactions: message_id there is a foreign
-- key to public.messages(id), channel_id is NOT NULL, and reactions_select gates
-- on can_view_channel(channel_id). A DM has none of those. So DM reactions get
-- their own table, keyed to dm_messages, gated on conversation membership, with
-- an RPC of the same shape as toggle_reaction. The channel path is untouched:
-- toggle_reaction is deliberately NOT redefined here, because its live body
-- post-dates the migrations in this repo and rewriting it blind would lose
-- whatever was added since.
--
-- Realtime: the delta is broadcast on dm:<conversation>, the topic openDM()
-- already subscribes to with a `reaction` handler (js/core/dms.js). The client
-- did not have to learn a new event; it only had to ask the right table and
-- call the right function (js/core/messages.js loadReactions / toggleReaction).
--
-- Known gap, deliberately left: anonymize_account (0016) deletes the caller's
-- rows from message_reactions and is not redefined here, for the same reason
-- toggle_reaction is not. A hard delete of the auth user cascades; an
-- anonymised-but-present account keeps emoji rows attached to a nameless id.
-- Add `delete from public.dm_message_reactions where user_id = v_uid` to
-- anonymize_account the next time that function is touched.

create table if not exists public.dm_message_reactions (
  message_id      uuid not null references public.dm_messages(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  emoji           text not null,
  -- Denormalised from dm_messages so the select policy is one membership
  -- test, the same shape as message_reactions.channel_id.
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists dm_reactions_msg_idx on public.dm_message_reactions (message_id);

alter table public.dm_message_reactions enable row level security;

-- Read: anyone in the conversation. Writes only through toggle_dm_reaction
-- (security definer), so there is no insert/update/delete policy at all -
-- deny-by-default, like every other write in this schema.
do $$ begin
  create policy dm_reactions_select on public.dm_message_reactions
    for select to authenticated
    using ((select private.is_conversation_member(conversation_id)));
exception when duplicate_object then null; end $$;

revoke all on public.dm_message_reactions from anon;
grant select on public.dm_message_reactions to authenticated;

-- Same contract as toggle_reaction: returns true when the reaction was added,
-- false when it was taken back. Same rate bucket too, so a person cannot get a
-- second allowance by reacting in DMs instead of channels.
create or replace function public.toggle_dm_reaction(p_message uuid, p_emoji text)
returns boolean
language plpgsql security definer set search_path to '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_conv  uuid;
  v_added boolean;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_emoji is null or length(p_emoji) < 1 or length(p_emoji) > 64 then
    raise exception 'invalid_emoji' using errcode = '22023';
  end if;

  -- Uniform 'forbidden' for a missing message, a deleted one, and one in a
  -- conversation the caller is not part of: the error must not say which.
  select m.conversation_id into v_conv
    from public.dm_messages m
   where m.id = p_message and m.deleted_at is null;
  if v_conv is null or not private.is_conversation_member(v_conv) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The personal-block rule send_dm applies (0013): somebody who has blocked
  -- you does not get your reactions either.
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
  if found then
    v_added := false;
  else
    insert into public.dm_message_reactions(message_id, user_id, emoji, conversation_id)
    values (p_message, v_uid, p_emoji, v_conv)
    on conflict do nothing;
    v_added := true;
  end if;

  perform app.emit('dm:' || v_conv::text, 'reaction',
    jsonb_build_object('message_id', p_message, 'emoji', p_emoji,
                       'user_id', v_uid, 'added', v_added,
                       'conversation_id', v_conv));
  return v_added;
end;
$fn$;

revoke all on function public.toggle_dm_reaction(uuid, text) from public, anon;
grant execute on function public.toggle_dm_reaction(uuid, text) to authenticated;
grant execute on function public.toggle_dm_reaction(uuid, text) to service_role;
