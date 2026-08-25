// Saying how a task is going, and saying what is in the way.
//
// The task system already has states, and a state change is a fine record of
// what happened but a poor record of WHY. "Blocked" with one mutable note cannot
// answer how long it has been stuck, how many times the date has moved, or who
// last touched it - and those three are what somebody actually wants at the
// moment they ask "where are we with this". So updates go into an append-only
// log and the task keeps only the latest value as a cover.
//
// THREE KINDS OF BLOCKER, because they need three different responses:
//   another task     -> chase that task, and the chain can be walked
//   another person   -> chase that person
//   something outside -> nobody here can chase it, and pretending otherwise is
//                        how a task sits for six weeks with somebody's name on it
//
// The wording is not Jira's. "Blockers" and "dependencies" are words for people
// who have used a tracker; "What is stopping you?" is a question anybody can
// answer, and the difference decides whether a field gets filled in at all.
//
// EVERYTHING HERE DEGRADES. Every RPC it needs is new (migration 0101). If the
// migration has not been run the panel says so once and the rest of the task
// system carries on exactly as before, because a feature that half-exists must
// not take the working part down with it.
import { rpc, tryRpc } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { el, esc, relTime, fromLocalInput } from '../util.js';
import { icon } from '../icons.js';
import { parseDue, sayDue } from '../lib/asks.js';

const CLS = 'tpg';
let app = null;
// Set once, the first time an RPC comes back missing. Everything after that is a
// no-op rather than a stream of identical failures.
let available = true;

const isMissing = (e) =>
  /could not find the function|does not exist|schema cache|PGRST202/i.test(e?.message || '');

async function call(fn, args) {
  if (!available) return [null, new Error('unavailable')];
  const [out, err] = await tryRpc(fn, args);
  if (err && isMissing(err)) {
    available = false;
    console.info('[Dek] task progress needs migration 0101; the feature is off until then');
  }
  return [out, err];
}

// ------------------------------------------------------------------ posting
// One dialog, three shapes. Splitting it into three buttons put three controls on
// a card that already has five, and on a phone that is a wall.
async function updateDialog(task) {
  const stuck = task.state === 'blocked';
  const people = await peopleOptions();

  const out = await app.ui.formModal({
    title: stuck ? 'Update on ' + shortTitle(task) : 'How is it going?',
    note: stuck
      ? 'Say what changed. If it is no longer stuck, choose that below.'
      : 'Whoever asked for this, and whoever handed it out, will see it.',
    fields: [
      { name: 'kind', label: 'What is happening', type: 'select',
        value: stuck ? 'unblocked' : 'progress',
        options: [
          { value: 'progress', label: 'Getting on with it' },
          { value: 'blocked', label: 'I am stuck on something' },
          { value: 'unblocked', label: 'No longer stuck' },
          { value: 'note', label: 'Just a note' },
        ] },
      { name: 'note', label: 'In your own words', type: 'textarea', rows: 3,
        placeholder: stuck ? 'The district office sent half the list'
          : 'Half the invoices are matched, the rest need the bank statement' },
      // Free text rather than a picker, and parsed the same way the composer
      // parses a sentence. "end of week" is what people type; making them find
      // Friday in a calendar widget on a phone is how the field stays empty.
      { name: 'eta', label: 'When do you think it will be done', type: 'text',
        placeholder: 'friday, tomorrow, in 3 days, 22 Aug',
        hint: 'Plain words are fine. Leave blank if you would rather not say.' },
      { name: 'blocked_on_user', label: 'Waiting on somebody', type: 'select',
        value: '', options: [{ value: '', label: 'Nobody' }, ...people] },
      { name: 'blocked_on_external', label: 'Waiting on somebody outside', type: 'text',
        placeholder: 'The district office' },
    ],
    submitLabel: 'Post it',
  });
  if (!out) return;

  let etaAt = null;
  if (out.eta && out.eta.trim()) {
    const d = parseDue(out.eta);
    if (d) etaAt = d.at;
    else {
      // Refusing quietly and posting the update without the date is worse than
      // asking again: the person believes they have given a date and nobody has
      // one.
      app.ui.toast(`Could not read "${out.eta}" as a date. Try "friday" or "22 Aug".`, 'error');
      return;
    }
  }

  const kind = out.kind || 'progress';
  const [, err] = await call('post_task_progress', {
    p_task: task.id,
    p_kind: kind,
    p_note: out.note || null,
    p_eta_at: etaAt ? etaAt.toISOString() : null,
    p_percent: null,
    p_blocked_on_task: null,
    p_blocked_on_user: out.blocked_on_user || null,
    p_blocked_on_external: out.blocked_on_external || null,
  });
  if (err) {
    app.ui.toast(available ? 'That did not post. Try again in a moment.'
      : 'Progress updates are not switched on for this organisation yet.', 'error');
    return;
  }
  app.ui.toast(kind === 'blocked' ? 'Marked stuck. The people waiting have been told.'
    : etaAt ? 'Posted, due ' + sayDue(etaAt) : 'Posted', 'success');
  bus.emit('tasks:count');
  bus.emit('task:updated', { taskId: task.id });
}

const shortTitle = (t) => (t.title || 'this').length > 32
  ? (t.title || '').slice(0, 30) + '…' : (t.title || 'this');

async function peopleOptions() {
  const out = [];
  for (const [id, p] of store.profiles) {
    if (p.is_ghost || !p.display_name) continue;
    out.push({ value: id, label: p.display_name });
  }
  return out.sort((a, z) => a.label.localeCompare(z.label)).slice(0, 200);
}

// ------------------------------------------------------------------ history
// What happened, oldest first, because a story read backwards is not a story.
async function renderHistory(host, task) {
  host.innerHTML = `<div class="muted pad">loading…</div>`;
  const [events, err] = await call('list_task_events', { p_task: task.id });
  if (err || !Array.isArray(events)) {
    host.innerHTML = available
      ? '<div class="empty">Could not load the history.</div>'
      : '<div class="empty">Progress updates are not switched on yet.</div>';
    return;
  }
  if (!events.length) {
    host.innerHTML = '<div class="empty">Nothing posted about this yet.</div>';
    return;
  }
  host.innerHTML = '';
  for (const e of events) {
    const row = el('div', CLS + '-ev ' + CLS + '-ev-' + esc(e.kind));
    const who = nameOf(e.actor_id);
    const what = {
      progress: 'got on with it', blocked: 'is stuck', unblocked: 'is unstuck',
      eta: 'gave a date', note: 'said', state: 'changed it', handoff: 'handed it on',
      nudge: 'was nudged',
    }[e.kind] || e.kind;
    const waiting = e.blocked_on_external ? ` on ${esc(e.blocked_on_external)}`
      : e.blocked_on_user ? ` on ${esc(nameOf(e.blocked_on_user))}` : '';
    row.innerHTML = `<div class="${CLS}-evhead"><b>${esc(who)}</b> ${esc(what)}${waiting}
        <span class="muted">${esc(relTime(e.created_at))}</span></div>
      ${e.note ? `<div class="${CLS}-evnote">${esc(e.note)}</div>` : ''}
      ${e.eta_at ? `<div class="${CLS}-eveta">expects it ${esc(sayDue(new Date(e.eta_at)))}</div>` : ''}`;
    host.appendChild(row);
  }
}

// ------------------------------------------------------------------ chain
// Who is at the end of the queue. One line, and only when there IS a chain,
// because "not blocked" printed on every card is noise.
async function renderChain(host, task) {
  const [chain] = await call('task_block_chain', { p_task: task.id, p_depth: 5 });
  if (!Array.isArray(chain) || chain.length < 2) { host.innerHTML = ''; return; }
  // depth 0 is this task; anything deeper is what it is waiting on.
  const rest = chain.filter((c) => c.depth > 0).sort((a, z) => a.depth - z.depth);
  if (!rest.length) { host.innerHTML = ''; return; }
  const names = rest.map((c) => `${esc(c.title)}${c.assignee_id ? ' (' + esc(nameOf(c.assignee_id)) + ')' : ''}`);
  host.innerHTML = `<div class="${CLS}-chain"><b>Waiting on:</b> ${names.join(' &rarr; ')}</div>`;
}

// ------------------------------------------------------------------ triage
// Work that is real and owned by nobody. The Requests tab already covers "asked
// for, needs a yes". This is the other half - accepted, unassigned, and rotting.
// The one-key disposition is the only part of Linear's Triage worth copying at
// this size: pick it up, hand it to somebody, or say it is not happening.
const TRIAGE_PANEL = 'triage';

async function renderTriage(body) {
  body.innerHTML = '<div class="muted pad">loading…</div>';
  if (!store.ws) { body.innerHTML = '<div class="empty">Open a Space first.</div>'; return; }
  const [rows, err] = await call('list_triage', { p_workspace: store.ws.id });
  if (err || !Array.isArray(rows)) {
    body.innerHTML = available
      ? '<div class="empty">Could not load the queue.</div>'
      : '<div class="empty">The unassigned queue needs migration 0101.</div>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="empty">Nothing is waiting for an owner. '
      + 'That is the state this queue is supposed to be in.</div>';
    return;
  }

  body.innerHTML = '';
  body.appendChild(el('div', 'muted pad',
    `${rows.length} ${rows.length === 1 ? 'thing has' : 'things have'} no owner. `
    + 'Oldest and most urgent first.'));

  for (const t of rows) {
    const card = el('div', 'result ' + CLS + '-tri');
    card.innerHTML = `
      <div class="${CLS}-tritop"><b>${esc(t.title)}</b>
        ${t.due_at ? `<span class="muted">${esc(sayDue(new Date(t.due_at)))}</span>` : ''}</div>
      <div class="muted ${CLS}-trimeta">asked by ${esc(nameOf(t.created_by))}
        &middot; ${esc(relTime(t.created_at))}
        ${t.age_days > 7 ? ` &middot; <b>waiting ${Math.round(t.age_days)} days</b>` : ''}</div>`;

    const bar = el('div', 'row gap ' + CLS + '-tribar');
    const act = (label, kind, fn) => {
      const b = el('button', 'sm ' + kind, label);
      b.type = 'button';
      b.onclick = async () => {
        b.disabled = true;
        try { await fn(); app.ui.openPanel(TRIAGE_PANEL); bus.emit('tasks:count'); }
        catch (e) { b.disabled = false; app.ui.toast(e?.message || 'That did not work', 'error'); }
      };
      bar.appendChild(b);
    };
    act('I will do it', '', () => rpc('update_task', { p_task: t.id, p_assignee: store.me }));
    act('Give it to somebody', 'ghost', async () => {
      const who = await app.ui.formModal({
        title: 'Who is doing it', fields: [
          { name: 'assignee', label: 'Person', type: 'select',
            options: await peopleOptions(), required: true }],
        submitLabel: 'Hand it over',
      });
      if (!who) throw new Error('cancelled');
      await rpc('update_task', { p_task: t.id, p_assignee: who.assignee });
    });
    act('Not happening', 'ghost', async () => {
      const ok = await app.ui.confirmModal({
        title: 'Drop this?', body: 'It disappears from the queue. The message stays.',
        confirmLabel: 'Drop it', danger: true,
      });
      if (!ok) throw new Error('cancelled');
      await rpc('set_task_state', { p_task: t.id, p_state: 'cancelled' });
    });
    card.appendChild(bar);
    body.appendChild(card);
  }
}

// ------------------------------------------------------------------ chrome
const STYLE_ID = CLS + '-css';
function style() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.${CLS}-ev{padding:var(--s-3) 0;border-bottom:1px solid var(--c-border)}
.${CLS}-ev:last-child{border-bottom:0}
.${CLS}-evhead{font-size:var(--t-sm)}
.${CLS}-evhead .muted{margin-left:var(--s-2);font-size:var(--t-xs)}
.${CLS}-evnote{margin-top:2px;font-size:var(--t-sm);color:var(--c-text-2);word-break:break-word}
.${CLS}-eveta{margin-top:2px;font-size:var(--t-xs);color:var(--c-text-2)}
.${CLS}-ev-blocked{border-left:2px solid var(--c-danger);padding-left:var(--s-3)}
.${CLS}-ev-unblocked{border-left:2px solid var(--c-success);padding-left:var(--s-3)}
.${CLS}-chain{margin-top:var(--s-3);padding:var(--s-3) var(--s-4);border-radius:var(--r-sm,6px);
  background:color-mix(in srgb,var(--c-danger) 8%,transparent);font-size:var(--t-xs);
  line-height:var(--t-loose);word-break:break-word}
.${CLS}-tri{margin-bottom:var(--s-3)}
.${CLS}-tritop{display:flex;gap:var(--s-4);align-items:baseline;flex-wrap:wrap}
.${CLS}-tritop b{flex:1;word-break:break-word}
.${CLS}-trimeta{font-size:var(--t-xs);margin-top:var(--s-2)}
.${CLS}-tribar{margin-top:var(--s-3);flex-wrap:wrap;gap:var(--s-2)}
.${CLS}-tribar button{min-height:36px}
@media (max-width: 520px){.${CLS}-tribar button{flex:1}}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register(a) {
  app = a;
  style();

  a.ui.registerPanel({
    id: TRIAGE_PANEL,
    title: 'Nobody has this',
    icon: 'clock',
    render: (body) => { renderTriage(body).catch(() => {}); },
  });

  // The task panel is tasks.js's. Rather than reach into it, this listens for a
  // card asking to be expanded and fills the slot the card provides. Two features
  // sharing one surface without either owning the other.
  bus.on('task:expand', ({ task, host }) => {
    if (!task || !host) return;
    host.innerHTML = '';
    const chain = el('div');
    const hist = el('div', CLS + '-hist');
    const bar = el('div', 'row gap');
    const post = el('button', 'sm', 'Post an update');
    post.onclick = () => updateDialog(task);
    bar.appendChild(post);
    host.append(chain, bar, hist);
    renderChain(chain, task).catch(() => {});
    renderHistory(hist, task).catch(() => {});
  });

  a.ui.addSlashCommand({
    name: 'unassigned',
    description: 'Show the work nobody has picked up',
    run: () => a.ui.openPanel(TRIAGE_PANEL),
  });
}
