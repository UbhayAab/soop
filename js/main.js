// Bootstrap: sign in, load the Space, wire the shell, register features.
import { sb, session } from './sb.js';
import { api, tryRpc } from './api.js';
import { store, bus, nameOf } from './store.js';
import { $, el, esc } from './util.js';
import ui, { toast, openPanel, closePanel, renderHeaderButtons, modal, closePopovers } from './ui.js';
import { initAuth, showAuth, showChat, needsPasswordSetup, showSetPassword } from './core/auth.js';
import { loadSpaces, switchWorkspace, spaceChooser, inviteDialog, copyInvite, extractToken, looksLikeOrgInvite } from './core/workspace.js';
import { openChannel, renderChannels, wireScroll, refreshUnread, jumpToSeq,
  paintLastChannelFromCache } from './core/channels.js';
import { initComposer, setReply, resolveMentions } from './core/composer.js';
import { initPresence } from './core/presence.js';
import { initVoice } from './core/voice.js';
import { openThread, threadState } from './core/threads.js';
import { registerCoreActions, registerCoreHeader } from './core/actions.js';
import { openDM, startDM } from './core/dms.js';
import { jumpTo, buildMessage } from './core/messages.js';
import { initPWA, paintInstallButton } from './pwa.js';
import { initTheme, openThemePicker, cycleTheme } from './theme.js';
import { icon, logoMark } from './icons.js';
import { initShell, paintIdentity, paintChannelBar } from './shell.js';
import { registerFeatures } from './features/index.js';
import { initEmbed, embed, pinnedSpaceOf, notifyHost } from './embed.js';

// Any element carrying data-ico gets its SVG injected. Keeping the markup
// declarative means index.html stays readable and the icon set can change
// without touching the shell.
function hydrateIcons(root) {
  for (const n of root.querySelectorAll('[data-ico]')) {
    if (n.firstElementChild?.classList.contains('ico')) continue;
    n.insertAdjacentHTML('afterbegin', icon(n.dataset.ico));
  }
  const mark = root.querySelector?.('#brandMark');
  if (mark && !mark.firstElementChild) mark.innerHTML = logoMark(44);
}

// ------------------------------------------------------------------ routing
function route() {
  const h = location.hash || '';
  let m;
  // An ORGANISATION link, which is the one the operator hands out. It places the
  // person in the org and every open server in it, then the directory shows them
  // the rest. Matched before #/join/ because that pattern would swallow it.
  if ((m = h.match(/#\/join-org\/([^/?#]+)/))) return { kind: 'joinOrg', token: decodeURIComponent(m[1]) };
  if ((m = h.match(/#\/join\/([^/?#]+)/))) return { kind: 'join', token: decodeURIComponent(m[1]) };
  if ((m = h.match(/#\/m\/([0-9a-f-]{36})\/(\d+)/i))) return { kind: 'message', channelId: m[1], seq: +m[2] };
  if ((m = h.match(/#\/c\/([0-9a-f-]{36})/i))) return { kind: 'channel', channelId: m[1] };
  return { kind: 'none' };
}

async function applyRoute() {
  const r = route();
  if (r.kind === 'channel') {
    const c = store.channels.find((x) => x.id === r.channelId);
    if (c) await openChannel(c);
  } else if (r.kind === 'message') {
    const c = store.channels.find((x) => x.id === r.channelId);
    if (c) await openChannel(c, { jumpSeq: r.seq });
  } else if (r.kind === 'joinOrg' || r.kind === 'join') {
    // An invite opened by somebody who is ALREADY signed in and has the app on
    // screen. A URL that differs only in its fragment does not reload the page,
    // so main() never runs again and enter()'s redeem never happens - the hash
    // just changed and nothing at all occurred. That is the ordinary case for
    // this product, because the link is pasted into a chat that people read on
    // the phone they are already signed in on, and it made the org links look
    // dead for exactly the people most likely to click one.
    await redeemFromRoute(r);
  }
  if (r.kind !== 'none') history.replaceState(null, '', location.pathname + location.search);
}

// One redeem path, used by the cold-start route in enter() and by a hash change
// on a running app.
async function redeemFromRoute(r) {
  try {
    if (r.kind === 'joinOrg') {
      const org = await api.rpc('redeem_org_invite', { p_token: extractToken(r.token) });
      await loadSpaces();
      const s = store.spaces.find((x) => x.org_id === org?.id);
      if (s && s.id !== store.ws?.id) await switchWorkspace(s);
      toast('You are in ' + (org?.name || 'the organisation'), 'success');
    } else {
      const ws = await api.redeemInvite(extractToken(r.token));
      await loadSpaces();
      const s = store.spaces.find((x) => x.id === ws?.id);
      if (s && s.id !== store.ws?.id) await switchWorkspace(s);
      toast('You are in ' + (ws?.name || 'the Space'), 'success');
    }
  } catch (e) {
    toast(inviteError(e), 'error');
  }
}

// Someone opening an invite link who is not signed in has to detour through
// email. The mail app usually opens the sign-in link in a NEW tab, and
// sessionStorage is per-tab, so the invite would be silently lost and they would
// land in the demo Space wondering where their organisation went. localStorage
// survives the round trip; the 30 minute TTL stops a stale token from hijacking
// an unrelated sign-in days later.
const INVITE_KEY = 'hearth.pendingInvite';
const INVITE_TTL_MS = 30 * 60 * 1000;

function stashPendingInvite(token) {
  try {
    localStorage.setItem(INVITE_KEY, JSON.stringify({ token, at: Date.now() }));
  } catch { /* private mode: the in-URL token still works on this tab */ }
}

function takePendingInvite() {
  try {
    const raw = localStorage.getItem(INVITE_KEY);
    if (!raw) return null;
    localStorage.removeItem(INVITE_KEY);
    const { token, at } = JSON.parse(raw);
    return Date.now() - at < INVITE_TTL_MS ? token : null;
  } catch { return null; }
}

// The in-URL path reads its token from the hash and never calls
// takePendingInvite, so the copy main() stashed before sign-in survives and gets
// redeemed again on the next reload inside the TTL.
function clearPendingInvite() {
  try { localStorage.removeItem(INVITE_KEY); } catch { /* private mode */ }
}

// What somebody sees when a link has already been used. The raw value is a
// Postgres exception string - `invite_exhausted`, or a row-level-security
// message - shown for 3.2 seconds and then gone. It is not readable and it does
// not say what to do, and with one-use links this is now the ORDINARY failure
// rather than a rare one: it is what a forwarded link looks like.
function inviteError(e) {
  const m = String(e?.message || '');
  if (/exhaust|max_uses|already used|uses_exceeded|no_uses/i.test(m)) {
    return 'That invite link has already been used. Ask for a fresh one - each link lets one person in.';
  }
  if (/expire/i.test(m)) return 'That invite link has expired. Ask for a fresh one.';
  if (/revoke/i.test(m)) return 'That invite link was cancelled. Ask for a fresh one.';
  if (/not.?found|invalid|no rows/i.test(m)) return 'That invite link is not valid. Check you copied all of it.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return 'No connection, so the invite could not be checked. Try again when you are back online.';
  }
  return 'That invite link did not work. Ask whoever sent it for a fresh one.';
}

// ------------------------------------------------------------------ enter
async function enter() {
  const s = await session();
  if (!s) { showAuth(); return; }
  // Before ANY round trip: draw the conversation this person was last reading,
  // from this phone's own storage, into the shell that is about to be shown.
  // Everything below - the password check, redeem_invite, the profile, the
  // bootstrap, the message page - is between five and fifteen seconds of
  // waiting on a bad line, and none of it is needed to show what they already
  // had. Measured on Slow 3G / 4x CPU: 15.4s to a painted message without this.
  store.me = s.user.id;
  // Showing the shell here is safe precisely because there IS a cached page:
  // only a user who has already signed in and finished any forced password
  // setup can have one. If the check below disagrees, showAuth() takes the
  // screen back.
  if (await paintLastChannelFromCache().catch(() => false)) showChat();
  // A session restored from storage can still be sitting on the temporary
  // password it was provisioned with - reloading the page must not be a way
  // around the forced reset.
  if (await needsPasswordSetup()) { showAuth(); showSetPassword(s.user.email); return; }
  sb.realtime.setAuth(s.access_token);

  // An invite in the URL is the whole multi-org story: open link, land in that
  // Space - or, for an organisation link, in that organisation and every open
  // server inside it.
  const r = route();
  const pendingRaw = (r.kind === 'join' || r.kind === 'joinOrg') ? r.token : takePendingInvite();
  const pendingIsOrg = r.kind === 'joinOrg' || (typeof pendingRaw === 'string' && pendingRaw.startsWith('org:'));
  const pending = pendingIsOrg && typeof pendingRaw === 'string'
    ? pendingRaw.replace(/^org:/, '') : pendingRaw;
  let joinedId = null;
  let joinedOrg = null;
  if (pending) {
    try {
      if (pendingIsOrg) {
        joinedOrg = await api.rpc('redeem_org_invite', { p_token: extractToken(pending) });
      } else {
        const wsRow = await api.redeemInvite(extractToken(pending));
        joinedId = wsRow?.id || null;
      }
    } catch (e) {
      toast(inviteError(e), 'error');
    }
    // SPEND THE TOKEN EXACTLY ONCE.
    //
    // The hash used to be left intact here, and applyRoute() further down this
    // same function matches `#/join/` and redeems again - so one human click on
    // one link called redeem_invite TWICE. A third time on any reload inside the
    // stash's 30 minute window, because the in-URL path never clears the stash
    // that main() wrote before sign-in.
    //
    // With an unlimited link nobody noticed: the second redeem was a no-op that
    // returned the same Space. The moment a link is good for one person, the
    // first call consumes it and the second fails, so the person joins
    // successfully and is then shown an error saying the link is not valid. If
    // the server counts attempts rather than successes it is worse than cosmetic
    // and the invite is genuinely burnt before anybody else can use it.
    //
    // Clearing the hash before applyRoute() sees it is the whole fix.
    history.replaceState(null, '', location.pathname + location.search);
    clearPendingInvite();
  }
  showChat();

  const { data: prof } = await sb.from('profiles')
    .select('*').eq('id', store.me).maybeSingle();
  store.myProfile = prof || { id: store.me, display_name: 'you' };
  store.profiles.set(store.me, store.myProfile);
  paintIdentity();

  subscribeUser(s.user.id);
  initPresence();

  await loadSpaces();

  // The demo Space is for someone who arrives cold with nowhere to go. It used
  // to be joined on EVERY sign-in that did not carry an invite token, which
  // meant a person provisioned into a real organisation was silently added to a
  // Space of 1571 strangers and, because the default below preferred the demo
  // slug, landed in it instead of their own. Only fall back to it when the
  // person genuinely belongs to nothing.
  // Somebody registered ahead of their organisation link - which is now the
  // normal way in, since accounts are created first and the org link is sent
  // after. Dropping them into a Space of 1571 strangers is worse than telling
  // them the truth, so the demo fallback is only for a session that has no
  // organisation either.
  // The demo Space used to catch anybody who belonged to nothing. It has 1770
  // members and 3095 messages, and dropping a new colleague into it was wrong
  // twice over: it is not their team, and it is by far the heaviest Space in the
  // project, so on a phone on mobile data the bootstrap for it is the slowest
  // thing the app ever does. When it did not finish, the shell had already
  // painted and the conversation had not - which is the blank screen people kept
  // reporting right after choosing their password. Somebody who belongs to
  // nothing now gets a screen that says so and can act on it.
  // An archived server, or one counting down to deletion, takes no new messages.
  // Opening into one is a dead room that reads as a broken app, and it is what
  // happened right after an admin deleted a server they were standing in.
  const live = (x) => !x.archived_at && !x.scheduled_delete_at;
  // Embedded, the host has already decided which room this is: a tech dashboard
  // docks the tech server. That beats every heuristic below, because those exist
  // to guess what somebody wanted and here nobody has to guess. It does NOT beat
  // an invite link the person just clicked - following a link they chose and
  // landing somewhere else is the one thing more confusing than a wrong default.
  const pinned = embed.active && !joinedId ? pinnedSpaceOf(store.spaces) : null;
  if (embed.active && embed.space && !pinned) {
    notifyHost('error', { where: 'pin', message: 'no Space matching ' + embed.space });
  }
  const active = pinned
    || store.spaces.find((x) => x.id === joinedId)
    // Straight into the organisation they just joined, not whichever Space is
    // oldest.
    || (joinedOrg ? store.spaces.find((x) => x.org_id === joinedOrg.id && live(x)) : null)
    || store.spaces.find((x) => x.slug !== 'demo' && live(x))
    || store.spaces.find(live)
    || store.spaces.find((x) => x.slug !== 'demo')
    || store.spaces[0];

  if (active) {
    document.body.classList.remove('no-team');
    await switchWorkspace(active);
    // A channel the host named in the iframe src, resolved once its Space is
    // loaded. Written into the hash so applyRoute() opens it by the one path
    // every other route uses.
    if (embed.active && embed.channel && !location.hash) {
      const c = store.channels.find((x) => x.id === embed.channel)
        || store.channels.find((x) => (x.name || '').toLowerCase() === String(embed.channel).toLowerCase());
      if (c) location.hash = '#/c/' + c.id;
    }
    await applyRoute();
  } else {
    renderChannels();
    // A route may still be pending - somebody who opened an org link, was sent
    // to sign in, and came back. Redeem it before concluding they have nothing.
    await applyRoute();
    if (!store.spaces.length) showNoTeam();
  }
  bus.emit('auth');
  paintInstallButton();
}

// ------------------------------------------------------------------ no team
// The screen for somebody who has an account and belongs to nothing yet. It has
// to do three things the old empty <div> did not: say plainly that this is not
// broken, give them something to DO without waiting for anybody, and accept the
// link in the form it actually reaches them - pasted whole out of WhatsApp,
// where nobody is going to extract a token from a URL by hand.
export function showNoTeam(msg) {
  const org = store.orgs[0];
  const box = $('messages');
  // Everything that only makes sense once you are in a Space comes off: the
  // channel bar with its lone "#", the Space search, the composer telling them
  // to "pick a channel" when there are none. Leaving that chrome around the
  // message is what still made it read as broken rather than as a step.
  document.body.classList.add('no-team');
  box.innerHTML = `
    <div class="noteam">
      <h2>${org ? `You are in ${esc(org.name)}` : 'You are signed in'}</h2>
      <p class="muted">${org
        ? 'You are not in any of its servers yet. Paste the invite your admin sent you, or ask them to add you to one.'
        : 'You are not part of a team yet. Paste the invite link or code your admin sent you.'}</p>
      <label class="field"><span class="field-label">Invite link or code</span>
        <input id="joinCode" placeholder="Paste the whole link, or just the code" autocomplete="off" /></label>
      <button id="joinGo" class="wide">Join</button>
      <div id="joinErr" class="autherr hidden"></div>
      <p class="muted fineprint">Nothing is wrong with your account and your password is saved.
        You just have not been added to a team yet.</p>
    </div>`;
  if (msg) { $('joinErr').textContent = msg; $('joinErr').classList.remove('hidden'); }

  const go = async () => {
    const raw = $('joinCode').value.trim();
    if (!raw) return;
    const btn = $('joinGo');
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = '…';
    $('joinErr').classList.add('hidden');
    try {
      // Accept every shape the same link arrives in: the full URL, the hash
      // alone, or the bare token. An org token and a Space token are different
      // RPCs and the link does not always say which, so try the org first and
      // fall back rather than making somebody guess which kind they were sent.
      const token = extractToken(raw);
      const isOrg = looksLikeOrgInvite(raw);
      let landed = null;
      if (isOrg) {
        const o = await api.rpc('redeem_org_invite', { p_token: token });
        landed = o?.name;
      } else {
        try {
          const ws = await api.redeemInvite(token);
          landed = ws?.name;
        } catch {
          const o = await api.rpc('redeem_org_invite', { p_token: token });
          landed = o?.name;
        }
      }
      await loadSpaces();
      const s = store.spaces[0];
      if (s) {
        document.body.classList.remove('no-team');
        await switchWorkspace(s);
        toast('You are in ' + (landed || s.name), 'success');
      } else {
        throw new Error('That invite was accepted but did not put you in a server. Ask your admin to add you to one.');
      }
    } catch (e) {
      $('joinErr').textContent = /not valid|invalid|expired|revoked/i.test(e.message || '')
        ? 'That link or code is not valid any more. Ask your admin for a fresh one.'
        : (e.message || 'Could not join with that');
      $('joinErr').classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = was;
    }
  };
  $('joinGo').onclick = go;
  $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

function subscribeUser(uid) {
  import('./sb.js').then(({ subscribe }) => {
    subscribe('user', 'user:' + uid, {
      mention: () => { refreshUnread(); flashTitle(); },
      unread: () => refreshUnread(),
      // set_status / clear_status broadcast here. This was an empty function, so
      // a status set on the phone never appeared on the laptop, and shell.js's
      // 'status:changed' listener had no publisher anywhere in the app - the
      // sidebar foot kept saying "Active" after a write that had succeeded.
      status: (p) => {
        store.myProfile = { ...(store.myProfile || {}), ...(p || {}), id: store.me };
        store.profiles.set(store.me, store.myProfile);
        bus.emit('status:changed');
        bus.emit('profiles');
      },
      // set_presence_status broadcasts the availability the same way, so a hold
      // chosen on one device is reflected on the other rather than being fought
      // over by two beats.
      presence: (p) => {
        if (p?.status) { store.myPresence = p.status; bus.emit('presence:mine', p.status); }
        bus.emit('status:changed');
      },
      claims_changed: async () => {
        const { data } = await sb.auth.refreshSession();
        if (data?.session) sb.realtime.setAuth(data.session.access_token);
      },
      // A direct message, on the topic this client holds for the whole session.
      // Until 0063 the only DM event was on dm:<conversation>, which nothing
      // subscribes to unless that exact conversation is already open - so a DM
      // reached a person only if they happened to be looking straight at it. This
      // is what makes one arrive while you are reading a channel, or in your other
      // Space, or with the phone in your pocket.
      dm: (p) => {
        refreshUnread();
        flashTitle();
        import('./core/channels.js').then(({ refreshDMList }) => refreshDMList?.());
        if (p?.conversation_id && p.conversation_id === store.currentDM) {
          import('./core/dms.js').then(({ reconcileDM }) => reconcileDM?.());
        }
      },
      reminder: (p) => toast('Reminder: ' + (p?.note || 'you asked to be reminded')),
    });
  });
}

let titleTimer = null;
function flashTitle() {
  if (document.visibilityState === 'visible') return;
  clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => {
    document.title = (on = !on) ? '● Soop' : 'Soop';
  }, 900);
  document.addEventListener('visibilitychange', function once() {
    clearInterval(titleTimer);
    document.title = 'Soop';
    document.removeEventListener('visibilitychange', once);
  });
}

// ------------------------------------------------------------------ quick switcher
function quickSwitcher() {
  const box = el('div', 'switcher');
  box.innerHTML = '<input id="qsInput" placeholder="Jump to a channel, person or command…" /><div id="qsRows"></div>';
  const m = modal({ title: '', body: box, wide: true });
  const input = box.querySelector('#qsInput');
  const rows = box.querySelector('#qsRows');
  let items = [];
  let idx = 0;

  const draw = () => {
    rows.innerHTML = items.map((it, i) =>
      `<div class="qs-row${i === idx ? ' sel' : ''}" data-i="${i}">
        <span class="qs-ico">${it.icon || ''}</span><span>${esc(it.label)}</span>
        <span class="muted">${esc(it.hint || '')}</span></div>`).join('');
    rows.querySelectorAll('.qs-row').forEach((n) => {
      n.onclick = () => { m.close(); items[+n.dataset.i].run(); };
    });
  };
  const run = () => {
    const q = input.value.replace(/^[#@>]/, '').trim();
    items = ui.getSwitcherSources().flatMap((s) => {
      try { return s.search(q) || []; } catch { return []; }
    }).slice(0, 12);
    idx = 0;
    draw();
  };
  input.oninput = run;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % Math.max(1, items.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % Math.max(1, items.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) { m.close(); items[idx].run(); } }
  };
  run();
}

// ------------------------------------------------------------------ shortcuts
function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); quickSwitcher(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openPanel('search', {}); return; }
    if (e.key === 'Escape') { closePopovers(); if (!typing) closePanel(); return; }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('composer')?.focus(); }
    // Shift+T cycles dark -> light -> colorful, for comparing them quickly.
    if (e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); cycleTheme(); }
  });
}

// ------------------------------------------------------------------ events
bus.on('thread:openById', async ({ threadId, channelId, rootMessageId }) => {
  const c = store.channels.find((x) => x.id === channelId);
  if (c && store.current?.id !== c.id) await openChannel(c, { keepPanel: true });
  const { data } = await sb.from('messages').select('*').eq('id', rootMessageId).maybeSingle();
  if (data) openThread(data);
});

bus.on('message:jump', async ({ messageId }) => {
  const { data } = await sb.from('messages').select('channel_id,seq').eq('id', messageId).maybeSingle();
  if (!data) return;
  const c = store.channels.find((x) => x.id === data.channel_id);
  if (c) openChannel(c, { jumpSeq: data.seq });
});

bus.on('message:editLast', async ({ id }) => {
  const m = store.msgCache.get(id);
  if (!m) return;
  const { formModal } = ui;
  const out = await formModal({
    title: 'Edit message',
    fields: [{ name: 'text', label: '', type: 'textarea', value: m.body_text, rows: 5, required: true }],
    submitLabel: 'Save',
  });
  if (out) api.edit(id, out.text).catch((e) => toast(e.message, 'error'));
});

// A thread reply the author chose to broadcast should show up in the channel
// immediately for them too.
bus.on('thread:alsoSent', ({ message }) => {
  if (!message || message.channel_id !== store.current?.id) return;
  import('./core/channels.js').then(({ reconcile }) => reconcile());
});

// ------------------------------------------------------------------ start
async function main() {
  // First, before a single pixel: whether this is a standalone tab or a panel
  // inside a dashboard changes the layout, the identity source and which chrome
  // exists at all, and a panel that flashes the standalone app for one frame
  // before correcting itself looks broken in exactly the place it can least
  // afford to.
  initEmbed();
  // Asked to run inside a page that is not on the allowlist. embed.js has put
  // the reason on screen; carrying on would paint a sign-in card in a frame we
  // have just said we do not trust.
  if (embed.refused) return;

  // stash an invite arriving before sign-in so it survives the auth round trip
  const r = route();
  // The org variant is tagged so the far side of the email round trip knows
  // which RPC to redeem it with. Same 30 minute TTL, same reason.
  if (r.kind === 'join') stashPendingInvite(r.token);
  if (r.kind === 'joinOrg') stashPendingInvite('org:' + r.token);

  initTheme();
  hydrateIcons(document);
  initAuth(enter);
  initComposer();
  initVoice();
  initShortcuts();
  wireScroll();
  registerCoreActions();
  registerCoreHeader();
  // Await it: features register header buttons and panels, and a button that
  // appears a second after the app paints reads as a glitch.
  await registerFeatures({ ui, api, store, bus, sb });
  renderHeaderButtons();
  // A panel inside a dashboard is not a thing you install, and it must not be a
  // thing that registers a service worker: the SW is scoped to the whole origin,
  // so an embed installing one would start serving a cached shell to the
  // standalone app in another tab, on a version the person never chose. The
  // standalone app owns that decision.
  if (!embed.active) initPWA();

  $('panelClose').onclick = closePanel;
  $('btnInvite').onclick = () => inviteDialog();
  $('btnSpaces').onclick = spaceChooser;
  $('btnMembersCount').onclick = () => openPanel('members');

  // Binds the global bar, the channel bar overflow and the user menus. This was
  // imported but never called for several deploys, which left the search field,
  // the More menu, both identity menus and 12 of the 16 registered header
  // buttons completely unclickable - most of the app looked present and did
  // nothing.
  initShell();
  bus.on('invite:open', () => inviteDialog());
  $('installBtn').onclick = () => import('./pwa.js').then((m) => m.promptInstall());

  // Mobile: the sidebar is off-canvas until asked for, and any navigation
  // inside it should close it again.
  $('navToggle').onclick = () => document.body.classList.toggle('nav-open');
  $('sidebar').addEventListener('click', (e) => {
    if (e.target.closest('.chan')) document.body.classList.remove('nav-open');
  });
  $('messages').addEventListener('click', () => document.body.classList.remove('nav-open'));

  // Awaited nowhere, so a rejection anywhere on the sign-in path - loadSpaces,
  // switchWorkspace, openChannel - was an unhandled rejection that main().catch
  // could never see. What the person got was a half-drawn shell and silence.
  const bootFailed = (e) => {
    console.error('[soop] sign-in path failed', e);
    toast('Something went wrong loading your Spaces. Reload to try again.', 'error');
  };

  const s = await session();
  if (s) { enter().catch(bootFailed); return; }

  // Embedded with nobody signed in yet. The dashboard already knows who this
  // person is, so the sign-in card is the wrong answer to a question that is
  // about to be answered for us - it just has not arrived yet. Wait for it,
  // saying so, and only fall back to the card if the host never speaks or its
  // handover fails. Someone who reaches that fallback can still sign in by hand,
  // which is the right last resort and a much better one than a dead panel.
  if (embed.active) {
    document.documentElement.classList.add('embed-awaiting-auth');
    const wait = el('div', 'embed-wait');
    wait.innerHTML = '<div class="embed-wait-in"><b>Connecting you to Soop</b>'
      + '<div style="margin-top:6px">Signing in with your dashboard account.</div></div>';
    document.body.appendChild(wait);

    const give = (msg) => {
      wait.remove();
      document.documentElement.classList.remove('embed-awaiting-auth');
      if (msg) toast(msg, 'error');
      showAuth();
    };
    // Long enough to cover a host that fetches a handoff token from its own
    // backend on a slow line, short enough that a misconfigured embed does not
    // just spin forever with no way for the person to do anything about it.
    const giveUp = setTimeout(() => give(null), 15000);

    bus.on('embed:authed', () => { clearTimeout(giveUp); wait.remove();
      document.documentElement.classList.remove('embed-awaiting-auth');
      enter().catch(bootFailed); });
    bus.on('embed:authFailed', ({ message }) => { clearTimeout(giveUp);
      give('Your dashboard could not sign you in: ' + message); });
    return;
  }

  showAuth();
}

window.addEventListener('hashchange', () => {
  if (store.me) applyRoute();
});

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="padding:20px;color:#f88">Soop failed to start:\n${esc(e.stack || e.message)}</pre>`;
});
