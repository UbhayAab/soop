// Voice channels: a WebRTC peer mesh with Supabase Realtime as the signalling
// bus. No SFU, no third-party service - for ambient rooms of a handful of people
// a mesh is the right call and it costs nothing.
import { sb, subscribe, unsubscribe, getSub, accessToken } from '../sb.js';
import { api, table } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { $, el, esc } from '../util.js';
import { toast } from '../ui.js';
import { renderChannels } from './channels.js';
import { SUPABASE_URL } from '../config.js';

const RTC = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

// Cloudflare Realtime TURN. STUN alone connects peers on permissive networks
// and fails SILENTLY for everyone behind carrier-grade NAT - which is what Jio
// and Airtel mobile data are, i.e. most of this app's real audience. The roster
// still shows both people present while neither hears anything; that failure
// mode is why TURN exists. Credentials are short-lived and minted by the
// dek-turn Edge Function, which holds the account secret so it never reaches a
// browser. Until that function is deployed we stay STUN-only, exactly as before.
let turnTried = false;
async function withTurn() {
  if (turnTried) return RTC;
  turnTried = true;
  try {
    const r = await fetch(SUPABASE_URL + '/functions/v1/dek-turn', {
      headers: { Authorization: 'Bearer ' + (accessToken() || '') },
    });
    if (!r.ok) return RTC;
    const j = await r.json();
    if (j && Array.isArray(j.iceServers) && j.iceServers.length) {
      RTC.iceServers.push(...j.iceServers);
    }
  } catch {
    /* No relay endpoint: historical behaviour. */
  }
  return RTC;
}

export const voice = {
  active: false, channel: null, local: null, muted: false, deafened: false,
  peers: new Map(), monitors: new Map(), ptt: false, pttHeld: false, beat: null,
  // Screen sharing. `screen` is the MediaStream from getDisplayMedia when this
  // person is sharing, and `screenSenders` is the RTCRtpSender per peer so the
  // track can be pulled back out again without tearing the call down.
  screen: null, screenSenders: new Map(),
  // Who else is sharing, peer id -> MediaStream. More than one at a time is
  // allowed; the viewer shows the most recent and offers a switcher.
  remoteScreens: new Map(),
};

// A screen at 1280x720 is roughly 1.2 Mbit/s of upload. In a MESH that is per
// PEER, so five other people in the room is six megabits going up a connection
// that on Indian mobile data is often two. Capping it is not politeness, it is
// the difference between a slightly soft screen and a call that stops carrying
// audio - and audio is the part nobody can do without.
const SCREEN_MAX_BITRATE = 800000;
const SCREEN_MAX_FPS = 8;

export async function joinVoice(channelId) {
  const c = store.channels.find((x) => x.id === channelId);
  if (!c) return;
  if (voice.active && voice.channel?.id === c.id) return;
  if (voice.active) await leaveVoice();

  // Room capacity. The mesh costs (N-1) uploads per client, so past roughly
  // eight audio peers every laptop in the room is paying for the whole party.
  // The server owns the number; if the RPC has not been deployed this throws
  // and we fail OPEN - a missing check must never lock people out of voice.
  try {
    const ok = await api.canJoinVoice(c.id);
    if (ok === false) { toast('That voice room is full right now', 'info'); return; }
  } catch {
    /* Unversioned server: proceed without the cap. */
  }

  try {
    voice.local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch {
    toast('Microphone permission is needed to join voice', 'error');
    return;
  }

  voice.active = true;
  voice.channel = c;
  $('voicebar').classList.remove('hidden');
  $('vchanName').textContent = c.name;
  applyMicState();

  try { await api.joinVoice(c.id); } catch (e) { toast(e.message, 'error'); }

  subscribe('voice', 'vc:' + c.id, { signal: (p) => onSignal(p) }, { self: false });

  // Liveness. Without this the server cannot tell a closed laptop from a quiet
  // listener, and the room fills with people who are not there.
  clearInterval(voice.beat);
  voice.beat = setInterval(() => {
    if (voice.active && voice.channel) api.voiceHeartbeat(voice.channel.id).catch(() => {});
  }, 30000);

  const parts = await table('voice_participants', (q) => q.eq('channel_id', c.id));
  // Deterministic offerer (lower id offers) so two peers never both offer.
  for (const p of parts) if (p.user_id !== store.me && store.me < p.user_id) makePeer(p.user_id, true);
  await refreshVoice();
  monitorSelf();
}

async function makePeer(peerId, initiator) {
  if (voice.peers.has(peerId)) return voice.peers.get(peerId);
  const pc = new RTCPeerConnection(await withTurn());
  voice.peers.set(peerId, pc);
  voice.local.getTracks().forEach((t) => pc.addTrack(t, voice.local));
  // Somebody joining a room where a share is already running has to receive it.
  // Without this they get audio and a blank space where everybody else can see
  // the screen, and nothing anywhere says why.
  if (voice.screen) addScreenTo(peerId, pc);

  pc.onicecandidate = (e) => { if (e.candidate) signal(peerId, { kind: 'ice', data: e.candidate }); };
  pc.ontrack = (e) => {
    // Two kinds of track arrive on the same connection now, and they need
    // completely different homes: audio into a hidden <audio> element that
    // autoplays, video into a viewer somebody looks at. Routing a video track
    // into the audio element is silent and invisible, which is the worst
    // possible failure because there is nothing to see OR hear.
    if (e.track.kind === 'video') {
      const stream = e.streams[0];
      voice.remoteScreens.set(peerId, stream);
      // The far side stopping is delivered here, not through any signal we sent.
      e.track.addEventListener('ended', () => {
        voice.remoteScreens.delete(peerId);
        bus.emit('voice:screen', { peerId, on: false });
      });
      stream.addEventListener?.('removetrack', () => {
        voice.remoteScreens.delete(peerId);
        bus.emit('voice:screen', { peerId, on: false });
      });
      bus.emit('voice:screen', { peerId, on: true, stream });
      return;
    }
    let a = document.getElementById('a-' + peerId);
    if (!a) {
      a = document.createElement('audio');
      a.id = 'a-' + peerId;
      a.autoplay = true;
      document.body.appendChild(a);
    }
    a.srcObject = e.streams[0];
    a.muted = voice.deafened;
    monitorSpeaking(peerId, e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) dropPeer(peerId);
    refreshVoice();
  };
  if (initiator) {
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o).then(() => signal(peerId, { kind: 'offer', data: o })))
      .catch(() => {});
  }
  return pc;
}

// GLARE. Until screen sharing there was exactly one offer per connection, made
// at join time by whichever side had the lower user id, so two offers could
// never cross. Starting a share means offering again on a connection that is
// already up, and if two people press Share within a round trip of each other
// both sides offer at once. setRemoteDescription with an offer while in
// have-local-offer throws, and the connection is then wedged: no more audio,
// no error anybody sees, and the only cure is leaving and rejoining.
//
// This is the perfect-negotiation pattern, cut down to what this mesh needs.
// One side is "polite" and gives way; the rule only has to be consistent and
// opposite on the two peers, and comparing ids is both. The impolite side
// ignores the colliding offer and its own will be answered.
const polite = (peerId) => store.me > peerId;

// ICE candidates that arrived before there was anywhere to put them.
//
// addIceCandidate throws if no remote description is set yet, and the existing
// code swallowed that with .catch(() => {}) - so a candidate that beat its offer
// through the broadcast was simply lost. That was already a source of slow and
// occasionally failed connects, and the rollback above makes it strictly worse:
// during a rollback the connection legitimately has no remote description, and
// that is exactly the window when the other side is spraying candidates.
//
// A lost candidate is not a visible error. It is a call that takes eight seconds
// to connect instead of one, or does not connect at all, on some networks and
// not others. Buffer them and drain once there is a remote description.
const pendingIce = new Map();

async function addIce(pc, from, candidate) {
  if (!pc) return;
  if (!pc.remoteDescription) {
    if (!pendingIce.has(from)) pendingIce.set(from, []);
    // Bounded, because a peer that never completes its offer would otherwise
    // grow this forever. Fifty is far more than any real negotiation produces.
    const q = pendingIce.get(from);
    if (q.length < 50) q.push(candidate);
    return;
  }
  try { await pc.addIceCandidate(candidate); } catch { /* stale candidate */ }
}

async function drainIce(pc, from) {
  const q = pendingIce.get(from);
  if (!q?.length) return;
  pendingIce.delete(from);
  for (const cand of q) {
    try { await pc.addIceCandidate(cand); } catch { /* stale by now */ }
  }
}

async function onSignal(p) {
  if (p.to !== store.me) return;
  const from = p.from;
  try {
    if (p.kind === 'offer') {
      const pc = await makePeer(from, false);
      const collision = pc.signalingState !== 'stable';
      if (collision) {
        if (!polite(from)) return;
        // Rolling back drops our own half-made offer and accepts theirs. We do
        // not resend ours: whatever prompted it (a track added) is still on the
        // connection, so the answer we are about to make carries it anyway.
        await pc.setLocalDescription({ type: 'rollback' });
      }
      await pc.setRemoteDescription(p.data);
      await drainIce(pc, from);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      signal(from, { kind: 'answer', data: ans });
    } else if (p.kind === 'answer') {
      const pc = voice.peers.get(from);
      // An answer arriving when we are not expecting one is a late duplicate
      // from a rolled-back negotiation. Setting it would throw.
      if (pc && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(p.data);
        await drainIce(pc, from);
      }
    } else if (p.kind === 'ice') {
      await addIce(voice.peers.get(from), from, p.data);
    } else if (p.kind === 'bye') {
      dropPeer(from);
    }
  } catch (e) { console.warn('signal', e); }
}

function signal(to, msg) {
  getSub('voice')?.send({ type: 'broadcast', event: 'signal', payload: { from: store.me, to, ...msg } });
}

// ------------------------------------------------------------------ screen
// Whether this device can share at all. iOS has no web screen-capture API of any
// kind - not in Safari, not in Chrome for iOS, which is Safari underneath - so
// on an iPhone this is absent and the honest answer is to say so rather than
// show a button that does nothing. Feature detection rather than sniffing the
// user agent, because that is the thing that is actually true.
export const canShareScreen = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

function addScreenTo(peerId, pc) {
  const track = voice.screen?.getVideoTracks()[0];
  if (!track) return null;
  const sender = pc.addTrack(track, voice.screen);
  voice.screenSenders.set(peerId, sender);
  // Cap it. Defaults negotiate upward until something gives, and in a mesh the
  // thing that gives is the audio nobody can do without.
  const params = sender.getParameters();
  params.encodings = params.encodings?.length ? params.encodings : [{}];
  params.encodings[0].maxBitrate = SCREEN_MAX_BITRATE;
  params.encodings[0].maxFramerate = SCREEN_MAX_FPS;
  sender.setParameters(params).catch(() => { /* older browsers ignore encodings */ });
  return sender;
}

// One offer per peer, serialised, because two overlapping renegotiations on the
// same connection is the same wedge glare causes.
const renegotiating = new Set();
async function renegotiate(peerId) {
  const pc = voice.peers.get(peerId);
  if (!pc || renegotiating.has(peerId)) return;
  renegotiating.add(peerId);
  try {
    if (pc.signalingState !== 'stable') return;
    const o = await pc.createOffer();
    await pc.setLocalDescription(o);
    signal(peerId, { kind: 'offer', data: o });
  } catch (e) { console.warn('renegotiate', e); } finally { renegotiating.delete(peerId); }
}

export async function startScreenShare() {
  if (!voice.active) { toast('Join a voice room first', 'error'); return false; }
  if (voice.screen) return true;
  if (!canShareScreen()) {
    toast('This device cannot share a screen. iPhones and iPads have no way to '
      + 'do it from a browser - use a laptop, or Android.', 'error');
    return false;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: SCREEN_MAX_FPS },
      // Sharing system audio would arrive as a second audio track and be mixed
      // into the same element as somebody's voice. Not worth the confusion here.
      audio: false,
    });
  } catch {
    // Cancelling the picker is by far the most common outcome and is not an
    // error worth shouting about.
    return false;
  }
  voice.screen = stream;
  const track = stream.getVideoTracks()[0];
  // Text on a shared screen is what people are actually looking at, so ask the
  // encoder to keep it sharp rather than smooth.
  if ('contentHint' in track) track.contentHint = 'detail';

  // The browser's own "Stop sharing" bar is outside this app entirely, so this
  // is the only way to hear about it. Without it the share ends for everybody
  // else and the app still says you are sharing.
  track.addEventListener('ended', () => { stopScreenShare(); });

  for (const [peerId, pc] of voice.peers) { addScreenTo(peerId, pc); renegotiate(peerId); }
  bus.emit('voice:sharing', { on: true, stream });
  return true;
}

export async function stopScreenShare() {
  if (!voice.screen) return;
  const stream = voice.screen;
  voice.screen = null;
  for (const [peerId, sender] of voice.screenSenders) {
    try { voice.peers.get(peerId)?.removeTrack(sender); } catch { /* peer already gone */ }
    renegotiate(peerId);
  }
  voice.screenSenders.clear();
  stream.getTracks().forEach((t) => t.stop());
  bus.emit('voice:sharing', { on: false });
}

function dropPeer(id) {
  voice.peers.get(id)?.close();
  voice.peers.delete(id);
  voice.screenSenders.delete(id);
  pendingIce.delete(id);
  if (voice.remoteScreens.delete(id)) bus.emit('voice:screen', { peerId: id, on: false });
  // srcObject nulled before the element goes, so the decoder is released rather
  // than pinned by a detached node still holding a live MediaStream.
  const a = document.getElementById('a-' + id);
  if (a) { a.srcObject = null; a.remove(); }
  const m = voice.monitors.get(id);
  if (m) { cancelAnimationFrame(m.raf); m.ctx?.close?.(); voice.monitors.delete(id); }
}

export async function leaveVoice() {
  if (!voice.active) return;
  // Before the peers are torn down, so the tracks are stopped and the browser's
  // "you are sharing your screen" bar goes away. Leaving a call while still
  // holding a live capture is how somebody's screen stays on their taskbar for
  // the rest of the afternoon.
  await stopScreenShare();
  voice.remoteScreens.clear();
  const ch = voice.channel;
  for (const id of [...voice.peers.keys()]) { signal(id, { kind: 'bye' }); dropPeer(id); }
  clearInterval(voice.beat);
  voice.beat = null;
  unsubscribe('voice');
  voice.local?.getTracks().forEach((t) => t.stop());
  voice.local = null;
  voice.active = false;
  voice.channel = null;
  $('voicebar').classList.add('hidden');
  try { await api.leaveVoice(ch.id); } catch { /* best effort */ }
  await refreshVoice();
}

function applyMicState() {
  const on = voice.ptt ? voice.pttHeld : !voice.muted;
  voice.local?.getAudioTracks().forEach((t) => { t.enabled = on; });
  const b = $('vmute');
  if (b) {
    b.textContent = voice.ptt ? (voice.pttHeld ? '🎙 Live' : '🎙 Hold Space') : voice.muted ? '🔇 Unmute' : '🎤 Mute';
    b.classList.toggle('on', on);
  }
}

// Who is in which room, as a comparable string. Sorted per room because the row
// order out of the table is not guaranteed and an order change is not a change
// anybody can see.
function vpFingerprint(m) {
  const parts = [];
  for (const [ch, ids] of m) parts.push(ch + ':' + [...ids].sort().join(','));
  return parts.sort().join('|');
}
let lastVoicePrint = null;

export async function refreshVoice() {
  const vids = store.channels.filter((c) => c.kind === 'voice').map((c) => c.id);
  if (vids.length) {
    const rows = await table('voice_participants', (q) => q.in('channel_id', vids));
    store.voiceParts = new Map();
    for (const r of rows) {
      if (!store.voiceParts.has(r.channel_id)) store.voiceParts.set(r.channel_id, []);
      store.voiceParts.get(r.channel_id).push(r.user_id);
    }
    // Same reason as the unread poll in channels.js: renderChannels() rewrites
    // the whole sidebar and then awaits renderNavSections(), which issues
    // list_topics on every call because a 20 second poll never hits topics.js's
    // 1500ms cache. Nobody joins or leaves a voice room most of the time, so
    // most of these repaints drew exactly what was already on screen.
    const print = vpFingerprint(store.voiceParts);
    if (print !== lastVoicePrint) { lastVoicePrint = print; renderChannels(); }
  }
  // "Who is in a room" has just changed. Deliberately NOT voice:refresh: line
  // 231 binds that event to this very function, so emitting it here would be an
  // unbounded loop. Anything outside core that paints the state of the rooms
  // listens to this one.
  bus.emit('voice:state');
  if (voice.active) {
    const ids = store.voiceParts.get(voice.channel.id) || [];
    $('vparts').innerHTML = ids.map((u) =>
      `<span class="vpart" id="vp-${esc(u)}">${esc(nameOf(u))}${u === store.me ? ' (you)' : ''}</span>`).join('');
    for (const u of ids) if (u !== store.me && !voice.peers.has(u) && store.me < u) makePeer(u, true);
  }
}

function monitorSpeaking(id, stream) {
  try {
    // Close the previous one first. ontrack can fire more than once for a peer -
    // a connection rebuilt after a transient drop is the ordinary case, and
    // renegotiation is a new one - and each call started another AudioContext
    // and another requestAnimationFrame loop while the map kept only the latest
    // handle. The earlier loop then ran for the rest of the session with nothing
    // able to cancel it. Browsers cap AudioContexts per document at a small
    // number, so after a few reconnects creation throws and the speaking
    // indicator stops working for everybody, silently, via the catch below.
    const old = voice.monitors.get(id);
    if (old) { cancelAnimationFrame(old.raf); old.ctx?.close?.(); voice.monitors.delete(id); }

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const loop = () => {
      an.getByteFrequencyData(buf);
      const v = buf.reduce((a, b) => a + b, 0) / buf.length;
      document.getElementById('vp-' + id)?.classList.toggle('speaking', v > 18);
      const raf = requestAnimationFrame(loop);
      voice.monitors.set(id, { raf, ctx });
    };
    loop();
  } catch { /* analyser is a nicety */ }
}

function monitorSelf() {
  if (!voice.local) return;
  monitorSpeaking(store.me, voice.local);
}

export function initVoice() {
  $('vleave').onclick = leaveVoice;
  $('vmute').onclick = () => {
    if (voice.ptt) return;
    voice.muted = !voice.muted;
    applyMicState();
  };
  $('vdeafen').onclick = () => {
    voice.deafened = !voice.deafened;
    document.querySelectorAll('audio[id^="a-"]').forEach((a) => { a.muted = voice.deafened; });
    $('vdeafen').textContent = voice.deafened ? '🔇 Undeafen' : '🎧 Deafen';
    $('vdeafen').classList.toggle('on', !voice.deafened);
  };
  $('vptt').onclick = () => {
    voice.ptt = !voice.ptt;
    voice.pttHeld = false;
    $('vptt').classList.toggle('on', voice.ptt);
    $('vptt').textContent = voice.ptt ? 'PTT on' : 'PTT off';
    applyMicState();
    if (voice.ptt) toast('Push to talk: hold Space to speak');
  };

  // Push-to-talk: Space, but never while typing.
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && voice.ptt && voice.active && !typing(e) && !voice.pttHeld) {
      e.preventDefault(); voice.pttHeld = true; applyMicState();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && voice.ptt && voice.pttHeld) { voice.pttHeld = false; applyMicState(); }
  });

  // Leaving the tab open with a stale participant row is worse than a clean exit.
  window.addEventListener('pagehide', () => { if (voice.active) navigator.sendBeacon && leaveVoice(); });
  bus.on('voice:join', ({ channelId }) => joinVoice(channelId));
  bus.on('voice:refresh', refreshVoice);
  // The reaper evicts anyone who stopped heartbeating; tear down that peer
  // rather than holding a connection to a browser that is gone.
  bus.on('voice:left', ({ userId }) => { if (userId && userId !== store.me) dropPeer(userId); });
}
