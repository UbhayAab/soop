// Voice channels: a WebRTC peer mesh with Supabase Realtime as the signalling
// bus. No SFU, no third-party service - for ambient rooms of a handful of people
// a mesh is the right call and it costs nothing.
import { subscribe, unsubscribe, getSub } from '../sb.js';
import { api, table } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { $, el, esc, debounceLead } from '../util.js';
import { icon } from '../icons.js';
import { toast } from '../ui.js';
import { renderChannels } from './channels.js';
// The peer connection, the glare rule, the ICE buffer and the TURN credentials
// all moved to core/rtc.js when direct calls arrived, because every one of those
// is equally load-bearing for a call and two copies would mean fixing each bug
// twice. What stayed here is everything a ROOM means: the roster, the bar, push
// to talk, the screen share, and signalling over the room's realtime topic.
//
// The TURN fetch moving also fixed it. It read `'Bearer ' + (accessToken() || '')`
// against an ASYNC accessToken(), so every request carried the literal string
// "Bearer [object Promise]", was rejected, and the mesh has been STUN-only the
// whole time - which is exactly the silent failure the comment there warns about,
// on the carrier-grade NAT most of this app's users are behind.
import { createLink, levelMeter, signalInbox } from './rtc.js';

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

// A peer in a room. The connection itself, the glare rule and the ICE buffering
// are core/rtc.js's job; what is left here is everything that is about a ROOM -
// where an incoming track goes, who is speaking, and the screen share.
//
// voice.peers now holds LINKS, not RTCPeerConnections. Anything that genuinely
// needs the connection (adding and removing a screen track) reaches through
// .pc, which is deliberately the only place that does.
// Signals for a peer whose connection is still being built. Both sides of a
// join start building off the same roster refresh, so whichever side resolves
// its ICE config second used to lose the other's offer outright - silently.
const inbox = signalInbox();

async function makePeer(peerId, initiator) {
  if (voice.peers.has(peerId)) return voice.peers.get(peerId);
  // Reserved before the first await. createLink resolves the ICE config, and two
  // roster refreshes inside that window would otherwise build two connections to
  // the same person - a duplicate offer, and a wedge.
  voice.peers.set(peerId, null);
  const link = await createLink({
    id: peerId,
    me: store.me,
    send: (msg) => signal(peerId, msg),
    onTrack: (track, stream) => {
      // Two kinds of track arrive on the same connection now, and they need
      // completely different homes: audio into a hidden <audio> element that
      // autoplays, video into a viewer somebody looks at. Routing a video track
      // into the audio element is silent and invisible, which is the worst
      // possible failure because there is nothing to see OR hear.
      if (track.kind === 'video') {
        voice.remoteScreens.set(peerId, stream);
        // The far side stopping is delivered here, not through any signal we sent.
        track.addEventListener('ended', () => {
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
      a.srcObject = stream;
      a.muted = voice.deafened;
      monitorSpeaking(peerId, stream);
    },
    onState: (state) => {
      if (['failed', 'closed', 'disconnected'].includes(state)) dropPeer(peerId);
      refreshVoice();
    },
  });

  // Left the room while the ICE config was in flight.
  if (!voice.active || !voice.local) { link.close(); voice.peers.delete(peerId); return null; }
  voice.peers.set(peerId, link);
  voice.local.getTracks().forEach((t) => link.pc.addTrack(t, voice.local));
  inbox.release(peerId, link);
  // Somebody joining a room where a share is already running has to receive it.
  // Without this they get audio and a blank space where everybody else can see
  // the screen, and nothing anywhere says why.
  if (voice.screen) addScreenTo(peerId, link.pc);

  if (initiator) link.offer();
  return link;
}

async function onSignal(p) {
  if (p.to !== store.me) return;
  if (p.kind === 'bye') { dropPeer(p.from); return; }
  // Three cases, and only the first is the obvious one:
  //   - a link exists          -> hand it over
  //   - none, and this is an offer -> this peer is arriving; build for them
  //   - a build is already in flight (the map holds a null placeholder), or a
  //     candidate arrived ahead of its offer -> hold it until there is a link
  if (voice.peers.has(p.from) && !voice.peers.get(p.from)) { inbox.hold(p.from, p); return; }
  const link = voice.peers.get(p.from) || (p.kind === 'offer' ? await makePeer(p.from, false) : null);
  if (!link) { inbox.hold(p.from, p); return; }
  await link.handle(p);
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

// Serialising overlapping renegotiations - two of them on one connection wedge
// it the same way glare does - is the link's own job now.
const renegotiate = (peerId) => voice.peers.get(peerId)?.renegotiate();

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

  for (const [peerId, link] of voice.peers) {
    if (!link) continue;                    // still resolving its ICE config
    addScreenTo(peerId, link.pc);
    renegotiate(peerId);
  }
  bus.emit('voice:sharing', { on: true, stream });
  return true;
}

export async function stopScreenShare() {
  if (!voice.screen) return;
  const stream = voice.screen;
  voice.screen = null;
  for (const [peerId, sender] of voice.screenSenders) {
    try { voice.peers.get(peerId)?.pc.removeTrack(sender); } catch { /* peer already gone */ }
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
  inbox.drop(id);
  if (voice.remoteScreens.delete(id)) bus.emit('voice:screen', { peerId: id, on: false });
  // srcObject nulled before the element goes, so the decoder is released rather
  // than pinned by a detached node still holding a live MediaStream.
  const a = document.getElementById('a-' + id);
  if (a) { a.srcObject = null; a.remove(); }
  voice.monitors.get(id)?.();
  voice.monitors.delete(id);
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
  // Including your own, which dropPeer never sees: monitorSelf has been opening
  // one AudioContext per join and leaving it running since the day it was
  // written, and browsers allow only a handful per document.
  for (const stop of voice.monitors.values()) stop?.();
  voice.monitors.clear();
  inbox.clear();
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
    // Markup, not textContent, which would print the SVG source. The glyph follows
    // `on`, which is the thing this button is really reporting: a mic while sound
    // is leaving this machine and micOff while none is, so held-open push-to-talk
    // reads live and "Hold Space" reads shut. The slashed MIC is deliberate rather
    // than the slashed speaker - deafen sits immediately beside this button and
    // owns the speaker pair, and one off-glyph on both would make neither legible.
    const label = voice.ptt ? (voice.pttHeld ? 'Live' : 'Hold Space')
      : voice.muted ? 'Unmute' : 'Mute';
    b.innerHTML = icon(on ? 'mic' : 'micOff') + ' ' + label;
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
  // Stop the previous one first. onTrack can fire more than once for a peer - a
  // connection rebuilt after a transient drop is the ordinary case, and a
  // renegotiation is another - and each meter holds an AudioContext and a
  // requestAnimationFrame loop. Browsers cap AudioContexts per document at a
  // small number, so a leaked one per reconnect ends with creation throwing and
  // every speaking indicator dying, silently.
  voice.monitors.get(id)?.();
  voice.monitors.set(id, levelMeter(stream, (speaking) => {
    document.getElementById('vp-' + id)?.classList.toggle('speaking', speaking);
  }));
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
    // Headphones while you can hear, the slashed speaker when you cannot. This is
    // the OUTPUT pair; the mute button owns the input pair, which is why that one
    // uses micOff and this one does not.
    $('vdeafen').innerHTML = voice.deafened
      ? icon('volumeOff') + ' Undeafen'
      : icon('headphones') + ' Deafen';
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
  // voice_join and voice_leave both arrive as voice:refresh, which re-reads the
  // whole participant list; a join-leave pair inside the window is one read,
  // not two. Leading edge, so the first arrival still paints immediately.
  bus.on('voice:refresh', debounceLead(refreshVoice, 700));
  // The reaper evicts anyone who stopped heartbeating; tear down that peer
  // rather than holding a connection to a browser that is gone.
  bus.on('voice:left', ({ userId }) => { if (userId && userId !== store.me) dropPeer(userId); });
}
