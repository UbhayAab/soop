// Direct calls. Ringing a person, the way a phone does.
//
// A voice ROOM is a place: it is always there, you walk in, and somebody may or
// may not be standing in it. That is a good shape for a standup and the wrong
// shape for "I need Priya, now" - which is why both organisations kept reaching
// for WhatsApp for the one thing this app could already carry. A call names a
// person, rings on their device, and ends with an answer or a refusal.
//
// THE MESH IS THE SAME MESH. Audio is peer to peer, exactly as rooms are, and
// the negotiation lives in js/core/rtc.js so a fix to either one is a fix to
// both. Two people is one connection; three is two connections each, which is
// the honest ceiling for this and is enforced by the server.
//
// THE SIGNALLING IS NOT THE SAME. A room broadcasts SDP on vc:<channel>, which
// works because everyone in the room has joined that topic. A call has no topic
// of its own and inventing one would need an RLS policy on realtime.messages
// that cannot be verified from this repo (EFFICIENCY.md rank 5 refused a change
// for exactly that reason: a wrong policy means calls that silently never
// connect). So signals go out through the call_signal RPC and come back on
// user:<uid> - the per-person topic that provably works today. That costs an
// HTTP round trip per signal, which is why ICE candidates are batched below;
// after the first two seconds of a call, nothing is sent at all.
import { api } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { toast } from '../ui.js';
import { createLink, levelMeter, signalInbox } from './rtc.js';
import { voice } from './voice.js';

// How long a phone rings before nobody is home. WhatsApp is around 45 seconds
// and the server sweeps at 90, so this stays well inside the window where the
// row is still ringing.
const RING_MS = 45000;
// The callee's own backstop, slightly longer: if the CALLER's browser dies
// mid-ring there is nobody left to cancel, and a phone that rings forever is
// worse than one that gives up.
const RING_GIVEUP_MS = 55000;
const BEAT_MS = 25000;
// ICE candidates arrive in bursts of ten to thirty in the first second. One RPC
// each is thirty requests; one every 150ms is three or four, and 150ms is far
// below the point where a delayed candidate slows a connection down.
const ICE_BATCH_MS = 150;

export const call = {
  // The server's view of the call, verbatim: call_id, conversation_id, state,
  // created_by, participants[{user_id, state}]. Null when there is no call.
  info: null,
  // 'idle' | 'incoming' | 'outgoing' | 'live'
  phase: 'idle',
  local: null,
  muted: false,
  speaker: true,
  links: new Map(),      // peer id -> PeerLink
  meters: new Map(),     // peer id -> stop()
  speaking: new Set(),   // peer ids currently making sound
  startedAt: 0,
  beat: null,
  ringTimer: null,
  // Kept after the call ends, because the record line is written once the row is
  // already gone from `info`.
  lastConversation: null,
  // A call recovered from the server after a reload is answered differently: the
  // row already says we are in it, so there is nothing to answer.
  rejoin: false,
};

const others = () => (call.info?.participants || [])
  .filter((p) => p.user_id !== store.me);

// Who is actually in the audio right now, me excluded. 'caller' counts: the
// person who started the call is in it from the first second, and leaving them
// out here is a callee who answers and hears nobody.
const IN_AUDIO = ['caller', 'joined'];
const joined = () => others().filter((p) => IN_AUDIO.includes(p.state)).map((p) => p.user_id);

export const callActive = () => call.phase !== 'idle';
export const isCaller = () => call.info?.created_by === store.me;

// The people this call is with, as a sentence. Used by every surface that has to
// name it, so they cannot disagree.
export function callTitle() {
  const ids = others().map((p) => p.user_id);
  if (!ids.length) return 'Call';
  const names = ids.map((u) => nameOf(u));
  return names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function paint() { bus.emit('call:update', { call: call.info, phase: call.phase }); }

// The last call this device finished. Every ending is delivered twice - once by
// whichever local path hung up, and once by the server's own fanout coming back
// round - and without this the second one repaints an ended call, toasts a second
// time and, on the caller's side, writes the record line twice.
let lastEnded = null;

// ------------------------------------------------------------------ transport
//
// One outbound queue per peer. Offers and answers go immediately - they are the
// critical path and there is exactly one of each - while ICE candidates collect
// for a moment and travel together.
const iceOut = new Map();     // peer id -> {timer, batch:[]}
// Signals that beat their own connection into existence. See rtc.js.
const inbox = signalInbox();

function flushIce(peerId) {
  const q = iceOut.get(peerId);
  if (!q) return;
  clearTimeout(q.timer);
  iceOut.delete(peerId);
  if (!q.batch.length || !call.info) return;
  api.callSignal(call.info.call_id, peerId, { kind: 'ice-batch', data: q.batch })
    .catch(() => { /* the far side has gone; the connection will say so */ });
}

function sendTo(peerId, msg) {
  if (!call.info) return;
  if (msg.kind === 'ice') {
    let q = iceOut.get(peerId);
    if (!q) { q = { timer: null, batch: [] }; iceOut.set(peerId, q); }
    q.batch.push(msg.data);
    if (!q.timer) q.timer = setTimeout(() => flushIce(peerId), ICE_BATCH_MS);
    return;
  }
  // An offer or answer must not overtake candidates already queued for the same
  // peer, or the far side buffers them for nothing.
  flushIce(peerId);
  api.callSignal(call.info.call_id, peerId, msg)
    .catch((e) => console.warn('[call] signal failed', e.message));
}

// ------------------------------------------------------------------ audio out
function audioFor(peerId) {
  let a = document.getElementById('ca-' + peerId);
  if (!a) {
    a = document.createElement('audio');
    a.id = 'ca-' + peerId;
    a.autoplay = true;
    a.playsInline = true;
    document.body.appendChild(a);
  }
  return a;
}

function dropAudio(peerId) {
  const a = document.getElementById('ca-' + peerId);
  // srcObject nulled before the element goes, so the decoder is released rather
  // than pinned by a detached node still holding a live MediaStream.
  if (a) { a.srcObject = null; a.remove(); }
}

// ------------------------------------------------------------------ peers
async function connectTo(peerId) {
  if (call.links.has(peerId) || peerId === store.me || !call.local) return;
  // Placeholder first: createLink awaits the ICE config, and two call_state
  // events inside that window would otherwise both build a connection to the
  // same person - which is a duplicate offer and a wedged negotiation.
  call.links.set(peerId, null);
  let link;
  try {
    link = await createLink({
      id: peerId,
      me: store.me,
      send: (msg) => sendTo(peerId, msg),
      onTrack: (track, stream) => {
        if (track.kind !== 'audio') return;
        const a = audioFor(peerId);
        a.srcObject = stream;
        a.muted = !call.speaker;
        a.play?.().catch(() => { /* autoplay policy; the accept gesture usually covers it */ });
        call.meters.get(peerId)?.();
        call.meters.set(peerId, levelMeter(stream, (on) => {
          const was = call.speaking.has(peerId);
          if (on === was) return;
          if (on) call.speaking.add(peerId); else call.speaking.delete(peerId);
          bus.emit('call:speaking', { userId: peerId, speaking: on });
        }));
      },
      onState: (s) => {
        bus.emit('call:peer', { userId: peerId, state: s });
        if (s === 'failed' || s === 'closed') dropPeer(peerId);
      },
    });
  } catch (e) {
    call.links.delete(peerId);
    console.warn('[call] could not build a connection', e);
    return;
  }
  // Torn down while we were awaiting the ICE config.
  if (!call.local || call.phase === 'idle') { link.close(); call.links.delete(peerId); return; }
  call.links.set(peerId, link);
  await link.addStream(call.local);
  // Anything the far side sent while this was being built. Before our own offer,
  // so an offer that already arrived is answered instead of colliding with ours.
  inbox.release(peerId, link);
  // Deterministic offerer, the same rule rooms use: the lower id offers, so two
  // peers never both offer on a fresh connection.
  if (String(store.me) < String(peerId)) await link.offer();
}

function dropPeer(peerId) {
  call.links.get(peerId)?.close();
  call.links.delete(peerId);
  call.meters.get(peerId)?.();
  call.meters.delete(peerId);
  call.speaking.delete(peerId);
  flushIce(peerId);
  inbox.drop(peerId);
  dropAudio(peerId);
}

// ------------------------------------------------------------------ mic
async function openMic() {
  if (call.local) return true;
  try {
    call.local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch {
    toast('Microphone permission is needed to make a call', 'error');
    return false;
  }
  call.muted = false;
  // Your own level, so the bar can show that your mic is live before anybody
  // answers - which is the difference between a quiet call and a dead one.
  call.meters.get(store.me)?.();
  call.meters.set(store.me, levelMeter(call.local, (on) => {
    const was = call.speaking.has(store.me);
    if (on === was) return;
    if (on) call.speaking.add(store.me); else call.speaking.delete(store.me);
    bus.emit('call:speaking', { userId: store.me, speaking: on });
  }));
  return true;
}

export function setMuted(on) {
  call.muted = on;
  call.local?.getAudioTracks().forEach((t) => { t.enabled = !on; });
  paint();
}

export function setSpeaker(on) {
  call.speaker = on;
  document.querySelectorAll('audio[id^="ca-"]').forEach((a) => { a.muted = !on; });
  paint();
}

// ------------------------------------------------------------------ ringing
export async function startCall(conversationId) {
  if (callActive()) { toast('You are already in a call', 'info'); return null; }
  // Asked BEFORE the server is told, so a refused microphone is a call that
  // never rang rather than one the other person answers into silence.
  if (!(await openMic())) return null;

  let info;
  try {
    info = await api.startCall(conversationId);
  } catch (e) {
    releaseMic();
    toast(callError(e), 'error');
    return null;
  }
  call.info = info;
  call.phase = 'outgoing';
  call.startedAt = 0;
  beatOn();
  paint();

  // Everybody was already on a call: the server ends it immediately and says so.
  if (info.state === 'ended') { finish(info.end_reason || 'busy'); return null; }

  clearTimeout(call.ringTimer);
  call.ringTimer = setTimeout(() => {
    if (call.phase === 'outgoing') hangUp('missed');
  }, RING_MS);
  return info;
}

// Answering. The one place a call becomes audio.
export async function answerCall() {
  if (call.phase !== 'incoming' || !call.info) return;
  if (!(await openMic())) { await declineCall('declined'); return; }
  clearTimeout(call.ringTimer);

  // Rejoining after a reload. The row already says we are in this call, and
  // answer_call would refuse it - correctly, because there is nothing left to
  // answer. All that was lost was the audio, which openMic and applyState below
  // rebuild.
  if (call.rejoin) {
    call.rejoin = false;
    beatOn();
    // A caller who reloaded while it was still ringing goes back to ringing, not
    // into audio: there is nobody on the other end yet. applyState would leave
    // this stuck on the incoming sheet, because a 'ringing' call gives it nothing
    // to do.
    if (isCaller() && call.info.state === 'ringing') {
      call.phase = 'outgoing';
      clearTimeout(call.ringTimer);
      call.ringTimer = setTimeout(() => {
        if (call.phase === 'outgoing') hangUp('missed');
      }, RING_MS);
      paint();
      return;
    }
    applyState(call.info);
    return;
  }

  const id = call.info.call_id;
  let info;
  try {
    info = await api.answerCall(id);
  } catch (e) {
    // The most common cause by far is that the other side hung up while the
    // ringing UI was still on screen.
    const gone = /call_gone/.test(e.message || '');
    finish('gone');
    // Anything else - a dropped request, a token that expired mid-ring - leaves
    // a row that still says ringing, and the caller would go on listening to a
    // ringback for ninety seconds until the sweeper caught it. Say no properly.
    if (!gone) api.declineCall(id, 'declined').catch(() => {});
    toast(gone ? 'That call has already ended' : callError(e), 'info');
    return;
  }
  applyState(info);
}

export async function declineCall(reason = 'declined') {
  if (!call.info) return;
  const id = call.info.call_id;
  finish(reason);
  try { await api.declineCall(id, reason); } catch { /* it is already over for us */ }
}

export async function hangUp(reason = null) {
  if (!call.info) return;
  const id = call.info.call_id;
  const wasRinging = call.phase === 'outgoing';
  const mine = isCaller();
  const secs = call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
  finish(reason || (wasRinging ? 'cancelled' : 'ended'));
  try { await api.endCall(id, reason); } catch { /* best effort */ }
  // The record of the call belongs in the conversation, the way it does on a
  // phone: a line you can scroll back to. Written by the CALLER only, so three
  // people in a call do not write three lines about it.
  if (mine) await writeRecord(reason || (wasRinging ? 'cancelled' : 'ended'), secs);
}

// ------------------------------------------------------------------ record
// One line in the DM, posted through the ordinary send_dm path. Nothing about it
// is special-cased on the server: it is a message, so it syncs, searches, pushes
// and heals like every other message, and a person who does not want it can
// delete it.
async function writeRecord(reason, secs) {
  const conv = call.lastConversation;
  if (!conv) return;
  const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  const text = reason === 'missed' ? 'Voice call - no answer'
    : reason === 'declined' ? 'Voice call - declined'
      : reason === 'busy' ? 'Voice call - line was busy'
        : reason === 'cancelled' ? 'Voice call - cancelled'
          : secs > 0 ? `Voice call - ${dur}` : 'Voice call';
  try {
    await api.sendDM({ conversation: conv, nonce: crypto.randomUUID(), text: '\u{1F4DE} ' + text });
  } catch { /* the line is a courtesy, never worth an error on screen */ }
}

// ------------------------------------------------------------------ lifecycle
function beatOn() {
  clearInterval(call.beat);
  call.beat = setInterval(() => {
    if (call.info) api.callHeartbeat(call.info.call_id).catch(() => {});
  }, BEAT_MS);
}

function releaseMic() {
  call.local?.getTracks().forEach((t) => t.stop());
  call.local = null;
  call.meters.get(store.me)?.();
  call.meters.delete(store.me);
}

// Everything that has to happen exactly once when a call stops being a call.
// Called from the local hang-up paths AND from the server's own call_state, so
// it must be idempotent: whichever arrives second finds nothing left to do.
function finish(reason) {
  if (call.phase === 'idle' && !call.info) return;
  clearTimeout(call.ringTimer);
  clearInterval(call.beat);
  call.ringTimer = null;
  call.beat = null;
  for (const id of [...call.links.keys()]) dropPeer(id);
  // Anything held for a peer who never finished arriving. Bounded per peer, but
  // a call that ends mid-negotiation should not leave it for the next one.
  inbox.clear();
  releaseMic();
  const ended = call.info;
  lastEnded = ended?.call_id || lastEnded;
  call.lastConversation = ended?.conversation_id || call.lastConversation;
  call.info = null;
  call.phase = 'idle';
  call.muted = false;
  call.speaker = true;
  call.startedAt = 0;
  call.rejoin = false;
  call.speaking.clear();
  bus.emit('call:ended', { call: ended, reason });
  paint();
}

// The server's state, applied. This is the only writer of call.phase once a call
// exists, so two devices, a decline and a hang-up racing each other all converge
// on whatever the database says rather than on whoever painted last.
function applyState(info) {
  if (!info) return;
  if (info.call_id === lastEnded) return;                        // the echo of our own ending
  if (call.info && info.call_id !== call.info.call_id) return;   // a stale echo
  call.info = info;

  if (info.state === 'ended') {
    const reason = info.end_reason || 'ended';
    const secs = call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
    const mine = isCaller();
    finish(reason);
    // The far side ended it; the caller still owns the record line.
    if (mine) writeRecord(reason, secs);
    return;
  }

  const me = (info.participants || []).find((p) => p.user_id === store.me);
  if (me && ['declined', 'missed', 'left', 'busy'].includes(me.state)) { finish(me.state); return; }

  if (info.state === 'live' && IN_AUDIO.includes(me?.state)) {
    if (call.phase !== 'live') {
      call.phase = 'live';
      call.startedAt = call.startedAt || Date.now();
      beatOn();
    }
    // Build a connection to everybody else who is in, and tear down the ones who
    // have left. Driven off the server's roster rather than off signals, so a
    // person joining a three-way call is picked up by both of the others.
    const live = new Set(joined());
    for (const id of live) connectTo(id);
    for (const id of [...call.links.keys()]) if (!live.has(id)) dropPeer(id);
  }
  paint();
}

// ------------------------------------------------------------------ inbound
function onRing(info) {
  if (info?.call_id === lastEnded) return;   // a ring for a call this device already ended
  // Already busy here. The server knows about other CALLS, but it cannot know
  // this person is standing in a voice room, so that check is ours.
  if (callActive() || voice.active) {
    api.declineCall(info.call_id, 'busy').catch(() => {});
    bus.emit('call:missed', { call: info, reason: 'busy' });
    return;
  }
  call.info = info;
  call.phase = 'incoming';
  call.lastConversation = info.conversation_id;
  bus.emit('call:incoming', { call: info });
  paint();

  clearTimeout(call.ringTimer);
  call.ringTimer = setTimeout(() => {
    // No second event here: declineCall ends the call locally, and the 'missed'
    // ending already reaches the UI as call:ended. Emitting both toasted twice
    // for one missed call.
    if (call.phase === 'incoming') declineCall('missed');
  }, RING_GIVEUP_MS);
}

function onSignal({ call_id: callId, from, payload }) {
  if (!call.info || call.info.call_id !== callId) return;
  const link = call.links.get(from);
  const deliver = (msg) => (link ? link.handle(msg) : inbox.hold(from, msg));
  if (payload?.kind === 'ice-batch') {
    for (const c of payload.data || []) deliver({ kind: 'ice', data: c });
    return;
  }
  deliver(payload);
}

// PostgREST turns a raised exception into a message; these are the ones worth a
// sentence rather than a code.
function callError(e) {
  const m = e?.message || '';
  if (/already_in_call/.test(m)) return 'You are already in a call';
  if (/group_too_big/.test(m)) return 'A call is for up to three people. Use a voice room for more.';
  if (/nobody_to_call/.test(m)) return 'There is nobody in this conversation to call';
  if (/rate|limit/i.test(m)) return 'Too many calls in a row. Wait a minute.';
  if (/function|schema cache|does not exist/i.test(m)) {
    return 'Calling is not switched on for this server yet';
  }
  return m || 'That call could not be started';
}

// Whether the server understands calls at all. A deployment that has not run
// migration 0119 has no start_call, and every press would fail with a
// schema-cache error nobody can act on.
//
// Deliberately NOT its own probe request. Optimistic until something proves
// otherwise, and the thing that proves it is the get_active_call below, which
// this client already makes once per sign-in for reload recovery. An extra RPC
// on every boot to ask a question that is the same answer for the life of a
// deployment is exactly the idle traffic EFFICIENCY.md is about.
let supported = null;
const missingRpc = (e) => /function|schema cache|does not exist/i.test(e?.message || '');
export const callsSupported = () => supported !== false;

export function initCall() {
  bus.on('call:ring', ({ payload }) => onRing(payload));
  bus.on('call:state', ({ payload }) => applyState(payload));
  bus.on('call:signalled', ({ payload }) => onSignal(payload));

  // A call that outlives its tab is a phone left off the hook: the far side
  // hears silence and the participant row keeps everybody else out of a call
  // with that person for the next ninety seconds.
  window.addEventListener('pagehide', () => { if (callActive()) hangUp('dropped'); });

  // A call that was live when the page reloaded. The audio is gone - peer
  // connections do not survive a navigation - so this rejoins rather than
  // pretends, and if the far side has already given up it just ends.
  const recover = async () => {
    if (supported === false) return;
    try {
      const info = await api.activeCall();
      supported = true;
      if (!info || info.state === 'ended') return;
      const me = (info.participants || []).find((p) => p.user_id === store.me);
      if (!me) return;
      if (me.state === 'ringing') { onRing(info); return; }
      // We were IN it. Reopening the mic needs a gesture on some browsers, so
      // this offers rather than assumes.
      call.info = info;
      call.phase = 'incoming';
      call.rejoin = true;
      call.lastConversation = info.conversation_id;
      bus.emit('call:incoming', { call: info, rejoin: true });
      paint();
    } catch (e) {
      if (missingRpc(e)) supported = false;      // a server without migration 0119
    }
  };
  bus.on('auth', recover);
  // Registered after sign-in has already happened - a reload lands here with the
  // session restored and 'auth' long since emitted - so the listener alone would
  // never fire and a call that survived the reload would be invisible.
  if (store.me) recover();
}
