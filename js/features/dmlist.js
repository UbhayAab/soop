// The phone's DMs tab used to fall back to opening the whole sidebar drawer,
// which buries conversations under channels, voice rooms and org chrome. This
// registers a dedicated panel instead: every conversation one tap away,
// newest activity first, unread state read from the same store the sidebar and
// tab bar already paint from - so there is exactly one source of truth.
//
// It listed only people who had already written to you, and the only way to
// start a NEW conversation was a "+ New message" button in the panel FOOTER,
// which on a phone was painted underneath the floating tab bar - present,
// untappable, and reported as "there is no option to start a DM". So the route
// people actually found was Members -> the person -> their card -> Message.
//
// The fix is the search box and the New message row at the top of the body: the
// search covers the whole Space, not just the conversations, and somebody you
// have never written to appears in it with "Start a conversation" beside their
// name.
//
// The footer button is GONE rather than kept as a second door. Fixing the
// footer's own geometry left two identically-worded buttons in one short panel,
// one at each end, and reported straight back as such. One panel, one verb, and
// it is the one above the fold.
import { store, bus, nameOf } from '../store.js';
import { el, esc, relTime, debounce } from '../util.js';
import { avatarHtml, roleTagHtml } from '../core/messages.js';
import { startDM } from '../core/dms.js';

const PANEL = 'dms';

// Survives a repaint. The unread and badge events below re-render the panel
// underneath whoever is typing in it, and losing the query mid-search - which is
// what happens if this lives in the closure - reads as the box clearing itself.
let query = '';

function style() {
  if (document.getElementById('dmlist-css')) return;
  const s = el('style');
  s.id = 'dmlist-css';
  s.textContent = `
    .dmrow{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer}
    .dmrow:hover,.dmrow.on{background:var(--panel3)}
    .dmrow .who{flex:1;min-width:0}
    .dmrow .nm{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dmrow .sub{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dmrow .badge{margin-left:auto}
    .dmrow .dot-unread{margin-left:auto}
    .dmstack{display:flex;align-items:center}
    .dmstack .avatar{margin-left:-10px;border:2px solid var(--panel)}
    .dmstack .avatar:first-child{margin-left:0}
    /* The new-message row. Deliberately the first thing under the search box and
       styled as an action rather than as another conversation, because it is the
       one row in this panel that is not a person you already talk to. */
    /* justify-content, explicitly: the base button rule centres its content, so
       without this the row's ＋ and its label float in the middle and stop
       lining up with the avatars and names directly underneath. */
    .dmnew{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%;
      min-height:0;margin:0 0 6px;padding:9px 10px;
      border:1px dashed var(--line);border-radius:8px;background:none;color:var(--accent);
      font-weight:600;font-size:13.5px;text-align:left;box-shadow:none;cursor:pointer}
    .dmnew:hover{background:var(--panel3);border-style:solid}
    /* 34px, the width of the avatar in the rows below, so the label starts on the
       same vertical line as every name in the list. */
    .dmnew .plus{display:inline-flex;flex:none;align-items:center;justify-content:center;
      width:34px;height:34px;border-radius:50%;background:var(--panel3);font-weight:700}
    .dmsearch{width:100%;margin-bottom:8px}
    .dmsec{margin:12px 4px 4px;color:var(--dim);font-size:11px;font-weight:700;
      letter-spacing:.06em;text-transform:uppercase}
    .dmsec:first-child{margin-top:2px}`;
  document.head.appendChild(s);
}

// Same three-state unread reading as renderChannels in channels.js: bootstrap
// sends a JSON boolean, refreshDMList normalises to 0/1, and anything numeric
// above one carries a count. Copying the logic beats inventing a second truth.
function unreadOf(d) {
  const on = d.unread === true || +d.unread > 0;
  const n = typeof d.unread === 'number' && d.unread > 1 ? d.unread : null;
  return { on, n };
}

const othersOf = (d) => (d.other_user_ids || []).filter((u) => u !== store.me);

function avatarsFor(d) {
  const others = othersOf(d);
  if (!others.length) return '<span class="ch-ico">@</span>';
  if (others.length === 1) return avatarHtml(others[0], 34);
  // A group shows its first two faces stacked; names stay in the row label.
  return `<span class="dmstack">${others.slice(0, 2).map((u) => avatarHtml(u, 30)).join('')}</span>`;
}

function row(d) {
  const others = othersOf(d);
  const label = others.length ? others.map(nameOf).join(', ') : 'you';
  const { on, n } = unreadOf(d);
  const ts = Date.parse(d.last_message_at || '') || 0;
  const r = el('div', 'dmrow' + (store.currentDM === d.conversation_id ? ' on' : ''));
  r.innerHTML = `${avatarsFor(d)}
    <span class="who"><span class="nm">${esc(label)}${others.length === 1 ? roleTagHtml(others[0]) : ''}</span>
      <span class="sub">${others.length > 1 ? esc(`group · ${others.length} people`) : ''}
        ${ts ? `<span>${esc(relTime(d.last_message_at))}</span>` : ''}</span></span>
    ${on ? (n ? `<span class="badge">${n}</span>` : '<span class="dot-unread"></span>') : ''}`;
  r.onclick = () => bus.emit('dm:request', { conversationId: d.conversation_id });
  r.dataset.dm = d.conversation_id;
  return r;
}

// Somebody in this Space you have no conversation with yet. Same row shape as
// above so the two lists read as one list, with the verb instead of a timestamp.
function personRow(p) {
  const r = el('div', 'dmrow');
  r.innerHTML = `${avatarHtml(p.id, 34)}
    <span class="who"><span class="nm">${esc(nameOf(p.id))}${roleTagHtml(p.id)}</span>
      <span class="sub">${p.username ? esc('@' + p.username) + ' · ' : ''}Start a conversation</span></span>
    ${store.online.has(p.id) ? '<span class="dot on"></span>' : ''}`;
  r.onclick = () => startDM(p.id);
  return r;
}

function matches(q, ...fields) {
  if (!q) return true;
  return fields.some((f) => (f || '').toLowerCase().includes(q));
}

// Newest conversation first; a never-written row sorts by name so the empty
// list still reads stably instead of shuffling between opens.
function sortedDMs() {
  return [...store.dms].sort((a, b) => {
    const ta = Date.parse(a.last_message_at || '') || 0;
    const tb = Date.parse(b.last_message_at || '') || 0;
    if (ta !== tb) return tb - ta;
    return (nameOf(othersOf(a)[0]) || '').localeCompare(nameOf(othersOf(b)[0]) || '');
  });
}

async function render(body) {
  body.innerHTML = '';

  const search = el('input', 'dmsearch');
  search.type = 'search';
  search.placeholder = 'Search people, or start a new conversation';
  search.setAttribute('aria-label', 'Search conversations and people');
  search.value = query;

  const newBtn = el('button', 'dmnew');
  newBtn.type = 'button';
  newBtn.innerHTML = '<span class="plus">＋</span><span>New message</span>';
  newBtn.onclick = () => bus.emit('dm:new');

  const list = el('div');
  body.append(search, newBtn, list);

  const draw = () => {
    const q = query.trim().toLowerCase();
    list.innerHTML = '';

    const convs = sortedDMs().filter((d) =>
      matches(q, ...othersOf(d).map(nameOf), ...othersOf(d).map((u) => store.profiles.get(u)?.username)));

    // Everyone in the Space you are not already in a one-to-one with. Only ever
    // shown for an actual query: an unsearched list of a hundred colleagues under
    // the six people you talk to is not a DM list.
    const spokenTo = new Set();
    for (const d of store.dms) {
      const o = othersOf(d);
      if (o.length === 1) spokenTo.add(o[0]);
    }
    const people = !q ? [] : [...store.profiles.values()]
      .filter((p) => p.id !== store.me && !p.is_app && !spokenTo.has(p.id))
      .filter((p) => matches(q, p.display_name, p.username, store.nicknames.get(p.id)))
      .sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)))
      .slice(0, 20);

    if (!convs.length && !people.length) {
      list.appendChild(el('div', 'empty', q
        ? `Nobody in this Space matches "${esc(q)}".`
        : 'No conversations yet. Pick <b>New message</b> above, or type a name in the '
          + 'box to find anyone in this Space.'));
      return;
    }

    if (convs.length) {
      if (q) list.appendChild(el('div', 'dmsec', 'Conversations'));
      for (const d of convs) list.appendChild(row(d));
    }
    if (people.length) {
      list.appendChild(el('div', 'dmsec', 'Start a new conversation'));
      for (const p of people) list.appendChild(personRow(p));
    }
  };

  // 150ms is the same debounce the Members panel uses: under the threshold where
  // typing feels laggy and well over the rate a phone keyboard fires at.
  const onType = debounce(() => { query = search.value; draw(); }, 150);
  search.addEventListener('input', onType);
  // Enter with exactly one person matched opens them. The fastest path to a
  // first message is then: tap DMs, type three letters, press go.
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    query = search.value;
    const only = list.querySelectorAll('.dmrow');
    if (only.length === 1) { e.preventDefault(); only[0].click(); }
  });
  draw();
}

export function register(app) {
  style();

  app.ui.registerPanel({
    id: PANEL,
    title: 'Direct messages',
    // A fresh open is a fresh search. Carrying the last query across would open
    // the panel already filtered to something typed ten minutes ago.
    render: (body, ctx) => { query = ctx?.keepQuery ? query : ''; return render(body); },
  });

  // While the panel is open, mirror the same signals the tab bar badge uses so
  // unread dots move live. Both are no-ops when some other surface is up.
  const repaint = () => {
    if (app.ui.currentPanel() !== PANEL) return;
    const body = document.getElementById('panelContent');
    if (!body) return;
    // Never steal the caret. A repaint while somebody is mid-word replaces the
    // input element under them, and re-focusing after the fact is what makes a
    // phone keyboard flicker; if they are typing, the list they are looking at
    // is already the one they asked for.
    if (document.activeElement?.classList?.contains('dmsearch')) return;
    render(body).catch(() => {});
  };
  bus.on('unread', repaint);
  bus.on('spaces:badges', repaint);
  bus.on('profiles', repaint);
}
