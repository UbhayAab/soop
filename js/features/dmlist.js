// The phone's DMs tab used to fall back to opening the whole sidebar drawer,
// which buries conversations under channels, voice rooms and org chrome. This
// registers a dedicated panel instead: every conversation one tap away,
// newest activity first, unread state read from the same store the sidebar and
// tab bar already paint from - so there is exactly one source of truth.
//
// Starting a NEW conversation lives here too, at the top, as a search. The
// "+ New message" button used to sit in the panel footer, and on a phone the
// footer sat under the floating tab bar (css/layout.css reserved the tab bar's
// height for .content and not for the footer) - painted, unreachable, and
// reported as "there is no option to start a DM; I found it under Members ->
// person -> Message". The search finds anyone in the Space by name or handle
// and one tap starts the conversation; the button beside it opens the picker,
// which is still the way to start a group.
import { store, bus, nameOf } from '../store.js';
import { el, esc, relTime, debounce } from '../util.js';
import { avatarHtml, adminPillHtml } from '../core/messages.js';

const PANEL = 'dms';

function style() {
  if (document.getElementById('dmlist-css')) return;
  const s = el('style');
  s.id = 'dmlist-css';
  s.textContent = `
    .dmstart{display:flex;align-items:center;gap:8px;margin:0 0 8px}
    .dmstart input{flex:1 1 auto;min-width:0}
    .dmstart button{flex:none;white-space:nowrap}
    .dm-hint{margin:0 0 10px;font-size:11.5px;color:var(--dim)}
    .dmrow{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer}
    .dmrow:hover,.dmrow.on{background:var(--panel3)}
    .dmrow .who{flex:1;min-width:0}
    .dmrow .nm{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dmrow .nm .pill{margin-left:6px}
    .dmrow .sub{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dmrow .badge{margin-left:auto}
    .dmrow .dot-unread{margin-left:auto}
    .dmstack{display:flex;align-items:center}
    .dmstack .avatar{margin-left:-10px;border:2px solid var(--panel)}
    .dmstack .avatar:first-child{margin-left:0}`;
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
const labelOf = (d) => {
  const others = othersOf(d);
  return others.length ? others.map(nameOf).join(', ') : 'you';
};

function avatarsFor(d) {
  const others = othersOf(d);
  if (!others.length) return '<span class="ch-ico">@</span>';
  if (others.length === 1) return avatarHtml(others[0], 34);
  // A group shows its first two faces stacked; names stay in the row label.
  return `<span class="dmstack">${others.slice(0, 2).map((u) => avatarHtml(u, 30)).join('')}</span>`;
}

function row(d) {
  const others = othersOf(d);
  const label = labelOf(d);
  const { on, n } = unreadOf(d);
  const ts = Date.parse(d.last_message_at || '') || 0;
  const r = el('div', 'dmrow' + (store.currentDM === d.conversation_id ? ' on' : ''));
  r.innerHTML = `${avatarsFor(d)}
    <span class="who"><span class="nm">${esc(label)}${others.length === 1 ? adminPillHtml(others[0]) : ''}</span>
      <span class="sub">${others.length > 1 ? esc(`group · ${others.length} people`) : ''}
        ${ts ? `<span>${esc(relTime(d.last_message_at))}</span>` : ''}</span></span>
    ${on ? (n ? `<span class="badge">${n}</span>` : '<span class="dot-unread"></span>') : ''}`;
  r.onclick = () => bus.emit('dm:request', { conversationId: d.conversation_id });
  r.dataset.dm = d.conversation_id;
  return r;
}

// Newest conversation first; a never-written row sorts by name so the empty
// list still reads stably instead of shuffling between opens.
function sortedConversations() {
  return [...store.dms].sort((a, b) => {
    const ta = Date.parse(a.last_message_at || '') || 0;
    const tb = Date.parse(b.last_message_at || '') || 0;
    if (ta !== tb) return tb - ta;
    return (nameOf((a.other_user_ids || [])[0]) || '').localeCompare(nameOf((b.other_user_ids || [])[0]) || '');
  });
}

// A 1:1 that already exists with this person. The People section must not
// offer to "start" a conversation the list above is already showing.
function hasOneToOne(userId) {
  return store.dms.some((d) => {
    const others = othersOf(d);
    return others.length === 1 && others[0] === userId;
  });
}

// Anyone in this Space, by name, handle or the name you gave them. Online
// first, because "is she around" is usually the next question.
function matchingPeople(q) {
  return [...store.profiles.values()]
    .filter((p) => p.id && p.id !== store.me && !p.is_app)
    .filter((p) => (p.display_name || '').toLowerCase().includes(q)
      || (p.username || '').toLowerCase().includes(q)
      || nameOf(p.id).toLowerCase().includes(q))
    .filter((p) => !hasOneToOne(p.id))
    .sort((a, b) => (store.online.has(b.id) - store.online.has(a.id))
      || nameOf(a.id).localeCompare(nameOf(b.id)))
    .slice(0, 30);
}

function personRow(p) {
  const r = el('div', 'dmrow dm-person');
  const handle = p.username ? '@' + esc(p.username) + ' · ' : '';
  const presence = store.online.has(p.id) ? 'online · ' : '';
  r.innerHTML = `${avatarHtml(p.id, 34)}
    <span class="who"><span class="nm">${esc(nameOf(p.id))}${adminPillHtml(p.id)}</span>
      <span class="sub">${handle}${presence}start a conversation</span></span>`;
  r.dataset.user = p.id;
  r.onclick = () => bus.emit('dm:start', { userId: p.id });
  return r;
}

// The open panel's list painter, kept so a repaint on 'unread' redraws the
// rows and leaves whatever is typed in the search box alone.
let live = null;

async function render(body) {
  body.innerHTML = '';
  const bar = el('div', 'dmstart');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search people or conversations';
  search.setAttribute('aria-label', 'Search people or conversations');
  search.autocomplete = 'off';
  const compose = el('button', 'sm', '+ New message');
  compose.type = 'button';
  compose.title = 'Start a direct message or a group';
  compose.onclick = () => bus.emit('dm:new');
  bar.append(search, compose);
  const hint = el('div', 'dm-hint muted', 'Type a name to message anyone in this Space.');
  const list = el('div', 'dm-list');
  body.append(bar, hint, list);

  const draw = () => {
    const raw = search.value.trim();
    const q = raw.toLowerCase();
    hint.style.display = q ? 'none' : '';
    list.innerHTML = '';
    const convs = sortedConversations().filter((d) => !q || labelOf(d).toLowerCase().includes(q));
    const people = q ? matchingPeople(q) : [];
    if (!convs.length && !people.length) {
      list.appendChild(el('div', 'empty', q
        ? `Nobody here matches <b>${esc(raw)}</b>. Try part of a first name, or their @handle.`
        : 'No conversations yet. Type a name above to message anyone in this Space, '
          + 'or pick <b>New message</b> to start a group.'));
      return;
    }
    if (convs.length) {
      if (q) list.appendChild(el('h4', 'sec', 'Conversations'));
      for (const d of convs) list.appendChild(row(d));
    }
    if (people.length) {
      list.appendChild(el('h4', 'sec', 'People'));
      for (const p of people) list.appendChild(personRow(p));
    }
  };
  search.addEventListener('input', debounce(draw, 120));
  live = { draw };
  draw();
}

export function register(app) {
  style();

  app.ui.registerPanel({
    id: PANEL,
    title: 'Direct messages',
    render,
    onClose() { live = null; },
  });

  // While the panel is open, mirror the same signals the tab bar badge uses so
  // unread dots move live. Both are no-ops when some other surface is up.
  const repaint = () => {
    if (app.ui.currentPanel() !== PANEL) { live = null; return; }
    live?.draw();
  };
  bus.on('unread', repaint);
  bus.on('spaces:badges', repaint);
  bus.on('profiles', repaint);
  bus.on('admins', repaint);
}
