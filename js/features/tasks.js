// Tasks out of a message.
//
// "Can someone collect the receipts?" gets three thumbs-up and is done by nobody.
// This turns any message into an assignment with one person's name and a due
// date, and keeps the ask and the commitment in the same place - the task always
// points back at the message it came from, so the discussion about the work IS
// the thread on that message, and there is no second place to go and read.
//
// THIS COMMENT USED TO SAY "two states, open and done. No projects, no boards, no
// dependencies, no subtasks", and it also said tasks land in the assignee's
// existing Later queue. The first half was long untrue; the second half is now
// PROVEN true - the exported create_task (supabase/migrations/0104_tasks_base.sql)
// inserts a saved_items row for the assignee on every accepted assignment, and
// nothing in this client calls later_add because it does not need to. The Later
// panel joins that saved row back onto the task at read time (step 21), so an
// assigned task shows up in your queue carrying its due date and state.
//
// What is actually here:
//   proposed    somebody asked; it is nobody's until accepted
//   accepted    owned, not started
//   in_progress owned and moving (the server may accept it; the client never
//               sends it, so this state is currently unreachable from the UI)
//   blocked     stuck, with a written reason, which is the whole point of it
//   in_review   done by the doer, waiting on whoever handed it out
//   done / rejected / cancelled
//
// The forecast on each card is arithmetic over finished tasks in this Space (see
// js/lib/forecast.js). Nobody is asked to estimate anything, because asking does
// not work.
//
// The cheap way IN is js/features/quicktask.js, which reads an ordinary sentence
// and offers to make it one of these.
import { rpc, tryRpc, table, api } from '../api.js';
import { store, bus, nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, plain, relTime, toLocalInput, fromLocalInput } from '../util.js';
import { icon } from '../icons.js';
import { getSub } from '../sb.js';
import { forecast } from '../lib/forecast.js';

const CLS = 'tsk';
const PANEL = 'tasks';

// message_id -> the open tasks hanging off it, so a message row can show a chip
// without a round trip per row.
const byMessage = new Map();
// Every task in the Space, finished ones included, kept from the last chip
// refresh. The forecast reads it; nothing else does.
let history = [];
let openCount = 0;
let uiRef = null;
const toastFn = (...a) => uiRef?.toast(...a);

function humanError(e) {
  const m = String(e?.message || '');
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'No connection. Try again when you are back online.';
  if (/assignee_cannot_see_channel/i.test(m)) return 'That person cannot see this channel, so they would never find the task.';
  if (/forbidden/i.test(m)) return 'Only the person who made this task, the person it is for, or a moderator can change it.';
  if (/not_found/i.test(m)) return 'That task is gone.';
  if (/rate_limited/i.test(m)) return 'Slow down a moment, then try again.';
  if (/title_too_long/i.test(m)) return 'That title is too long.';
  return 'That did not work. Try again in a moment.';
}
const toastErr = (e) => toastFn(humanError(e), 'error');

// ------------------------------------------------------------------ helpers
const isOverdue = (t) => !t.done_at && t.due_at && new Date(t.due_at).getTime() <= Date.now();

function dueLabel(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const d = Math.round(abs / 86400000);
  const h = Math.round(abs / 3600000);
  const m = Math.round(abs / 60000);
  const unit = abs < 3600000 ? `${m}m` : abs < 172800000 ? `${h}h` : `${d}d`;
  return ms <= 0 ? `${unit} overdue` : `due in ${unit}`;
}

// Who can be given this task.
//
// This CANNOT come from store.profiles. That map is "every profile this client
// has ever seen" across every Space it has ever opened - measured at 1183 entries
// on a freshly signed-in account whose only Space had two members - so the picker
// filled up with strangers, and create_task then refused them with
// `assignee_cannot_see_channel`. A picker whose entries mostly error is worse than
// no picker.
//
// So read workspace_members for the Space we are actually in (wm_select RLS lets a
// member see their own Space's roster and nothing else) and look the names up in
// the profiles map, which by then holds them. One small request per dialog open,
// which is the right trade against handing someone a list they cannot use.
const MAX_ASSIGNEES = 200;

async function assigneeOptions(keep = null) {
  const people = [];
  if (store.ws) {
    const mem = await table('workspace_members', (q) => q.eq('workspace_id', store.ws.id));
    const ids = mem.map((m) => m.user_id);
    // Anyone core has not cached yet - a volunteer who joined while this tab was
    // open - would otherwise render as "someone".
    const unknown = ids.filter((u) => !store.profiles.has(u));
    if (unknown.length) {
      for (const p of await table('profiles', (q) => q.in('id', unknown.slice(0, 500)))) {
        store.profiles.set(p.id, { ...(store.profiles.get(p.id) || {}), ...p });
      }
    }
    for (const id of ids) {
      const p = store.profiles.get(id) || {};
      if (p.is_ghost) continue;                       // deleted accounts cannot do a task
      people.push({ value: id, label: p.display_name || p.username || 'someone' });
    }
  }
  people.sort((a, z) => a.label.localeCompare(z.label));

  const list = people.slice(0, MAX_ASSIGNEES);
  // Me and the current holder must always be selectable even past the cap.
  for (const id of [keep, store.me]) {
    if (id && !list.some((o) => o.value === id)) {
      const found = people.find((o) => o.value === id);
      if (found) list.unshift(found);
    }
  }
  return [{ value: '', label: 'Nobody yet' }, ...list];
}

// ------------------------------------------------------------------ create
async function createDialog(msg) {
  const preset = plain(msg.body_text || '', 120);
  // Whether this organisation lets everybody hand work out. Asked before the
  // dialog opens so the form can say what pressing the button will actually do,
  // rather than accepting it and quietly turning it into something else.
  let mayAssignOthers = true;
  const [caps] = await tryRpc('my_capabilities', { p_workspace: store.ws?.id });
  if (caps && typeof caps['task.assign_other'] === 'boolean') {
    mayAssignOthers = caps['task.assign_other'];
  }

  const out = await uiRef.formModal({
    title: mayAssignOthers ? 'Make this a task' : 'Make this a task, or ask for one',
    note: mayAssignOthers ? null
      : 'Your organisation lets only certain people hand tasks to others. Choosing somebody '
        + 'else sends it to them as a request, and it reaches that person only once it is '
        + 'accepted. Choosing yourself always just works.',
    fields: [
      { name: 'title', label: 'What needs doing', value: preset, required: true,
        placeholder: 'Collect the receipts' },
      { name: 'assignee', label: 'Who is doing it', type: 'select', options: await assigneeOptions(),
        value: store.me,
        hint: mayAssignOthers
          ? 'They will see it in their Tasks list straight away.'
          : 'Yourself: starts immediately. Anybody else: goes as a request first.' },
      // No reminder is promised here. It used to say "They get one reminder when
      // it falls due", and nothing schedules one - not in this client and not in
      // any RPC it calls. Promising a nudge that never arrives is worse than
      // promising nothing, because the person stops watching for the thing
      // themselves. Say it again when the nudge ladder actually exists.
      { name: 'due', label: 'Due by (optional)', type: 'datetime-local',
        hint: 'Shown on the task, and it turns red when it passes. Leave blank for no deadline.' },
    ],
    submitLabel: 'Create task',
  });
  if (!out) return;

  try {
    const t = await rpc('create_task', {
      p_message: msg.id,
      p_title: out.title.trim() || null,
      p_assignee: out.assignee || null,
      p_due_at: out.due ? fromLocalInput(out.due) : null,
    });
    // Say which of the two things happened. "Task created" when what actually
    // happened is "request sent, and nobody has it yet" is the kind of small lie
    // that makes people think the app dropped their work.
    toastFn(t?.state === 'proposed'
      ? 'Asked for. Somebody who can accept it will see it under Requests.'
      : 'Task created', 'success');
    // Assignment announcement. Until a server trigger exists, THIS is what
    // actually reaches the assignee: an ordinary message riding the ordinary
    // mention path, so badge, activity feed and any future push all fire. The
    // resolver handles display names with spaces ("@Asha Kumar") natively.
    const chan = msg.channel_id || store.current?.id;
    if (t && t.state !== 'proposed' && out.assignee && out.assignee !== store.me && chan) {
      // No glyph in front of this one, and no icon() either. This string is not
      // chrome: it is the BODY of a real message that goes through api.send, is
      // stored, and is re-rendered by the markdown pipeline, by the activity feed
      // and by any push preview. An SVG has nowhere to survive that trip - the
      // sanitiser drops it and the raw markup stays in the row - so the words
      // carry the meaning, which they already did.
      const text = `Task for @${nameOf(out.assignee) || 'you'}: ${t.title || out.title.trim()}`
        + (t.due_at ? ` - due ${dueLabel(t.due_at)}` : '');
      api.send({
        channel: chan,
        nonce: crypto.randomUUID(),
        text,
        mentions: bus.resolveMentions ? bus.resolveMentions(text) : [],
      }).catch(() => { /* the task itself succeeded; the ping is best-effort */ });
    }
    await refreshChips();
    refreshCount();
  } catch (e) { toastErr(e); }
}

// ------------------------------------------------------------------ message chip
// One chip under the message, so the commitment lives where the ask was made.
function paintChip(host, tasks) {
  if (!tasks.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
  host.style.display = '';
  host.innerHTML = '';

  for (const t of tasks) {
    const chip = el('div', CLS + '-chip' + (t.done_at ? ' ' + CLS + '-chipdone' : '')
      + (isOverdue(t) ? ' ' + CLS + '-chiplate' : ''));
    const who = t.assignee_id ? nameOf(t.assignee_id) : 'nobody yet';
    chip.innerHTML = `${icon('check')}<span class="${CLS}-chiptext">${esc(t.title)}</span>
      <span class="${CLS}-chipwho">${esc(who)}</span>
      ${t.due_at ? `<span class="${CLS}-chipdue">${esc(dueLabel(t.due_at))}</span>` : ''}`;

    const mayFlip = t.assignee_id === store.me || t.created_by === store.me || hasPerm(PERM.MANAGE_MESSAGES);
    if (mayFlip) {
      const b = el('button', 'sm ghost', t.done_at ? 'Reopen' : 'Mark done');
      b.type = 'button';
      b.onclick = async (ev) => {
        ev.stopPropagation();
        b.disabled = true;
        try {
          await rpc('set_task_done', { p_task: t.id, p_done: !t.done_at });
          await refreshChips();
          refreshCount();
        } catch (e) { b.disabled = false; toastErr(e); }
      };
      chip.appendChild(b);
    }
    host.appendChild(chip);
  }
}

// The nonce problem this file used to solve by re-reading row.dataset.id on
// every paint is fixed at the source: core now emits message:idUpgraded when
// the optimistic id dies (messages.js, both swap sites), and the listener below
// re-stamps and repaints. slot.dataset.msg is therefore authoritative here.
function slotMessageId(slot) {
  return slot.dataset.msg;
}

// One workspace-scoped read repaints every chip on screen. Per-message lookups
// would be one request per rendered row, which on 3G is the wrong trade.
async function refreshChips() {
  if (!store.ws) return;
  const [rows] = await tryRpc('list_tasks', {
    p_workspace: store.ws.id, p_filter: 'all', p_channel: null, p_include_done: true });
  if (!Array.isArray(rows)) return;
  // This call already asks for every task in the Space including finished ones,
  // which is exactly the history the forecast needs. Keeping the rows means a
  // card can say when something will land without a second round trip, and
  // without the panel's own tab filter narrowing the reference class - "for me"
  // would otherwise forecast one person from one person's history, which is the
  // sample size the cascade in lib/forecast.js exists to avoid.
  history = rows;
  byMessage.clear();
  for (const t of rows) {
    if (!byMessage.has(t.message_id)) byMessage.set(t.message_id, []);
    byMessage.get(t.message_id).push(t);
  }
  for (const h of document.querySelectorAll('.' + CLS + '-slot')) {
    paintChip(h, byMessage.get(slotMessageId(h)) || []);
  }
}

function mount(msg, row) {
  if (!msg?.id || msg.conversation_id) return;
  const existing = row.querySelector('.' + CLS + '-slot');
  if (existing) {
    // Re-render of a row we already decorated: keep the node, refresh the id.
    if (existing.dataset.msg !== msg.id) {
      existing.dataset.msg = msg.id;
      paintChip(existing, byMessage.get(msg.id) || []);
    }
    return;
  }
  const body = row.querySelector('.body') || row;
  const slot = el('div', CLS + '-slot');
  slot.dataset.msg = msg.id;
  slot.style.display = 'none';
  body.appendChild(slot);
  const known = byMessage.get(msg.id);
  if (known) paintChip(slot, known);
}

// ------------------------------------------------------------------ panel
// "I asked for" was the old label on the assigned-by-me tab, which was wrong in
// both directions once requesting exists: asking for a task and handing one out
// are now different acts with different tabs.
const TABS = [
  { key: 'mine', label: 'For me', empty: 'Nothing is assigned to you. That is a good thing.' },
  { key: 'blocked', label: 'Stuck', empty: 'Nothing is stuck.' },
  { key: 'proposed', label: 'Requests', empty: 'Nobody has asked for anything.' },
  { key: 'review', label: 'To review', empty: 'Nothing is waiting on you.' },
  { key: 'assigned', label: 'I handed out', empty: 'You have not given anybody a task yet.' },
  { key: 'requested', label: 'I asked for', empty: 'You have not asked for anything.' },
  { key: 'all', label: 'Everything', empty: 'No tasks in this Space yet.' },
];

const STATE_LABEL = {
  proposed: 'waiting for a yes',
  accepted: 'not started',
  in_progress: 'in progress',
  blocked: 'stuck',
  in_review: 'waiting on a review',
  done: 'done',
  rejected: 'declined',
  cancelled: 'cancelled',
};
// Validated, not trusted: a stale value from an older build would make
// TABS.find() return undefined and throw while rendering the empty state.
let activeTab = TABS.some((t) => t.key === localStorage.getItem('dak.tasks.tab'))
  ? localStorage.getItem('dak.tasks.tab') : 'mine';

async function renderPanel(body, ctx = {}) {
  if (ctx.tab) activeTab = ctx.tab;
  body.innerHTML = '<div class="muted pad">loading…</div>';
  if (!store.ws) { body.innerHTML = '<div class="empty">Open a Space first.</div>'; return; }

  const bar = el('div', 'row gap ' + CLS + '-tabs');
  for (const t of TABS) {
    const b = el('button', 'sm ghost' + (t.key === activeTab ? ' on' : ''), esc(t.label));
    b.onclick = () => {
      activeTab = t.key;
      localStorage.setItem('dak.tasks.tab', t.key);
      uiRef.openPanel(PANEL, { tab: t.key });
    };
    bar.appendChild(b);
  }

  const [rows, err] = await tryRpc('list_tasks', {
    p_workspace: store.ws.id, p_filter: activeTab, p_channel: null, p_include_done: true });

  body.innerHTML = '';
  body.appendChild(bar);

  if (err) { body.appendChild(el('div', 'empty', esc(humanError(err)))); return; }

  const tabDef = TABS.find((t) => t.key === activeTab) || TABS[0];
  const list = rows || [];
  const open = list.filter((t) => !t.done_at);
  const done = list.filter((t) => t.done_at).slice(0, 25);
  openCount = activeTab === 'mine' ? open.length : openCount;

  if (!list.length) {
    const e = el('div', 'empty', esc(tabDef.empty) + '<br><br>');
    e.appendChild(document.createTextNode('To make one: press and hold a message '
      + '(or hover it on a computer), open the ... menu and pick "Make this a task".'));
    body.appendChild(e);
    return;
  }

  const overdue = open.filter(isOverdue);
  const rest = open.filter((t) => !isOverdue(t));

  const section = (title, items) => {
    if (!items.length) return;
    body.appendChild(el('h4', 'sec', esc(title) + ` (${items.length})`));
    for (const t of items) body.appendChild(taskCard(t));
  };
  section('Overdue', overdue);
  section('Open', rest);
  section('Done', done);
}

// When this will actually be finished, from what this team has already finished.
//
// Nobody is asked to estimate anything - see lib/forecast.js for why asking does
// not work. This is arithmetic over rows already on the client. It is shown only
// when the answer is worth reading: a task that is going fine and has plenty of
// room says nothing at all, because a line on every card is a line nobody reads.
//
// The wording avoids "p85" and every other word from the literature. "85 times
// out of 100" is understood by somebody who has never seen a percentile, and
// naming what it was based on is what makes the number believable - or properly
// unbelievable when the sample is three.
const BAND_WORD = {
  amber: 'Running long',
  red: 'Very likely to slip',
  stale: 'Older than anything this team has finished',
};

function forecastLine(t) {
  if (t.done_at || t.state === 'proposed' || t.state === 'rejected' || t.state === 'cancelled') return '';
  let f = null;
  try { f = forecast(history, t); } catch { return ''; }
  if (!f) return '';

  const when = (d) => d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  const band = BAND_WORD[f.band] || '';
  let body;
  if (f.stale) body = `Nothing this team has finished took this long. Worth asking what is holding it.`;
  else if (f.thin) {
    // Under twelve finished items a percentile is arithmetic theatre, so quote
    // what actually happened. With n samples the slowest sits near the n/(n+1)
    // percentile anyway, which makes this both honest and roughly the number a
    // percentile would have given.
    if (!f.n || !f.worst) return '';
    body = `Too little finished work here to forecast. The slowest of the last ${f.n} took `
      + `${f.worst < 2 ? 'about a day' : Math.round(f.worst) + ' days'}.`;
  } else if (f.band === 'ok') {
    // Fine and young. Saying so on every card is how the line stops being read.
    return '';
  } else {
    body = `Most likely done ${when(f.p50At)}. 85 times out of 100, by ${when(f.p85At)}. `
      + `From the last ${f.n} finished by ${f.basis}.`;
  }
  return `<div class="${CLS}-fc ${CLS}-fc-${esc(f.band)}">`
    + (band ? `<b>${esc(band)}.</b> ` : '') + esc(body) + '</div>';
}

function taskCard(t) {
  const card = el('div', 'result ' + CLS + '-card' + (t.done_at ? ' ' + CLS + '-carddone' : ''));
  const who = t.assignee_id ? nameOf(t.assignee_id) : 'nobody yet';
  card.innerHTML = `
    <div class="${CLS}-cardtop">
      <span class="${CLS}-cardtitle">${esc(t.title)}</span>
      ${t.due_at ? `<span class="${CLS}-due${isOverdue(t) ? ' ' + CLS + '-late' : ''}">${esc(dueLabel(t.due_at))}</span>` : ''}
    </div>
    <div class="${CLS}-meta muted">
      <b>${esc(who)}</b>
      ${t.state && t.state !== 'accepted'
        ? `<span class="${CLS}-state ${CLS}-state-${esc(t.state)}">${esc(STATE_LABEL[t.state] || t.state)}</span>`
        : ''}
      · #${esc(t.channel_name || 'channel')} ·
      ${t.assigned_by && t.assigned_by !== t.created_by
        ? `given by ${esc(nameOf(t.assigned_by))}`
        : `asked by ${esc(nameOf(t.created_by))}`} · ${esc(relTime(t.created_at))}
    </div>
    ${t.state === 'blocked' && t.blocker_note
      ? `<div class="${CLS}-blocked"><b>Stuck:</b> ${esc(t.blocker_note)}
         <span class="muted">since ${esc(relTime(t.blocked_at))}</span></div>` : ''}
    ${t.decision === 'changes_requested' && t.note
      ? `<div class="${CLS}-blocked"><b>Changes asked for:</b> ${esc(t.note)}</div>` : ''}
    ${t.state === 'rejected' && t.note
      ? `<div class="${CLS}-blocked"><b>Declined:</b> ${esc(t.note)}</div>` : ''}
    ${t.body_text ? `<div class="${CLS}-quote">${esc(plain(t.body_text, 160))}</div>` : ''}
    ${forecastLine(t)}`;

  const bar = el('div', 'row gap ' + CLS + '-bar');
  const mine = t.assignee_id === store.me;
  const mayFlip = mine || t.created_by === store.me || hasPerm(PERM.MANAGE_MESSAGES);
  const act = (label, kind, fn) => {
    const b = el('button', 'sm ' + kind, label);
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try { await fn(); uiRef.openPanel(PANEL, { tab: activeTab }); refreshCount(); }
      catch (err) { b.disabled = false; toastErr(err); }
    };
    bar.appendChild(b);
    return b;
  };

  // A request is waiting on a decision, and nothing else about it matters until
  // somebody makes one.
  if (t.state === 'proposed') {
    if (hasPerm(PERM.MANAGE_MESSAGES) || hasPerm(PERM.MODERATE)) {
      act('Accept', '', async () => {
        await rpc('decide_task', { p_task: t.id, p_decision: 'accept' });
        uiRef.toast('Accepted', 'success');
      });
    }
    if (t.created_by === store.me || hasPerm(PERM.MANAGE_MESSAGES) || hasPerm(PERM.MODERATE)) {
      act('Decline', 'ghost', async () => {
        const why = await uiRef.formModal({
          title: 'Decline this request',
          note: 'Whoever asked will be told. A reason is not required, but it saves them asking again.',
          fields: [{ name: 'reason', label: 'Why', type: 'textarea', rows: 2 }],
          submitLabel: 'Decline',
        });
        if (!why) throw new Error('cancelled');
        await rpc('decide_task', { p_task: t.id, p_decision: 'decline', p_reason: why.reason || null });
        uiRef.toast('Declined', 'success');
      });
    }
  } else if (t.state === 'in_review') {
    // The person who did the work is not offered the verdict on it.
    const mayReview = (t.reviewer_id === store.me || hasPerm(PERM.MANAGE_MESSAGES))
      && !(mine && t.reviewer_id !== store.me);
    if (mayReview) {
      act('Approve', '', async () => {
        await rpc('review_task', { p_task: t.id, p_verdict: 'approved' });
        uiRef.toast('Approved', 'success');
      });
      act('Ask for changes', 'ghost', async () => {
        const out = await uiRef.formModal({
          title: 'Ask for changes',
          note: 'It goes back to them, still open.',
          fields: [{ name: 'note', label: 'What needs doing', type: 'textarea', rows: 3, required: true }],
          submitLabel: 'Send it back',
        });
        if (!out) throw new Error('cancelled');
        await rpc('review_task', { p_task: t.id, p_verdict: 'changes_requested', p_note: out.note });
      });
    } else if (mine) {
      bar.appendChild(el('span', 'muted', 'Waiting on ' + esc(nameOf(t.reviewer_id))));
    }
  } else if (mayFlip) {
    if (t.state === 'blocked') {
      act('No longer stuck', '', async () => {
        await rpc('set_task_state', { p_task: t.id, p_state: 'unblocked' });
      });
    } else if (!t.done_at) {
      // "I have started" was a defined state no button could reach: a task
      // picked up five minutes ago looked identical to one untouched for two
      // weeks. The server accepted in_progress all along; the UI just never
      // sent it.
      if (t.state === 'accepted') {
        act('Start work', '', async () => {
          await rpc('set_task_state', { p_task: t.id, p_state: 'in_progress' });
          uiRef.toast('Marked as started', 'success');
        });
      }
      // The one control this whole flow exists for. Nobody in the field makes
      // saying "I am stuck" a first-class action; it is always a comment
      // somebody has to notice.
      act('I am stuck', 'ghost', async () => {
        const out = await uiRef.formModal({
          title: 'What are you stuck on?',
          note: 'Whoever gave you this, and whoever asked for it, will be told.',
          fields: [{ name: 'note', label: 'What is in the way', type: 'textarea', rows: 3, required: true,
            placeholder: 'Waiting on the district office to send the list' }],
          submitLabel: 'Mark it stuck',
        });
        if (!out) throw new Error('cancelled');
        await rpc('set_task_state', { p_task: t.id, p_state: 'blocked', p_note: out.note });
      });
    }

    if (!t.done_at && t.state !== 'in_review' && t.assigned_by && t.assigned_by !== store.me) {
      act('Send for review', 'ghost', async () => {
        await rpc('set_task_state', { p_task: t.id, p_state: 'in_review' });
        uiRef.toast('Sent to ' + nameOf(t.assigned_by), 'success');
      });
    }

    act(t.done_at ? 'Reopen' : 'Mark done', t.done_at ? 'ghost' : '', async () => {
      try {
        await rpc('set_task_done', { p_task: t.id, p_done: !t.done_at });
      } catch (err) {
        if (!/blocked_not_cleared/.test(err.message || '')) throw err;
        const ok = await uiRef.confirmModal({
          title: 'This is still marked stuck',
          body: 'You said you were waiting on something. Finish it anyway?',
          confirmLabel: 'Finish it anyway',
        });
        if (!ok) throw new Error('cancelled');
        await rpc('set_task_done', { p_task: t.id, p_done: true, p_force: true });
      }
    });

    const ed = el('button', 'sm ghost', 'Edit');
    ed.onclick = (e) => { e.stopPropagation(); editDialog(t); };
    bar.appendChild(ed);
  }

  const jump = el('button', 'sm ghost', 'Go to message');
  jump.onclick = (e) => { e.stopPropagation(); bus.emit('message:jump', { messageId: t.message_id }); };
  bar.appendChild(jump);

  if (t.created_by === store.me || hasPerm(PERM.MANAGE_MESSAGES)) {
    const rm = el('button', 'sm ghost', 'Delete');
    rm.onclick = async (e) => {
      e.stopPropagation();
      const ok = await uiRef.confirmModal({
        title: 'Delete this task?',
        body: 'The message stays. Only the task disappears.',
        confirmLabel: 'Delete', danger: true,
      });
      if (!ok) return;
      try {
        await rpc('delete_task', { p_task: t.id });
        uiRef.openPanel(PANEL, { tab: activeTab });
        refreshCount();
      } catch (err) { toastErr(err); }
    };
    bar.appendChild(rm);
  }

  // Progress, blockers and the chain live in taskprogress.js. This card offers
  // the door and the empty slot; whoever answers the event fills it. If nobody
  // does - the module failed to load, or the migration it needs has not been run
  // - the slot stays empty and the button is simply never added, which is the
  // behaviour every optional feature in this app has.
  const slot = el('div', CLS + '-more');
  slot.style.display = 'none';
  if (!t.done_at) {
    const more = el('button', 'sm ghost', 'Updates');
    more.onclick = (e) => {
      e.stopPropagation();
      const open = slot.style.display !== 'none';
      slot.style.display = open ? 'none' : '';
      more.textContent = open ? 'Updates' : 'Hide updates';
      if (!open) bus.emit('task:expand', { task: t, host: slot });
    };
    bar.appendChild(more);
  }

  card.appendChild(bar);
  card.appendChild(slot);
  // Clicking the card goes to the message the ask was made in. Anything inside
  // the expanded slot is its own control and must not also do that.
  card.onclick = (e) => {
    if (e.target.closest('.' + CLS + '-more')) return;
    bus.emit('message:jump', { messageId: t.message_id });
  };
  return card;
}

async function editDialog(t) {
  const out = await uiRef.formModal({
    title: 'Edit task',
    fields: [
      { name: 'title', label: 'What needs doing', value: t.title, required: true },
      { name: 'assignee', label: 'Who is doing it', type: 'select',
        options: await assigneeOptions(t.assignee_id), value: t.assignee_id || '' },
      { name: 'due', label: 'Due by', type: 'datetime-local',
        value: t.due_at ? toLocalInput(t.due_at) : '',
        hint: 'Clear this box to remove the deadline.' },
    ],
    submitLabel: 'Save',
  });
  if (!out) return;
  try {
    await rpc('update_task', {
      p_task: t.id,
      p_title: out.title.trim() || null,
      p_assignee: out.assignee || null,
      p_due_at: out.due ? fromLocalInput(out.due) : null,
      p_clear_due: !out.due,
    });
    uiRef.openPanel(PANEL, { tab: activeTab });
    refreshCount();
  } catch (e) { toastErr(e); }
}

// ------------------------------------------------------------------ badge
function paintBadge() {
  const btn = document.getElementById('hb-' + PANEL);
  if (!btn) return;
  const want = openCount > 0
    ? icon('check') + `<span class="badge ${CLS}-badge">${openCount > 99 ? '99+' : openCount}</span>`
    : icon('check');
  if (btn.innerHTML !== want) btn.innerHTML = want;
}

async function refreshCount() {
  if (!store.me || !store.ws) return;
  const [rows] = await tryRpc('list_tasks', {
    p_workspace: store.ws.id, p_filter: 'mine', p_channel: null, p_include_done: false });
  if (!Array.isArray(rows)) return;
  openCount = rows.length;
  paintBadge();
  // The header button only exists when Tasks lands inside ui.inlineCap, which on
  // a full registry it does not. Publish the number so the sidebar row - the
  // surface people actually reach this through - can carry the badge instead.
  // Overdue rides along for the embed host's task badge; isOverdue is the same
  // predicate the panel's own Overdue section groups by.
  bus.emit('tasks:count', { open: openCount, overdue: rows.filter(isOverdue).length });
}

// Core rebuilds the header row whenever any feature adds a button, which wipes the
// badge. Watching the row is cheaper than fighting the render order.
function watchHeader() {
  const host = document.getElementById('headerActions');
  if (!host) return;
  new MutationObserver(paintBadge).observe(host, { childList: true });
}

// ------------------------------------------------------------------ realtime
const bound = new WeakSet();
let rebind = null;
function bindChannel() {
  const ch = getSub('chan');
  if (!ch) return false;
  if (bound.has(ch)) return true;
  bound.add(ch);
  ch.on('broadcast', { event: 'task_update' }, () => {
    refreshChips();
    refreshCount();
  });
  return true;
}
function scheduleBind() {
  clearInterval(rebind);
  let tries = 0;
  rebind = setInterval(() => { if (bindChannel() || ++tries > 20) clearInterval(rebind); }, 400);
}

// ------------------------------------------------------------------ styles
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-slot{display:flex;flex-direction:column;gap:var(--s-2);margin-top:var(--s-3)}
.${CLS}-chip{display:flex;align-items:center;gap:var(--s-3);flex-wrap:wrap;max-width:520px;
  padding:var(--s-3) var(--s-4);border:1px solid var(--c-border);border-left:3px solid var(--c-accent);
  border-radius:var(--r-md);background:var(--c-surface-2);font-size:var(--t-sm)}
.${CLS}-chip svg{width:15px;height:15px;flex:none;color:var(--c-accent)}
.${CLS}-chipdone{border-left-color:var(--c-success);opacity:.75}
.${CLS}-chipdone svg{color:var(--c-success)}
.${CLS}-chipdone .${CLS}-chiptext{text-decoration:line-through}
.${CLS}-chiplate{border-left-color:var(--c-danger)}
.${CLS}-chiptext{font-weight:var(--t-semibold);word-break:break-word}
.${CLS}-chipwho{color:var(--c-text-2)}
/* --c-warn as text is 2.83:1 on surface-2 in the colorful theme. The chip is
   already colour-coded by its left border, so the label reads in --c-text-2. */
.${CLS}-chipdue{color:var(--c-text-2)}
.${CLS}-chiplate .${CLS}-chipdue{color:var(--c-danger)}
.${CLS}-chip button{margin-left:auto;min-height:32px}

.${CLS}-tabs{margin-bottom:var(--s-4);flex-wrap:wrap}
.${CLS}-tabs button{min-height:36px}
.${CLS}-card{cursor:pointer}
.${CLS}-carddone .${CLS}-cardtitle{text-decoration:line-through;opacity:.7}
.${CLS}-cardtop{display:flex;gap:var(--s-4);align-items:baseline;flex-wrap:wrap}
.${CLS}-cardtitle{flex:1;font-weight:var(--t-semibold);word-break:break-word}
.${CLS}-due{font-size:var(--t-xs);color:var(--c-text-2);white-space:nowrap}
.${CLS}-late{color:var(--c-danger);font-weight:var(--t-semibold)}
.${CLS}-meta{font-size:var(--t-xs);margin-top:var(--s-2);word-break:break-word}
.${CLS}-quote{margin-top:var(--s-3);padding-left:var(--s-4);
  border-left:2px solid var(--c-border);color:var(--c-text-2);font-size:var(--t-sm)}
.${CLS}-bar{margin-top:var(--s-3);flex-wrap:wrap;gap:var(--s-2)}
.${CLS}-bar button{min-height:36px}
.${CLS}-badge{margin-left:var(--s-1);vertical-align:top}
/* Stuck work has to look different from work that is merely not finished. The
   whole point of asking somebody to say they are blocked is that somebody else
   can see it without reading every card. */
.${CLS}-blocked{margin-top:var(--s-3);padding:var(--s-3) var(--s-4);border-radius:var(--r-sm,6px);
  background:color-mix(in srgb,var(--c-danger) 10%,transparent);
  border-left:2px solid var(--c-danger);font-size:var(--t-sm);line-height:var(--t-loose)}
/* The forecast. Quieter than "stuck", because it is a projection and not a
   statement somebody made - and it only appears at all when there is something
   worth saying, so it never becomes the line people scroll past. */
.${CLS}-fc{margin-top:var(--s-3);font-size:var(--t-xs);line-height:var(--t-loose);
  color:var(--c-text-2);padding-left:var(--s-4);border-left:2px solid var(--c-border)}
.${CLS}-fc b{color:var(--c-text)}
.${CLS}-fc-amber{border-left-color:var(--c-warn,var(--c-danger))}
.${CLS}-fc-red,.${CLS}-fc-stale{border-left-color:var(--c-danger)}
/* The expanded slot. Filled by taskprogress.js, empty and hidden otherwise. */
.${CLS}-more{margin-top:var(--s-3);padding-top:var(--s-3);border-top:1px solid var(--c-border);
  cursor:auto}
.${CLS}-blocked .muted{font-size:var(--t-xs)}
.${CLS}-state{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;
  font-size:11px;background:var(--c-bg);border:1px solid var(--c-border);white-space:nowrap}
.${CLS}-state-blocked{color:var(--c-danger);border-color:color-mix(in srgb,var(--c-danger) 40%,var(--c-border))}
.${CLS}-state-proposed,.${CLS}-state-in_review{color:var(--c-accent);
  background:var(--c-accent-quiet);border-color:transparent}
.${CLS}-state-rejected,.${CLS}-state-cancelled{text-decoration:line-through;opacity:.75}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  uiRef = ui;
  style();
  watchHeader();

  bus.on('message:render', ({ msg, el: row }) => mount(msg, row));
  // The optimistic nonce on a slot I just created died: re-stamp and paint the
  // chip now if a task for this message already exists (it usually does - the
  // create round trip beat the send echo). Before core emitted this, the chip
  // for the task you had just made never appeared until reload.
  bus.on('message:idUpgraded', ({ from, id, row }) => {
    for (const s of row.querySelectorAll('.' + CLS + '-slot')) {
      if (s.dataset.msg === from) { s.dataset.msg = id; paintChip(s, byMessage.get(id) || []); }
    }
  });
  // No refreshChips here: channel:subscribed always fires right after an open,
  // so this was a second identical read of every task in the Space per open.
  // The task_update broadcast paints live changes; the subscribed refetch heals
  // anything dropped while the socket was down.
  bus.on('channel:open', scheduleBind);
  // Core replaces the 'chan' object on a recovered drop as well as on a switch,
  // and emits this precisely so features can re-bind (channels.js). Binding only
  // on channel:open meant that after any reconnect - a tunnel, a lift, a laptop
  // lid - task updates stopped arriving silently and the panel showed yesterday
  // until somebody changed channel. ackloop, forms and polls all already listen.
  bus.on('channel:subscribed', () => { scheduleBind(); refreshChips(); });
  bus.on('workspace', () => { refreshCount(); });
  bus.on('auth', refreshCount);
  scheduleBind();
  refreshCount();

  // Due-date nudges. The dates were parsed, stored and painted red while doing
  // nothing at the moment they mattered; this makes them speak while the app is
  // open. Once per task per due stamp, deduped in localStorage, visible-tab only.
  // A server cron (migration 0102) will eventually cover closed laptops; this
  // covers every session that exists today.
  const REMIND_KEY = 'dak.task.reminded';
  let reminded = [];
  try { reminded = JSON.parse(localStorage.getItem(REMIND_KEY) || '[]'); } catch { reminded = []; }
  const remindedSet = new Set(Array.isArray(reminded) ? reminded : []);
  let ticks = 0;
  setInterval(async () => {
    if (!store.ws || document.visibilityState !== 'visible') return;
    // The assignee badge had no pulse either: counts moved only on your own
    // actions or a broadcast inside the one open channel. Every other tick a
    // slow visible-tab poll keeps it honest without costing anything offline.
    if (++ticks % 2 === 0) refreshCount();
    try {
      const [rows] = await tryRpc('list_tasks', {
        p_workspace: store.ws.id, p_filter: 'all', p_channel: null, p_include_done: false });
      if (!Array.isArray(rows)) return;
      const now = Date.now();
      let dirty = false;
      for (const t of rows) {
        if (t.assignee_id !== store.me || !t.due_at || t.done_at) continue;
        const due = new Date(t.due_at).getTime();
        if (Number.isNaN(due)) continue;
        const late = now - due;
        const soon = due - now;
        // Speak once when it comes within ten minutes, and again for a day
        // after it slips - not forever, or the badge becomes wallpaper.
        if (!(late >= 0 && late < 86400000) && !(soon > 0 && soon <= 600000)) continue;
        const key = t.id + ':' + t.due_at;
        if (remindedSet.has(key)) continue;
        remindedSet.add(key);
        dirty = true;
        toastFn(late >= 0 ? `Overdue: ${t.title}` : `Due in ${Math.ceil(soon / 60000)} min: ${t.title}`);
      }
      if (remindedSet.size > 300) {
        const keep = [...remindedSet].slice(-200);
        remindedSet.clear();
        keep.forEach((k) => remindedSet.add(k));
        dirty = true;
      }
      if (dirty) localStorage.setItem(REMIND_KEY, JSON.stringify([...remindedSet]));
    } catch { /* offline or unversioned RPC: stay silent */ }
  }, 60000);

  ui.addMessageAction({
    id: 'make-task',
    label: icon('check'),
    title: 'Make this a task',
    order: 44,
    contexts: ['channel', 'thread'],
    show: (m) => !!m.id && !m.conversation_id,
    onClick: (m, ev) => { ev?.stopPropagation?.(); createDialog(m); },
  });

  ui.registerPanel({ id: PANEL, title: 'Tasks', render: renderPanel });

  ui.addHeaderButton({
    id: PANEL, label: icon('check'), title: 'Tasks', order: 74,
    onClick: () => ui.openPanel(PANEL, { tab: activeTab }),
  });

  ui.addSlashCommand({
    name: 'tasks',
    description: 'Show what you are on the hook for',
    run: () => ui.openPanel(PANEL, { tab: 'mine' }),
  });

  ui.addSwitcherSource({
    id: 'tasks',
    search: (q) => (/task|todo|due/i.test(q)
      ? [{ label: 'My tasks', hint: 'What you are on the hook for', icon: icon('check'),
           run: () => ui.openPanel(PANEL, { tab: 'mine' }) }]
      : []),
  });
}
