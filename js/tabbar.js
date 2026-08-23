// Mobile bottom tab bar. Slack's phone shell keeps Home / DMs / Activity one
// thumb away; Dek buried everything behind a hamburger, which the gap matrix
// ranked the number-one week-one trust killer. This module adds the bar, wires
// each tab to machinery that already exists (openChannel, dm:request,
// openPanel), derives the active state from the same stores those paths write,
// and gets out of the way on desktop, in embeds, and before sign-in.
import { store, bus } from './store.js';
import { $, el } from './util.js';

const TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'dms', label: 'DMs', icon: 'dm' },
  { id: 'activity', label: 'Activity', icon: 'bell' },
  { id: 'later', label: 'Later', icon: 'bookmark' },
];

let active = 'home';
let root = null;

function iconFor(id) {
  // Inline glyphs instead of icons.js: the bar paints before feature modules
  // register and must never depend on registration order.
  switch (id) {
    case 'home': return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>';
    case 'dms': return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.2-.6L3 21l1.7-4.6A8.4 8.4 0 1 1 21 11.5z"/></svg>';
    case 'activity': return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
    case 'later': return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
    default: return '';
  }
}

function unreadBadge() {
  let mentions = 0;
  for (const v of store.unread.values()) mentions += v?.mention_count || 0;
  const dm = (store.dms || []).reduce((n, d) => n + (typeof d.unread === 'number' ? d.unread : (d.unread ? 1 : 0)), 0);
  return { home: mentions || [...store.unread.values()].some((v) => v?.unread), dms: dm };
}

function paint() {
  if (!root) return;
  const badges = unreadBadge();
  root.querySelectorAll('.tab').forEach((b) => {
    const id = b.dataset.tab;
    b.classList.toggle('on', id === active);
    const dot = b.querySelector('.tab-dot');
    if (!dot) return;
    const show = id === 'home' ? badges.home : id === 'dms' ? badges.dms > 0 : false;
    dot.classList.toggle('show', !!show);
    dot.textContent = id === 'dms' && badges.dms > 99 ? '99+' : '';
  });
}

async function go(id) {
  document.body.classList.remove('nav-open');       // drawer closed by any tab
  try { const ui = await import('./ui.js'); ui.closePopovers?.(); } catch {}
  active = id;
  paint();
  if (id === 'home') {
    const c = store.current || store.channels.find((x) => !x.archived_at);
    if (c) { const { openChannel } = await import('./core/channels.js'); openChannel(c); }
    else bus.emit('channel:list');
  } else if (id === 'dms') {
    // A DM list surface, not a blind jump: opening the sidebar drawer scoped to
    // conversations beats guessing which conversation they meant.
    if (store.currentDM) { const { openDM } = await import('./core/dms.js'); openDM(store.currentDM); }
    else { document.body.classList.add('nav-open'); }
  } else {
    const { openPanel } = await import('./ui.js');
    openPanel(id === 'later' ? 'later' : 'activity');
  }
}

export function initTabBar() {
  if (root) return;
  root = el('nav', 'tabbar');
  root.id = 'tabbar';
  root.innerHTML = TABS.map((t) => `
    <button class="tab" data-tab="${t.id}" type="button" aria-label="${t.label}">
      ${iconFor(t.id)}<span>${t.label}</span><i class="tab-dot"></i>
    </button>`).join('');
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) go(b.dataset.tab);
  });
  $('#chat')?.appendChild(root);

  bus.on('unread', paint);
  bus.on('spaces:badges', paint);
  bus.on('channel:open', () => { active = 'home'; paint(); });
  bus.on('dm:open', () => { active = 'dms'; paint(); });
  bus.on('panel:close', paint);
  bus.on('panel:open', ({ id }) => { if (id === 'activity' || id === 'later') { active = id; paint(); } });
  paint();
}
