-- The Apps console (org-admin only) and the three app-facing calls.
--
-- Every app-facing function enters through private.app_ctx and nowhere else.

-- ------------------------------------------------------------ console: apps

create or replace function public.create_app(
  p_org uuid, p_name text, p_description text default null
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_app uuid; v_profile uuid := util.uuidv7();
  v_name text := btrim(coalesce(p_name, ''));
  v_slug text; v_user text;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(v_name) = 0 or length(v_name) > 80 then
    raise exception 'bad_name' using errcode = '22023';
  end if;

  -- An app profile needs an auth.users row because profiles.id references it.
  -- banned_until far in the future means this row can never be signed in as,
  -- which is the whole security story: it is an identity, not an account.
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, banned_until)
  values (v_profile, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'app-' || v_profile::text || '@apps.invalid', now(), now(), 'infinity');

  v_slug := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
  v_slug := btrim(v_slug, '-');
  if v_slug = '' then v_slug := 'app'; end if;
  v_user := left(v_slug, 24) || '-' || left(encode(extensions.gen_random_bytes(3), 'hex'), 4);

  -- auth.users has a trigger that creates the profile row, so this is an upsert
  -- rather than an insert. Discovered by the smoke test, not by reading.
  insert into public.profiles (id, username, display_name, is_app)
  values (v_profile, v_user::public.citext, v_name, true)
  on conflict (id) do update
    set username = excluded.username, display_name = excluded.display_name, is_app = true;

  insert into public.apps (org_id, profile_id, name, description, created_by)
  values (p_org, v_profile, v_name, nullif(btrim(coalesce(p_description, '')), ''), v_uid)
  returning id into v_app;

  update public.profiles set app_id = v_app where id = v_profile;

  insert into private.app_secrets (app_id, signing_secret)
  values (v_app, encode(extensions.gen_random_bytes(32), 'hex'));

  return jsonb_build_object('id', v_app, 'profile_id', v_profile, 'name', v_name, 'username', v_user);
end;
$fn$;

create or replace function public.set_app_avatar(p_app uuid, p_avatar_key text)
returns void language plpgsql security definer set search_path to '' as $fn$
declare v_org uuid; v_profile uuid;
begin
  select org_id, profile_id into v_org, v_profile from public.apps where id = p_app;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.profiles set avatar_key = nullif(btrim(coalesce(p_avatar_key, '')), '')
   where id = v_profile;
end;
$fn$;

create or replace function public.disable_app(p_app uuid)
returns void language plpgsql security definer set search_path to '' as $fn$
declare v_org uuid; v_profile uuid;
begin
  select org_id, profile_id into v_org, v_profile from public.apps where id = p_app;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  update public.apps set disabled_at = now() where id = p_app;
  -- Pull the identity out of every Space at once, so the kill switch is visible
  -- in the member list and not only in a table nobody looks at.
  delete from public.workspace_members
   where user_id = v_profile
     and workspace_id in (select workspace_id from public.app_installs where app_id = p_app);
end;
$fn$;

create or replace function public.list_apps(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
begin
  if not private.is_org_admin(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', a.name, 'description', a.description,
      'profile_id', a.profile_id, 'avatar_key', p.avatar_key,
      'username', p.username::text,
      'disabled_at', a.disabled_at, 'created_at', a.created_at,
      'installs', (select count(*) from public.app_installs i
                    where i.app_id = a.id and i.uninstalled_at is null),
      'last_used_at', (select max(t.last_used_at) from public.app_tokens t
                        join public.app_installs i on i.id = t.install_id
                       where i.app_id = a.id)
    ) order by a.created_at desc)
    from public.apps a join public.profiles p on p.id = a.profile_id
    where a.org_id = p_org), '[]'::jsonb);
end;
$fn$;

create or replace function public.get_app(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_org uuid; v_out jsonb;
begin
  select org_id into v_org from public.apps where id = p_app;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  select jsonb_build_object(
    'id', a.id, 'org_id', a.org_id, 'name', a.name, 'description', a.description,
    'profile_id', a.profile_id, 'avatar_key', p.avatar_key, 'username', p.username::text,
    'disabled_at', a.disabled_at,
    'installs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'workspace_id', i.workspace_id, 'workspace_name', w.name,
        'scopes', i.scopes, 'channel_scope', i.channel_scope,
        'installed_at', i.installed_at, 'uninstalled_at', i.uninstalled_at,
        'channels', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name::text))
                                from public.app_install_channels ic
                                join public.channels c on c.id = ic.channel_id
                               where ic.install_id = i.id), '[]'::jsonb),
        -- token_sha256 is never selected here. There is no reason to serve it.
        'tokens', coalesce((select jsonb_agg(jsonb_build_object(
                              'id', t.id, 'hint', t.token_hint, 'label', t.label,
                              'created_at', t.created_at, 'last_used_at', t.last_used_at,
                              'expires_at', t.expires_at, 'revoked_at', t.revoked_at)
                            order by t.created_at desc)
                              from public.app_tokens t where t.install_id = i.id), '[]'::jsonb)
      ) order by i.installed_at)
      from public.app_installs i
      join public.workspaces w on w.id = i.workspace_id
     where i.app_id = a.id), '[]'::jsonb)
  ) into v_out
  from public.apps a join public.profiles p on p.id = a.profile_id
  where a.id = p_app;
  return v_out;
end;
$fn$;

-- ------------------------------------------------------- console: installs

create or replace function public.install_app(
  p_app uuid, p_workspace uuid, p_scopes bigint default 1,
  p_channel_scope text default 'listed', p_channels uuid[] default '{}'::uuid[]
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid; v_profile uuid; v_install uuid; v_ws_org uuid;
begin
  select org_id, profile_id into v_org, v_profile from public.apps where id = p_app;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  select org_id into v_ws_org from public.workspaces where id = p_workspace;
  if v_ws_org is distinct from v_org then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_channel_scope not in ('listed', 'all') then
    raise exception 'bad_channel_scope' using errcode = '22023';
  end if;

  insert into public.app_installs (app_id, workspace_id, scopes, channel_scope, installed_by)
  values (p_app, p_workspace, coalesce(p_scopes, 0), p_channel_scope, v_uid)
  on conflict (app_id, workspace_id) do update
    set scopes = excluded.scopes, channel_scope = excluded.channel_scope,
        installed_by = excluded.installed_by, uninstalled_at = null
  returning id into v_install;

  delete from public.app_install_channels where install_id = v_install;
  insert into public.app_install_channels (install_id, channel_id)
  select v_install, c.id from public.channels c
   where c.id = any(coalesce(p_channels, '{}'::uuid[])) and c.workspace_id = p_workspace;

  -- The app becomes a real member of the Space. This is what makes its messages
  -- render with a name: profiles RLS lets you see anyone you share a Space with.
  insert into public.workspace_members (workspace_id, user_id, member_type)
  values (p_workspace, v_profile, 'member')
  on conflict (workspace_id, user_id) do nothing;

  insert into public.audit_log (workspace_id, actor_id, action, target, data)
  values (p_workspace, v_uid, 'app_install', to_jsonb(p_app::text),
          jsonb_build_object('scopes', p_scopes, 'channel_scope', p_channel_scope));

  return jsonb_build_object('install_id', v_install);
end;
$fn$;

create or replace function public.update_install(
  p_install uuid, p_scopes bigint, p_channel_scope text,
  p_channels uuid[] default '{}'::uuid[]
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare v_org uuid; v_ws uuid;
begin
  select a.org_id, i.workspace_id into v_org, v_ws
    from public.app_installs i join public.apps a on a.id = i.app_id where i.id = p_install;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_channel_scope not in ('listed', 'all') then
    raise exception 'bad_channel_scope' using errcode = '22023';
  end if;

  update public.app_installs
     set scopes = coalesce(p_scopes, 0), channel_scope = p_channel_scope
   where id = p_install;

  delete from public.app_install_channels where install_id = p_install;
  insert into public.app_install_channels (install_id, channel_id)
  select p_install, c.id from public.channels c
   where c.id = any(coalesce(p_channels, '{}'::uuid[])) and c.workspace_id = v_ws;

  insert into public.audit_log (workspace_id, actor_id, action, target, data)
  values (v_ws, (select auth.uid()), 'app_install_update', to_jsonb(p_install::text),
          jsonb_build_object('scopes', p_scopes, 'channel_scope', p_channel_scope));

  return jsonb_build_object('ok', true);
end;
$fn$;

create or replace function public.uninstall_app(p_install uuid)
returns void language plpgsql security definer set search_path to '' as $fn$
declare v_org uuid; v_ws uuid; v_profile uuid;
begin
  select a.org_id, i.workspace_id, a.profile_id into v_org, v_ws, v_profile
    from public.app_installs i join public.apps a on a.id = i.app_id where i.id = p_install;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  update public.app_installs set uninstalled_at = now() where id = p_install;
  update public.app_tokens set revoked_at = now()
   where install_id = p_install and revoked_at is null;
  delete from public.workspace_members where workspace_id = v_ws and user_id = v_profile;

  insert into public.audit_log (workspace_id, actor_id, action, target, data)
  values (v_ws, (select auth.uid()), 'app_uninstall', to_jsonb(p_install::text), '{}'::jsonb);
end;
$fn$;

-- ---------------------------------------------------------- console: tokens

create or replace function private.mint_app_token(p_install uuid, p_label text, p_by uuid)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_token text; v_id uuid;
begin
  v_token := 'dek_at_' || translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  insert into public.app_tokens (install_id, token_sha256, token_hint, label, created_by)
  values (p_install, extensions.digest(v_token, 'sha256'), right(v_token, 6),
          nullif(btrim(coalesce(p_label, '')), ''), p_by)
  returning id into v_id;
  -- The plaintext is returned exactly once, here, and never stored.
  return jsonb_build_object('id', v_id, 'token', v_token, 'hint', right(v_token, 6));
end;
$fn$;

create or replace function public.create_app_token(p_install uuid, p_label text default null)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_org uuid; v_ws uuid; v_uid uuid := (select auth.uid());
begin
  select a.org_id, i.workspace_id into v_org, v_ws
    from public.app_installs i join public.apps a on a.id = i.app_id where i.id = p_install;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  insert into public.audit_log (workspace_id, actor_id, action, target, data)
  values (v_ws, v_uid, 'app_token_create', to_jsonb(p_install::text),
          jsonb_build_object('label', p_label));
  return private.mint_app_token(p_install, p_label, v_uid);
end;
$fn$;

-- Rotate mints a NEW token and puts the old one on a timer rather than killing
-- it, because the Bhiwandi box is redeployed by a person walking to it.
create or replace function public.rotate_app_token(
  p_token uuid, p_grace interval default interval '48 hours'
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare v_org uuid; v_ws uuid; v_install uuid; v_label text; v_uid uuid := (select auth.uid());
begin
  select a.org_id, i.workspace_id, i.id, t.label into v_org, v_ws, v_install, v_label
    from public.app_tokens t
    join public.app_installs i on i.id = t.install_id
    join public.apps a on a.id = i.app_id
   where t.id = p_token;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  update public.app_tokens set expires_at = now() + coalesce(p_grace, interval '48 hours')
   where id = p_token and revoked_at is null;

  insert into public.audit_log (workspace_id, actor_id, action, target, data)
  values (v_ws, v_uid, 'app_token_rotate', to_jsonb(p_token::text),
          jsonb_build_object('grace', p_grace::text));
  return private.mint_app_token(v_install, v_label, v_uid);
end;
$fn$;

create or replace function public.revoke_app_token(p_token uuid)
returns void language plpgsql security definer set search_path to '' as $fn$
declare v_org uuid; v_ws uuid;
begin
  select a.org_id, i.workspace_id into v_org, v_ws
    from public.app_tokens t
    join public.app_installs i on i.id = t.install_id
    join public.apps a on a.id = i.app_id
   where t.id = p_token;
  if v_org is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.is_org_admin(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;

  update public.app_tokens set revoked_at = now() where id = p_token and revoked_at is null;
  insert into public.audit_log (workspace_id, actor_id, action, target, data)
  values (v_ws, (select auth.uid()), 'app_token_revoke', to_jsonb(p_token::text), '{}'::jsonb);
end;
$fn$;

-- ------------------------------------------------------------- app-facing

-- The first call every app author makes, and the whole "is my token right"
-- answer in one round trip.
create or replace function public.app_whoami(p_token text)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare c private.app_ctx_t; v_scopes jsonb; v_channels jsonb;
begin
  c := private.app_ctx(p_token);
  perform private.app_touch(c.token_id);

  select coalesce(jsonb_agg(private.app_scope_name(b) order by b), '[]'::jsonb) into v_scopes
    from unnest(array[1, 2, 4, 8, 16, 32, 64, 128]::bigint[]) b
   where (c.scopes & b) = b;

  if c.channel_scope = 'all' then
    select coalesce(jsonb_agg(jsonb_build_object('id', ch.id, 'name', ch.name::text) order by ch.name), '[]'::jsonb)
      into v_channels from public.channels ch
     where ch.workspace_id = c.workspace_id and ch.archived_at is null;
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', ch.id, 'name', ch.name::text) order by ch.name), '[]'::jsonb)
      into v_channels from public.app_install_channels ic
      join public.channels ch on ch.id = ic.channel_id
     where ic.install_id = c.install_id and ch.archived_at is null;
  end if;

  return jsonb_build_object(
    'app', jsonb_build_object('id', c.app_id, 'name', c.app_name, 'profile_id', c.profile_id),
    'workspace', (select jsonb_build_object('id', w.id, 'name', w.name)
                    from public.workspaces w where w.id = c.workspace_id),
    'scopes', v_scopes,
    'channel_scope', c.channel_scope,
    'channels', v_channels);
end;
$fn$;

create or replace function public.app_post_message(
  p_token text, p_channel text, p_text text,
  p_thread uuid default null, p_client_msg_id uuid default null,
  p_attachments jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare c private.app_ctx_t; v_ch uuid; v_text text; v_msg uuid;
begin
  c := private.app_ctx(p_token);
  perform private.app_require(c, 1);
  if jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 0 then
    perform private.app_require(c, 16);
  end if;

  v_ch := private.app_channel(c, p_channel);
  v_text := coalesce(p_text, '');
  if length(btrim(v_text)) = 0 then raise exception 'empty_body' using errcode = '22023'; end if;
  if length(v_text) > 8000 then raise exception 'body_too_long' using errcode = '22023'; end if;

  perform private.rate_limit('app_post', c.install_id, v_ch, 120, interval '1 hour');

  v_msg := app.post_message(
    v_ch, c.profile_id,
    jsonb_build_object('text', v_text),
    v_text, coalesce(p_attachments, '[]'::jsonb), p_thread, p_client_msg_id);

  perform private.app_touch(c.token_id);
  return jsonb_build_object('ok', true, 'message_id', v_msg, 'channel_id', v_ch);
end;
$fn$;

create or replace function public.app_create_task(
  p_token text, p_channel text, p_title text, p_assignee text default null,
  p_due timestamptz default null
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare
  c private.app_ctx_t; v_ch uuid; v_title text; v_assignee uuid;
  v_msg uuid; v_task public.tasks; v_who text;
begin
  c := private.app_ctx(p_token);
  perform private.app_require(c, 8);
  v_ch := private.app_channel(c, p_channel);

  v_title := btrim(coalesce(p_title, ''));
  if length(v_title) = 0 then raise exception 'empty_title' using errcode = '22023'; end if;
  if length(v_title) > 300 then raise exception 'title_too_long' using errcode = '22023'; end if;

  -- An assignee is named the way a person names one: a username or an email.
  v_who := trim(leading '@' from btrim(coalesce(p_assignee, '')));
  if v_who <> '' then
    select p.id into v_assignee
      from public.profiles p
      join public.workspace_members m on m.user_id = p.id and m.workspace_id = c.workspace_id
      left join auth.users u on u.id = p.id
     where p.username = v_who::public.citext or lower(u.email) = lower(v_who)
     limit 1;
    if v_assignee is null then
      raise exception 'assignee_not_found: %', v_who using errcode = 'P0002';
    end if;
    if not private.can_user_view_channel(v_assignee, v_ch) then
      raise exception 'assignee_cannot_see_channel' using errcode = '22023';
    end if;
  end if;

  perform private.rate_limit('app_task', c.install_id, v_ch, 120, interval '1 hour');

  -- tasks.message_id is NOT NULL: a task in Dek always hangs off a message that
  -- people can reply to. So the app posts the task, then the task points at it.
  v_msg := app.post_message(v_ch, c.profile_id,
             jsonb_build_object('text', v_title), v_title);

  insert into public.tasks (workspace_id, channel_id, message_id, title, assignee_id,
                            created_by, due_at, state, assigned_by, state_since)
  values (c.workspace_id, v_ch, v_msg, v_title, v_assignee, c.profile_id, p_due,
          'accepted', case when v_assignee is not null then c.profile_id end, now())
  returning * into v_task;

  if v_assignee is not null then
    insert into public.saved_items (user_id, message_id, state)
    values (v_assignee, v_msg, 'todo') on conflict (user_id, message_id) do nothing;
    perform app.emit('user:' || v_assignee::text, 'task_assigned',
      jsonb_build_object('task_id', v_task.id, 'message_id', v_msg, 'channel_id', v_ch,
                         'workspace_id', c.workspace_id, 'title', v_title, 'due_at', p_due));
    perform app.enqueue_notification(v_assignee,
      jsonb_build_object('kind', 'task_assigned', 'task_id', v_task.id, 'message_id', v_msg,
                         'channel_id', v_ch, 'workspace_id', c.workspace_id));
  end if;

  perform app.emit('ch:' || v_ch::text, 'task_update',
                   jsonb_build_object('task_id', v_task.id, 'action', 'created'));
  perform private.app_touch(c.token_id);
  return jsonb_build_object('ok', true, 'task_id', v_task.id, 'message_id', v_msg,
                            'channel_id', v_ch, 'assignee_id', v_assignee);
end;
$fn$;

-- App-facing calls are reachable without a Supabase session, exactly like
-- post_as_bot already is. The token is the credential; app_ctx is the gate.
grant execute on function public.app_whoami(text) to anon, authenticated;
grant execute on function public.app_post_message(text, text, text, uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.app_create_task(text, text, text, text, timestamptz) to anon, authenticated;
