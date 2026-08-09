-- Tasks, second pass: when work started, what is blocking it, and an append-only
-- record of everything anybody said about it.
--
-- WHAT IS ALREADY THERE AND IS NOT BEING CHANGED. Eight states with a proposal
-- round trip and a review round trip, a written reason when somebody is stuck, a
-- due date, and the message the ask came from. That is a better foundation than
-- most trackers ship with. Nothing here replaces any of it.
--
-- WHAT IS MISSING, AND WHY EACH ONE MATTERS.
--
-- started_at. Everything about forecasting turns on it. Without it the only
--   measurable interval is created_at to done_at, which is LEAD time - how long
--   the person waiting waited - and includes however many days the task sat in a
--   queue. Cycle time, the part somebody can actually influence, needs a start.
--   js/lib/forecast.js already reads started_at and falls back to created_at, so
--   this column improves the numbers without a client change.
--
-- priority. One glyph on the card. Deliberately five values and no more: every
--   tracker that allowed a custom priority scheme ended up with everything at
--   the top.
--
-- origin. The only way to ever answer "is the sentence parser helping". Compare
--   how often a parsed task is edited before it is accepted, and how often it is
--   deleted within an hour, against a hand-made one. Without this the question
--   of whether to add a model on top is unanswerable, which means it gets
--   answered by taste.
--
-- due_precision and due_string. js/lib/asks.js already works out whether the
--   person said a time or only a day, and throws it away. Somebody who wrote "by
--   Friday" and is shown "due Friday 12:00" is looking at a lunchtime deadline
--   that nobody set, and that is the moment they stop believing every other
--   parsed field too. Keeping the raw phrase is also what makes it possible to
--   answer "why does this say 3:30am".
--
-- task_events. The single biggest one. A mutable blocker_note cannot answer how
--   long something has been stuck, how many times the estimate has moved, or who
--   last touched it, and all three are inputs to escalation and to the forecast.
--
-- task_links. Blocked-on-a-person-or-a-thing is text. Blocked on ANOTHER TASK is
--   an edge, and once it is an edge you can ask who is at the end of the chain.

-- ---------------------------------------------------------------- columns
alter table public.tasks add column if not exists started_at    timestamptz;
alter table public.tasks add column if not exists priority      smallint not null default 0;
alter table public.tasks add column if not exists origin        text not null default 'manual';
alter table public.tasks add column if not exists due_precision text;
alter table public.tasks add column if not exists due_string    text;

-- 0 none, 1 low, 2 medium, 3 high, 4 urgent. Unset sorts LAST, not first: a
-- default of "no priority" that sorts to the top is how every list ends up
-- looking urgent.
alter table public.tasks drop constraint if exists tasks_priority_range;
alter table public.tasks add constraint tasks_priority_range check (priority between 0 and 4);

alter table public.tasks drop constraint if exists tasks_origin_known;
alter table public.tasks add constraint tasks_origin_known
  check (origin in ('manual', 'parsed', 'slash', 'import', 'external', 'bot'));

alter table public.tasks drop constraint if exists tasks_due_precision_known;
alter table public.tasks add constraint tasks_due_precision_known
  check (due_precision is null or due_precision in ('day', 'minute'));

-- Backfill: anything already finished must have a start, or every historical row
-- is invisible to the forecast. created_at is the honest fallback and is
-- explicitly lead time, which is what those rows have always measured.
update public.tasks set started_at = created_at
 where started_at is null and done_at is not null;

create index if not exists tasks_started_idx on public.tasks (workspace_id, started_at);
create index if not exists tasks_prio_idx    on public.tasks (workspace_id, priority desc, due_at);

-- ---------------------------------------------------------------- category
-- The single most portable idea in Jira, and it costs one function. Boards,
-- filters and roll-ups key off the CATEGORY and never off the state name, which
-- is what lets a Space rename "in review" to "with the doctor" without breaking
-- every count in the app.
create or replace function public.task_category(p_state text, p_done timestamptz)
returns text language sql immutable as $$
  select case
    when p_done is not null then 'closed'
    when p_state = 'proposed'    then 'triage'
    when p_state = 'accepted'    then 'todo'
    when p_state in ('in_progress', 'blocked', 'in_review') then 'doing'
    when p_state in ('done', 'rejected', 'cancelled') then 'closed'
    else 'todo' end
$$;

-- There is exactly ONE completion axis and it stays that way. Jira's Resolution
-- field is orthogonal to status, which is why a Jira issue can be Done and
-- Unresolved forever and why every team ends up maintaining a post-function on
-- every terminal transition. done_at plus the cancelled and rejected states
-- already say everything a second flag would.

-- ---------------------------------------------------------------- events
create table if not exists public.task_events (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id     uuid not null,
  kind         text not null check (kind in
                 ('progress','eta','blocked','unblocked','state','handoff','note','nudge')),
  from_state   text,
  to_state     text,
  eta_at       timestamptz,
  percent      smallint check (percent is null or percent between 0 and 100),
  note         text,
  -- Three kinds of blocker, because they need three different responses: chase a
  -- task, chase a person, or chase somebody outside who nobody here can chase.
  blocked_on_task     uuid references public.tasks(id) on delete set null,
  blocked_on_user     uuid,
  blocked_on_external text,
  source       text not null default 'ui' check (source in ('ui','parse','nudge_reply','bot','external')),
  created_at   timestamptz not null default now()
);
create index if not exists task_events_task_idx on public.task_events (task_id, created_at desc);
create index if not exists task_events_ws_idx   on public.task_events (workspace_id, created_at desc);

alter table public.task_events enable row level security;

-- Readable by anybody who can see the Space. Written only through the RPC below,
-- which is what keeps it append-only: there is no update policy and no delete
-- policy, on purpose. Asana's status updates are create-and-delete-only by
-- deliberate API design for the same reason - a history you can edit is not a
-- history.
drop policy if exists task_events_read on public.task_events;
create policy task_events_read on public.task_events for select
  using (exists (select 1 from public.workspace_members m
                  where m.workspace_id = task_events.workspace_id
                    and m.user_id = auth.uid()));

-- ---------------------------------------------------------------- links
create table if not exists public.task_links (
  from_task  uuid not null references public.tasks(id) on delete cascade,
  to_task    uuid not null references public.tasks(id) on delete cascade,
  kind       text not null check (kind in ('blocks','relates','duplicates')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  primary key (from_task, to_task, kind),
  -- A task blocking itself is a typo, and a chain query that meets one never
  -- terminates.
  check (from_task <> to_task)
);
create index if not exists task_links_to_idx on public.task_links (to_task) where cleared_at is null;

-- ONE row, always stored in the `blocks` direction, and "is blocked by" derived
-- by reading it backwards. Atlassian's own model documentation says link
-- direction is interpretable only at the interface and not at the API, so
-- storing both directions buys nothing and gives you two rows that can disagree.
alter table public.task_links enable row level security;
drop policy if exists task_links_read on public.task_links;
create policy task_links_read on public.task_links for select
  using (exists (select 1 from public.tasks t
                 join public.workspace_members m on m.workspace_id = t.workspace_id
                 where t.id = task_links.from_task and m.user_id = auth.uid()));

-- ---------------------------------------------------------------- post
create or replace function public.post_task_progress(
  p_task uuid, p_kind text, p_note text default null,
  p_eta_at timestamptz default null, p_percent smallint default null,
  p_blocked_on_task uuid default null, p_blocked_on_user uuid default null,
  p_blocked_on_external text default null)
returns public.task_events
language plpgsql security definer set search_path = public as $$
declare t public.tasks; ev public.task_events;
begin
  select * into t from public.tasks where id = p_task;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;

  if not exists (select 1 from public.workspace_members
                  where workspace_id = t.workspace_id and user_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.task_events (task_id, workspace_id, actor_id, kind, note, eta_at,
                                  percent, blocked_on_task, blocked_on_user, blocked_on_external)
  values (p_task, t.workspace_id, auth.uid(), p_kind, nullif(btrim(p_note), ''), p_eta_at,
          p_percent, p_blocked_on_task, p_blocked_on_user, nullif(btrim(p_blocked_on_external), ''))
  returning * into ev;

  -- The task keeps denormalised latest-values so the list render stays one query.
  -- The log is the history; these are the cover.
  if p_kind = 'blocked' then
    update public.tasks
       set state = 'blocked', blocker_note = coalesce(nullif(btrim(p_note), ''), blocker_note),
           blocked_at = now()
     where id = p_task;
    if p_blocked_on_task is not null then
      insert into public.task_links (from_task, to_task, kind, created_by)
      values (p_blocked_on_task, p_task, 'blocks', auth.uid())
      on conflict (from_task, to_task, kind) do update set cleared_at = null;
    end if;
  elsif p_kind = 'unblocked' then
    update public.tasks
       set state = case when state = 'blocked' then 'in_progress' else state end,
           blocked_at = null
     where id = p_task;
    update public.task_links set cleared_at = now()
     where to_task = p_task and kind = 'blocks' and cleared_at is null;
  elsif p_kind = 'progress' then
    -- Saying anything about a task IS starting it. Making people press a
    -- separate Start button first is how started_at ends up null on most rows,
    -- and a null started_at is a task the forecast cannot see.
    update public.tasks
       set started_at = coalesce(started_at, now()),
           state = case when state = 'accepted' then 'in_progress' else state end
     where id = p_task;
  end if;

  return ev;
end;
$$;

create or replace function public.list_task_events(p_task uuid)
returns setof public.task_events
language sql security definer set search_path = public stable as $$
  select e.* from public.task_events e
   where e.task_id = p_task
     and exists (select 1 from public.workspace_members m
                  where m.workspace_id = e.workspace_id and m.user_id = auth.uid())
   order by e.created_at asc
   limit 200;
$$;

-- ------------------------------------------------------- what is blocking what
-- The chain, not just the immediate blocker. "Waiting on Karthik" is useful;
-- "waiting on Karthik, who is waiting on the district office" is what actually
-- gets escalated, and it is the thing nobody can see without walking the graph.
create or replace function public.task_block_chain(p_task uuid, p_depth int default 5)
returns table (depth int, task_id uuid, title text, assignee_id uuid, state text, blocked_at timestamptz)
language sql security definer set search_path = public stable as $$
  with recursive chain as (
    select 0 as depth, t.id, t.title, t.assignee_id, t.state, t.blocked_at
      from public.tasks t where t.id = p_task
    union all
    select c.depth + 1, t.id, t.title, t.assignee_id, t.state, t.blocked_at
      from chain c
      join public.task_links l on l.to_task = c.id and l.kind = 'blocks' and l.cleared_at is null
      join public.tasks t on t.id = l.from_task
     where c.depth < p_depth
  )
  select c.depth, c.id, c.title, c.assignee_id, c.state, c.blocked_at
    from chain c
   where exists (select 1 from public.tasks t
                 join public.workspace_members m on m.workspace_id = t.workspace_id
                  where t.id = c.id and m.user_id = auth.uid());
$$;

-- ------------------------------------------------------------------ triage
-- Work with no owner. The proposed state already covers "somebody asked and it
-- needs a yes"; this is the other half - accepted work that nobody picked up,
-- which is where "can someone collect the receipts" lands and where it quietly
-- rots.
create or replace function public.list_triage(p_workspace uuid)
returns table (id uuid, title text, created_by uuid, created_at timestamptz,
               due_at timestamptz, channel_id uuid, priority smallint, age_days numeric)
language sql security definer set search_path = public stable as $$
  select t.id, t.title, t.created_by, t.created_at, t.due_at, t.channel_id, t.priority,
         round(extract(epoch from (now() - t.created_at)) / 86400, 1)
    from public.tasks t
   where t.workspace_id = p_workspace
     and t.assignee_id is null
     and t.done_at is null
     and t.state not in ('rejected', 'cancelled')
     and exists (select 1 from public.workspace_members m
                  where m.workspace_id = p_workspace and m.user_id = auth.uid())
   order by t.priority desc, t.due_at nulls last, t.created_at asc
   limit 200;
$$;

grant execute on function public.post_task_progress(uuid, text, text, timestamptz, smallint, uuid, uuid, text) to authenticated;
grant execute on function public.list_task_events(uuid) to authenticated;
grant execute on function public.task_block_chain(uuid, int) to authenticated;
grant execute on function public.list_triage(uuid) to authenticated;
grant execute on function public.task_category(text, timestamptz) to authenticated;

-- ------------------------------------------------------------------ NOTE
-- list_tasks must return the new columns or the client cannot use them. That
-- function is not in this repo, so it is not rewritten here. Add to its select
-- list: started_at, priority, origin, due_precision, due_string, and
-- task_category(state, done_at) as category. Everything the client does degrades
-- gracefully without them - the forecast falls back to created_at, the priority
-- glyph does not render - so this migration is safe to run before that edit.
