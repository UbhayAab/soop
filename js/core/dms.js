// Direct messages. Same rendering path as channels so DMs get reactions,
// attachments, replies and the in-app media viewer for free.
import { sb, subscribe, unsubscribe } from '../sb.js';
import { api, table, tryRpc } from '../api.js';
import { store, bus, nameOf, resetChannelState } from '../store.js';
import { $, el, esc } from '../util.js';
import { toast, modal, closePanel } from '../ui.js';
import { appendMessage, claimMessage, loadReactions, applyReaction, atBottom, scrollDown } from './messages.js';
import { renderChannels, refreshUnread, showNewBelow, clearNewBelow } from './channels.js';
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
  if (lastSeq) api.markDMRead(conversationId, lastSeq).catch(() => {});

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
  api.markDMRead(conversationId, m.seq).catch(() => {});
  bus.emit('message:new', { msg: m, dm: true });
}

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
    api.markDMRead(conversationId, store.dmCursor).then(refreshUnread).catch(() => {});
  }
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
  try {
    const conv = await api.createDM(store.ws.id, [userId]);
    if (!store.dms.find((d) => d.conversation_id === conv.id)) {
      store.dms.push({ conversation_id: conv.id, kind: conv.kind, other_user_ids: [userId, store.me], unread: 0 });
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

export function newDMDialog() {
  const box = el('div', 'picker-list');
  const search = el('input');
  search.placeholder = 'Search people';
  const list = el('div', 'picker-rows');
  box.append(search, list);

  const draw = (q = '') => {
    const rows = [...store.profiles.values()]
      .filter((p) => p.id !== store.me)
      .filter((p) => !q || (p.display_name || '').toLowerCase().includes(q.toLowerCase())
        || (p.username || '').toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = '';
    if (!rows.length) { list.appendChild(el('div', 'empty', 'Nobody else here yet. Invite someone first.')); return; }
    for (const p of rows) {
      const r = el('div', 'picker-row');
      r.innerHTML = `${avatarHtml(p.id, 26)}<span>${esc(p.display_name || p.username)}</span>
        ${store.online.has(p.id) ? '<span class="dot on"></span>' : ''}`;
      r.onclick = () => { m.close(); startDM(p.id); };
      list.appendChild(r);
    }
  };
  const m = modal({ title: 'New message', body: box });
  search.oninput = () => draw(search.value);
  draw();
}

bus.on('dm:request', ({ conversationId }) => openDM(conversationId));
bus.on('dm:new', newDMDialog);

// Every resync trigger - rejoin, visibility, network, backstop - reaches DMs too.
bus.on('delivery:resync', () => { if (store.currentDM) reconcileDM(); });
bus.on('realtime:subscribed', ({ key, rejoined }) => {
  if (key === 'dm' && rejoined && store.currentDM) reconcileDM();
});
