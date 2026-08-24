-- 0103 - task RPCs, exported from the live database so deploys stop drifting.
-- Exported 2026-08-23 via Management API. These are the definitions the
-- client has been calling blind since day one.

-- create_task
CREATE OR REPLACE FUNCTION public.create_task(p_message uuid, p_title text DEFAULT NULL::text, p_assignee uuid DEFAULT NULL::uuid, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_note text DEFAULT NULL::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_msg public.messages; v_task public.tasks; v_title text;
  v_state public.task_state; v_assignee uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_msg from public.messages where id = p_message and deleted_at is null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.can_view_channel(v_msg.channel_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.has_channel_perm(v_msg.channel_id, 1) then raise exception 'forbidden' using errcode = '42501'; end if;  -- SEND

  -- Fall back to the message text so "make this a task" is genuinely one tap.
  v_title := btrim(coalesce(nullif(btrim(coalesce(p_title, '')), ''), left(v_msg.body_text, 200)));
  if length(v_title) = 0 then v_title := 'Follow up'; end if;
  if length(v_title) > 300 then raise exception 'title_too_long' using errcode = '22023'; end if;

  v_assignee := p_assignee;
  if v_assignee is not null and not private.can_user_view_channel(v_assignee, v_msg.channel_id) then
    raise exception 'assignee_cannot_see_channel' using errcode = '22023';
  end if;

  if v_assignee is null or v_assignee = v_uid then
    -- Taking it yourself, or leaving it unassigned. Never gated.
    v_state := 'accepted';
  elsif private.can_assign_others(v_msg.workspace_id, v_msg.channel_id) then
    v_state := 'accepted';
  else
    -- The request. It is the same row, in a state that says a decision is owed.
    v_state := 'proposed';
  end if;

  perform private.rate_limit('task_create', v_uid, v_msg.channel_id, 30, interval '60 seconds');

  insert into public.tasks(workspace_id, channel_id, message_id, title, assignee_id, created_by,
                           due_at, state, assigned_by, note, state_since)
  values (v_msg.workspace_id, v_msg.channel_id, p_message, v_title, v_assignee, v_uid,
          p_due_at, v_state,
          case when v_state = 'accepted' and v_assignee is not null then v_uid end,
          nullif(btrim(coalesce(p_note, '')), ''), now())
  returning * into v_task;

  -- Only a real assignment reaches somebody's queue. A proposal is not work
  -- anybody has been given yet, and putting it in their Later list would be
  -- telling them to do something nobody has agreed to.
  if v_state = 'accepted' and v_assignee is not null then
    insert into public.saved_items(user_id, message_id, state)
    values (v_assignee, p_message, 'todo')
    on conflict (user_id, message_id) do nothing;
    perform app.emit('user:'||v_assignee::text, 'task_assigned',
      jsonb_build_object('task_id', v_task.id, 'message_id', p_message,
                         'channel_id', v_msg.channel_id, 'workspace_id', v_msg.workspace_id,
                         'title', v_title, 'due_at', p_due_at));
    if v_assignee <> v_uid then
      perform app.enqueue_notification(v_assignee,
        jsonb_build_object('kind', 'task_assigned', 'task_id', v_task.id, 'message_id', p_message,
                           'channel_id', v_msg.channel_id, 'workspace_id', v_msg.workspace_id));
    end if;
  end if;

  perform app.emit('ch:'||v_msg.channel_id::text, 'task_update',
    jsonb_build_object('task_id', v_task.id, 'action',
                       case when v_state = 'proposed' then 'proposed' else 'created' end));
  return v_task;
end;
$function$


-- decide_task
CREATE OR REPLACE FUNCTION public.decide_task(p_task uuid, p_decision text, p_assignee uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_t public.tasks; v_assignee uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_t from public.tasks where id = p_task;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_t.state <> 'proposed' then
    raise exception 'not_proposed' using
      errcode = '22023', hint = 'That task is not waiting for a decision.';
  end if;
  if p_decision not in ('accept', 'decline') then
    raise exception 'bad_decision' using errcode = '22023';
  end if;

  -- The person who asked can always withdraw their own request. Everything else
  -- needs the triage permission.
  if not (private.can_triage(v_t.workspace_id, v_t.channel_id)
          or (p_decision = 'decline' and v_t.created_by = v_uid)) then
    raise exception 'forbidden' using
      errcode = '42501', hint = 'Only somebody who can triage may decide on requested tasks.';
  end if;

  if p_decision = 'decline' then
    update public.tasks
       set state = 'rejected', decision = 'rejected', decided_by = v_uid, decided_at = now(),
           note = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), note), state_since = now()
     where id = p_task returning * into v_t;
    -- Tell the person who asked. A request that vanishes is worse than a no.
    if v_t.created_by is not null and v_t.created_by <> v_uid then
      perform app.enqueue_notification(v_t.created_by,
        jsonb_build_object('kind', 'task_declined', 'task_id', p_task,
                           'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id));
    end if;
  else
    v_assignee := coalesce(p_assignee, v_t.assignee_id);
    if v_assignee is null then
      raise exception 'assignee_required' using
        errcode = '22023', hint = 'Accepting a task means giving it to somebody.';
    end if;
    if not private.can_user_view_channel(v_assignee, v_t.channel_id) then
      raise exception 'assignee_cannot_see_channel' using errcode = '22023';
    end if;

    update public.tasks
       set state = 'accepted', assignee_id = v_assignee, assigned_by = v_uid,
           decided_by = v_uid, decided_at = now(), state_since = now()
     where id = p_task returning * into v_t;

    insert into public.saved_items(user_id, message_id, state)
    values (v_assignee, v_t.message_id, 'todo') on conflict (user_id, message_id) do nothing;
    perform app.emit('user:'||v_assignee::text, 'task_assigned',
      jsonb_build_object('task_id', p_task, 'message_id', v_t.message_id,
                         'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id,
                         'title', v_t.title, 'due_at', v_t.due_at));
    if v_assignee <> v_uid then
      perform app.enqueue_notification(v_assignee,
        jsonb_build_object('kind', 'task_assigned', 'task_id', p_task,
                           'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id));
    end if;
    -- And tell the person who asked that it happened.
    if v_t.created_by is not null and v_t.created_by not in (v_uid, v_assignee) then
      perform app.enqueue_notification(v_t.created_by,
        jsonb_build_object('kind', 'task_accepted', 'task_id', p_task,
                           'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id));
    end if;
  end if;

  perform app.emit('ch:'||v_t.channel_id::text, 'task_update',
    jsonb_build_object('task_id', p_task, 'action', p_decision));
  return v_t;
end;
$function$


-- delete_task
CREATE OR REPLACE FUNCTION public.delete_task(p_task uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_task public.tasks;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_task from public.tasks where id = p_task;
  if not found then return; end if;
  if not private.can_view_channel(v_task.channel_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_task.created_by is distinct from v_uid and not private.has_channel_perm(v_task.channel_id, 2) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.tasks where id = p_task;
  perform app.emit('ch:'||v_task.channel_id::text, 'task_update',
    jsonb_build_object('task_id', p_task, 'action', 'deleted'));
end;
$function$


-- later_add
CREATE OR REPLACE FUNCTION public.later_add(p_message uuid)
 RETURNS saved_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_ch uuid; v_row public.saved_items;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select channel_id into v_ch from public.messages where id = p_message;
  if v_ch is null or not private.can_view_channel(v_ch) then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.saved_items(user_id, message_id)
  values (v_uid, p_message)
  on conflict (user_id, message_id) do nothing;
  select * into v_row from public.saved_items where user_id = v_uid and message_id = p_message;
  return v_row;
end;
$function$


-- list_tasks
CREATE OR REPLACE FUNCTION public.list_tasks(p_workspace uuid, p_filter text DEFAULT 'mine'::text, p_channel uuid DEFAULT NULL::uuid, p_include_done boolean DEFAULT false)
 RETURNS TABLE(id uuid, workspace_id uuid, channel_id uuid, message_id uuid, title text, assignee_id uuid, created_by uuid, assigned_by uuid, reviewer_id uuid, state text, decision text, blocker_note text, blocked_at timestamp with time zone, state_since timestamp with time zone, note text, due_at timestamp with time zone, done_at timestamp with time zone, created_at timestamp with time zone, channel_name text, body_text text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_filter text := lower(coalesce(p_filter, 'mine'));
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not (select private.is_member(p_workspace)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_filter not in ('mine', 'assigned', 'requested', 'proposed', 'review',
                      'blocked', 'channel', 'all') then
    raise exception 'invalid_filter:%', v_filter using
      errcode = '22023',
      hint = 'mine, assigned, requested, proposed, review, blocked, channel or all.';
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
           when 'channel'   then true
           when 'all'       then true
           else t.assignee_id = v_uid
         end
     and (coalesce(p_include_done, false)
          or (t.done_at is null and t.state not in ('rejected', 'cancelled')))
   order by
     case when t.state = 'blocked' then 0 else 1 end,     -- stuck work first
     t.due_at nulls last, t.created_at
   limit 300;
end;
$function$


-- my_capabilities
CREATE OR REPLACE FUNCTION public.my_capabilities(p_workspace uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when not (select private.is_member(p_workspace)) then null else
    (select jsonb_object_agg(a.key, private.policy_allows(a.key, p_workspace)
                                    and (a.bit is null or private.has_perm(p_workspace, a.bit)))
       from public.policy_actions a)
    || jsonb_build_object(
         'perms', private.member_perms(p_workspace)::text,
         'is_admin', private.role_exempt(p_workspace),
         'is_org_admin', private.is_org_admin(
           (select w.org_id from public.workspaces w where w.id = p_workspace)))
  end;
$function$


-- remind_me
CREATE OR REPLACE FUNCTION public.remind_me(p_message uuid, p_remind_at timestamp with time zone, p_note text DEFAULT NULL::text)
 RETURNS reminders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_ch uuid; v_ws uuid; v_row public.reminders;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_remind_at is null then raise exception 'invalid_remind_at' using errcode = '22023'; end if;
  select channel_id, workspace_id into v_ch, v_ws from public.messages where id = p_message;
  if v_ch is null or not private.can_view_channel(v_ch) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.rate_limit('remind', v_uid, null, 30, interval '60 seconds');
  insert into public.reminders(user_id, message_id, channel_id, workspace_id, remind_at, note)
  values (v_uid, p_message, v_ch, v_ws, p_remind_at, p_note)
  returning * into v_row;
  return v_row;
end;
$function$


-- review_task
CREATE OR REPLACE FUNCTION public.review_task(p_task uuid, p_verdict text, p_note text DEFAULT NULL::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_t public.tasks;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_t from public.tasks where id = p_task;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_t.state <> 'in_review' then
    raise exception 'not_in_review' using errcode = '22023';
  end if;
  if p_verdict not in ('approved', 'changes_requested', 'rejected') then
    raise exception 'bad_verdict' using errcode = '22023';
  end if;

  -- The named reviewer, or anybody who can manage messages there. Never the
  -- assignee reviewing their own work, unless they were named as the reviewer
  -- too, which only happens when a manager assigned it to themselves.
  if not (v_t.reviewer_id = v_uid or private.has_channel_perm(v_t.channel_id, 2)) then
    raise exception 'forbidden' using
      errcode = '42501', hint = 'Only the reviewer can decide on this.';
  end if;
  if v_t.assignee_id = v_uid and v_t.reviewer_id is distinct from v_uid then
    raise exception 'cannot_review_own' using
      errcode = '42501', hint = 'Somebody other than you has to look at this.';
  end if;

  update public.tasks
     set decision   = p_verdict,
         decided_by = v_uid,
         decided_at = now(),
         note       = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note),
         state      = case p_verdict
                        when 'approved'          then 'done'::public.task_state
                        when 'rejected'          then 'rejected'::public.task_state
                        else 'in_progress'::public.task_state end,
         -- Only approval finishes it. changes_requested and rejected leave
         -- done_at null on purpose.
         done_at    = case when p_verdict = 'approved' then now() else null end,
         done_by    = case when p_verdict = 'approved' then v_uid else null end,
         state_since = now()
   where id = p_task
  returning * into v_t;

  if v_t.assignee_id is not null then
    update public.saved_items
       set state = case when v_t.done_at is not null then 'done' else 'todo' end
     where user_id = v_t.assignee_id and message_id = v_t.message_id;
    if v_t.assignee_id <> v_uid then
      perform app.enqueue_notification(v_t.assignee_id,
        jsonb_build_object('kind', 'task_reviewed', 'task_id', p_task, 'verdict', p_verdict,
                           'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id));
    end if;
  end if;

  perform app.emit('ch:'||v_t.channel_id::text, 'task_update',
    jsonb_build_object('task_id', p_task, 'action', 'reviewed', 'verdict', p_verdict));
  return v_t;
end;
$function$


-- schedule_message
CREATE OR REPLACE FUNCTION public.schedule_message(p_channel uuid, p_body_text text, p_deliver_at timestamp with time zone, p_mentions uuid[] DEFAULT '{}'::uuid[])
 RETURNS scheduled_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_ws uuid; v_row public.scheduled_messages; v_mentions uuid[];
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select workspace_id into v_ws from public.channels where id = p_channel;
  if v_ws is null or not private.can_view_channel(p_channel) then raise exception 'forbidden' using errcode = '42501'; end if;
  -- CHANGED: channel-resolved SEND.
  if not private.has_channel_perm(p_channel, 1) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_deliver_at is null then raise exception 'invalid_deliver_at' using errcode = '22023'; end if;
  if length(coalesce(p_body_text, '')) > 8000 then raise exception 'body_too_long' using errcode = '22023'; end if;
  v_mentions := (select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_mentions, '{}')) x);
  if coalesce(array_length(v_mentions, 1), 0) > 50 then raise exception 'too_many_mentions' using errcode = '22023'; end if;
  perform private.rate_limit('schedule', v_uid, p_channel, 30, interval '10 seconds');

  insert into public.scheduled_messages(channel_id, workspace_id, author_id, body, body_text, attachments, mentions, deliver_at)
  values (p_channel, v_ws, v_uid, jsonb_build_object('text', coalesce(p_body_text, '')),
          coalesce(p_body_text, ''), '[]'::jsonb, v_mentions, p_deliver_at)
  returning * into v_row;
  return v_row;
end;
$function$


-- set_task_done
CREATE OR REPLACE FUNCTION public.set_task_done(p_task uuid, p_done boolean DEFAULT true, p_force boolean DEFAULT false)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_t public.tasks; v_actor text;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_t from public.tasks where id = p_task;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.can_view_channel(v_t.channel_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_actor := private.task_actor(v_t);
  if v_actor not in ('manager', 'assignee', 'creator') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if coalesce(p_done, true) then
    if v_t.state = 'blocked' and not coalesce(p_force, false) then
      raise exception 'blocked_not_cleared' using
        errcode = '22023',
        hint = 'This is still marked blocked. Clear the blocker, or say you meant it.';
    end if;
    if v_t.state = 'in_review' and v_actor = 'assignee'
       and v_t.reviewer_id is not null and v_t.reviewer_id <> v_uid then
      -- Jira ships this as a Separation of Duties condition. It is free here.
      raise exception 'awaiting_review' using
        errcode = '42501',
        hint = 'Somebody else is reviewing this. They close it.';
    end if;
  end if;

  update public.tasks
     set done_at    = case when coalesce(p_done, true) then now() else null end,
         done_by    = case when coalesce(p_done, true) then v_uid else null end,
         -- Atomic. Jira's most notorious configuration footgun is a resolution
         -- set by a post function an admin can forget, which produces items that
         -- are closed and unresolved at once.
         state      = case when coalesce(p_done, true) then 'done'::public.task_state
                           else 'in_progress'::public.task_state end,
         decision   = case when coalesce(p_done, true) then decision else null end,
         prev_state = null, blocker_note = null, blocked_at = null,
         state_since = now()
   where id = p_task
  returning * into v_t;

  if v_t.assignee_id is not null then
    update public.saved_items
       set state = case when v_t.done_at is not null then 'done' else 'todo' end
     where user_id = v_t.assignee_id and message_id = v_t.message_id;
  end if;

  if v_t.done_at is not null and v_t.assigned_by is not null and v_t.assigned_by <> v_uid then
    perform app.enqueue_notification(v_t.assigned_by,
      jsonb_build_object('kind', 'task_done', 'task_id', p_task,
                         'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id));
  end if;

  perform app.emit('ch:'||v_t.channel_id::text, 'task_update',
    jsonb_build_object('task_id', p_task,
                       'action', case when v_t.done_at is not null then 'done' else 'reopened' end));
  return v_t;
end;
$function$


-- set_task_state
CREATE OR REPLACE FUNCTION public.set_task_state(p_task uuid, p_state text, p_note text DEFAULT NULL::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_t public.tasks; v_actor text; v_next public.task_state; v_note text;
  -- Its own variable. The first draft reused v_uid as the notify loop's
  -- iterator, which overwrote the caller's identity halfway through the function
  -- and made every check after that point answer for whoever was last notified.
  v_tell uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_t from public.tasks where id = p_task;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.can_view_channel(v_t.channel_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_actor := private.task_actor(v_t);
  v_note := nullif(btrim(coalesce(p_note, '')), '');

  -- Only the people holding the work may move it: its assignee, whoever made
  -- it, or somebody who can manage messages in that channel.
  if v_actor not in ('manager', 'assignee', 'creator') then
    raise exception 'forbidden' using
      errcode = '42501', hint = 'Only the person doing this task, or a manager, can move it.';
  end if;

  if p_state = 'blocked' then
    if v_note is null then
      raise exception 'blocker_note_required' using
        errcode = '22023',
        hint = 'Say what you are stuck on. A blocked task nobody can act on is just a stalled one.';
    end if;
    if v_t.state in ('done', 'rejected', 'cancelled') then
      raise exception 'already_finished' using errcode = '22023';
    end if;
    update public.tasks
       set prev_state = case when state = 'blocked' then prev_state else state end,
           state = 'blocked', blocker_note = v_note, blocked_at = coalesce(blocked_at, now()),
           state_since = now()
     where id = p_task returning * into v_t;

    -- Tell whoever handed it over, and whoever asked for it. A blocker nobody
    -- hears about is the failure mode this whole flow exists to prevent.
    for v_tell in select distinct u from unnest(array[v_t.assigned_by, v_t.created_by]) u
                   where u is not null and u <> v_uid
    loop
      perform app.enqueue_notification(v_tell,
        jsonb_build_object('kind', 'task_blocked', 'task_id', p_task,
                           'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id));
    end loop;

  elsif p_state = 'unblocked' then
    if v_t.state <> 'blocked' then
      raise exception 'not_blocked' using errcode = '22023';
    end if;
    update public.tasks
       set state = coalesce(prev_state, 'in_progress'), prev_state = null,
           blocker_note = null, blocked_at = null, state_since = now()
     where id = p_task returning * into v_t;

  elsif p_state in ('accepted', 'in_progress', 'in_review', 'cancelled') then
    v_next := p_state::public.task_state;
    if v_t.state in ('done', 'rejected') and v_next <> 'in_progress' then
      raise exception 'already_finished' using
        errcode = '22023', hint = 'Reopen it first.';
    end if;
    -- Cancelling is a manager's call, or the maker of the task withdrawing it.
    if v_next = 'cancelled' and v_actor not in ('manager', 'creator') then
      raise exception 'forbidden' using
        errcode = '42501', hint = 'Only a manager, or whoever made it, can cancel a task.';
    end if;
    update public.tasks
       set state = v_next,
           prev_state = null, blocker_note = null, blocked_at = null,
           done_at = case when v_next = 'in_progress' then null else done_at end,
           done_by = case when v_next = 'in_progress' then null else done_by end,
           reviewer_id = case when v_next = 'in_review'
                              then coalesce(reviewer_id, assigned_by, created_by) else reviewer_id end,
           note = coalesce(v_note, note),
           state_since = now()
     where id = p_task returning * into v_t;

    if v_next = 'in_review' and v_t.reviewer_id is not null and v_t.reviewer_id <> (select auth.uid()) then
      perform app.enqueue_notification(v_t.reviewer_id,
        jsonb_build_object('kind', 'task_in_review', 'task_id', p_task,
                           'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id));
    end if;
  else
    raise exception 'bad_state:%', p_state using
      errcode = '22023',
      hint = 'Use set_task_done to finish one, and review_task to approve it.';
  end if;

  if v_t.assignee_id is not null then
    update public.saved_items
       set state = case when v_t.state = 'done' then 'done' else 'todo' end
     where user_id = v_t.assignee_id and message_id = v_t.message_id;
  end if;

  perform app.emit('ch:'||v_t.channel_id::text, 'task_update',
    jsonb_build_object('task_id', p_task, 'action', p_state));
  return v_t;
end;
$function$


-- update_task
CREATE OR REPLACE FUNCTION public.update_task(p_task uuid, p_title text DEFAULT NULL::text, p_assignee uuid DEFAULT NULL::uuid, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_clear_due boolean DEFAULT false, p_clear_assignee boolean DEFAULT false)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_t public.tasks; v_old uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_t from public.tasks where id = p_task;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.can_view_channel(v_t.channel_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if private.task_actor(v_t) not in ('manager', 'assignee', 'creator') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_old := v_t.assignee_id;

  -- Handing it to somebody else is the gated act, wherever it happens. Handing
  -- it to yourself, or letting it go, is not.
  if p_assignee is not null and p_assignee is distinct from v_old and p_assignee <> v_uid
     and not private.can_assign_others(v_t.workspace_id, v_t.channel_id) then
    raise exception 'policy_forbidden:task.assign_other' using
      errcode = '42501',
      hint = 'Your organisation only lets certain people hand tasks to others. You can ask for it instead.';
  end if;
  if p_assignee is not null and not private.can_user_view_channel(p_assignee, v_t.channel_id) then
    raise exception 'assignee_cannot_see_channel' using errcode = '22023';
  end if;
  if p_title is not null and length(btrim(p_title)) > 300 then
    raise exception 'title_too_long' using errcode = '22023';
  end if;

  update public.tasks
     set title       = coalesce(nullif(btrim(coalesce(p_title, '')), ''), title),
         assignee_id = case when p_clear_assignee then null else coalesce(p_assignee, assignee_id) end,
         assigned_by = case when p_assignee is not null and p_assignee is distinct from v_old
                            then v_uid else assigned_by end,
         due_at      = case when p_clear_due then null else coalesce(p_due_at, due_at) end
   where id = p_task
  returning * into v_t;

  -- Both ends of a reassignment hear about it. Only telling the new person is
  -- how somebody keeps a task in their list that is no longer theirs.
  if v_t.assignee_id is distinct from v_old then
    if v_t.assignee_id is not null then
      insert into public.saved_items(user_id, message_id, state)
      values (v_t.assignee_id, v_t.message_id, 'todo') on conflict (user_id, message_id) do nothing;
      if v_t.assignee_id <> v_uid then
        perform app.enqueue_notification(v_t.assignee_id,
          jsonb_build_object('kind', 'task_assigned', 'task_id', p_task,
                             'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id));
      end if;
    end if;
    if v_old is not null and v_old <> v_uid then
      perform app.enqueue_notification(v_old,
        jsonb_build_object('kind', 'task_unassigned', 'task_id', p_task,
                           'channel_id', v_t.channel_id, 'workspace_id', v_t.workspace_id));
    end if;
  end if;

  perform app.emit('ch:'||v_t.channel_id::text, 'task_update',
    jsonb_build_object('task_id', p_task, 'action', 'updated'));
  return v_t;
end;
$function$


