// The phone's DMs tab used to fall back to opening the whole sidebar drawer,
// which buries conversations under channels, voice rooms and org chrome. This
// registers a dedicated panel instead: every conversation one tap away,
// newest activity first, unread state read from the same store the sidebar and
// tab bar already paint from - so there is exactly one source of truth.
import { store, bus, nameOf } from '../store.js';
import { el, esc, relTime } from '../util.js';
import { avatarHtml } from '../core/messages.js';

const PANEL = 'dms';

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

function avatarsFor(d) {
  const others = (d.other_user_ids || []).filter((u) => u !== store.me);
  if (!others.length) return '<span class="ch-ico">@</span>';
  if (others.length === 1) return avatarHtml(others[0], 34);
  // A group shows its first two faces stacked; names stay in the row label.
  return `<span class="dmstack">${others.slice(0, 2).map((u) => avatarHtml(u, 30)).join('')}</span>`;
}

function row(d) {
  const others = (d.other_user_ids || []).filter((u) => u !== store.me);
  const label = others.length ? others.map(nameOf).join(', ') : 'you';
  const { on, n } = unreadOf(d);
  const ts = Date.parse(d.last_message_at || '') || 0;
  const r = el('div', 'dmrow' + (store.currentDM === d.conversation_id ? ' on' : ''));
  r.innerHTML = `${avatarsFor(d)}
    <span class="who"><span class="nm">${esc(label)}</span>
      <span class="sub">${others.length > 1 ? esc(`group · ${others.length} people`) : ''}
        ${ts ? `<span>${esc(relTime(d.last_message_at))}</span>` : ''}</span></span>
    ${on ? (n ? `<span class="badge">${n}</span>` : '<span class="dot-unread"></span>') : ''}`;
  r.onclick = () => bus.emit('dm:request', { conversationId: d.conversation_id });
  r.dataset.dm = d.conversation_id;
  return r;
}

async function render(body) {
  body.innerHTML = '<div class="muted pad">loading…</div>';

  // Newest conversation first; a never-written row sorts by name so the empty
  // list still reads stably instead of shuffling between opens.
  const rows = [...store.dms].sort((a, b) => {
    const ta = Date.parse(a.last_message_at || '') || 0;
    const tb = Date.parse(b.last_message_at || '') || 0;
    if (ta !== tb) return tb - ta;
    return (nameOf((a.other_user_ids || [])[0]) || '').localeCompare(nameOf((b.other_user_ids || [])[0]) || '');
  });

  body.innerHTML = '';
  if (!rows.length) {
    body.appendChild(el('div', 'empty',
      'No conversations yet. Pick <b>New message</b> below and choose someone '
      + 'from this Space to start one.'));
    return;
  }
  for (const d of rows) body.appendChild(row(d));
}

export function register(app) {
  style();

  app.ui.registerPanel({
    id: PANEL,
    title: 'Direct messages',
    render,
    async footer(foot) {
      foot.innerHTML = '';
      const b = el('button', 'sm', '+ New message');
      b.type = 'button';
      b.onclick = () => bus.emit('dm:new');
      foot.appendChild(b);
    },
  });

  // While the panel is open, mirror the same signals the tab bar badge uses so
  // unread dots move live. Both are no-ops when some other surface is up.
  const repaint = () => {
    if (app.ui.currentPanel() !== PANEL) return;
    const body = document.getElementById('panelContent');
    if (!body) return;
    render(body).catch(() => {});
  };
  bus.on('unread', repaint);
  bus.on('spaces:badges', repaint);
}
