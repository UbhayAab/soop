-- 0127_org_form_templates.sql
--
-- Reported by the person who runs the org: "If I make an organisation-level
-- form - say a Leave Request Form - why can't I just import it when I am in
-- some other channel of some other server of the same organisation? Right now I
-- have to make it in one channel, then the second channel, then the third; then
-- if I change server I have to make it again."
--
-- That is literally true today. public.create_form is the only way a form comes
-- into existence and it takes a channel, so a Leave Request that four Spaces
-- need is four hand-retyped builders. Retyped, not copied: nothing anywhere
-- carries the questions from one channel to the next, so the four copies drift
-- apart within a month and the answers stop being comparable at all.
--
-- WHY A TEMPLATE PLUS A COPY, AND NOT ONE SHARED DEF
--
-- public.form_submissions carries a composite foreign key
-- (form_id, workspace_id) -> public.form_defs(id, workspace_id). A submission
-- is therefore pinned to one Space by the schema itself, and a single form_def
-- shared across Spaces is not representable without tearing that key out and
-- re-deriving tenancy on every read of every submission. So the org-level thing
-- is a TEMPLATE - questions, no channel, no answers - and importing it makes a
-- real form_defs row in the target channel, stamped with template_id.
--
-- The copy is not a fork, because private.normalise_form_fields keys fields
-- positionally as f1..fN. Two copies of one template therefore produce answer
-- objects with identical keys, so aggregating by template_id compares like with
-- like across every Space in the org. That is what public.template_responses
-- below exists to do, and it is the whole payoff of the copy.
--
-- Every existing RPC - get_form, submit_form, list_forms, close_form,
-- list_form_submissions - keeps working untouched, because an imported form is
-- an ordinary form. Nothing here changes a signature or an existing row.
--
-- Shape is the apps precedent (0112 / 0113): an org-level table with RLS on and
-- NO policy, reachable only through security-definer RPCs, and the same
-- cross-tenant refusal install_app carries.

-- ============================================================================
-- 1. The org-level template
-- ============================================================================
create table if not exists public.form_templates (
  id          uuid primary key default util.uuidv7(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  title       text not null,
  description text,
  fields      jsonb not null default '[]'::jsonb,
  multi       boolean not null default false,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  -- Bumped by update_form_template, and the sort key the picker orders on: the
  -- template somebody fixed this morning is the one being looked for.
  updated_at  timestamptz not null default now(),
  -- Retire rather than delete. A template with fifty imported copies is the
  -- only thing linking those copies to each other, so deleting the row would
  -- silently un-relate answers that are still being collected.
  archived_at timestamptz
);

create index if not exists form_templates_org_idx
  on public.form_templates (org_id) where archived_at is null;

-- RLS on with no policy at all, exactly as public.apps is: clients get nothing
-- directly and there is no column grant to get subtly wrong later.
alter table public.form_templates enable row level security;

-- Nullable and additive: every form that exists today keeps working and simply
-- has no template. Partial index because the overwhelming majority of rows are
-- and will remain hand-made one-offs.
alter table public.form_defs
  add column if not exists template_id uuid references public.form_templates(id) on delete set null;

create index if not exists form_defs_template_idx
  on public.form_defs (template_id) where template_id is not null;

-- ============================================================================
-- 2. Authoring a template (org admin)
-- ============================================================================
-- Org admin, not Space admin, because the whole complaint is that the thing is
-- per-channel when the organisation is the level it actually lives at. Fields
-- go through private.normalise_form_fields so a template can never hold a shape
-- create_form would later refuse - the import would fail at the far end, in
-- somebody else's Space, weeks after the mistake was made.
create or replace function public.create_form_template(
  p_org uuid, p_title text, p_desc text, p_fields jsonb, p_multi boolean default false
) returns public.form_templates
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_title text;
  v_out   public.form_templates;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  v_title := btrim(coalesce(p_title, ''));
  if length(v_title) = 0 then raise exception 'invalid_title' using errcode = '22023'; end if;
  if length(v_title) > 200 then raise exception 'title_too_long' using errcode = '22023'; end if;
  if length(coalesce(p_desc, '')) > 4000 then
    raise exception 'description_too_long' using errcode = '22023';
  end if;

  perform private.rate_limit('form_template', v_uid, p_org, 20, interval '60 seconds');

  insert into public.form_templates (org_id, title, description, fields, multi, created_by)
  values (p_org, v_title, nullif(btrim(coalesce(p_desc, '')), ''),
          private.normalise_form_fields(p_fields), coalesce(p_multi, false), v_uid)
  returning * into v_out;
  return v_out;
end;
$fn$;

-- Null means "leave this alone", so a caller can rename a template without
-- resending the questions. An empty string in p_desc clears the description,
-- which is the only way to say "there is no explanation at all" through a
-- signature where null already means unchanged.
--
-- Editing a template does NOT reach into copies that are already posted. It
-- cannot: people are mid-answer in those channels, and rewriting question 3
-- under them would leave answers keyed to a question nobody was asked. The next
-- import picks up the new version.
create or replace function public.update_form_template(
  p_template uuid, p_title text default null, p_desc text default null,
  p_fields jsonb default null, p_multi boolean default null
) returns public.form_templates
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_org   uuid;
  v_title text;
  v_out   public.form_templates;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select org_id into v_org from public.form_templates where id = p_template;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  if p_title is not null then
    v_title := btrim(p_title);
    if length(v_title) = 0 then raise exception 'invalid_title' using errcode = '22023'; end if;
    if length(v_title) > 200 then raise exception 'title_too_long' using errcode = '22023'; end if;
  end if;
  if length(coalesce(p_desc, '')) > 4000 then
    raise exception 'description_too_long' using errcode = '22023';
  end if;

  update public.form_templates
     set title       = coalesce(v_title, title),
         description = case when p_desc is null then description
                            else nullif(btrim(p_desc), '') end,
         fields      = case when p_fields is null then fields
                            else private.normalise_form_fields(p_fields) end,
         multi       = coalesce(p_multi, multi),
         updated_at  = now()
   where id = p_template
  returning * into v_out;
  return v_out;
end;
$fn$;

create or replace function public.archive_form_template(
  p_template uuid, p_archived boolean default true
) returns public.form_templates
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid;
  v_out public.form_templates;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select org_id into v_org from public.form_templates where id = p_template;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  -- Copies already posted are deliberately left open. Retiring the template
  -- stops it spreading further; it does not close a form somebody is answering.
  update public.form_templates
     set archived_at = case when coalesce(p_archived, true) then now() else null end,
         updated_at  = now()
   where id = p_template
  returning * into v_out;
  return v_out;
end;
$fn$;

-- ============================================================================
-- 3. Finding one
-- ============================================================================
-- Gated on org MEMBER, not org admin. An ordinary lead running a channel is
-- exactly the person who needs to import a Leave Request, and gating the search
-- on admin would leave them back where they started, retyping it. Authoring is
-- the privileged act; finding what already exists is not.
--
-- Searches title, description and the creator, because the second half of the
-- report asks for it in those words ("maybe by form ID or form name and created
-- by"), and takes a raw uuid, because the id is what gets pasted into a chat
-- when one person tells another which form they mean. The cast is defensive:
-- everything else typed into that box is free text, and a bare ::uuid on it
-- would turn a search for "leave" into 22P02 instead of an answer.
--
-- LIKE metacharacters are neutralised the way admin_search_members does it, so
-- a title with a literal % or _ in it is searchable at all. total is counted
-- before the slice, so the caller can say "showing 50 of 312" honestly rather
-- than guessing from a short page.
create or replace function public.search_form_templates(
  p_org uuid, p_query text default null, p_limit int default 50, p_offset int default 0
) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_q      text;
  v_pat    text;
  v_id     uuid;
  v_limit  int;
  v_offset int;
  v_total  int;
  v_rows   jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_limit, 50) < 1 then raise exception 'invalid_limit' using errcode = '22023'; end if;
  if coalesce(p_offset, 0) < 0 then raise exception 'invalid_offset' using errcode = '22023'; end if;

  v_limit  := least(coalesce(p_limit, 50), 200);
  -- Clamped so offset + limit can never leave int4 and answer 22003 instead of
  -- an empty page, the same overflow admin_search_members was fixed for.
  v_offset := least(coalesce(p_offset, 0), 1000000000);
  v_q      := nullif(btrim(coalesce(p_query, '')), '');
  v_pat    := case when v_q is null then null
                   else '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  begin
    v_id := v_q::uuid;
  exception when others then v_id := null;
  end;

  with base as (
    select t.id, t.title, t.description, t.fields, t.multi,
           t.created_by, t.created_at, t.updated_at,
           coalesce(p.display_name, p.username::text) as created_by_name
      from public.form_templates t
      left join public.profiles p on p.id = t.created_by
     where t.org_id = p_org
       and t.archived_at is null
       and ( v_pat is null
             or (v_id is not null and t.id = v_id)
             or t.title ilike v_pat escape '\'
             or coalesce(t.description, '') ilike v_pat escape '\'
             or coalesce(p.display_name, '') ilike v_pat escape '\'
             or coalesce(p.username::text, '') ilike v_pat escape '\' )
  ),
  counted as (select count(*)::int as n from base),
  page as (
    select row_number() over (order by b.updated_at desc, b.id desc) as ord, b.*
      from base b
     order by b.updated_at desc, b.id desc
     offset v_offset limit v_limit
  )
  select (select n from counted),
         coalesce((select jsonb_agg(jsonb_build_object(
           'id', pg.id, 'title', pg.title, 'description', pg.description,
           'fields', pg.fields, 'multi', pg.multi,
           'created_by', pg.created_by, 'created_by_name', pg.created_by_name,
           'created_at', pg.created_at, 'updated_at', pg.updated_at,
           -- How many channels already run this. The single most useful number
           -- in the picker: it is the difference between "the form everyone
           -- uses" and "a draft somebody left here in March".
           'used_count', (select count(*) from public.form_defs f where f.template_id = pg.id)
         ) order by pg.ord) from page pg), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', coalesce(v_total, 0), 'rows', v_rows);
end;
$fn$;

-- ============================================================================
-- 4. The import
-- ============================================================================
-- The answer to the report, and the only new write path.
--
-- It calls public.create_form rather than repeating its body. That is not
-- tidiness: create_form owns the channel gate, the title and description
-- limits, the field normalisation, the rate limit, the message it posts into
-- the channel and the form_update broadcast the card listens on. A second copy
-- of all that would be a second thing to keep in step, and the form posted by
-- an import would drift from the form posted by the composer button - a
-- different message body, a different realtime event, a card that never
-- repaints.
--
-- Everything specific to importing happens BEFORE that call, so nothing is
-- written and no message is posted if the import is going to be refused.
create or replace function public.import_form_template(
  p_template uuid, p_channel uuid
) returns public.form_defs
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_t      public.form_templates;
  v_ws     uuid;
  v_ws_org uuid;
  v_form   public.form_defs;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;

  select * into v_t from public.form_templates where id = p_template;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_t.archived_at is not null then
    raise exception 'archived' using errcode = '22023',
      hint = 'This organisation form has been retired. An organisation admin can bring it back.';
  end if;

  select workspace_id into v_ws from public.channels where id = p_channel;
  if v_ws is null or not private.can_view_channel(p_channel) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not private.has_channel_perm(p_channel, 1) then      -- SEND
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The cross-tenant line install_app carries, for the same reason: an org
  -- admin of one organisation is an ordinary member somewhere else, and a
  -- template must not be able to walk into a Space that belongs to a different
  -- organisation just because the caller can post there.
  select org_id into v_ws_org from public.workspaces where id = v_ws;
  if v_ws_org is distinct from v_t.org_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Two live copies of the same form in one channel means two piles of answers
  -- that nobody merges and half the team filling in the wrong one. A CLOSED
  -- copy is fine and is not blocked: that is last quarter's round, and running
  -- it again is the ordinary reason to import the same template twice.
  if exists (select 1 from public.form_defs f
              where f.channel_id  = p_channel
                and f.template_id = p_template
                and not f.closed) then
    raise exception 'already_imported' using errcode = '23505',
      hint = 'This form is already open in this channel. Close the one that is there before posting it again.';
  end if;

  v_form := public.create_form(p_channel, v_t.title, v_t.description, v_t.fields, v_t.multi);

  -- Stamped after the fact because create_form does not know about templates
  -- and should not have to. This one column is what makes every copy of this
  -- form, across every Space in the org, countable as one thing.
  update public.form_defs set template_id = p_template
   where id = v_form.id
  returning * into v_form;

  return v_form;
end;
$fn$;

-- ============================================================================
-- 5. What the whole thing was for
-- ============================================================================
-- One number for "how many leave requests did the organisation file", across
-- every Space, which is a question that could not be asked at all before this
-- migration because the four hand-retyped copies of the form had nothing in
-- common to group by.
--
-- total counts every submission in the org. by_form is listed only for channels
-- the CALLER can see: an org member is not automatically a member of every
-- Space, and a private channel's name plus a live answer count is not something
-- an aggregate should hand out to somebody who cannot open the channel. hidden
-- says how many copies were left off, so a partial list says so rather than
-- quietly reading as the whole picture.
create or replace function public.template_responses(p_template uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_org    uuid;
  v_total  bigint;
  v_rows   jsonb;
  v_hidden int;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select org_id into v_org from public.form_templates where id = p_template;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_member(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  select count(*) into v_total
    from public.form_submissions s
    join public.form_defs f on f.id = s.form_id
   where f.template_id = p_template;

  select coalesce(jsonb_agg(jsonb_build_object(
           'form_id',        f.id,
           'workspace_id',   f.workspace_id,
           'channel_id',     f.channel_id,
           'channel_name',   c.name::text,
           'workspace_name', w.name,
           'count', (select count(*) from public.form_submissions s where s.form_id = f.id))
           order by w.name, c.name)
           filter (where (select private.can_view_channel(f.channel_id))), '[]'::jsonb),
         count(*) filter (where not (select private.can_view_channel(f.channel_id)))::int
    into v_rows, v_hidden
    from public.form_defs f
    join public.channels c   on c.id = f.channel_id
    join public.workspaces w on w.id = f.workspace_id
   where f.template_id = p_template;

  return jsonb_build_object('total', coalesce(v_total, 0),
                            'by_form', v_rows,
                            'hidden', coalesce(v_hidden, 0));
end;
$fn$;

-- ============================================================================
-- 6. Grants
-- ============================================================================
-- Same posture as every form RPC already live: nothing for public or anon, and
-- authenticated reaches these tables only through the six functions above.
revoke all on function public.create_form_template(uuid, text, text, jsonb, boolean) from public, anon;
revoke all on function public.update_form_template(uuid, text, text, jsonb, boolean) from public, anon;
revoke all on function public.archive_form_template(uuid, boolean) from public, anon;
revoke all on function public.search_form_templates(uuid, text, int, int) from public, anon;
revoke all on function public.import_form_template(uuid, uuid) from public, anon;
revoke all on function public.template_responses(uuid) from public, anon;

grant execute on function public.create_form_template(uuid, text, text, jsonb, boolean) to authenticated;
grant execute on function public.update_form_template(uuid, text, text, jsonb, boolean) to authenticated;
grant execute on function public.archive_form_template(uuid, boolean) to authenticated;
grant execute on function public.search_form_templates(uuid, text, int, int) to authenticated;
grant execute on function public.import_form_template(uuid, uuid) to authenticated;
grant execute on function public.template_responses(uuid) to authenticated;
