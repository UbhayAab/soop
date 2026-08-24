// Direct messages. Same rendering path as channels so DMs get reactions,
// attachments, replies and the in-app media viewer for free.
import { sb, subscribe, unsubscribe } from '../sb.js';
import { api, table, tryRpc } from '../api.js';
import { store, bus, nameOf, resetChannelState } from '../store.js';
import { $, el, esc, debounce } from '../util.js';
import { toast, modal, closePanel } from '../ui.js';
import { appendMessage, claimMessage, loadReactions, applyReaction, atBottom, scrollDown } from './messages.js';
import { renderChannels, showNewBelow, clearNewBelow } from './channels.js';
import { avatarHtml } from './messages.js';

// A DM had no cursor, no gap detection and no healing path of ANY kind. Both
// periodic loops gated on `store.current`, which openDM sets to null, so a
// dropped broadcast in a 1:1 conversation was unrecoverable until the
// conversation was reopened - and the sidebar cheerfully showed "1 unread" on
// the conversation that was open on screen with the message nowhere in it.
// dm_messages already carries a gapless per-conversation seq, so this needed no
// schema change, only the same three things channels now have: a cursor, a gap
// branch, and a resume.
const DM_PAGE = 80;
const dmGapBuffer = new Map();
let dmGen = 0;

export async function openDM(conversationId) {
  const gen = ++dmGen;
  // A pending read for the conversation being LEFT must go out now, not on the
  // timer: the whole point of the coalescing window is bursts, and switching
  // mid-burst is exactly when the reader stops caring about it. The write is
  // monotonic in seq, so a duplicate after the reopen path's own markDMRead
  // below is harmless.
  flushDMRead();
  store.current = null;
  store.currentDM = conversationId;
  resetChannelState();
  dmGapBuffer.clear();
  closePanel();

  const conv = store.dms.find((d) => d.conversation_id === conversationId);
  const others = (conv?.other_user_ids || []).filter((u) => u !== store.me);
  const label = others.length ? others.map(nameOf).join(', ') : 'you';
  $('hdrName').textContent = '@ ' + label;
  $('hdrTopic').textContent = '';
  const c = $('composer');
  c.dataset.ph = 'Message ' + label;
  c.placeholder = c.dataset.ph;
  c.value = store.drafts.get('dm:' + conversationId) || '';
  renderChannels();

  const list = $('messages');
  list.innerHTML = '<div class="muted pad">loading…</div>';
  // Newest page, not oldest. `order('seq').limit(80)` fetched the FIRST eighty
  // messages ever sent, so any conversation past eighty opened on ancient
  // history with today's messages nowhere on screen.
  const page = await table('dm_messages', (q) =>
    q.eq('conversation_id', conversationId).order('seq', { ascending: false }).limit(DM_PAGE));
  if (gen !== dmGen) return;
  const msgs = page.slice().reverse();
  list.innerHTML = '';
  if (!msgs.length) {
    list.appendChild(el('div', 'empty', `This is the start of your conversation with <b>${esc(label)}</b>.`));
  }
  for (const m of msgs) {
    if (!claimMessage(m)) continue;
    appendMessage(list, m, 'dm', { bulk: true });
  }
  await loadReactions(msgs.map((m) => m.id));
  if (gen !== dmGen) return;
  // The pill is a sibling of the list, so opening a conversation does not clear
  // it. Use the hardened pin rather than one bare assignment, or avatars and
  // images settling leave the newest message below the fold - which then reads as
  // "not at the bottom" and turns the next arrival into a pill instead of a
  // follow.
  clearNewBelow();
  scrollDown(list);

  const lastSeq = msgs.length ? msgs[msgs.length - 1].seq : 0;
  store.dmCursor = lastSeq || 0;
  if (lastSeq) {
    api.markDMRead(conversationId, lastSeq).catch(() => {});
    clearDMUnreadLocal(conversationId);
  }

  // Opening a DM never touched the 'typing' subscription, so the previous
  // CHANNEL's typ:<channel_id> topic stayed live - and composer.js sendTyping()
  // publishes on whatever getSub('typing') currently holds. Every keystroke typed
  // into a private conversation was therefore broadcast into the last channel the
  // person had open, where everyone reading it saw "<name> is typing…" while they
  // wrote a DM. Nothing in a DM should reach a channel at all.
  unsubscribe('typing');

  subscribe('dm', 'dm:' + conversationId, {
    msg: (m) => onIncomingDM(conversationId, m),
    reaction: (p) => applyReaction(p),
    read: () => bus.emit('dm:receipts', { conversationId }),
  });

  bus.emit('dm:open', { conversationId });
  refreshReceipts(conversationId);
}

function onIncomingDM(conversationId, m) {
  if (store.currentDM !== conversationId) return;
  const seq = +(m.seq || 0);
  // No `store.dmCursor &&` here on purpose. openDM() sets the cursor BEFORE it
  // subscribes, so 0 always means "this conversation is empty" and never "we do
  // not know yet" - and a brand new conversation whose first messages are
  // dropped is the case a truthiness check silently skips. The channel side
  // needs an explicit flag for this because it subscribes before it knows; here
  // the ordering already guarantees it.
  if (seq && seq > store.dmCursor + 1) {
    dmGapBuffer.set(seq, m);
    reconcileDM();
    return;
  }
  applyIncomingDM(conversationId, m);
}

function applyIncomingDM(conversationId, m) {
  if (store.currentDM !== conversationId) return;
  if (m.seq) store.dmCursor = Math.max(store.dmCursor, m.seq);
  if (!claimMessage(m)) return;
  const list = $('messages');
  // The channel path has always asked whether the reader is at the bottom before
  // following it down. This did not: every arriving DM yanked whoever was reading
  // back up the conversation to the newest message, with no pill and nothing to
  // say what had happened. Reported by both organisations, and DMs are where they
  // noticed it, because a DM is the one place a message always concerns you.
  const stick = atBottom(list);
  appendMessage(list, m, 'dm');
  if (stick) scrollDown(list); else showNewBelow();
  // Coalesced, the same way the channel path already coalesces its own
  // mark_read. Uncoalesced this was one RPC AND one realtime fan-out per message
  // in a burst - somebody sending five lines in ten seconds cost five of each,
  // to say the same thing five times. The reader's screen has already cleared
  // its own unread state locally; the only thing this call drives is the
  // sender's "Seen" line, and that does not need to be five updates either.
  markDMReadSoon(conversationId, m.seq);
  bus.emit('message:new', { msg: m, dm: true });
}

// The DM half of coalescing, deliberately the same shape as markReadSoon in
// js/core/channels.js so the two paths behave identically. Highest seq wins, one
// call per window however many messages land inside it.
const DM_READ_MS = 1200;
let dmReadPending = null;
let dmReadTimer = null;

function markDMReadSoon(conversationId, seq) {
  if (!seq) return;
  if (!dmReadPending || dmReadPending.id !== conversationId || seq > dmReadPending.seq) {
    dmReadPending = {
      id: conversationId,
      seq: Math.max(seq, dmReadPending?.id === conversationId ? dmReadPending.seq : 0),
    };
  }
  if (dmReadTimer) return;
  dmReadTimer = setTimeout(flushDMRead, DM_READ_MS);
}

// Send the coalesced cursor immediately and disarm the timer. Two callers want
// this ahead of schedule: openDM when the reader moves to another conversation,
// and hidden - pocketing or closing the tab kills timers without firing them,
// so the last burst in a DM would stay unread everywhere but this device.
function flushDMRead() {
  if (dmReadTimer) { clearTimeout(dmReadTimer); dmReadTimer = null; }
  const p = dmReadPending;
  dmReadPending = null;
  if (p) api.markDMRead(p.id, p.seq).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDMRead();
});

// The DM half of RESUME. Same shape as the channel one: replay past the cursor,
// re-bootstrap if the cursor is older than anything retained.
export async function reconcileDM() {
  const conversationId = store.currentDM;
  if (!conversationId) return;
  const gen = dmGen;
  const start = store.dmCursor;

  for (let page = 0; ; page++) {
    let r;
    try { r = await api.resumeDM(conversationId, store.dmCursor, 200); }
    catch { return; }                       // transient; a trigger will come round again
    if (gen !== dmGen || store.currentDM !== conversationId) return;
    if (r?.too_old) { await openDM(conversationId); return; }

    const rows = Array.isArray(r?.messages) ? r.messages : [];
    if (!rows.length) break;
    const list = $('messages');
    const stick = atBottom(list);
    let landed = 0;
    for (const m of rows) {
      store.dmCursor = Math.max(store.dmCursor, m.seq || 0);
      dmGapBuffer.delete(m.seq);
      if (m.deleted_at) continue;
      if (!claimMessage(m)) continue;
      appendMessage(list, m, 'dm');
      landed++;
      bus.emit('message:new', { msg: m, dm: true, healed: true });
    }
    await loadReactions(rows.map((m) => m.id));
    if (gen !== dmGen || store.currentDM !== conversationId) return;
    // A healed message is still an arriving message: recovering what the socket
    // dropped must not move somebody who is reading further up either.
    if (stick) scrollDown(list); else if (landed) showNewBelow(landed);
    if (!r.more || page + 1 >= 5) break;
  }

  for (const seq of [...dmGapBuffer.keys()].sort((a, b) => a - b)) {
    if (seq > store.dmCursor + 1) break;
    const m = dmGapBuffer.get(seq);
    dmGapBuffer.delete(seq);
    applyIncomingDM(conversationId, m);
  }

  if (store.dmCursor > start) {
    api.markDMRead(conversationId, store.dmCursor).catch(() => {});
    clearDMUnreadLocal(conversationId);
  }
}

// The DM half of channels.clearUnreadLocal: a DM's unread state lives on the
// store.dms row, not in store.unread, and mark_dm_read's outcome is known the
// moment we send it. Repaint via 'unread' so tabbar/dmlist/shortcuts follow.
function clearDMUnreadLocal(conversationId) {
  const row = store.dms.find((d) => d.conversation_id === conversationId);
  if (!row || !(row.unread === true || +row.unread > 0)) return;
  row.unread = 0;
  bus.emit('unread');
  renderChannels();
}

async function refreshReceipts(conversationId) {
  const [rows] = await tryRpc('get_dm_receipts', { p_conversation: conversationId });
  if (!Array.isArray(rows)) return;
  const others = rows.filter((r) => r.user_id !== store.me);
  const host = $('dmReceipt');
  if (!host) return;
  if (!others.length) { host.textContent = ''; return; }
  const seenUpTo = Math.max(...others.map((r) => r.last_read_seq || 0));
  const lastMine = [...document.querySelectorAll('.msg.me')].pop();
  const mySeq = lastMine ? +(lastMine.dataset.seq || 0) : 0;
  host.textContent = mySeq && seenUpTo >= mySeq ? 'Seen' : '';
}

export async function startDM(userId) {
  // create_dm has always accepted an array; the only caller ever passed one id,
  // so three people who needed one conversation had to create a whole channel
  // instead and went back to WhatsApp. Accept either shape.
  const ids = Array.isArray(userId) ? userId : [userId];
  try {
    const conv = await api.createDM(store.ws.id, ids);
    if (!store.dms.find((d) => d.conversation_id === conv.id)) {
      store.dms.push({ conversation_id: conv.id, kind: conv.kind, other_user_ids: [...ids, store.me], unread: 0 });
    }
    await openDM(conv.id);
    renderChannels();
  } catch (e) {
    // create_dm filters the recipients down to members of THIS Space and raises
    // 'need_recipient' when none survive, so two people in different
    // organisations cannot DM at all here. The raw error code told the person
    // nothing, and this is the most likely thing to hit for the one account that
    // is a member of both.
    toast(/need_recipient/i.test(e.message || '')
      ? 'That person is not in this Space, so there is no conversation to open. Switch to the Space you share with them.'
      : (e.message || 'Could not start that conversation'), 'error');
  }
}

const GROUP_DM_CAP = 9;

export function newDMDialog() {
  const box = el('div', 'picker-list');
  const search = el('input');
  search.placeholder = 'Search people';
  const hint = el('div', 'picker-hint muted', 'Pick one for a direct message, or several for a group.');
  const list = el('div', 'picker-rows');
  const go = el('button', 'sm', 'Start conversation');
  go.type = 'button';
  go.disabled = true;
  box.append(search, hint, list, go);

  const picked = new Set();

  const paintHint = () => {
    const n = picked.size;
    go.textContent = n > 1 ? `Start group (${n})` : n === 1 ? 'Start conversation' : 'Start conversation';
    go.disabled = n === 0;
    hint.textContent = n >= GROUP_DM_CAP
      ? `Group size caps at ${GROUP_DM_CAP}.`
      : n > 1 ? `${n} selected - this will be a group.` : 'Pick one for a direct message, or several for a group.';
  };

  const draw = (q = '') => {
    const rows = [...store.profiles.values()]
      .filter((p) => p.id !== store.me)
      .filter((p) => !q || (p.display_name || '').toLowerCase().includes(q.toLowerCase())
        || (p.username || '').toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = '';
    if (!rows.length) { list.appendChild(el('div', 'empty', 'Nobody else here yet. Invite someone first.')); return; }
    for (const p of rows.slice(0, 60)) {
      const r = el('div', 'picker-row' + (picked.has(p.id) ? ' picked' : ''));
      r.innerHTML = `${avatarHtml(p.id, 26)}<span>${esc(p.display_name || p.username)}</span>
        ${store.online.has(p.id) ? '<span class="dot on"></span>' : '<span class="picker-check">✓</span>'}`;
      r.onclick = () => {
        if (picked.has(p.id)) picked.delete(p.id);
        else if (picked.size < GROUP_DM_CAP) picked.add(p.id);
        paintHint();
        draw(search.value);
      };
      list.appendChild(r);
    }
  };
  const m = modal({ title: 'New message', body: box });
  go.onclick = () => { if (picked.size) { m.close(); startDM([...picked]); } };
  search.oninput = () => draw(search.value);
  draw();
}

bus.on('dm:request', ({ conversationId }) => openDM(conversationId));
bus.on('dm:new', newDMDialog);
// The `read` broadcast on the dm topic emits this, but nothing listened - so the
// Seen line was painted exactly once per open and then froze forever while the
// other person kept reading. Re-run the receipts fetch whenever it fires for the
// conversation actually on screen, debounced because the sender's client can
// fire read broadcasts in a burst and each one is an RPC.
const refreshReceiptsSoon = debounce((id) => refreshReceipts(id), 1000);
bus.on('dm:receipts', ({ conversationId }) => {
  if (store.currentDM === conversationId) refreshReceiptsSoon(conversationId);
});

// Every resync trigger - rejoin, visibility, network, backstop - reaches DMs too.
bus.on('delivery:resync', () => { if (store.currentDM) reconcileDM(); });
bus.on('realtime:subscribed', ({ key, rejoined }) => {
  if (key === 'dm' && rejoined && store.currentDM) reconcileDM();
});
