// Workspace (Space) lifecycle: the left rail of orgs, one-call bootstrap, and
// invite links. Hearth is multi-org: an admin shares one link and the person who
// opens it lands in exactly that Space.
import { api, table, tryRpc } from '../api.js';
import { sb, subscribe } from '../sb.js';
import { store, bus } from '../store.js';
import { PERM } from '../config.js';
import { $, el, esc, initials, hueOf } from '../util.js';
import { toast, formModal, modal, confirmModal, renderHeaderButtons } from '../ui.js';
import { renderChannels, openChannel, refreshUnread, lastChannelId } from './channels.js';

// ------------------------------------------------------------------ rail
// The rail groups by ORGANISATION. Until 0064 there was nothing to group by:
// create_space minted a fresh organizations row per Space, so every server was
// its own org and the rail was a flat list of unrelated icons. Measured on the
// live database before that migration: 150 workspaces, 150 organizations, and no
// organization with more than one workspace - which is exactly the thing that was
// reported as "a server itself is an organization".
//
// One group per org, its name above its servers, and the servers of an org that
// this person has not joined reachable through the directory at the end of the
// group rather than being invisible.
export function renderSpaceRail() {
  const r = $('spaceRail');
  if (!r) return;
  const orgs = store.orgs || [];
  const byOrg = new Map();
  for (const s of store.spaces) {
    const k = s.org_id || '';
    if (!byOrg.has(k)) byOrg.set(k, []);
    byOrg.get(k).push(s);
  }

  const icon = (s) => {
    const b = store.spaceBadges.get(s.id);
    const active = store.ws?.id === s.id;
    return `<div class="sicon${active ? ' active' : ''}" data-ws="${s.id}" title="${esc(s.name || '')}"
      style="--h:${hueOf(s.id)}">${esc(initials(s.name))}
      ${b?.mention_total ? `<span class="sbadge">${b.mention_total}</span>`
        : b?.unread_total ? '<span class="sdot"></span>' : ''}</div>`;
  };

  let h = '';
  const placed = new Set();
  for (const o of orgs) {
    const mine = byOrg.get(o.org_id) || [];
    // The label is what turns "five icons" into "these three are Jarurat Care".
    // Only worth drawing when the person is actually in more than one org.
    if (orgs.length > 1) h += `<div class="sorg-label" title="${esc(o.name)}">${esc(initials(o.name))}</div>`;
    for (const s of mine) { h += icon(s); placed.add(s.id); }
    // "in that org there can be multiple servers, which they can look into"
    h += `<div class="sicon sorg-more" data-org="${o.org_id}"
      title="Servers in ${esc(o.name)}">…</div>`;
    if (orgs.length > 1) h += '<div class="sorg-sep"></div>';
  }
  // A Space whose org this person is not a member of - the demo Space, or one
  // joined by a plain Space invite. Still theirs; just not under a heading.
  for (const s of store.spaces) if (!placed.has(s.id)) h += icon(s);

  h += `<div class="sicon add" data-add="1" title="Create or join">+</div>`;
  r.innerHTML = h;
  r.querySelectorAll('[data-ws]').forEach((n) => {
    n.onclick = () => {
      const s = store.spaces.find((x) => x.id === n.dataset.ws);
      if (s && s.id !== store.ws?.id) switchWorkspace(s);
    };
    n.oncontextmenu = (e) => { e.preventDefault(); spaceMenu(e, store.spaces.find((x) => x.id === n.dataset.ws)); };
  });
  r.querySelectorAll('[data-org]').forEach((n) => {
    n.onclick = () => orgDirectory(n.dataset.org);
  });
  r.querySelector('[data-add]').onclick = spaceChooser;
}

function spaceMenu(ev, s) {
  if (!s) return;
  import('../ui.js').then(({ contextMenu }) => contextMenu(ev, [
    { label: 'Invite people', onClick: () => inviteDialog(s) },
    { label: 'Copy invite link', onClick: () => copyInvite(s) },
    '-',
    { label: 'Leave Space', danger: true, onClick: async () => {
      if (!(await confirmModal({ title: 'Leave ' + s.name, body: 'You will need a new invite link to come back.', confirmLabel: 'Leave', danger: true }))) return;
      try {
        await api.leaveWorkspace(s.id);
        toast('Left ' + s.name);
        await loadSpaces();
        if (store.spaces[0]) await switchWorkspace(store.spaces[0]);
      } catch (e) { toast(e.message, 'error'); }
    } },
  ]));
}

// ------------------------------------------------------------------ load
export async function loadSpaces() {
  const rows = await table('workspaces', (q) => q.order('created_at'));
  store.spaces = rows;
  // Which organisations this person belongs to, for the rail's grouping and for
  // "can I make a server here". tryRpc rather than rpc: a client that reaches a
  // deployment without 0064 gets an empty list and the flat rail it had before,
  // rather than a broken sign-in.
  const [orgs] = await tryRpc('my_orgs', {});
  store.orgs = Array.isArray(orgs) ? orgs : [];
  const [summary] = await tryRpc('get_space_summary', {});
  if (Array.isArray(summary)) {
    store.spaceBadges = new Map(summary.map((s) => [s.workspace_id, s]));
  }
  renderSpaceRail();
  return rows;
}

// ------------------------------------------------------------------ the directory
// Every server in one organisation, joined or not, with who made it. This is the
// surface the operator asked for: "in that org there can be multiple servers,
// which they can look into", and "always show who made the server".
export async function orgDirectory(orgId) {
  const org = (store.orgs || []).find((o) => o.org_id === orgId);
  const box = el('div', 'orgdir');
  box.innerHTML = '<div class="muted pad">loading…</div>';
  const m = modal({ title: org ? org.name : 'Servers', body: box, wide: true });

  const paint = async () => {
    const [rows] = await tryRpc('list_org_spaces', { p_org: orgId });
    const list = Array.isArray(rows) ? rows : [];
    const canAdmin = org?.org_role === 'admin';
    box.innerHTML = `
      <div class="orgdir-head">
        <div class="muted">${list.length} server${list.length === 1 ? '' : 's'} in this organisation.
          Anyone here can make one.</div>
        <button class="sm" data-a="new">＋ New server</button>
      </div>
      <div class="orgdir-list">${list.map((s) => `
        <div class="orgdir-row" data-id="${s.id}">
          <span class="orgdir-ico" style="--h:${hueOf(s.id)}">${esc(initials(s.name))}</span>
          <div class="orgdir-main">
            <b>${esc(s.name)}</b>
            <div class="muted orgdir-sub">
              ${s.join_policy === 'open' ? '' : '🔒 invite only · '}made by ${esc(s.created_by_name || 'someone')}
              · ${s.member_count} member${s.member_count === 1 ? '' : 's'}
            </div>
          </div>
          ${s.is_member
            ? '<button class="sm ghost" data-open="1">Open</button>'
            : (s.join_policy === 'open' || canAdmin)
              ? '<button class="sm" data-join="1">Join</button>'
              : '<span class="muted orgdir-locked">Ask to be added</span>'}
        </div>`).join('')
      || '<div class="empty">No servers yet. Make the first one.</div>'}</div>
      ${canAdmin ? `<div class="orgdir-foot">
        <button class="sm ghost" data-a="invite">Invite people to ${esc(org.name)}</button>
        <button class="sm ghost" data-a="people">People and roles</button>
      </div>` : ''}`;

    box.querySelector('[data-a="new"]').onclick = () => { m.close(); createTeamSpaceDialog(orgId); };
    box.querySelector('[data-a="invite"]')?.addEventListener('click', () => { m.close(); orgInviteDialog(orgId); });
    box.querySelector('[data-a="people"]')?.addEventListener('click', () => { m.close(); orgPeopleDialog(orgId); });
    box.querySelectorAll('.orgdir-row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-open]')?.addEventListener('click', async () => {
        m.close();
        const s = store.spaces.find((x) => x.id === id);
        if (s) await switchWorkspace(s);
      });
      row.querySelector('[data-join]')?.addEventListener('click', async () => {
        try {
          await api.rpc('join_team_space', { p_workspace: id });
          await loadSpaces();
          const s = store.spaces.find((x) => x.id === id);
          m.close();
          if (s) await switchWorkspace(s);
          toast('Joined');
        } catch (e) { toast(joinError(e), 'error'); }
      });
    });
  };
  await paint().catch(() => { box.innerHTML = '<div class="empty">Could not load the servers.</div>'; });
}

const joinError = (e) => (/invite_only/.test(e.message || '')
  ? 'That server is invite only. Ask somebody inside it to add you.'
  : /banned/.test(e.message || '') ? 'You cannot join that server.'
  : e.message || 'Could not join');

// ------------------------------------------------------------------ make a server
export async function createTeamSpaceDialog(orgId) {
  const org = (store.orgs || []).find((o) => o.org_id === orgId);
  const out = await formModal({
    title: 'New server' + (org ? ' in ' + org.name : ''),
    note: 'A server is one team: HR, tech, design. It has its own channels and its '
        + 'own members, and nobody outside it can read what is said inside.',
    fields: [
      { name: 'name', label: 'Server name', required: true, placeholder: 'HR' },
      { name: 'join_policy', label: 'Who can join', type: 'select', value: 'invite',
        options: [
          { value: 'invite', label: 'Only people who are added (private)' },
          { value: 'open', label: 'Anyone in ' + (org?.name || 'this organisation') },
        ] },
    ],
    submitLabel: 'Create server',
  });
  if (!out) return;
  try {
    const ws = await api.rpc('create_team_space', {
      p_org: orgId, p_name: out.name.trim(), p_join_policy: out.join_policy || 'invite',
    });
    await loadSpaces();
    const s = store.spaces.find((x) => x.id === ws?.id) || ws;
    if (s) await switchWorkspace(s);
    toast('Created ' + (ws?.name || out.name));
  } catch (e) { toast(e.message || 'Could not create that server', 'error'); }
}

// ------------------------------------------------------------------ org invite
export async function orgInviteDialog(orgId) {
  const org = (store.orgs || []).find((o) => o.org_id === orgId);
  const out = await formModal({
    title: 'Invite people to ' + (org?.name || 'this organisation'),
    note: 'This link joins the ORGANISATION, not one server. Whoever opens it can '
        + 'then see every server in it and join the open ones.',
    fields: [
      { name: 'role', label: 'They join as', type: 'select', value: 'member',
        options: [
          { value: 'member', label: 'Member - can see the servers and make new ones' },
          { value: 'admin', label: 'Admin - can also invite, and open any server' },
        ] },
      { name: 'uses', label: 'How many people may use it', type: 'number',
        placeholder: 'leave blank for no limit' },
    ],
    submitLabel: 'Create link',
  });
  if (!out) return;
  try {
    const token = await api.rpc('create_org_invite', {
      p_org: orgId,
      p_role: out.role || 'member',
      p_max_uses: out.uses ? +out.uses : null,
      p_expires_at: null,
    });
    const link = location.origin + location.pathname + '#/join-org/' + token;
    await navigator.clipboard?.writeText(link).catch(() => {});
    const body = el('div');
    body.innerHTML = `<p class="muted">Send this to the people you want in
      <b>${esc(org?.name || 'this organisation')}</b>. It is copied already.</p>
      <input class="wide" readonly value="${esc(link)}" />`;
    modal({ title: 'Join link', body });
  } catch (e) { toast(e.message || 'Could not make a link', 'error'); }
}

// ------------------------------------------------------------------ org people
export async function orgPeopleDialog(orgId) {
  const org = (store.orgs || []).find((o) => o.org_id === orgId);
  const box = el('div', 'orgppl');
  box.innerHTML = '<div class="muted pad">loading…</div>';
  modal({ title: 'People in ' + (org?.name || 'this organisation'), body: box, wide: true });
  const paint = async () => {
    const [rows] = await tryRpc('list_org_members', { p_org: orgId });
    const list = Array.isArray(rows) ? rows : [];
    box.innerHTML = list.map((p) => `
      <div class="orgppl-row" data-u="${p.user_id}">
        <span class="orgdir-ico" style="--h:${hueOf(p.user_id)}">${esc(initials(p.display_name))}</span>
        <b class="orgppl-name">${esc(p.display_name)}</b>
        <select data-role>
          <option value="member"${p.org_role === 'member' ? ' selected' : ''}>Member</option>
          <option value="admin"${p.org_role === 'admin' ? ' selected' : ''}>Admin</option>
        </select>
      </div>`).join('') || '<div class="empty">Nobody yet.</div>';
    box.querySelectorAll('.orgppl-row').forEach((row) => {
      row.querySelector('[data-role]').onchange = async (e) => {
        const value = e.target.value;
        try {
          await api.rpc('set_org_role', { p_org: orgId, p_user: row.dataset.u, p_role: value });
          toast('Role updated');
          const o = (store.orgs || []).find((x) => x.org_id === orgId);
          if (o && row.dataset.u === store.me) o.org_role = value;
        } catch (err) {
          toast(/last_admin/.test(err.message || '')
            ? 'That is the only admin left. Make somebody else an admin first.'
            : err.message || 'Could not change that role', 'error');
          await paint();
        }
      };
    });
  };
  await paint().catch(() => { box.innerHTML = '<div class="empty">Could not load the members.</div>'; });
}

// One round trip for the whole workspace. Falls back to individual queries when
// the consolidated RPC is unavailable, so the client never hard-depends on it.
export async function switchWorkspace(target) {
  if (!target) return;
  store.ws = target;
  store.current = null;
  store.currentDM = null;
  $('spaceName').textContent = target.name || '';
  renderSpaceRail();

  const [boot] = await tryRpc('get_bootstrap', { p_workspace: target.id });
  if (boot && boot.channels) {
    store.categories = boot.categories || [];
    store.channels = boot.channels || [];
    store.dms = boot.dms || [];
    store.profiles = new Map((boot.members || []).map((m) => [m.user_id, { id: m.user_id, ...m }]));
    store.online = new Set((boot.members || []).filter((m) => m.online).map((m) => m.user_id));
    store.unread = new Map((boot.unread || []).map((u) => [u.scope_id, u]));
    store.notify = new Map((boot.notify || []).map((n) => [n.scope_id, n]));
    store.drafts = new Map((boot.drafts || []).map((d) => [d.scope_type + ':' + d.scope_id, d.body_text]));
    store.voiceParts = new Map();
    for (const v of boot.voice || []) {
      if (!store.voiceParts.has(v.channel_id)) store.voiceParts.set(v.channel_id, []);
      store.voiceParts.get(v.channel_id).push(v.user_id);
    }
    store.perms = BigInt(boot.me?.permissions ?? 0);
    store.isAdmin = !!boot.me?.is_admin || (store.perms & PERM.ADMINISTRATOR) !== 0n;
    if (boot.me) store.myProfile = { id: store.me, ...boot.me };
  } else {
    await legacyLoad(target);
  }

  bus.emit('workspace', { ws: target });
  renderHeaderButtons();
  await renderChannels();
  subscribeWorkspace(target);

  // Open where they left off. Two reasons, and the second is the important one:
  // going back to the conversation you were in is what every other chat app
  // does, and the cold-start paint has ALREADY drawn that channel from this
  // phone's storage - opening a different one instead would swap the screen out
  // from under the person a few seconds after showing it to them.
  const lastId = lastChannelId();
  const first = store.channels.find((c) => c.id === lastId && c.kind !== 'voice' && !c.archived_at)
    || store.channels.find((c) => c.name === 'general' && c.kind !== 'voice')
    || store.channels.find((c) => c.kind !== 'voice' && !c.archived_at);
  if (first) await openChannel(first);
  else $('messages').innerHTML = '<div class="empty">No channels here yet.</div>';
}

// Pre-0047 path: individual queries. Kept so a stale deploy still works.
async function legacyLoad(target) {
  const [cats, chans, mem] = await Promise.all([
    table('categories', (q) => q.eq('workspace_id', target.id).order('position')),
    table('channels', (q) => q.eq('workspace_id', target.id).order('position')),
    table('workspace_members', (q) => q.eq('workspace_id', target.id)),
  ]);
  store.categories = cats;
  store.channels = chans;
  const ids = mem.map((m) => m.user_id);
  if (ids.length) {
    const profs = await table('profiles', (q) => q.in('id', ids));
    store.profiles = new Map(profs.map((p) => [p.id, p]));
  }
  const convs = await table('conversations', (q) => q.eq('workspace_id', target.id));
  const convIds = convs.map((c) => c.id);
  const cmem = convIds.length ? await table('conversation_members', (q) => q.in('conversation_id', convIds)) : [];
  store.dms = convs.map((c) => ({
    conversation_id: c.id, kind: c.kind,
    other_user_ids: cmem.filter((m) => m.conversation_id === c.id).map((m) => m.user_id),
    last_message_at: c.last_message_at, unread: 0,
  }));
  const [unread] = await tryRpc('get_unread', { p_workspace: target.id });
  store.unread = new Map((unread || []).map((u) => [u.scope_id, u]));
  const [notif] = await tryRpc('get_notify_settings', { p_workspace: target.id });
  store.notify = new Map((notif?.channels || []).map((n) => [n.scope_id, n]));
  store.myProfile = store.profiles.get(store.me) || store.myProfile;
  store.perms = 0n;
  store.isAdmin = false;
}

function subscribeWorkspace(ws) {
  subscribe('ws', 'ws:' + ws.id, {
    channel_created: () => bus.emit('channels:reload'),
    channel_updated: () => bus.emit('channels:reload'),
    channel_deleted: () => bus.emit('channels:reload'),
    // The payload carries the profile, so one person joining a 300-member Space
    // costs every other client zero queries instead of one each.
    member_joined: (p) => {
      if (!p?.user_id) { reloadMembers(); return; }
      store.profiles.set(p.user_id, {
        id: p.user_id, display_name: p.display_name, username: p.username,
        avatar_key: p.avatar_key, status_text: p.status_text,
        status_emoji: p.status_emoji, member_type: p.member_type,
      });
      bus.emit('profiles');
    },
    member_left: (p) => {
      if (p?.user_id) store.profiles.delete(p.user_id);
      bus.emit('profiles');
    },
    // A colleague changed their custom status. Without this it only showed up
    // after a full reload: core/presence.js deliberately fetches profiles ONLY
    // for ids it has never seen, so an existing member's status_text was never
    // refetched. 0062 is what publishes this event.
    member_status: (p) => {
      if (!p?.user_id) return;
      const prev = store.profiles.get(p.user_id);
      if (!prev) return;                      // not someone on screen here
      store.profiles.set(p.user_id, {
        ...prev,
        status_text: p.status_text ?? null,
        status_emoji: p.status_emoji ?? null,
      });
      bus.emit('profiles');
    },
  });
}

export async function reloadMembers() {
  if (!store.ws) return;
  const mem = await table('workspace_members', (q) => q.eq('workspace_id', store.ws.id));
  const ids = mem.map((m) => m.user_id);
  if (!ids.length) return;
  const profs = await table('profiles', (q) => q.in('id', ids));
  for (const p of profs) store.profiles.set(p.id, { ...(store.profiles.get(p.id) || {}), ...p });
  bus.emit('profiles');
}

export async function reloadChannels(openId) {
  if (!store.ws) return;
  const [boot] = await tryRpc('get_bootstrap', { p_workspace: store.ws.id });
  if (boot?.channels) {
    store.categories = boot.categories || [];
    store.channels = boot.channels || [];
  } else {
    store.channels = await table('channels', (q) => q.eq('workspace_id', store.ws.id).order('position'));
    store.categories = await table('categories', (q) => q.eq('workspace_id', store.ws.id).order('position'));
  }
  await renderChannels();
  if (openId) {
    const c = store.channels.find((x) => x.id === openId);
    if (c) openChannel(c);
  }
}

// ------------------------------------------------------------------ create / join
export async function spaceChooser() {
  const box = el('div', 'chooser');
  const orgs = store.orgs || [];
  // A server inside an organisation you are already in is the common case now,
  // and it is what "let ppl make servers" asked for - so it is offered first,
  // by name, and every member gets it rather than only admins. Starting a whole
  // new organisation is the rare thing and reads as such.
  box.innerHTML = `
    ${orgs.map((o) => `
    <button class="chooser-card" data-org="${o.org_id}">
      <div class="cc-ico">🏢</div><div><b>New server in ${esc(o.name)}</b>
      <div class="muted">One team - HR, tech, design. Its own channels, its own
        members, and nobody outside it can read them.</div></div>
    </button>`).join('')}
    ${orgs.map((o) => `
    <button class="chooser-card" data-dir="${o.org_id}">
      <div class="cc-ico">🗂️</div><div><b>Browse ${esc(o.name)}</b>
      <div class="muted">${o.spaces} server${o.spaces === 1 ? '' : 's'} - see what exists and join.</div></div>
    </button>`).join('')}
    <button class="chooser-card" data-a="create">
      <div class="cc-ico">🏗️</div><div><b>Start a new organisation</b>
      <div class="muted">A separate organisation of your own, unrelated to the ones above.</div></div>
    </button>
    <button class="chooser-card" data-a="join">
      <div class="cc-ico">🔗</div><div><b>Join with a link</b>
      <div class="muted">Someone sent you an invite link or code? Paste it here.</div></div>
    </button>`;
  const m = modal({ title: 'Servers', body: box });
  box.querySelectorAll('[data-org]').forEach((n) => {
    n.onclick = () => { m.close(); createTeamSpaceDialog(n.dataset.org); };
  });
  box.querySelectorAll('[data-dir]').forEach((n) => {
    n.onclick = () => { m.close(); orgDirectory(n.dataset.dir); };
  });
  box.querySelector('[data-a="create"]').onclick = () => { m.close(); createSpaceDialog(); };
  box.querySelector('[data-a="join"]').onclick = () => { m.close(); joinDialog(); };
}

export async function createSpaceDialog() {
  const out = await formModal({
    title: 'Create a Space',
    note: 'A Space is your organization. Channels, members and roles all live inside it.',
    fields: [{ name: 'name', label: 'Space name', required: true, placeholder: 'Acme Inc' }],
    submitLabel: 'Create Space',
  });
  if (!out) return;
  try {
    const data = await api.createSpace(out.name.trim());
    await loadSpaces();
    const s = store.spaces.find((x) => x.id === data.id) || data;
    await switchWorkspace(s);
    toast('Space created');
    await inviteDialog(s, true);
  } catch (e) { toast(e.message, 'error'); }
}

export async function joinDialog() {
  const out = await formModal({
    title: 'Join a Space',
    fields: [{ name: 'link', label: 'Invite link or code', required: true,
      placeholder: 'https://…/#/join/abc123  or just abc123' }],
    submitLabel: 'Join',
  });
  if (!out) return;
  const token = extractToken(out.link.trim());
  try {
    const wsRow = await api.redeemInvite(token);
    await loadSpaces();
    const s = store.spaces.find((x) => x.id === wsRow.id) || wsRow;
    await switchWorkspace(s);
    toast('Joined ' + (s.name || 'the Space'));
  } catch (e) { toast(e.message || 'That invite did not work', 'error'); }
}

// Accepts the whole link, the hash alone, or a bare token. `join-org` has to be
// matched too and has to be matched FIRST: `join\/` alone does not match
// "join-org/", so an organisation link pasted whole came back as the entire URL
// and was then sent to the server as if it were the token. Nobody is going to
// pull a token out of a URL by hand on a phone, so every shape the link arrives
// in has to work.
export const extractToken = (s) => {
  const m = (s || '').match(/join-org\/([^/?#\s]+)/) || (s || '').match(/join\/([^/?#\s]+)/);
  return m ? decodeURIComponent(m[1]) : (s || '').trim();
};

// Which redeem an invite string is for, when the app has to choose. Only the
// link form says; a bare token does not, and the caller falls back.
export const looksLikeOrgInvite = (s) => /join-org\//.test(s || '');

export function inviteLinkFor(token) {
  return location.origin + location.pathname + '#/join/' + token;
}

export async function copyInvite(space) {
  const ws = space || store.ws;
  if (!ws) return;
  try {
    const token = await api.createInvite(ws.id, null, null, null);
    const link = inviteLinkFor(token);
    await navigator.clipboard?.writeText(link);
    toast('Invite link copied');
    return link;
  } catch (e) { toast(e.message, 'error'); }
}

export async function inviteDialog(space, isNew = false) {
  const ws = space || store.ws;
  if (!ws) return;
  const box = el('div', 'invite-box');
  box.innerHTML = `
    ${isNew ? `<p class="muted">Your Space <b>${esc(ws.name)}</b> is live. Share this link and anyone who opens it lands right here.</p>` : ''}
    <div class="invite-row"><input id="inviteLink" readonly value="generating…" />
      <button id="copyInvite">Copy</button></div>
    <div class="invite-opts">
      <label class="field"><span class="field-label">Expires</span>
        <select id="invExp">
          <option value="">Never</option><option value="1">1 day</option>
          <option value="7">7 days</option><option value="30">30 days</option></select></label>
      <label class="field"><span class="field-label">Max uses</span>
        <input id="invMax" type="number" min="1" placeholder="Unlimited" /></label>
      <button class="ghost" id="regen">Generate new link</button>
    </div>
    <div id="inviteList" class="invite-list"></div>`;
  const m = modal({ title: 'Invite to ' + ws.name, body: box, wide: true });

  const make = async () => {
    const days = box.querySelector('#invExp').value;
    const max = box.querySelector('#invMax').value;
    try {
      const token = await api.createInvite(
        ws.id, max ? +max : null,
        days ? new Date(Date.now() + +days * 86400000).toISOString() : null, null);
      box.querySelector('#inviteLink').value = inviteLinkFor(token);
      refreshList();
    } catch (e) { box.querySelector('#inviteLink').value = e.message; }
  };
  const refreshList = async () => {
    const [rows] = await tryRpc('list_invites', { p_workspace: ws.id });
    const host = box.querySelector('#inviteList');
    if (!Array.isArray(rows) || !rows.length) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="muted" style="margin:10px 0 4px">Active invites</div>' + rows
      .filter((r) => !r.revoked_at)
      .map((r) => `<div class="inv-row"><span>${r.uses || 0}${r.max_uses ? '/' + r.max_uses : ''} uses</span>
        <span class="muted">${r.expires_at ? 'expires ' + new Date(r.expires_at).toLocaleDateString() : 'never expires'}</span>
        <button class="icon" data-rev="${r.id}">Revoke</button></div>`).join('');
    host.querySelectorAll('[data-rev]').forEach((b) => {
      b.onclick = async () => { await api.revokeInvite(b.dataset.rev).catch(() => {}); refreshList(); };
    });
  };

  box.querySelector('#copyInvite').onclick = async () => {
    await navigator.clipboard?.writeText(box.querySelector('#inviteLink').value);
    toast('Copied');
  };
  box.querySelector('#regen').onclick = make;
  await make();
}

bus.on('channels:reload', (p) => reloadChannels(p?.open));
bus.on('spaces:badges', renderSpaceRail);
