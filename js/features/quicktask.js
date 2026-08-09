// Turning a sentence into a task without leaving the sentence.
//
// The task system underneath this is already good: request, accept, decline,
// stuck-with-a-reason, send for review, approve or send back. What it has never
// had is a cheap way IN. Making a task meant long-pressing a message, finding
// "Make this a task" in a menu, then filling a form with a title you had already
// typed, a person you had already named, and a date you had already said. Four
// steps to record something that was fully specified in the first one.
//
// So: when somebody sends a message that plainly hands work out - names a person,
// asks for something, gives a deadline - a strip appears under it saying what the
// task WOULD be. One tap makes it. One tap says no. That is the whole feature.
//
// IT NEVER CREATES ANYTHING BY ITSELF. Auto-creating from a guess is the version
// of this that gets switched off: one wrong task is something somebody has to
// find and delete, and after the second one nobody trusts the list. A suggestion
// that is wrong costs a glance, which is why the confidence bar in lib/asks.js is
// set where it is - it would rather miss than guess.
//
// It also only ever suggests on YOUR OWN message. Reading other people's messages
// and telling them what they meant is a different product and a worse one.
import { rpc, tryRpc, table } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { el, esc } from '../util.js';
import { icon } from '../icons.js';
import { parseAsk, sayDue } from '../lib/asks.js';

const CLS = 'qtk';
const OFF_KEY = 'hearth.quicktask.off';

let app = null;
// Messages this session has already offered on, so a re-render - a reaction
// arriving, a scroll bringing the row back - does not offer twice. Keyed by the
// row's live id, which changes once when the server's uuid replaces the client
// nonce, so both are recorded.
const offered = new Set();
const dismissed = new Set();

// One read per Space rather than one per suggestion. The roster is what turns
// "@Karthik" into a user id, and it is small and slow-changing.
let memberCache = { wsId: null, at: 0, list: [] };
const MEMBER_TTL = 300000;

async function members() {
  const wsId = store.ws?.id;
  if (!wsId) return [];
  if (memberCache.wsId === wsId && Date.now() - memberCache.at < MEMBER_TTL) return memberCache.list;

  // Same reasoning as tasks.js: store.profiles is every profile this client has
  // ever seen across every Space, which is the wrong list - it matched people
  // who cannot see the channel, and create_task then refused them.
  const rows = await table('workspace_members', (q) => q.eq('workspace_id', wsId));
  const ids = rows.map((r) => r.user_id);
  const unknown = ids.filter((u) => !store.profiles.has(u));
  if (unknown.length) {
    for (const p of await table('profiles', (q) => q.in('id', unknown.slice(0, 500)))) {
      store.profiles.set(p.id, { ...(store.profiles.get(p.id) || {}), ...p });
    }
  }
  const list = [];
  for (const id of ids) {
    const p = store.profiles.get(id) || {};
    if (p.is_ghost) continue;
    // Both spellings, because people are mentioned by either and the parser
    // takes the longest match.
    if (p.display_name) list.push({ id, name: p.display_name });
    if (p.username && p.username !== p.display_name) list.push({ id, name: p.username });
  }
  memberCache = { wsId, at: Date.now(), list };
  return list;
}

const isOff = () => localStorage.getItem(OFF_KEY) === '1';

// ------------------------------------------------------------------ create
// The row is the authority for the message id. A message you just sent is
// painted with a client nonce and core rewrites row.dataset.id to the server's
// uuid WITHOUT re-emitting message:render, so anything stamped at render time is
// stale for exactly the message the person is looking at - which is every
// message this feature ever touches.
function liveId(strip) {
  return strip.closest('.msg')?.dataset.id || strip.dataset.msg;
}

async function create(strip, ask) {
  const id = liveId(strip);
  if (!id) { app.ui.toast('That message has not finished sending', 'error'); return; }
  strip.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    const t = await rpc('create_task', {
      p_message: id,
      p_title: ask.title,
      p_assignee: ask.assignee || null,
      p_due_at: ask.due ? ask.due.toISOString() : null,
    });
    // Say which of the two things happened. An organisation can be set up so
    // that only certain people hand work to others; for everybody else, choosing
    // somebody else sends a request instead. "Task created" when what happened
    // is "request sent, nobody has it yet" is the small lie that makes people
    // think the app dropped their work.
    app.ui.toast(t?.state === 'proposed'
      ? 'Asked for. Somebody who can accept it will see it under Requests.'
      : ask.assignee && ask.assignee !== store.me
        ? 'Task created for ' + nameOf(ask.assignee)
        : ask.assignee ? 'Task created' : 'Added to the queue for anyone to pick up', 'success');
    strip.remove();
    bus.emit('later:changed');
    bus.emit('tasks:count');
  } catch (e) {
    strip.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    const m = String(e?.message || '');
    app.ui.toast(
      /assignee_cannot_see_channel/i.test(m)
        ? 'That person cannot see this channel, so they would never find the task.'
        : /failed to fetch|networkerror/i.test(m)
          ? 'No connection. Try again when you are back online.'
          : 'That did not work. Try again in a moment.', 'error');
  }
}

// The escape hatch. Everything the parser guessed is pre-filled and editable,
// which is the point: correcting one field is still faster than filling four.
async function amend(strip, ask, opts) {
  const out = await app.ui.formModal({
    title: 'Make this a task',
    fields: [
      { name: 'title', label: 'What needs doing', value: ask.title, required: true },
      { name: 'assignee', label: 'Who is doing it', type: 'select', value: ask.assignee || '',
        options: [{ value: '', label: 'Anyone can pick this up' },
          ...dedupe(opts).map((m) => ({ value: m.id, label: m.name }))] },
      { name: 'due', label: 'Due by', type: 'datetime-local',
        value: ask.due ? toLocal(ask.due) : '',
        hint: 'Leave blank for no deadline.' },
    ],
    submitLabel: 'Create task',
  });
  if (!out) return;
  await create(strip, {
    title: out.title.trim(),
    assignee: out.assignee || null,
    due: out.due ? new Date(out.due) : null,
  });
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, z) => a.name.localeCompare(z.name));
}

// The value a datetime-local input wants is local wall-clock with no zone, which
// toISOString() is not: it would silently shift the time by the offset.
function toLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ------------------------------------------------------------------ the strip
function paint(row, msgId, ask, opts) {
  const strip = el('div', CLS);
  strip.dataset.msg = msgId;

  const who = ask.assignee
    ? (ask.assignee === store.me ? 'you' : nameOf(ask.assignee))
    : 'anyone';
  const when = ask.due ? sayDue(ask.due) : null;

  strip.innerHTML = `
    <span class="${CLS}-ico">${icon('check')}</span>
    <span class="${CLS}-body">
      <span class="${CLS}-title">${esc(ask.title)}</span>
      <span class="${CLS}-meta">${esc(who)}${when ? ' · ' + esc(when) : ' · no deadline'}</span>
    </span>`;

  const bar = el('span', CLS + '-bar');
  const b = (label, kind, fn) => {
    const btn = el('button', 'sm ' + kind, label);
    btn.type = 'button';
    btn.onclick = (e) => { e.stopPropagation(); fn(); };
    bar.appendChild(btn);
    return btn;
  };
  b('Make it a task', '', () => create(strip, ask));
  b('Change', 'ghost', () => amend(strip, ask, opts));

  const no = el('button', 'icon ' + CLS + '-no', icon('close'));
  no.type = 'button';
  no.title = 'Not a task';
  no.onclick = (e) => {
    e.stopPropagation();
    dismissed.add(msgId);
    strip.remove();
  };
  bar.appendChild(no);
  strip.appendChild(bar);

  (row.querySelector('.mbody') || row).appendChild(strip);
}

// ------------------------------------------------------------------ trigger
// Only a message this person just sent, and only once. `pending` is on the row
// between the optimistic paint and the server's reply, which is exactly the
// window where offering is natural: they are still looking at what they typed.
// Older messages scrolling back into view are not fresh asks and must not be
// re-litigated every time the list repaints.
const FRESH_MS = 45000;

async function consider(msg, row) {
  if (isOff()) return;
  if (!msg || msg.author_id !== store.me) return;
  if (msg.conversation_id) return;               // a DM is not somebody's queue
  if (!store.ws || !store.current) return;
  const id = msg.id || row.dataset.id;
  if (!id || offered.has(id) || dismissed.has(id)) return;

  const sentAt = msg.created_at ? new Date(msg.created_at).getTime() : 0;
  if (!sentAt || Date.now() - sentAt > FRESH_MS) return;

  const text = msg.body_text || '';
  if (!text.trim()) return;

  // Claimed BEFORE the first await, not after. message:render fires more than
  // once for the same row in ordinary use - core emits it on build, and features
  // that decorate a row can cause another pass - and with the roster fetch
  // sitting between the guard and the mark, both calls sailed through the guard
  // and painted. Two identical strips under one message, which is measured and
  // was on screen at every width. Nothing here retries on failure, so claiming
  // early costs nothing: the worst case is one message that is never offered on.
  offered.add(id);

  const opts = await members();
  const ask = parseAsk(text, { members: opts, me: store.me });
  if (!ask) return;

  // The row may have been replaced, or already decorated, while the roster was
  // being fetched.
  if (!row.isConnected || row.querySelector('.' + CLS)) return;
  const live = row.dataset.id;
  if (live && live !== id) offered.add(live);
  paint(row, id, ask, opts);
}

// ------------------------------------------------------------------ chrome
const STYLE_ID = 'qtk-style';
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  // Deliberately quiet. This is a suggestion sitting inside somebody's own
  // message, and anything that looks like an alert there reads as "you did
  // something wrong" rather than "here is a shortcut".
  s.textContent = `
.${CLS}{display:flex;align-items:center;gap:var(--s-3);flex-wrap:wrap;
  margin:var(--s-2) 0 var(--s-1);padding:var(--s-2) var(--s-3);
  border:1px dashed var(--c-border);border-radius:var(--r-md);
  background:color-mix(in srgb, var(--c-accent) 6%, transparent);
  font-size:var(--t-sm);animation:${CLS}-in var(--m-base) var(--m-out)}
@keyframes ${CLS}-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.${CLS}{animation:none}}
.${CLS}-ico{display:grid;place-items:center;width:18px;height:18px;flex:none;color:var(--c-accent)}
.${CLS}-ico .ico{width:15px;height:15px}
.${CLS}-body{display:flex;flex-direction:column;min-width:0;flex:1 1 12ch;gap:1px}
.${CLS}-title{font-weight:var(--t-semibold);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLS}-meta{font-size:var(--t-xs);color:var(--c-text-2)}
.${CLS}-bar{display:flex;align-items:center;gap:var(--s-2);flex:none;margin-left:auto}
.${CLS}-no{width:26px;height:26px;min-width:26px;opacity:.6}
.${CLS}-no:hover{opacity:1}
.${CLS}-no .ico{width:13px;height:13px}
/* At phone width the buttons need the whole row or the title is squeezed to
   three characters and the suggestion stops being readable, which is the only
   thing it had to be. */
@media (max-width: 520px){
  .${CLS}-bar{margin-left:0;width:100%}
  .${CLS}-bar button.sm{flex:1}
  .${CLS}-no{flex:none !important}
}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register(a) {
  app = a;
  injectStyle();

  bus.on('message:render', ({ msg, el: row }) => { consider(msg, row).catch(() => {}); });
  bus.on('workspace', () => { memberCache = { wsId: null, at: 0, list: [] }; });

  // The explicit door, for a sentence the parser did not believe or a task with
  // no message behind it yet. It posts the line to the channel first, because a
  // task whose ask nobody saw is exactly the private to-do list this product is
  // trying not to become - the message IS the record of who asked for what.
  a.ui.addSlashCommand({
    name: 'task',
    description: 'Hand out a task - /task @person what needs doing by friday',
    run: async (argText) => {
      const text = (argText || '').trim();
      if (!text) { a.ui.toast('Say what needs doing, and who for', 'error'); return; }
      if (!store.current) { a.ui.toast('Open a channel first', 'error'); return; }

      const opts = await members();
      const ask = parseAsk(text, { members: opts, me: store.me })
        // Typed deliberately, so it counts as an ask even if it reads like a
        // remark. Only the person and the date still have to be found.
        || { title: text, assignee: null, due: null };

      const sent = await a.api.send({
        channel: store.current.id,
        nonce: crypto.randomUUID(),
        text,
        mentions: bus.resolveMentions ? bus.resolveMentions(text) : [],
        mentionScope: 'none',
      }).catch(() => null);
      if (!sent?.id) { a.ui.toast('Could not post that', 'error'); return; }

      try {
        const t = await rpc('create_task', {
          p_message: sent.id,
          p_title: ask.title,
          p_assignee: ask.assignee || null,
          p_due_at: ask.due ? ask.due.toISOString() : null,
        });
        a.ui.toast(t?.state === 'proposed' ? 'Asked for' : 'Task created', 'success');
        bus.emit('tasks:count');
      } catch {
        a.ui.toast('Posted, but the task did not stick. Long-press it to try again.', 'error');
      }
    },
  });

  // One switch, where somebody looking for it would look. Off is remembered on
  // this device rather than the account, because it is a preference about this
  // screen and not about the person.
  a.ui.addSlashCommand({
    name: 'tasksuggest',
    description: 'Turn task suggestions on or off on this device',
    run: (arg) => {
      const want = /^(off|no|stop)$/i.test((arg || '').trim()) ? true
        : /^(on|yes)$/i.test((arg || '').trim()) ? false : !isOff();
      localStorage.setItem(OFF_KEY, want ? '1' : '0');
      a.ui.toast(want
        ? 'Task suggestions off. Turn them back on with /tasksuggest on'
        : 'Task suggestions on', 'success');
    },
  });
}
