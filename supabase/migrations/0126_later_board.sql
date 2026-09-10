-- 0126_later_board.sql
--
-- Later is the fourth tab on every phone in this organisation and almost nobody
-- has ever used it. Eight tasks exist. Total. Across every workspace, since the
-- feature shipped.
--
-- It is not for want of machinery: tasks already have eight states, an assigner,
-- a reviewer, a blocker note, due dates, a triage queue and a nag job. The
-- machinery is not the problem. Three things are.
--
--   1. A TASK CANNOT BE CREATED. create_task takes p_message and raises
--      not_found without one, so the only way to make a task is to find a
--      message somebody already sent and convert it. A lead who wants to write
--      "call the twelve patients from Tuesday" has nowhere to type it. For a
--      project-management surface that is the whole game, and it was missing.
--
--   2. AN UNASSIGNED TASK CANNOT BE PICKED UP. update_task gates on
--      task_actor() being manager, assignee or creator - and an unassigned task
--      has no assignee, so an ordinary member looking at unclaimed work is none
--      of the three and can only look at it. "People can take them off" was not
--      possible.
--
--   3. THERE IS NO VIEW OF THE TEAM. list_tasks answers eight questions, every
--      one of them about the caller. A pod lead cannot ask who is carrying what,
--      which is the first question a lead has.
--
-- Nothing here changes an existing signature or an existing row.

-- ============================================================================
-- 1. Write a task down, without hunting for a message first
-- ============================================================================
--
-- It POSTS the task into the channel and hangs the task off that message,
-- rather than making message_id nullable.
--
-- That is a product decision, not a shortcut around the NOT NULL. This is a chat
-- app. Work that is assigned silently, in a list nobody has open, is work nobody
-- knows about - and every other part of this feature is built on the message:
-- jump-to-source, the saved_items row that puts it in somebody's Later, the
-- thread you argue about it in, quicktask. A task with no message would be a
-- second kind of task that half the app cannot show. So creating one says so out
-- loud, in the channel, where the team already looks.
create or replace function public.create_task_in_channel(
  p_channel  uuid,
  p_title    text,
  p_assignee uuid default null,
  p_due_at   timestamptz default null,
  p_note     text default null)
returns public.tasks language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_title text := btrim(coalesce(p_title, ''));
  v_who   text;
  v_line  text;
  v_msg   public.messages;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if v_title = '' then raise exception 'title_required' using errcode = '22023'; end if;
  if length(v_title) > 300 then raise exception 'title_too_long' using errcode = '22023'; end if;
  if not private.can_view_channel(p_channel) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not private.has_channel_perm(p_channel, 1) then     -- SEND
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The line that lands in the channel. Deliberately plain: it is read by
  -- volunteers on a phone, not parsed by anything.
  select coalesce(p.display_name, p.username::text) into v_who
    from public.profiles p where p.id = p_assignee;
  v_line := 'Task: ' || v_title
         || case when v_who is not null then ' - for ' || v_who else ' - anyone can pick this up' end
         || case when p_due_at is not null
                 then ', by ' || to_char(p_due_at at time zone 'Asia/Kolkata', 'FMDay FMDD FMMon')
                 else '' end;

  perform public.send_message(
    p_channel        := p_channel,
    p_client_msg_id  := util.uuidv7(),
    p_body           := '{}'::jsonb,
    p_body_text      := v_line,
    p_attachments    := '[]'::jsonb,
    p_mentions       := case when p_assignee is null then '{}'::uuid[] else array[p_assignee] end,
    p_mention_scope  := null,
    p_reply_to       := null,
    p_thread         := null,
    p_also_send      := false);

  select * into v_msg from public.messages
   where channel_id = p_channel and author_id = v_uid
   order by seq desc limit 1;
  if not found then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  -- One implementation of what a task IS. Every rule create_task enforces -
  -- who may assign whom, proposed vs accepted, the assignee's saved_items row,
  -- the notification, the rate limit - applies here unchanged because this is
  -- that function, called.
  return public.create_task(v_msg.id, v_title, p_assignee, p_due_at, p_note);
end;
$fn$;

grant execute on function public.create_task_in_channel(uuid, text, uuid, timestamptz, text) to authenticated;

-- ============================================================================
-- 2. Take an unclaimed task
-- ============================================================================
-- Deliberately its own function rather than a loosening of update_task. Update
-- is "change this task", and who may do that should stay narrow. This is one
-- specific act with one specific precondition - the task is NOT ASSIGNED TO
-- ANYBODY - and volunteering for unclaimed work is not an act that needs
-- permission from the person who wrote it down.
create or replace function public.claim_task(p_task uuid)
returns public.tasks language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_t   public.tasks;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_t from public.tasks where id = p_task;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.can_view_channel(v_t.channel_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- SEND, because taking work is participating in the channel. A read-only
  -- member of an announcement channel is not volunteering for anything.
  if not private.has_channel_perm(v_t.channel_id, 1) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Somebody already has it. Not an error worth a stack trace: two people
  -- tapping Claim in the same second is the ordinary case, and the loser should
  -- be told plainly rather than shown "forbidden".
  if v_t.assignee_id is not null then
    raise exception 'already_claimed' using errcode = '22023',
      hint = 'Somebody else picked this up first.';
  end if;
  if v_t.state in ('done', 'rejected', 'cancelled') or v_t.done_at is not null then
    raise exception 'task_closed' using errcode = '22023';
  end if;

  update public.tasks
     set assignee_id = v_uid,
         assigned_by = v_uid,
         -- Claimed, not started. "I will do this" and "I am doing this" are
         -- different facts and the board shows them in different places.
         state       = case when state = 'proposed' then 'accepted'::public.task_state else state end,
         state_since = now()
   where id = p_task
  returning * into v_t;

  -- The same saved_items row create_task writes for an assignee, so a claimed
  -- task reaches the claimer's Later list by the path everything else uses.
  insert into public.saved_items(user_id, message_id, state)
  values (v_uid, v_t.message_id, 'todo')
  on conflict (user_id, message_id) do nothing;

  perform app.emit('ch:'||v_t.channel_id::text, 'task_update',
    jsonb_build_object('task_id', v_t.id, 'action', 'claimed', 'by', v_uid));
  return v_t;
end;
$fn$;

grant execute on function public.claim_task(uuid) to authenticated;

-- ============================================================================
-- 3. Who is carrying what
-- ============================================================================
-- The first question a pod lead has, and list_tasks structurally cannot answer
-- it: every one of its eight filters is a question about the caller.
--
-- Visible to any member. Deliberately: a board whose whole point is "somebody
-- pick this up" cannot also be a secret, and the same rows are already readable
-- one at a time through list_tasks with filter 'all'. Only channels the CALLER
-- can see are counted, so a private channel does not leak through a total.
create or replace function public.team_workload(p_workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_out jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;

  with visible as (
    select t.*
      from public.tasks t
     where t.workspace_id = p_workspace
       and (select private.can_view_channel(t.channel_id))
       and t.state not in ('rejected', 'cancelled')
  ),
  per_person as (
    select v.assignee_id as user_id,
           count(*) filter (where v.done_at is null and v.state <> 'proposed')            as open,
           count(*) filter (where v.state = 'in_progress')                                as doing,
           count(*) filter (where v.state = 'blocked')                                    as blocked,
           count(*) filter (where v.done_at is null and v.due_at is not null
                              and v.due_at < now() and v.state <> 'proposed')             as overdue,
           count(*) filter (where v.done_at is not null and v.done_at > now() - interval '7 days')
                                                                                          as done_7d
      from visible v
     where v.assignee_id is not null
     group by v.assignee_id
  )
  select jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object(
                                 'user_id', p.user_id, 'open', p.open, 'doing', p.doing,
                                 'blocked', p.blocked, 'overdue', p.overdue, 'done_7d', p.done_7d)
                               order by p.overdue desc, p.blocked desc, p.open desc)
                          from per_person p), '[]'::jsonb),
    'unclaimed', (select count(*) from visible v
                   where v.assignee_id is null and v.done_at is null
                     and v.state in ('accepted', 'in_progress')),
    'blocked',   (select count(*) from visible v where v.state = 'blocked'),
    'overdue',   (select count(*) from visible v
                   where v.done_at is null and v.due_at is not null and v.due_at < now()
                     and v.state <> 'proposed'),
    'done_7d',   (select count(*) from visible v
                   where v.done_at is not null and v.done_at > now() - interval '7 days'))
    into v_out;

  return v_out;
end;
$fn$;

grant execute on function public.team_workload(uuid) to authenticated;

-- ============================================================================
-- 4. list_tasks learns 'unclaimed'
-- ============================================================================
-- The board's third column, and the only filter that describes work belonging
-- to nobody. Everything else in this function is unchanged from its live body.
create or replace function public.list_tasks(
  p_workspace uuid,
  p_filter text default 'mine',
  p_channel uuid default null,
  p_include_done boolean default false)
returns table(id uuid, workspace_id uuid, channel_id uuid, message_id uuid, title text,
              assignee_id uuid, created_by uuid, assigned_by uuid, reviewer_id uuid,
              state text, decision text, blocker_note text, blocked_at timestamptz,
              state_since timestamptz, note text, due_at timestamptz, done_at timestamptz,
              created_at timestamptz, channel_name text, body_text text)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_filter text := lower(coalesce(p_filter, 'mine'));
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not (select private.is_member(p_workspace)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_filter not in ('mine', 'assigned', 'requested', 'proposed', 'review',
                      'blocked', 'unclaimed', 'channel', 'all') then
    raise exception 'invalid_filter:%', v_filter using
      errcode = '22023',
      hint = 'mine, assigned, requested, proposed, review, blocked, unclaimed, channel or all.';
  end if;
  if v_filter = 'channel' and p_channel is null then
    raise exception 'channel_required' using errcode = '22023';
  end if;

  return query
  select t.id, t.workspace_id, t.channel_id, t.message_id, t.title,
         t.assignee_id, t.created_by, t.assigned_by, t.reviewer_id,
         t.state::text, t.decision, t.blocker_note, t.blocked_at, t.state_since, t.note,
         t.due_at, t.done_at, t.created_at,
         c.name::text, left(m.body_text, 240)
    from public.tasks t
    join public.channels c on c.id = t.channel_id
    left join public.messages m on m.id = t.message_id
   where t.workspace_id = p_workspace
     and (select private.can_view_channel(t.channel_id))
     and (p_channel is null or t.channel_id = p_channel)
     and case v_filter
           -- Work I hold. Proposals are not mine until somebody says yes.
           when 'mine'      then t.assignee_id = v_uid and t.state <> 'proposed'
           -- Linear has no assigner field and therefore cannot offer this view.
           when 'assigned'  then t.assigned_by = v_uid
           when 'requested' then t.created_by = v_uid
           -- The triage queue. Everything waiting on a decision here.
           when 'proposed'  then t.state = 'proposed'
                                 and (select private.can_triage(t.workspace_id, t.channel_id))
           when 'review'    then t.state = 'in_review'
                                 and (t.reviewer_id = v_uid
                                      or (select private.has_channel_perm(t.channel_id, 2)))
           -- Jira structurally cannot answer this: linkedIssues() takes one key,
           -- which is why Flagged = Impediment became the practical query.
           when 'blocked'   then t.state = 'blocked'
           -- NEW: work nobody has taken. The board's "up for grabs" column, and
           -- the only question here that is not about the caller.
           when 'unclaimed' then t.assignee_id is null
                                 and t.state in ('accepted', 'in_progress')
           when 'channel'   then true
           when 'all'       then true
           else t.assignee_id = v_uid
         end
     and (coalesce(p_include_done, false)
          or (t.done_at is null and t.state not in ('rejected', 'cancelled')))
   order by
     case when t.state = 'blocked' then 0 else 1 end,     -- stuck work first
     t.due_at nulls last, t.created_at;
end;
$fn$;

grant execute on function public.list_tasks(uuid, text, uuid, boolean) to authenticated;
