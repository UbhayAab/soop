-- 0119 - direct calls: ringing one person (or two) the way a phone does.
--
-- Voice ROOMS already existed: a door in the sidebar you walk through, where
-- somebody may or may not be standing on the other side. That is the wrong shape
-- for "I need Priya, now". Nobody sits in a room waiting to be found, so the
-- rooms went unused for one-to-one work and both organisations kept picking up
-- WhatsApp for the thing this app could already carry.
--
-- What a call is, that a room is not:
--   - it names a person rather than a place,
--   - it RINGS on their device whether or not they are looking at Dek,
--   - it has a beginning, an answer or a refusal, and an end you can point at.
--
-- WHY THE SIGNALLING GOES THROUGH THESE FUNCTIONS AND NOT STRAIGHT OVER
-- REALTIME. Voice rooms broadcast SDP and ICE client-to-client on vc:<channel>,
-- which works because everyone in that room has already joined that topic. A
-- direct call has no such topic, and inventing one (call:<id>) would need a new
-- RLS policy on realtime.messages - a policy this repo cannot see, let alone
-- verify. EFFICIENCY.md rank 5 already refused a change for exactly that reason:
-- if the policy is wrong, calls fail to connect with NO error surface anywhere.
-- So every signal is relayed by call_signal() below and delivered on user:<uid>,
-- the per-person topic that provably works today (task_assigned, claims_changed
-- and every DM notification ride it). It costs an HTTP round trip per signal,
-- which is why the client batches ICE candidates; for two people that is a few
-- dozen requests once, at the start of a call, and nothing at all after that.
--
-- The table is not bookkeeping for its own sake. It is the authorisation: without
-- a row saying these two people are in the same call, call_signal() would be an
-- open relay letting any signed-in account push arbitrary payloads at any other
-- account's browser.

-- ---------------------------------------------------------------- tables

create table if not exists public.calls (
  id              uuid primary key default util.uuidv7(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  -- Always anchored to a conversation. That is the whole permission model: you
  -- may ring the people you may already message, and create_dm() has decided who
  -- those are for years. No second, subtly different answer to "may I contact
  -- this person".
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_by      uuid not null references public.profiles(id),
  state           text not null default 'ringing'
                    check (state in ('ringing', 'live', 'ended')),
  started_at      timestamptz not null default now(),
  answered_at     timestamptz,
  ended_at        timestamptz,
  end_reason      text
);

-- One index, for the only two questions ever asked of this table: "is this
-- person in a call right now" (answer_call, the busy check, reload recovery) and
-- "what is stale". Both are state-first.
create index if not exists calls_live_idx on public.calls (state, started_at)
  where state <> 'ended';

create table if not exists public.call_participants (
  call_id   uuid not null references public.calls(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  -- caller  : started it
  -- ringing : their device is being rung
  -- joined  : answered, and is in the audio
  -- declined: said no
  -- missed  : nobody picked up before the ring expired
  -- busy    : already in another call, so their phone never rang
  -- left    : was in, hung up, the call carried on without them
  state     text not null default 'ringing'
              check (state in ('caller', 'ringing', 'joined', 'declined',
                               'missed', 'busy', 'left')),
  joined_at timestamptz,
  left_at   timestamptz,
  -- Liveness. A closed laptop leaves a 'joined' row behind, and every later call
  -- would then see that person as busy forever with nothing on any screen to
  -- explain it. The client beats every 25s; anything past 90s is gone.
  beat_at   timestamptz not null default now(),
  primary key (call_id, user_id)
);

create index if not exists call_participants_user_idx
  on public.call_participants (user_id, state);

-- Reachable only through the security-definer RPCs below, same as the apps
-- tables in 0112: RLS on with no policy is the leanest correct answer.
alter table public.calls             enable row level security;
alter table public.call_participants enable row level security;

-- ---------------------------------------------------------------- helpers

-- Nobody rings forever, and a call whose participants' browsers were killed is
-- not a call. Called at the head of the RPCs that care rather than from a cron:
-- the cost is one indexed update over a handful of live rows, and it means the
-- answer to "are you busy" is never wrong because a sweeper was late.
create or replace function private.reap_calls()
returns void language plpgsql security definer set search_path to '' as $fn$
begin
  update public.calls c
     set state = 'ended', ended_at = now(), end_reason = 'missed'
   where c.state = 'ringing' and c.started_at < now() - interval '90 seconds';

  update public.calls c
     set state = 'ended', ended_at = now(), end_reason = 'dropped'
   where c.state = 'live'
     and not exists (select 1 from public.call_participants p
                      where p.call_id = c.id and p.state = 'joined'
                        and p.beat_at > now() - interval '90 seconds');
end;
$fn$;

-- Is this person already on a call? Used to answer with 'busy' rather than
-- ringing a phone that is against somebody's ear.
create or replace function private.call_busy(p_user uuid)
returns boolean language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.call_participants p
      join public.calls c on c.id = p.call_id
     where p.user_id = p_user
       and c.state <> 'ended'
       and p.state in ('caller', 'ringing', 'joined')
       and p.beat_at > now() - interval '90 seconds');
$fn$;

-- The shape every client paints from. One place decides what a call looks like
-- on the wire, so the ring, the state change and the reload recovery can never
-- disagree about it.
create or replace function private.call_json(p_call uuid)
returns jsonb language sql stable security definer set search_path to '' as $fn$
  select jsonb_build_object(
    'call_id',         c.id,
    'conversation_id', c.conversation_id,
    'workspace_id',    c.workspace_id,
    'created_by',      c.created_by,
    'state',           c.state,
    'started_at',      c.started_at,
    'answered_at',     c.answered_at,
    'ended_at',        c.ended_at,
    'end_reason',      c.end_reason,
    'participants',    coalesce((
      select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'state', p.state)
                       order by p.user_id)
        from public.call_participants p where p.call_id = c.id), '[]'::jsonb))
  from public.calls c where c.id = p_call;
$fn$;

-- Tell everybody in a call what just happened to it. Their own devices included:
-- somebody who answers on their phone needs the laptop to stop ringing, and that
-- is the same event rather than a special case.
create or replace function private.call_fanout(p_call uuid, p_event text)
returns void language plpgsql security definer set search_path to '' as $fn$
declare v_json jsonb; r record;
begin
  v_json := private.call_json(p_call);
  for r in select user_id from public.call_participants where call_id = p_call loop
    perform app.emit('user:' || r.user_id::text, p_event, v_json);
  end loop;
end;
$fn$;

-- ---------------------------------------------------------------- start

-- A mesh with no SFU. Two people is one connection each way; three is two
-- uploads apiece and already the honest edge of what a phone on Indian mobile
-- data carries. Past that the answer is a voice room, which is built for it.
create or replace function public.start_call(p_conversation uuid)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_conv public.conversations;
  v_call uuid;
  v_ids  uuid[];
  v_rang int := 0;
  v_busy boolean;
  r      record;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;

  perform private.reap_calls();

  select * into v_conv from public.conversations where id = p_conversation;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.conversation_members
                  where conversation_id = p_conversation and user_id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select array_agg(user_id) into v_ids
    from public.conversation_members
   where conversation_id = p_conversation and user_id <> v_uid;
  if v_ids is null or array_length(v_ids, 1) = 0 then
    raise exception 'nobody_to_call' using errcode = '22023';
  end if;
  -- Three total. Raised as a named error the client can turn into a sentence,
  -- rather than silently calling the first two people in the group.
  if array_length(v_ids, 1) > 2 then
    raise exception 'group_too_big' using errcode = '22023';
  end if;

  -- Ringing from a device that is already in a call is a refusal, not a second
  -- call nobody can hear.
  if private.call_busy(v_uid) then
    raise exception 'already_in_call' using errcode = '22023';
  end if;

  perform private.rate_limit('call_start', v_uid, p_conversation, 12, interval '5 minutes');

  insert into public.calls (workspace_id, conversation_id, created_by)
  values (v_conv.workspace_id, p_conversation, v_uid)
  returning id into v_call;

  insert into public.call_participants (call_id, user_id, state, joined_at)
  values (v_call, v_uid, 'caller', now());

  for r in select unnest(v_ids) as uid loop
    v_busy := private.call_busy(r.uid);
    insert into public.call_participants (call_id, user_id, state)
    values (v_call, r.uid, case when v_busy then 'busy' else 'ringing' end);
    if not v_busy then v_rang := v_rang + 1; end if;
  end loop;

  -- Everyone was busy: end it here rather than leaving the caller listening to a
  -- ringback that can never be answered.
  if v_rang = 0 then
    update public.calls set state = 'ended', ended_at = now(), end_reason = 'busy'
     where id = v_call;
  end if;

  -- 'call_ring' rather than 'call_state' for the people being rung, because the
  -- two mean completely different things to a client: one starts a ringtone, the
  -- other repaints a call already on screen.
  for r in select user_id, state from public.call_participants where call_id = v_call loop
    if r.state = 'ringing' then
      perform app.emit('user:' || r.user_id::text, 'call_ring', private.call_json(v_call));
      -- Web push is drained by a scheduled job, so it will not make a phone ring
      -- inside the 45 seconds this call is alive. It is queued anyway: what
      -- arrives afterwards is the "you were called" notice, which is worth having.
      perform app.enqueue_notification(r.user_id,
        jsonb_build_object('kind', 'call_ring', 'call_id', v_call,
                           'conversation_id', p_conversation,
                           'workspace_id', v_conv.workspace_id, 'from', v_uid));
    else
      perform app.emit('user:' || r.user_id::text, 'call_state', private.call_json(v_call));
    end if;
  end loop;

  return private.call_json(v_call);
end;
$fn$;

-- ---------------------------------------------------------------- answer

-- Conditional on the row still ringing, which is what makes two of your own
-- devices racing to answer safe: the second one updates nothing and is told the
-- call is already live somewhere else.
create or replace function public.answer_call(p_call uuid)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_uid uuid := (select auth.uid()); v_ok boolean;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;

  update public.call_participants
     set state = 'joined', joined_at = now(), beat_at = now()
   where call_id = p_call and user_id = v_uid and state = 'ringing'
     and exists (select 1 from public.calls c
                  where c.id = p_call and c.state in ('ringing', 'live'))
  returning true into v_ok;
  if not coalesce(v_ok, false) then raise exception 'call_gone' using errcode = '22023'; end if;

  update public.calls
     set state = 'live', answered_at = coalesce(answered_at, now())
   where id = p_call and state = 'ringing';

  perform private.call_fanout(p_call, 'call_state');
  return private.call_json(p_call);
end;
$fn$;

-- ---------------------------------------------------------------- decline / end

-- Declining is not ending: in a three-way call one person saying no leaves the
-- other two talking. The call dies only when there is nobody left to ring and
-- nobody left to talk to.
create or replace function public.decline_call(p_call uuid, p_reason text default 'declined')
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_uid uuid := (select auth.uid()); v_left int; v_creator uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select created_by into v_creator from public.calls where id = p_call;
  if v_creator is null then raise exception 'not_found' using errcode = 'P0002'; end if;

  update public.call_participants
     set state = case when p_reason = 'missed' then 'missed' else 'declined' end,
         left_at = now()
   where call_id = p_call and user_id = v_uid and state = 'ringing';

  select count(*) into v_left from public.call_participants
   where call_id = p_call and state in ('ringing', 'joined') and user_id <> v_creator;

  if v_left = 0 then
    update public.calls
       set state = 'ended', ended_at = now(),
           end_reason = case when state = 'ringing'
                             then case when p_reason = 'missed' then 'missed' else 'declined' end
                             else 'ended' end
     where id = p_call and state <> 'ended';
  end if;

  perform private.call_fanout(p_call, 'call_state');
  return private.call_json(p_call);
end;
$fn$;

-- Hanging up. The caller hanging up ends it for everybody; anybody else hanging
-- up leaves, and it ends when there is only one person left in the room.
create or replace function public.end_call(p_call uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_uid uuid := (select auth.uid()); v_call public.calls; v_in int;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_call from public.calls where id = p_call;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.call_participants
                  where call_id = p_call and user_id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.call_participants
     set state = 'left', left_at = now()
   where call_id = p_call and user_id = v_uid and state in ('caller', 'joined', 'ringing');

  select count(*) into v_in from public.call_participants
   where call_id = p_call and state in ('ringing', 'joined');

  if v_uid = v_call.created_by or v_in <= 1 then
    update public.calls
       set state = 'ended', ended_at = now(),
           end_reason = coalesce(p_reason,
             case when v_call.state = 'ringing' then 'cancelled' else 'ended' end)
     where id = p_call and state <> 'ended';
    update public.call_participants
       set state = 'left', left_at = coalesce(left_at, now())
     where call_id = p_call and state in ('caller', 'ringing', 'joined');
  end if;

  perform private.call_fanout(p_call, 'call_state');
  return private.call_json(p_call);
end;
$fn$;

-- ---------------------------------------------------------------- signalling

-- The relay. Everything this function is for is in the two checks: the sender
-- must be in this call, and the recipient must be in the same one. Without them
-- it is an open channel from any account to any other account's browser.
--
-- The payload is passed through untouched and is never interpreted here. It is
-- SDP and ICE, which only the two browsers can make sense of; a database that
-- tried to validate it would be wrong the first time a browser shipped a new
-- codec. It is capped instead, because an uncapped passthrough is a way to push
-- a megabyte at somebody's phone.
create or replace function public.call_signal(p_call uuid, p_to uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path to '' as $fn$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if length(p_payload::text) > 65536 then
    raise exception 'payload_too_big' using errcode = '22023';
  end if;
  if not exists (select 1 from public.calls c
                  join public.call_participants me  on me.call_id = c.id and me.user_id = v_uid
                  join public.call_participants you on you.call_id = c.id and you.user_id = p_to
                 where c.id = p_call and c.state <> 'ended') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform app.emit('user:' || p_to::text, 'call_signal',
    jsonb_build_object('call_id', p_call, 'from', v_uid, 'payload', p_payload));
end;
$fn$;

-- ---------------------------------------------------------------- liveness

create or replace function public.call_heartbeat(p_call uuid)
returns void language sql security definer set search_path to '' as $fn$
  update public.call_participants set beat_at = now()
   where call_id = p_call and user_id = (select auth.uid())
     and state in ('caller', 'joined');
$fn$;

-- Reload recovery. A refresh mid-call otherwise means the call is simply gone
-- from that browser while the other side hears silence and waits.
create or replace function public.get_active_call()
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_uid uuid := (select auth.uid()); v_call uuid;
begin
  if v_uid is null then return null; end if;
  perform private.reap_calls();
  select c.id into v_call
    from public.calls c
    join public.call_participants p on p.call_id = c.id and p.user_id = v_uid
   where c.state <> 'ended' and p.state in ('caller', 'ringing', 'joined')
   order by c.started_at desc limit 1;
  if v_call is null then return null; end if;
  return private.call_json(v_call);
end;
$fn$;

-- ---------------------------------------------------------------- grants

grant execute on function public.start_call(uuid)               to authenticated;
grant execute on function public.answer_call(uuid)              to authenticated;
grant execute on function public.decline_call(uuid, text)       to authenticated;
grant execute on function public.end_call(uuid, text)           to authenticated;
grant execute on function public.call_signal(uuid, uuid, jsonb) to authenticated;
grant execute on function public.call_heartbeat(uuid)           to authenticated;
grant execute on function public.get_active_call()              to authenticated;
