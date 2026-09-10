// Later: where a team sees its work.
//
// This is the fourth tab on every phone in the organisation, and eight tasks
// exist. Total. Across every workspace, since the feature shipped. Nobody was
// confused about the button; there was nothing on the other side of it worth
// coming back to, and three concrete reasons why:
//
//   1. YOU COULD NOT WRITE A TASK DOWN. create_task took a message id and
//      refused without one, so the only way to make work was to find something
//      somebody had already typed and convert it. A lead who wants to write
//      "call the twelve patients from Tuesday" had nowhere to put it. Migration
//      0126 adds create_task_in_channel, and the + New task row here is the
//      thing that was missing.
//   2. YOU COULD NOT PICK UP UNCLAIMED WORK. update_task gates on being the
//      manager, assignee or creator, and unclaimed work has no assignee - so an
//      ordinary member looking at a job nobody had taken could only look at it.
//      0126 adds claim_task; "Up for grabs" is the surface for it.
//   3. THERE WAS NO VIEW OF ANYONE ELSE. Every one of list_tasks' filters is a
//      question about the caller. A pod lead could not ask who is carrying what,
//      which is the first question a lead has. 0126 adds team_workload.
//
// So the panel is three answers, in the order somebody wants them:
//
//   Mine        what do I have to do
//   Team        who has what, and what is stuck or unowned
//   Up for grabs  what can I take
//
// and one verb at the top of all three. It is deliberately not a kanban board:
// this is read on a 390px phone by volunteers between other jobs, and a column
// you have to drag things between is a laptop idea.
import { table, tryRpc, rpc } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { el, esc, fmt, plain, relTime, debounce } from '../util.js';
import { icon } from '../icons.js';

const PANEL = 'later';
const BTN = 'later';
const SEC_KEY = 'dak.later.sec.';
const VIEW_KEY = 'dak.later.view';
const INTRO_KEY = 'dak.later.intro';

const STATES = [
  { key: 'todo', label: 'To do', hint: 'Messages you have not started on yet.' },
  { key: 'in_progress', label: 'In progress', hint: 'Things you have picked up but not finished.' },
  { key: 'done', label: 'Done', hint: 'Finished items stay here until you remove them.' },
];

const VIEWS = [
  { key: 'mine', label: 'Mine' },
  { key: 'team', label: 'Team' },
  { key: 'grabs', label: 'Up for grabs' },
];

const readView = () => (VIEWS.some((v) => v.key === localStorage.getItem(VIEW_KEY))
  ? localStorage.getItem(VIEW_KEY) : 'mine');

// The badge only ever counts To do - a queue that counts "done" is not a queue.
let todoCount = 0;

function style() {
  if (document.getElementById('later-css')) return;
  const s = el('style');
  s.id = 'later-css';
  // Current tokens, not the retired --panel3/--dim/--line names this file used
  // to inject. Those only resolved through the compatibility shim at the top of
  // css/panels.css, which meant every rule here was one deleted shim away from
  // computing to `unset`.
  s.textContent = `
    .later-sec{display:flex;align-items:center;gap:var(--s-3);cursor:pointer;user-select:none}
    .later-sec:hover{color:var(--c-text)}
    .later-n{margin-left:auto;background:var(--c-surface-3);color:var(--c-text-2);
      border-radius:var(--r-full);padding:0 var(--s-3);font-size:var(--t-2xs);letter-spacing:0}
    .later-item{border-bottom:var(--bw) solid var(--c-border)}
    .later-item .body{font-size:var(--t-base);max-height:96px;overflow:hidden}
    .later-meta{font-size:var(--t-sm);display:flex;gap:var(--s-3);flex-wrap:wrap;align-items:center}
    .later-bar{gap:var(--s-2);flex-wrap:wrap;margin-top:var(--s-4)}
    .later-bar button{font-size:var(--t-sm)}
    .later-when{color:var(--c-warn)}
    .later-over{color:var(--c-danger)}
    /* The clock sits inside a run of text rather than alone in a button, so it
       has to lay out as a glyph does. The base .ico rule is display:block, which
       would drop the time onto its own line under the icon. */
    .later-when .ico,.later-over .ico{display:inline-block;width:13px;height:13px;
      margin:0;vertical-align:-2px}
    .later-badge{margin-left:var(--s-2);vertical-align:top}
    .later-done .body{opacity:.55;text-decoration:line-through}

    /* The three views. A segmented control rather than a row of tabs: there are
       exactly three and there will not be a fourth, and on a phone a segment is
       a thumb target where a tab is a guess. */
    .later-seg{display:flex;gap:var(--s-1);margin-bottom:var(--s-4);padding:var(--s-1);
      border-radius:var(--r-full);background:var(--c-surface-2)}
    .later-seg button{flex:1;min-height:34px;padding:var(--s-2) var(--s-3);border:none;
      border-radius:var(--r-full);background:none;color:var(--c-text-2);box-shadow:none;
      font-size:var(--t-sm);font-weight:var(--t-semibold);white-space:nowrap}
    .later-seg button:hover{background:var(--c-surface-3);color:var(--c-text)}
    .later-seg button.on{background:var(--c-surface);color:var(--c-text);box-shadow:var(--e-1)}
    .later-seg .later-segn{margin-left:var(--s-2);opacity:.7;font-weight:var(--t-normal)}

    /* The verb. Above everything, in all three views, because writing work down
       is the thing this surface exists for and it was the thing you could not
       do. Same shape as the DM panel's New message row, deliberately. */
    .later-new{display:flex;align-items:center;justify-content:flex-start;gap:var(--s-3);
      width:100%;min-height:0;margin:0 0 var(--s-4);padding:var(--s-4);
      border:var(--bw) dashed var(--c-border);border-radius:var(--r-md);background:none;
      color:var(--c-accent);font-size:var(--t-base);font-weight:var(--t-semibold);
      text-align:left;box-shadow:none;cursor:pointer}
    .later-new:hover{background:var(--c-surface-2);border-style:solid}
    .later-new .plus{display:inline-flex;flex:none;align-items:center;justify-content:center;
      width:28px;height:28px;border-radius:var(--r-full);background:var(--c-accent-quiet)}

    /* What this tab is for, for somebody opening it the first time. Shown until
       it is dismissed, and again whenever there is no work at all - which is
       exactly when an explanation is worth more than an empty list. */
    .later-intro{border:var(--bw) solid var(--c-border);border-radius:var(--r-md);
      padding:var(--s-5);margin-bottom:var(--s-5);background:var(--c-surface-2)}
    .later-intro h5{margin:0 0 var(--s-3);font-size:var(--t-md);font-weight:var(--t-semibold)}
    .later-intro ul{margin:0;padding-left:var(--s-6);color:var(--c-text-2);
      font-size:var(--t-sm);line-height:var(--t-body)}
    .later-intro li{margin-bottom:var(--s-2)}
    .later-introline{display:flex;align-items:center;gap:var(--s-4);margin-bottom:var(--s-4);
      padding:var(--s-3) var(--s-4);border-radius:var(--r-md);background:var(--c-surface-2);
      color:var(--c-text-2);font-size:var(--t-sm);line-height:var(--t-snug)}
    .later-introline span{flex:1;min-width:0}
    .later-introline button{flex:none}

    /* Team view. One row per person, and the numbers that matter first: what is
       late, then what is stuck, then the size of the pile. */
    .later-tile{display:flex;align-items:center;gap:var(--s-4);width:100%;
      padding:var(--s-4);margin-bottom:var(--s-3);border:var(--bw) solid var(--c-border);
      border-radius:var(--r-md);background:none;color:var(--c-text);box-shadow:none;
      font-size:var(--t-base);text-align:left;cursor:pointer}
    .later-tile:hover{background:var(--c-surface-2)}
    .later-tile b{font-weight:var(--t-semibold)}
    .later-tile .later-tilen{margin-left:auto;flex:none;color:var(--c-text-2);
      font-size:var(--t-sm)}
    .later-person{display:flex;align-items:center;gap:var(--s-4);padding:var(--s-4) var(--s-3);
      border-bottom:var(--bw) solid var(--c-border-subtle,var(--c-border))}
    .later-person .who{flex:1;min-width:0;font-weight:var(--t-semibold);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .later-person .nums{flex:none;display:flex;gap:var(--s-3);font-size:var(--t-sm);
      color:var(--c-text-2)}
    .later-person .nums .bad{color:var(--c-danger);font-weight:var(--t-semibold)}
    .later-person .nums .stuck{color:var(--c-warn);font-weight:var(--t-semibold)}`;
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
  // This rewrites the whole button, so it has to redraw the SAME icon the
  // registration hands ui.js. It used to paint an emoji tray over the SVG, which
  // meant the button quietly changed shape the first time a count landed.
  const want = queueCount > 0
    ? `${icon('inbox')}<span class="badge later-badge">${queueCount > 99 ? '99+' : queueCount}</span>`
    : icon('inbox');
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

// ------------------------------------------------------------------ new task
// The one thing this surface could not do. It posts into a channel, because a
// task nobody sees is not a task - see the header of migration 0126 for why the
// message is load-bearing rather than decorative.
async function newTaskDialog(ui, redraw) {
  if (!store.ws) { ui.toast('Open a Space first', 'info'); return; }
  const channels = store.channels
    .filter((c) => c.kind !== 'voice' && !c.archived_at)
    .sort((a, z) => String(a.name).localeCompare(String(z.name)));
  if (!channels.length) { ui.toast('There is no channel to put a task in yet', 'info'); return; }

  // Everyone in the Space, me first, and "anyone" as the default - unclaimed
  // work is the normal case for a volunteer team and it should be the cheapest
  // thing to type.
  const people = [...store.profiles.values()]
    .filter((p) => p.id !== store.me && !p.is_app)
    .sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)));
  const who = [
    { value: '', label: 'Anyone can pick this up' },
    { value: store.me, label: 'Me' },
    ...people.map((p) => ({ value: p.id, label: nameOf(p.id) })),
  ];

  const out = await ui.formModal({
    title: 'New task',
    note: 'It is posted in the channel you choose, so the team can see it and talk about it.',
    fields: [
      // formModal honours min/max, not maxlength, so a cap written that way is
      // silently ignored and the only enforcement is the server. Both, then:
      // the trim below and a translated error if it still gets through.
      { name: 'title', label: 'What needs doing', required: true,
        placeholder: 'Call the twelve patients from Tuesday' },
      { name: 'channel', label: 'In which channel', type: 'select',
        value: store.current?.id || channels[0].id,
        options: channels.map((c) => ({ value: c.id, label: '#' + c.name })) },
      { name: 'assignee', label: 'Who is doing it', type: 'select', value: '', options: who },
      { name: 'due', label: 'By when', type: 'date',
        hint: 'Optional. A task with no date is not late, it is just waiting.' },
    ],
    submitLabel: 'Add task',
  });
  if (!out) return;
  const title = (out.title || '').trim();
  if (!title) return;

  try {
    // End of the chosen day, in the reader's own zone: "by Friday" means the end
    // of Friday to a person and midnight to a Date, and marking somebody late at
    // 00:01 on the day they were given is how a tool loses trust.
    let due = null;
    if (out.due) { const d = new Date(out.due + 'T23:59:59'); if (!Number.isNaN(+d)) due = d.toISOString(); }
    await rpc('create_task_in_channel', {
      p_channel: out.channel,
      p_title: title,
      p_assignee: out.assignee || null,
      p_due_at: due,
      p_note: null,
    });
    ui.toast(out.assignee ? 'Task added and posted in the channel' : 'Task added - anyone can pick it up', 'success');
    bus.emit('later:changed');
    redraw();
  } catch (e) {
    ui.toast(taskError(e), 'error');
  }
}

// The server's words are codes. These are the three a person can actually do
// something about; anything else falls through to whatever it said.
function taskError(e) {
  const m = String(e?.message || '');
  if (/policy_forbidden:task.assign_other/.test(m)) {
    return 'Your organisation only lets certain people hand tasks to others. Leave it for anyone to pick up, or ask an admin.';
  }
  if (/assignee_cannot_see_channel/.test(m)) return 'That person cannot see that channel, so they would never find the task.';
  if (/already_claimed/.test(m)) return 'Somebody else picked that up first.';
  if (/task_closed/.test(m)) return 'That task is already finished.';
  if (/forbidden|42501/.test(m)) return 'You cannot post in that channel.';
  if (/title_too_long/.test(m)) return 'That title is too long. Keep it to a line - the detail can go in the channel.';
  if (/title_required/.test(m)) return 'Give it a name first.';
  if (/rate_limit/.test(m)) return 'Slow down a moment - too many tasks at once.';
  return m || 'That did not work';
}

// ------------------------------------------------------------------ panel
export function register({ ui, api }) {
  style();
  watchHeader();

  ui.registerPanel({
    id: PANEL,
    title: 'Later',
    async render(body, ctx) {
      const view = ctx?.view || readView();
      localStorage.setItem(VIEW_KEY, view);
      body.innerHTML = '<div class="muted pad">loading…</div>';

      const redraw = () => ui.openPanel(PANEL, { view });
      const go = (v) => ui.openPanel(PANEL, { view: v });

      // One read of the personal queue whichever view is showing, because the
      // segment counts have to be honest even while you are looking at Team.
      const [[raw], [tasksRaw], [grabsRaw], [workRaw]] = await Promise.all([
        tryRpc('get_later', {}),
        store.ws ? tryRpc('list_tasks', {
          p_workspace: store.ws.id, p_filter: 'mine', p_channel: null, p_include_done: false }) : Promise.resolve([[]]),
        store.ws ? tryRpc('list_tasks', {
          p_workspace: store.ws.id, p_filter: 'unclaimed', p_channel: null, p_include_done: false }) : Promise.resolve([[]]),
        store.ws ? tryRpc('team_workload', { p_workspace: store.ws.id }) : Promise.resolve([null]),
      ]);
      if (!Array.isArray(raw)) {
        body.innerHTML = '<div class="empty">Could not load your queue.</div>';
        return;
      }
      let rows = Array.isArray(raw) ? raw : [];
      const tasks = Array.isArray(tasksRaw) ? tasksRaw : [];
      const grabs = Array.isArray(grabsRaw) ? grabsRaw : [];
      const work = workRaw && typeof workRaw === 'object' ? workRaw : null;
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
      const plain0 = rows.filter((r) => !isTask(r));

      todoCount = plain0.filter((r) => (r.state || 'todo') === 'todo').length;
      queueCount = overdue.length + today.length + waiting.length + todoCount;
      paintBadge();

      body.innerHTML = '';

      // ---- the three views ----
      const seg = el('div', 'later-seg');
      const counts = { mine: queueCount, team: 0, grabs: grabs.length };
      for (const v of VIEWS) {
        const b = el('button', v.key === view ? 'on' : '');
        b.type = 'button';
        b.innerHTML = `${esc(v.label)}${counts[v.key] ? `<span class="later-segn">${counts[v.key]}</span>` : ''}`;
        b.onclick = () => go(v.key);
        seg.appendChild(b);
      }
      body.appendChild(seg);

      // ---- the verb, above everything, in every view ----
      const add = el('button', 'later-new');
      add.type = 'button';
      add.innerHTML = '<span class="plus">＋</span><span>New task</span>';
      add.onclick = () => newTaskDialog(ui, redraw);
      body.appendChild(add);

      // ---- what this is, while somebody still needs telling ----
      const nothingAtAll = !rows.length && !grabs.length;
      // The full explanation only where there is nothing else to look at.
      // Otherwise one line, because four bullets and a button is half a phone
      // screen spent on something the person can see for themselves the moment
      // there is any work on it.
      if (nothingAtAll) body.appendChild(introCard(true, redraw));
      else if (localStorage.getItem(INTRO_KEY) !== 'off') {
        body.appendChild(introLine(redraw));
      }

      if (view === 'team') { renderTeam(body, work, grabs, go, ui); return; }
      if (view === 'grabs') { renderGrabs(body, grabs, redraw, ui); return; }

      // ---- Mine ----
      if (!rows.length) {
        body.appendChild(el('div', 'empty',
          'Nothing is waiting on you. Work given to you lands here, and so does '
          + 'anything you save from a message with <b>⋯ Save for later</b>.'));
      }

      const taskSection = (key, label, items) => {
        if (!items.length) return;
        section(body, key, label, items.length, (host) => {
          for (const r of items) host.appendChild(taskCard(r, redraw, ui));
        });
      };

      taskSection('overdue', 'Late',
        overdue.sort((a, b) => new Date(a.task.due_at) - new Date(b.task.due_at)));
      taskSection('today', 'Due today',
        today.sort((a, b) => new Date(a.task.due_at) - new Date(b.task.due_at)));
      taskSection('waiting', 'Yours to move', waiting);

      for (const s of STATES) {
        // Task-backed rows live in the sections above; only plain saved items
        // walk the To do / In progress / Done flow here.
        const items = plain0.filter((r) => (r.state || 'todo') === s.key);
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

  // The tray, not `bookmark`. Core's own "Saved and Later" header button is
  // already a bookmark (js/core/actions.js), and two buttons sitting a few pixels
  // apart in the same row cannot wear the same picture and still mean two things.
  ui.addHeaderButton({
    id: BTN, label: icon('inbox'), title: 'Later queue', order: 90,
    onClick: () => ui.openPanel(PANEL, {}),
  });

  bus.on('auth', refreshCount);
  bus.on('workspace', refreshCount);
  // 'later:changed' was emitted by this file and by quicktask.js and nobody
  // listened, so claiming or adding work left a stale badge until the 90 second
  // timer came round. Debounced because a burst of changes is one change.
  const soon = debounce(() => refreshCount(), 400);
  bus.on('later:changed', soon);
  bus.on('tasks:count', soon);
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

// ------------------------------------------------------------------ intro
function introLine(redraw) {
  const box = el('div', 'later-introline');
  box.innerHTML = `<span><b>Mine</b> is yours, <b>Team</b> is everyone's,
    <b>Up for grabs</b> is free to take.</span>`;
  const hide = el('button', 'sm ghost', 'Got it');
  hide.type = 'button';
  hide.onclick = () => { localStorage.setItem(INTRO_KEY, 'off'); redraw(); };
  box.appendChild(hide);
  return box;
}

function introCard(empty, redraw) {
  const box = el('div', 'later-intro');
  box.innerHTML = `<h5>${empty ? 'This is where the work lives' : 'What Later is for'}</h5>
    <ul>
      <li><b>Mine</b> is what you have to do, soonest first.</li>
      <li><b>Team</b> is who is carrying what, and what is late or stuck.</li>
      <li><b>Up for grabs</b> is work nobody has taken. Tap it and it is yours.</li>
      <li>Anything you turn into a task is posted in its channel, so the team
        can see it and talk about it there.</li>
    </ul>`;
  const row = el('div', 'row gap');
  row.style.marginTop = 'var(--s-4)';
  const hide = el('button', 'sm ghost', 'Got it');
  hide.type = 'button';
  hide.onclick = () => { localStorage.setItem(INTRO_KEY, 'off'); redraw(); };
  row.appendChild(hide);
  box.appendChild(row);
  return box;
}

// ------------------------------------------------------------------ team
// The view list_tasks structurally cannot produce: every one of its filters is
// a question about the caller. team_workload (0126) is the one that is not.
function renderTeam(body, work, grabs, go, ui) {
  if (!work) {
    body.appendChild(el('div', 'empty',
      'The team view needs a newer server than this one. Everything else here still works.'));
    return;
  }

  // The three facts a lead acts on, before any per-person detail: work nobody
  // owns, work that is stuck, work that is late. Each one is a door.
  const tile = (label, n, tone, onClick) => {
    const b = el('button', 'later-tile');
    b.type = 'button';
    b.innerHTML = `<b>${n}</b> <span>${esc(label)}</span>
      <span class="later-tilen">${onClick ? 'Show' : ''}</span>`;
    if (tone && n > 0) b.querySelector('b').style.color = tone;
    if (onClick) b.onclick = onClick; else b.disabled = true;
    return b;
  };

  body.appendChild(el('h4', 'sec', 'Right now'));
  body.appendChild(tile(work.unclaimed === 1 ? 'thing nobody has picked up' : 'things nobody has picked up',
    work.unclaimed || 0, 'var(--c-accent)', work.unclaimed ? () => go('grabs') : null));
  body.appendChild(tile(work.blocked === 1 ? 'thing is stuck' : 'things are stuck',
    work.blocked || 0, 'var(--c-warn)',
    work.blocked ? () => ui.openPanel('tasks', { tab: 'blocked' }) : null));
  body.appendChild(tile(work.overdue === 1 ? 'thing is late' : 'things are late',
    work.overdue || 0, 'var(--c-danger)',
    work.overdue ? () => ui.openPanel('tasks', { tab: 'all' }) : null));
  body.appendChild(tile('finished in the last seven days', work.done_7d || 0, null, null));

  const people = Array.isArray(work.people) ? work.people : [];
  if (!people.length) {
    body.appendChild(el('div', 'empty',
      'Nobody is carrying anything yet. Add a task with <b>+ New task</b> and give it '
      + 'to somebody, or leave it for anyone to pick up.'));
    return;
  }

  body.appendChild(el('h4', 'sec', `Who has what - ${people.length}`));
  for (const p of people) {
    const row = el('div', 'later-person');
    // Late first, stuck second, size last: that is the order somebody reads them
    // in when deciding who to go and talk to.
    const nums = [
      p.overdue ? `<span class="bad">${p.overdue} late</span>` : '',
      p.blocked ? `<span class="stuck">${p.blocked} stuck</span>` : '',
      `<span>${p.open} open</span>`,
    ].filter(Boolean).join('');
    row.innerHTML = `<span class="who">${esc(nameOf(p.user_id))}</span>
      <span class="nums">${nums}</span>`;
    body.appendChild(row);
  }
}

// ------------------------------------------------------------------ up for grabs
function renderGrabs(body, grabs, redraw, ui) {
  if (!grabs.length) {
    body.appendChild(el('div', 'empty',
      'Nothing is waiting to be picked up. When somebody adds a task and leaves it '
      + 'for <b>anyone</b>, it appears here for the whole team to see.'));
    return;
  }
  body.appendChild(el('h4', 'sec', `Nobody has taken these - ${grabs.length}`));
  for (const t of grabs) {
    const card = el('div', 'result later-item');
    const overdue = t.due_at && new Date(t.due_at).getTime() <= Date.now();
    card.innerHTML = `
      <div class="muted later-meta">
        <b>${esc(t.title || 'Task')}</b>
        <span>in #${esc(t.channel_name || 'a channel')}</span>
        ${t.due_at ? `<span class="${overdue ? 'later-over' : 'later-when'}">${esc(dueLabel(t.due_at))}</span>` : ''}
        <span>asked by ${esc(nameOf(t.created_by))}</span>
      </div>
      ${t.note ? `<div class="body">${fmt(plain(t.note, 200))}</div>` : ''}`;

    const bar = el('div', 'row gap later-bar');
    const take = el('button', 'sm', "I'll do it");
    take.type = 'button';
    take.onclick = async (e) => {
      e.stopPropagation();
      take.disabled = true;
      try {
        await rpc('claim_task', { p_task: t.id });
        ui.toast('Yours. It is in Mine now.', 'success');
        bus.emit('later:changed');
        redraw();
      } catch (err) {
        take.disabled = false;
        ui.toast(taskError(err), 'error');
        // Somebody beat us to it, so the list on screen is already wrong.
        if (/already_claimed/.test(String(err?.message || ''))) redraw();
      }
    };
    bar.appendChild(take);

    const jump = el('button', 'sm ghost', 'See the message');
    jump.type = 'button';
    jump.onclick = (e) => { e.stopPropagation(); bus.emit('message:jump', { messageId: t.message_id }); };
    bar.appendChild(jump);

    card.appendChild(bar);
    body.appendChild(card);
  }
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
      ${r.remind_at ? `<span class="later-when">${icon('clock')} ${esc(whenText(r.remind_at))}</span>` : ''}
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

// The line under the title, or nothing.
//
// A task made with + New task carries the same words in both places - the title
// IS the message, because create_task_in_channel posts the title - so the card
// printed it twice and ate a third of a phone screen saying one thing. Only show
// the body when it says something the title does not.
function bodyUnder(t, r) {
  if (t.blocker_note) return `<div class="body later-over">${esc(plain(t.blocker_note, 160))}</div>`;
  const body = plain(r.body_text || '', 240).trim();
  const title = String(t.title || '').trim();
  if (!body) return '';
  const same = body === title
    || body === 'Task: ' + title
    || body.startsWith('Task: ' + title)
    || title.startsWith(body);
  return same ? '' : `<div class="body">${fmt(body)}</div>`;
}

// A task-backed queue row. It used to only read and jump, on the grounds that
// the Tasks board owns the state machine - which is true and was also why
// finishing something you had done meant leaving this surface, finding the other
// one, and finding the row again. The two verbs that close the loop live here
// now; everything else still belongs to the board.
function taskCard(r, redraw, ui) {
  const t = r.task;
  const card = el('div', 'result later-item');
  const overdue = new Date(t.due_at || 0).getTime() <= Date.now();
  card.innerHTML = `
    <div class="muted later-meta">
      <b>${esc(t.title || r.body_text?.slice(0, 60) || 'Task')}</b>
      <span>in #${esc(r.channel_name || t.channel_name || 'unknown')}</span>
      ${t.due_at ? `<span class="${overdue ? 'later-over' : 'later-when'}">${esc(dueLabel(t.due_at))}</span>` : ''}
      ${t.state === 'in_progress' ? '<span>started</span>' : ''}
      ${t.state === 'blocked' ? '<span class="later-over">stuck</span>' : ''}
    </div>
    ${bodyUnder(t, r)}`;

  const bar = el('div', 'row gap later-bar');
  const act = async (label, fn) => {
    const b = el('button', 'sm ghost', label);
    b.type = 'button';
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try { await fn(); bus.emit('later:changed'); redraw(); }
      catch (err) { b.disabled = false; ui.toast(taskError(err), 'error'); }
    };
    bar.appendChild(b);
  };

  if (t.state !== 'in_progress' && t.state !== 'blocked') {
    act('Start', () => rpc('set_task_state', { p_task: t.id, p_state: 'in_progress' }));
  }
  const done = el('button', 'sm', 'Done');
  done.type = 'button';
  done.onclick = async (e) => {
    e.stopPropagation();
    done.disabled = true;
    try {
      await rpc('set_task_done', { p_task: t.id, p_done: true });
      ui.toast('Finished', 'success');
      bus.emit('later:changed');
      redraw();
    } catch (err) {
      done.disabled = false;
      // A blocked task refuses to be closed until the blocker is cleared, which
      // is the right rule and a terrible error message.
      ui.toast(/blocked_not_cleared/.test(String(err?.message || ''))
        ? 'This is marked stuck. Clear what is blocking it on the Tasks board first.'
        : taskError(err), 'error');
    }
  };
  bar.appendChild(done);

  const open = el('button', 'sm ghost', 'More');
  open.type = 'button';
  open.title = 'Hand it on, change the date, or say what is blocking it';
  open.onclick = (e) => { e.stopPropagation(); ui.openPanel('tasks', { tab: 'mine' }); };
  bar.appendChild(open);

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
        <span class="${overdue ? 'later-over' : 'later-when'}">${icon('clock')} ${esc(whenText(r.remind_at))}
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
