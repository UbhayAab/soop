// Presence, typing indicators, and the periodic reconciliation loops that keep
// the UI correct even when a realtime broadcast is dropped (the transport is
// at-most-once by design).
import { table, api } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { $, esc } from '../util.js';
import { requestResync, refreshUnread, renderChannels } from './channels.js';
import { loadReactions } from './messages.js';
import { refreshVoice } from './voice.js';
import { ensureFreshAuth, retryAllNow, sb } from '../sb.js';

const typers = new Map(); // user_id -> timeout

// The typing sender now emits one edge on start and one on stop, with a 10s
// keepalive in between (composer.js). The receiver's expiry has to sit between
// those two numbers: long enough that a real typist's keepalive always lands
// first, short enough that a client that vanished mid-sentence - closed lid,
// killed tab, dead radio - stops claiming to be typing within a few seconds.
const TYPING_EXPIRY_MS = 12000;

// The old 6 second reconcile is now a backstop and nothing more. It was the
// primary healing mechanism and it could not do the job:
//   - it cannot run at all while the tab is frozen, which on Android is exactly
//     when the socket dies and messages are missed;
//   - it cost 10 requests a minute per client, forever, on phones on prepaid
//     data, to ask a question whose answer is almost always "nothing";
//   - and because the cursor was advanced past dropped messages before it ran,
//     it was structurally incapable of finding them.
// Delivery is now driven by events - rejoin, visibility, network, and a real
// seq gap in the stream - and this timer exists only to catch the case where
// every one of those signals failed to fire.
//
// It only ticks while the tab is VISIBLE. A backgrounded tab has its timers
// throttled to about one a minute and is frozen outright after a few minutes,
// so a background poll is a battery and data cost that buys nothing; the return
// to the foreground fires visibilitychange, which resyncs in ~200ms. So: 25s of
// insurance while someone is actually looking at the screen, nothing at all
// while the phone is in a pocket.
const BACKSTOP_MS = 25000;

export function initPresence() {
  // My liveness, and - riding on the same call, for free - which channel I have
  // open. That second fact is what makes channels.viewer_count real, and
  // viewer_count is the only input to the digest safety valve that decides
  // whether a hot channel fans out one message per viewer or one nudge for all
  // of them. It was a column nothing ever wrote, so digest was unreachable code.
  //
  // Sent on the beat rather than as its own request on purpose: the request the
  // client already makes is the cheapest place to put it, and on a phone the
  // radio is already awake for it.
  // The status the beat carries. This used to be a hard-coded 'online', and
  // heartbeat() overwrites user_presence.status, so choosing Away or Do not
  // disturb was undone within 45 seconds - sooner, because opening any channel
  // beats immediately. Live evidence before the fix: of 1798 user_presence rows,
  // 1797 were 'offline' and 1 was 'online'. Not one row in either organisation
  // was 'away' or 'dnd', in an app that has offered the choice since 0034. The
  // value was unreachable, not unwanted, which is exactly what "your status and
  // availability is not working" meant.
  //
  // features/shortcuts.js had already hit this and worked around it locally with
  // a 20-second re-assert loop. Sending the real value on the beat we are already
  // making fixes it for every caller and lets that loop go.
  //
  // Deliberately NOT remembered on the device. The server is the authority:
  // migration 0062 stops a beat downgrading a hold, so a hold survives a reload
  // on its own, and app.reap_presence still clears it 60s after the last beat.
  // That is the semantic we want - a hold, not a mode - and it means a shared
  // phone cannot carry one person's Away into the next person's session.
  let myStatus = 'online';
  const beat = () => api.heartbeat(myStatus, store.current?.id || null).catch(() => {});
  bus.on('presence:mine', (s) => {
    if (s !== 'online' && s !== 'away' && s !== 'dnd') return;
    myStatus = s;
    beat();
  });
  beat();
  setInterval(beat, 45000);
  // Opening a channel is the moment the census changes; waiting up to 45s to
  // report it would make the monitor lag a crowd arriving in a channel, which is
  // exactly the event it exists to catch.
  bus.on('channel:open', beat);
  bus.on('dm:open', beat);

  // Who else is around. This also has to pick up people who joined AFTER my
  // bootstrap snapshot: without it a new member is invisible in the member list,
  // in mention autocomplete and in the DM picker until a reload.
  //
  // Both halves of this used to be O(everyone), every 20 seconds, per client:
  // the whole workspace_members table (33 KB per tick on the 1,192-member demo
  // Space), then user_presence for every profile id the client had ever seen -
  // with those ids in the query string, which is why an idle client uploaded
  // 417 KB in three minutes. At 500 users that is ~5,600 presence rows scanned
  // per second across the fleet, and it is the thing that forces bigger compute
  // long before Realtime bills anything.
  //
  // Both are now bounded by what actually changed:
  //   - membership arrives on the ws: subscription (member_joined -> reloadMembers
  //     in workspace.js), so the poll is a backstop for a dropped broadcast. It
  //     runs every sixth tick and asks only for rows newer than the newest
  //     joined_at already seen.
  //   - presence asks the server for the people who are online, instead of
  //     fetching everyone and filtering in the browser. RLS on user_presence
  //     already restricts the answer to co-members (0003), so dropping the id
  //     list does not widen it.
  const ONLINE_WINDOW_MS = 90000;
  let memberCursor = null;   // newest joined_at seen; null = never fetched
  let tickN = 0;

  const syncMembers = async () => {
    if (!store.ws) return;
    // get_bootstrap already returned every member of this Space, so there is no
    // first-run full fetch to do. Start the cursor slightly in the past to cover
    // anyone who joined between that snapshot and this loop starting.
    if (!memberCursor) memberCursor = new Date(Date.now() - 300000).toISOString();
    // ASCENDING, and the cursor advances only to the last row actually consumed.
    // Descending would take the 200 NEWEST joiners and then move the cursor past
    // everyone older in the same window, so a Space that gains more than 200
    // members between two ticks - a bulk provisioning run, which is exactly how
    // these orgs onboard - would lose the earlier ones from the member list,
    // mention autocomplete and the DM picker until a full reload.
    const mem = await table('workspace_members', (q) => q
      .eq('workspace_id', store.ws.id)
      .gt('joined_at', memberCursor)
      .order('joined_at', { ascending: true })
      .limit(200));
    if (mem.length) memberCursor = mem[mem.length - 1].joined_at;
    const unknown = mem.map((m) => m.user_id).filter((u) => !store.profiles.has(u));
    if (!unknown.length) return;
    const profs = await table('profiles', (q) => q.in('id', unknown));
    for (const p of profs) store.profiles.set(p.id, p);
    bus.emit('profiles');
  };

  const tick = async () => {
    if (tickN++ % 6 === 0) await syncMembers();
    if (!store.profiles.size) return;
    const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
    const { data, error } = await sb.from('user_presence')
      .select('user_id,status,last_seen_at')
      .neq('status', 'offline')
      .gt('last_seen_at', cutoff);
    if (error) return;   // transient; the next tick asks again
    // RLS scopes the answer to people I share ANY Space with, which for someone
    // in two orgs is wider than the Space on screen. Keep the count meaning what
    // it has always meant: people here.
    store.online = new Set((data || []).map((p) => p.user_id).filter((u) => store.profiles.has(u)));
    // The status column used to be thrown away here, and features/status.js paid
    // its own user_presence read - every profile id in the query string - to buy
    // back exactly this column for the away/dnd badges. Keep it instead: absent
    // means offline or stale, which is all the badge painter needs to know.
    store.presenceStatus = new Map((data || []).map((p) => [p.user_id, p.status]));
    store.online.add(store.me);
    const c = $('onlineCount');
    if (c) c.textContent = store.online.size;
    bus.emit('presence');
  };
  tick();
  setInterval(tick, 20000);

  // backstop only - see BACKSTOP_MS above
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (store.current || store.currentDM) requestResync('backstop');
  }, BACKSTOP_MS);
  // Reactions were refetched for the last 60 messages every 9 seconds whether
  // anything had changed or not: 6.7 requests a minute per client, ~2 KB of
  // message ids in the query string each time, forever. The realtime `reaction`
  // event already paints the common case; this loop only exists to heal a
  // dropped one. So run it when the visible set of messages plausibly changed -
  // a new message, a channel switch - and otherwise fall back to a slow sweep.
  //
  // It only ticks while the tab is VISIBLE. message:new arrives from realtime
  // regardless of visibility, so without the guard a pocketed phone on a busy
  // channel swept forever for rows nobody could see.
  let rxnDirty = true;
  let rxnLast = 0;
  const RXN_IDLE_MS = 60000;
  const markRxnDirty = () => { rxnDirty = true; };
  bus.on('message:new', markRxnDirty);
  bus.on('channel:open', markRxnDirty);
  bus.on('dm:open', markRxnDirty);
  const sweepReactions = () => {
    if (document.visibilityState !== 'visible') return;
    if (!rxnDirty && Date.now() - rxnLast < RXN_IDLE_MS) return;
    // Ids come off the screen, not out of store.seen: seen is insertion order,
    // so after paging up it named the oldest rows just prepended while the
    // reactions actually in view went unhealed. What is on screen is exactly
    // the set worth healing.
    const rows = $('messages')?.querySelectorAll('.msg') || [];
    const ids = [...rows].map((r) => r.dataset.id).filter(Boolean).slice(-60);
    if (!ids.length) return;
    rxnDirty = false;
    rxnLast = Date.now();
    loadReactions(ids);
  };
  setInterval(sweepReactions, 9000);
  // THE MOST EXPENSIVE LOOP IN THE APP, and it was the one nobody looked at.
  //
  // refreshUnread() is three network calls, not one: get_unread, then the
  // cross-Space rollup for the rail badges, then the DM list (channels.js). At
  // every 15 seconds that is 720 requests an hour from a client that is doing
  // nothing, out of about 1,800 an hour in total. Measured against the Supabase
  // free plan that is the limit which breaks FIRST, and it breaks on egress at
  // roughly 29 people - which is smaller than this organisation already is. Not
  // on chat, not on voice: on timers ticking in tabs nobody is looking at.
  //
  // Three changes, in order of how much they save.
  //
  // Skip when the tab is not visible. A phone in somebody's pocket with the app
  // still open was polling all day. This costs nothing, because realtime already
  // delivers the messages that make a badge change; the poll is a backstop for a
  // dropped event, and a dropped event nobody can see does not need healing
  // until they look. Coming back to the tab refreshes immediately, so the badge
  // is right by the time it is read.
  //
  // Halve the rate, 15s to 30s. Realtime is the fast path.
  //
  // And run the expensive two thirds a quarter as often. The rail rollup and the
  // DM list are for OTHER Spaces and OTHER conversations, which is exactly the
  // information realtime is already pushing on its own topics.
  let unreadTick = 0;
  const pollUnread = () => {
    if (!store.ws) return;
    if (document.visibilityState !== 'visible') return;
    refreshUnread({ full: unreadTick++ % 4 === 0 });
  };
  setInterval(pollUnread, 30000);
  // The return-to-visible refresh lives in the resync handler further down,
  // which already does exactly this alongside the heartbeat, the auth check and
  // the socket retry. Registering a second listener here meant every tab switch
  // ran refreshUnread TWICE - and refreshUnread defaults to full, so that is six
  // RPCs where three were wanted. A laptop user switching tabs twenty times an
  // hour was paying sixty requests an hour for the duplicate alone.

  setInterval(() => {
    if (!store.ws) return;
    if (document.visibilityState !== 'visible') return;
    refreshVoice();
  }, 20000);

  // `state` is absent on payloads from a client that has not reloaded since the
  // typing change shipped; those are starts, which is what they always were.
  bus.on('typing', ({ user_id, name, state }) =>
    (state === 'stop' ? clearTyping(user_id) : showTyping(user_id, name)));
  bus.on('unread:reload', refreshUnread);

  // Indicators belong to the channel they were published on. Carrying them
  // across a switch shows a stranger typing into a conversation they are not in.
  const dropTypers = () => { for (const t of typers.values()) clearTimeout(t); typers.clear(); paintTyping(); };
  bus.on('channel:open', dropTypers);
  bus.on('dm:open', dropTypers);

  // ---- the event-driven triggers that replaced the timer ----
  // A phone coming out of a pocket, off a lift, out of a tunnel. Each of these
  // is a moment where the client KNOWS it may have missed something, and each
  // resyncs in ~200ms instead of waiting up to six seconds for a tick that a
  // frozen tab was never going to run anyway.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    beat();
    ensureFreshAuth().catch(() => {});
    // force: coming back from sleep is exactly the case where the socket looks
    // joined and carries nothing, and where a plain retryAllNow() skipped every
    // topic and left the tab needing a reload to receive anything again.
    retryAllNow({ force: true });
    requestResync('visible');
    // Reset the tick counter so this one is a FULL refresh: coming back is
    // exactly when the cross-Space rail badges and the DM list are most likely
    // to be wrong, and it is the one moment somebody is about to look at them.
    unreadTick = 0;
    refreshUnread();
    // Heal the reactions on screen now instead of waiting up to 9s for the tick.
    sweepReactions();
  });

  window.addEventListener('online', () => {
    beat();
    retryAllNow({ force: true });
    requestResync('online');
    refreshUnread();
  });

  window.addEventListener('focus', () => requestResync('focus'));

  // Android back-forward cache: the page is resumed wholesale, no reload, no
  // visibilitychange in some browsers, and every timer inside it is stale.
  window.addEventListener('pageshow', (e) => { if (e.persisted) requestResync('pageshow'); });
}

function showTyping(userId, name) {
  clearTimeout(typers.get(userId));
  typers.set(userId, setTimeout(() => { typers.delete(userId); paintTyping(); }, TYPING_EXPIRY_MS));
  paintTyping();
}

function clearTyping(userId) {
  clearTimeout(typers.get(userId));
  if (typers.delete(userId)) paintTyping();
}

function paintTyping() {
  const host = $('typing');
  if (!host) return;
  const names = [...typers.keys()].map(nameOf);
  host.textContent = !names.length ? ''
    : names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : 'Several people are typing…';
}
