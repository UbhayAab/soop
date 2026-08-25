// Later: the queue you actually work out of.
//
// Core already ships a combined "Saved & Later" list (panel id `saved`). That one
// is a reading list; this one is a work surface - three states you move an item
// through, the reminders you scheduled sitting next to them, and a jump straight
// back to where each message came from. It registers its own panel and header
// button ids so both can live side by side without touching core.
import { table, tryRpc } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { el, esc, fmt, plain, relTime } from '../util.js';
import { icon } from '../icons.js';

const PANEL = 'later';
const BTN = 'later';
const SEC_KEY = 'hearth.later.sec.';

const STATES = [
  { key: 'todo', label: 'To do', hint: 'Messages you have not started on yet.' },
  { key: 'in_progress', label: 'In progress', hint: 'Things you have picked up but not finished.' },
  { key: 'done', label: 'Done', hint: 'Finished items stay here until you remove them.' },
];

// The badge only ever counts To do - a queue that counts "done" is not a queue.
let todoCount = 0;

function style() {
  if (document.getElementById('later-css')) return;
  const s = el('style');
  s.id = 'later-css';
  s.textContent = `
    .later-sec{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
    .later-sec:hover{color:var(--dim)}
    .later-n{margin-left:auto;background:var(--panel3);color:var(--dim);border-radius:9px;
      padding:0 6px;font-size:10.5px;letter-spacing:0}
    .later-item{border-bottom:1px solid var(--line)}
    .later-item .body{font-size:13.5px;max-height:96px;overflow:hidden}
    .later-meta{font-size:12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .later-bar{gap:5px;flex-wrap:wrap;margin-top:7px}
    .later-bar button{font-size:12px}
    .later-when{color:var(--amber)}
    .later-over{color:var(--red)}
    .later-badge{margin-left:3px;vertical-align:top}
    .later-done .body{opacity:.55;text-decoration:line-through}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ badge
// One personal queue, one badge: overdue + due-today + waiting-on-me tasks
// plus plain to-do items. The Tasks board keeps its own count for its own
// surface; this is the number for "what is mine to move".
let queueCount = 0;

function paintBadge() {
  const btn = document.getElementById('hb-' + BTN);
  if (!btn) return;
  const want = queueCount > 0
    ? `📥<span class="badge later-badge">${queueCount > 99 ? '99+' : queueCount}</span>`
    : '📥';
  if (btn.innerHTML !== want) btn.innerHTML = want;
}

// Core rebuilds the whole header row whenever any feature adds a button, which
// wipes the badge. Watching the row is cheaper than fighting the render order.
function watchHeader() {
  const host = document.getElementById('headerActions');
  if (!host) return;
  new MutationObserver(paintBadge).observe(host, { childList: true });
}

async function refreshCount() {
  if (!store.me) return;
  const [[rows], [tasks]] = await Promise.all([
    tryRpc('get_later', {}),
    store.ws ? tryRpc('list_tasks', {
      p_workspace: store.ws.id, p_filter: 'mine', p_channel: null, p_include_done: false }) : Promise.resolve([[]]),
  ]);
  if (!Array.isArray(rows)) return;
  todoCount = rows.filter((r) => (r.state || 'todo') === 'todo').length;
  queueCount = todoCount
    + (Array.isArray(tasks) ? tasks.filter((t) => t.state !== 'in_review').length : 0);
  paintBadge();
}

// ------------------------------------------------------------------ data
// get_later does not return the author, so fill it in from the messages the
// queue points at. One extra round trip beats showing "someone" on every row.
async function withAuthors(rows) {
  const ids = [...new Set(rows.map((r) => r.message_id).filter(Boolean))];
  if (!ids.length) return rows;
  const msgs = await table('messages', (q) => q.in('id', ids));
  const by = new Map(msgs.map((m) => [m.id, m.author_id]));
  return rows.map((r) => ({ ...r, author_id: by.get(r.message_id) || null }));
}

function untilLabel(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

const whenText = (iso) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function dueLabel(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const unit = abs < 3600000 ? `${Math.round(abs / 60000)}m`
    : abs < 172800000 ? `${Math.round(abs / 3600000)}h`
    : `${Math.round(abs / 86400000)}d`;
  return ms <= 0 ? `${unit} overdue` : `due in ${unit}`;
}

// ------------------------------------------------------------------ panel
export function register({ ui, api }) {
  style();
  watchHeader();

  ui.registerPanel({
    id: PANEL,
    title: 'Later',
    async render(body) {
      body.innerHTML = '<div class="muted pad">loading…</div>';

      // One personal queue, read side: the saved queue plus my assigned tasks
      // joined on the message they came from. create_task already writes the
      // saved row server-side, so every assigned task shows up here carrying
      // its own facts - due dates and state - instead of as a bare todo.
      const [[raw], [tasksRaw]] = await Promise.all([
        tryRpc('get_later', {}),
        store.ws ? tryRpc('list_tasks', {
          p_workspace: store.ws.id, p_filter: 'mine', p_channel: null, p_include_done: false }) : Promise.resolve([[]]),
      ]);
      if (!Array.isArray(raw)) {
        body.innerHTML = `<div class="empty">Could not load your queue.</div>`;
        return;
      }
      let rows = Array.isArray(raw) ? raw : [];
      const tasks = Array.isArray(tasksRaw) ? tasksRaw : [];
      const byMsg = new Map(tasks.map((t) => [t.message_id, t]));
      rows = rows.map((r) => {
        const t = byMsg.get(r.message_id);
        return t ? { ...r, task: t } : r;
      });
      try { rows = await withAuthors(rows); } catch { /* names are a nicety, not the point */ }

      const now = Date.now();
      const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
      const isTask = (r) => r.task && r.task.state !== 'done';
      const hasDue = (r) => !!r.task.due_at;
      const dueMs = (r) => new Date(r.task.due_at).getTime();
      // No date is not an overdue date - undated work waits in its own section.
      const overdue = rows.filter((r) => isTask(r) && hasDue(r) && dueMs(r) <= now);
      const today = rows.filter((r) => isTask(r) && hasDue(r)
        && dueMs(r) > now && dueMs(r) <= endOfDay.getTime());
      // Assigned work with no date pressure: my move is the next move.
      const waiting = rows.filter((r) => isTask(r) && !overdue.includes(r) && !today.includes(r));

      todoCount = rows.filter((r) => !isTask(r) && (r.state || 'todo') === 'todo').length;
      queueCount = overdue.length + today.length + waiting.length + todoCount;
      paintBadge();

      const redraw = () => ui.openPanel(PANEL, {});

      body.innerHTML = '';

      if (!rows.length) {
        body.appendChild(el('div', 'empty',
          'Your Later queue is empty. Hover any message, open <b>⋯</b> and pick '
          + '<b>Save for later</b> to park it here, then work it through To do, '
          + 'In progress and Done.'));
      }

      const taskSection = (key, label, items) => {
        if (!items.length) return;
        section(body, key, label, items.length, (host) => {
          for (const r of items) host.appendChild(taskCard(r, redraw, ui));
        });
      };

      taskSection('overdue', 'Overdue',
        overdue.sort((a, b) => new Date(a.task.due_at) - new Date(b.task.due_at)));
      taskSection('today', 'Due today',
        today.sort((a, b) => new Date(a.task.due_at) - new Date(b.task.due_at)));
      taskSection('waiting', 'Waiting on me', waiting);

      for (const s of STATES) {
        // Task-backed rows live in the sections above; only plain saved items
        // walk the To do / In progress / Done flow here.
        const items = rows.filter((r) => !isTask(r) && (r.state || 'todo') === s.key);
        // An empty queue already explained itself above; do not repeat it three times.
        if (!rows.length) break;
        section(body, s.key, s.label, items.length, (host) => {
          if (!items.length && s.key !== 'done') { host.appendChild(el('div', 'empty', esc(s.hint))); return; }
          for (const r of items) host.appendChild(itemCard(r, s.key, redraw, ui, api));
        });
      }

      await remindersSection(body, redraw, ui, api);
    },
  });

  ui.addHeaderButton({
    id: BTN, label: icon('bookmark'), title: 'Later queue', order: 90,
    onClick: () => ui.openPanel(PANEL, {}),
  });

  bus.on('auth', refreshCount);
  bus.on('workspace', refreshCount);
  // Core's "Save for later" menu item does not announce itself, so a slow beat
  // keeps the badge honest without hammering the server - and only while
  // somebody can actually see the badge. Returning to the tab refreshes at once.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    refreshCount();
  }, 90000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshCount();
  });
  refreshCount();
}

function section(host, key, title, count, build) {
  const collapsed = localStorage.getItem(SEC_KEY + key) === '0';
  const head = el('h4', 'sec later-sec',
    `<span>${collapsed ? '▸' : '▾'}</span><span>${esc(title)}</span><span class="later-n">${count}</span>`);
  const wrap = el('div');
  if (collapsed) wrap.style.display = 'none';
  head.onclick = () => {
    const now = wrap.style.display === 'none';
    wrap.style.display = now ? '' : 'none';
    head.firstElementChild.textContent = now ? '▾' : '▸';
    localStorage.setItem(SEC_KEY + key, now ? '1' : '0');
  };
  host.append(head, wrap);
  build(wrap);
}

function itemCard(r, stateKey, redraw, ui, api) {
  const card = el('div', 'result later-item' + (stateKey === 'done' ? ' later-done' : ''));
  const who = r.author_id ? nameOf(r.author_id) : 'someone';
  card.innerHTML = `
    <div class="muted later-meta">
      <b>${esc(who)}</b><span>in #${esc(r.channel_name || 'unknown')}</span>
      <span>· ${esc(relTime(r.created_at))}</span>
      ${r.remind_at ? `<span class="later-when">⏰ ${esc(whenText(r.remind_at))}</span>` : ''}
    </div>
    <div class="body">${fmt(plain(r.body_text, 240))}</div>`;

  const bar = el('div', 'row gap later-bar');
  for (const s of STATES) {
    const b = el('button', 'sm ghost' + (stateKey === s.key ? ' on' : ''), esc(s.label));
    b.title = 'Move to ' + s.label;
    b.onclick = async (e) => {
      e.stopPropagation();
      if (stateKey === s.key) return;
      try {
        await api.laterSetState(r.message_id, s.key);
        bus.emit('later:changed');
        redraw();
      } catch (err) { ui.toast(err.message, 'error'); }
    };
    bar.appendChild(b);
  }

  const jump = el('button', 'sm ghost', 'Jump');
  jump.title = 'Open the message in its channel';
  jump.onclick = (e) => { e.stopPropagation(); bus.emit('message:jump', { messageId: r.message_id }); };
  bar.appendChild(jump);

  const rm = el('button', 'sm ghost', 'Remove');
  rm.title = 'Take it off the queue';
  rm.onclick = async (e) => {
    e.stopPropagation();
    try {
      await api.laterRemove(r.message_id);
      bus.emit('later:changed');
      redraw();
    } catch (err) { ui.toast(err.message, 'error'); }
  };
  bar.appendChild(rm);

  card.appendChild(bar);
  card.onclick = () => bus.emit('message:jump', { messageId: r.message_id });
  return card;
}

// A task-backed queue row: the board owns the state machine, so this card
// reads and jumps - it does not offer the saved-item To do / Done buttons.
function taskCard(r, redraw, ui) {
  const t = r.task;
  const card = el('div', 'result later-item');
  const who = r.author_id ? nameOf(r.author_id) : 'someone';
  const overdue = new Date(t.due_at || 0).getTime() <= Date.now();
  card.innerHTML = `
    <div class="muted later-meta">
      <b>${esc(t.title || r.body_text?.slice(0, 60) || 'Task')}</b>
      <span>in #${esc(r.channel_name || t.channel_name || 'unknown')}</span>
      ${t.due_at ? `<span class="${overdue ? 'later-over' : 'later-when'}">${esc(dueLabel(t.due_at))}</span>` : ''}
      <span>${esc(t.state || '')}</span>
    </div>
    ${t.blocker_note ? `<div class="body later-over">${esc(plain(t.blocker_note, 160))}</div>`
      : `<div class="body">${fmt(plain(r.body_text || '', 240))}</div>`}`;

  const bar = el('div', 'row gap later-bar');
  const open = el('button', 'sm ghost', 'Open in Tasks');
  open.title = 'Work this on the Tasks board';
  open.onclick = (e) => { e.stopPropagation(); ui.openPanel('tasks', { tab: 'mine' }); };
  bar.appendChild(open);

  const jump = el('button', 'sm ghost', 'Jump');
  jump.title = 'Open the message in its channel';
  jump.onclick = (e) => { e.stopPropagation(); bus.emit('message:jump', { messageId: r.message_id }); };
  bar.appendChild(jump);

  card.appendChild(bar);
  card.onclick = () => bus.emit('message:jump', { messageId: r.message_id });
  return card;
}

// ------------------------------------------------------------------ reminders
// There is no list-reminders RPC, but the table is RLS-scoped to me, so reading
// it directly is both safe and the whole story.
async function remindersSection(body, redraw, ui, api) {
  const host = el('div');
  body.appendChild(el('h4', 'sec', 'Pending reminders'));
  body.appendChild(host);
  host.innerHTML = '<div class="muted pad">loading…</div>';

  let rows;
  try {
    rows = await table('reminders', (q) =>
      q.eq('fired', false).order('remind_at', { ascending: true }).limit(50));
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(e.message || 'could not load reminders')}</div>`;
    return;
  }

  if (!rows.length) {
    host.innerHTML = '<div class="empty">No reminders scheduled. '
      + 'Pick <b>Remind me…</b> from a message\'s <b>⋯</b> menu and it will show up here '
      + 'until it fires.</div>';
    return;
  }

  const ids = [...new Set(rows.map((r) => r.message_id).filter(Boolean))];
  const msgs = ids.length ? await table('messages', (q) => q.in('id', ids)) : [];
  const byId = new Map(msgs.map((m) => [m.id, m]));

  host.innerHTML = '';
  for (const r of rows) {
    const m = byId.get(r.message_id);
    const ch = store.channels.find((c) => c.id === r.channel_id);
    const overdue = new Date(r.remind_at).getTime() <= Date.now();
    const card = el('div', 'result later-item');
    card.innerHTML = `
      <div class="muted later-meta">
        <span class="${overdue ? 'later-over' : 'later-when'}">⏰ ${esc(whenText(r.remind_at))}
          · ${esc(untilLabel(r.remind_at))}</span>
        ${ch ? `<span>in #${esc(ch.name)}</span>` : ''}
      </div>
      ${r.note ? `<div class="body">${fmt(plain(r.note, 160))}</div>` : ''}
      <div class="body muted">${m ? fmt(plain(m.body_text, 160)) : 'the message is no longer visible to you'}</div>`;

    const bar = el('div', 'row gap later-bar');
    if (r.message_id) {
      const jump = el('button', 'sm ghost', 'Jump');
      jump.onclick = (e) => { e.stopPropagation(); bus.emit('message:jump', { messageId: r.message_id }); };
      bar.appendChild(jump);
    }
    const cancel = el('button', 'sm ghost', 'Cancel');
    cancel.onclick = async (e) => {
      e.stopPropagation();
      try { await api.cancelReminder(r.id); ui.toast('Reminder cancelled'); redraw(); }
      catch (err) { ui.toast(err.message, 'error'); }
    };
    bar.appendChild(cancel);
    card.appendChild(bar);
    host.appendChild(card);
  }
}
