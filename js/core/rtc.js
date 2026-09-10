// One peer connection, negotiated correctly, with nothing in it that knows what
// the audio is FOR.
//
// This file exists because there are now two things in the app that hold peer
// connections - voice rooms (js/core/voice.js) and direct calls
// (js/core/call.js) - and every hard-won correctness fix in the room code is
// equally load-bearing for a call: the perfect-negotiation glare rule, the ICE
// candidates that arrive before their offer, the TURN credentials that are the
// difference between "connected" and silence on Jio. Two copies of that would
// mean fixing every future bug twice and finding out about the second copy from
// a call that did not connect.
//
// What is deliberately NOT here: audio elements, DOM, participant rosters,
// ringing, mute buttons. A PeerLink hands you tracks and tells you what state it
// is in. Everything about what that means to a person belongs to the caller.
import { accessToken } from '../sb.js';
import { SUPABASE_URL } from '../config.js';

// ------------------------------------------------------------------ ice
const BASE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

// Cloudflare Realtime TURN. STUN alone connects peers on permissive networks and
// fails SILENTLY for everyone behind carrier-grade NAT - which is what Jio and
// Airtel mobile data are, i.e. most of this app's real audience. Both sides show
// each other as present while neither hears anything; that failure mode is why
// TURN exists. Credentials are short-lived and minted by the dek-turn Edge
// Function, which holds the account secret so it never reaches a browser. Until
// that function is deployed we stay STUN-only, exactly as before.
//
// Fetched once per page load and shared by rooms AND calls. Two copies of this
// fetch would be two Edge invocations for one page and, worse, two different
// credential sets in flight at once.
let icePromise = null;

export function iceConfig() {
  if (icePromise) return icePromise;
  icePromise = (async () => {
    try {
      const r = await fetch(SUPABASE_URL + '/functions/v1/dek-turn', {
        headers: { Authorization: 'Bearer ' + ((await accessToken()) || '') },
      });
      if (!r.ok) return BASE;
      const j = await r.json();
      if (j && Array.isArray(j.iceServers) && j.iceServers.length) {
        return { iceServers: [...BASE.iceServers, ...j.iceServers] };
      }
    } catch {
      /* No relay endpoint: historical behaviour, STUN only. */
    }
    return BASE;
  })();
  return icePromise;
}

// Whether relaying is even available. The call UI says so out loud when it is
// not, because "connecting…" that never resolves is the worst thing a call can
// do and this is the single likeliest cause.
export async function hasRelay() {
  const cfg = await iceConfig();
  return cfg.iceServers.some((s) => /^turns?:/.test(
    Array.isArray(s.urls) ? s.urls[0] || '' : s.urls || ''));
}

// ------------------------------------------------------------------ glare
// One side is "polite" and gives way when two offers cross. The rule only has to
// be consistent and OPPOSITE on the two peers; comparing ids is both.
export const isPolite = (me, peer) => String(me) > String(peer);

// ------------------------------------------------------------------ link
//
// createLink({ id, me, send, onTrack, onState, onClose })
//   id      - the other person's user id
//   me      - my user id (only used to decide politeness)
//   send    - (msg) => void, delivers {kind, data} to that person however the
//             caller likes: a realtime broadcast in a room, an RPC in a call
//   onTrack - (track, stream) => void
//   onState - (connectionState) => void
//
// Everything a caller needs afterwards is on the returned object: .pc for the
// two track operations that are genuinely connection-level (screen share adds
// and removes senders), .handle for an incoming signal, .close.
export async function createLink({ id, me, send, onTrack, onState } = {}) {
  const pc = new RTCPeerConnection(await iceConfig());
  const polite = isPolite(me, id);

  // ICE candidates that arrived before there was anywhere to put them.
  //
  // addIceCandidate throws if no remote description is set yet. Swallowing that
  // silently - which is what a bare .catch(() => {}) does - loses any candidate
  // that beat its offer through the transport, and a lost candidate is not a
  // visible error: it is a call that takes eight seconds to connect instead of
  // one, or does not connect at all, on some networks and not others. During a
  // rollback the connection legitimately has no remote description, and that is
  // exactly the window when the other side is spraying candidates.
  let pending = [];
  let closed = false;

  const drain = async () => {
    const q = pending;
    pending = [];
    for (const c of q) {
      try { await pc.addIceCandidate(c); } catch { /* stale by now */ }
    }
  };

  pc.onicecandidate = (e) => { if (e.candidate) send({ kind: 'ice', data: e.candidate }); };
  pc.ontrack = (e) => onTrack?.(e.track, e.streams[0]);
  pc.onconnectionstatechange = () => onState?.(pc.connectionState);

  // One offer at a time, serialised, because two overlapping renegotiations on
  // the same connection wedge it the same way glare does.
  let negotiating = false;
  async function renegotiate() {
    if (closed || negotiating || pc.signalingState !== 'stable') return;
    negotiating = true;
    try {
      const o = await pc.createOffer();
      await pc.setLocalDescription(o);
      send({ kind: 'offer', data: o });
    } catch (e) {
      console.warn('[rtc] renegotiate', e);
    } finally { negotiating = false; }
  }

  async function handle(msg) {
    if (closed || !msg) return;
    try {
      if (msg.kind === 'offer') {
        const collision = pc.signalingState !== 'stable';
        if (collision) {
          // The impolite side ignores the colliding offer; its own will be
          // answered. The polite side rolls back, dropping its half-made offer
          // and accepting theirs - and does not resend, because whatever
          // prompted the offer (a track added) is still on the connection and
          // the answer we are about to make carries it anyway.
          if (!polite) return;
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription(msg.data);
        await drain();
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        send({ kind: 'answer', data: ans });
      } else if (msg.kind === 'answer') {
        // An answer arriving when we are not expecting one is a late duplicate
        // from a rolled-back negotiation. Setting it would throw.
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(msg.data);
          await drain();
        }
      } else if (msg.kind === 'ice') {
        if (!pc.remoteDescription) {
          // Bounded, because a peer that never completes its offer would grow
          // this forever. Fifty is far more than a real negotiation produces.
          if (pending.length < 50) pending.push(msg.data);
          return;
        }
        try { await pc.addIceCandidate(msg.data); } catch { /* stale candidate */ }
      }
    } catch (e) { console.warn('[rtc] signal', msg.kind, e); }
  }

  return {
    id,
    pc,
    polite,
    handle,
    renegotiate,
    // Adds every track of a stream and offers once, rather than once per track.
    async addStream(stream, { offer = false } = {}) {
      for (const t of stream.getTracks()) pc.addTrack(t, stream);
      if (offer) await renegotiate();
    },
    async offer() { await renegotiate(); },
    close() {
      if (closed) return;
      closed = true;
      pending = [];
      try { pc.close(); } catch { /* already gone */ }
    },
    get state() { return pc.connectionState; },
  };
}

// ------------------------------------------------------------------ inbox
//
// Signals that arrived for a peer whose connection is still being built.
//
// createLink is async - it waits on the ICE config, which on the first call of a
// session is a network fetch - and BOTH sides start building at the same moment,
// off the same event. If the far side wins that race its offer lands here while
// there is nothing to hand it to, and a dropped offer is not an error: it is one
// person hearing nothing, forever, with both names showing as present. The old
// room code dropped it silently for exactly this reason.
//
// Bounded, because a peer that never finishes building must not grow this without
// limit. Forty is far more than a negotiation produces.
export function signalInbox({ cap = 40 } = {}) {
  const q = new Map();
  return {
    hold(id, msg) {
      const a = q.get(id) || [];
      if (a.length < cap) a.push(msg);
      q.set(id, a);
    },
    // Handed to the link in arrival order the moment it exists.
    release(id, link) {
      const a = q.get(id);
      q.delete(id);
      if (!a || !link) return;
      for (const m of a) link.handle(m);
    },
    drop(id) { q.delete(id); },
    clear() { q.clear(); },
  };
}

// ------------------------------------------------------------------ level
// "Is this person speaking right now", as a number, with the one bug that
// version of this always has already fixed: each call created an AudioContext
// and a requestAnimationFrame loop, and callers kept only the newest handle, so
// every reconnect leaked one of each. Browsers cap AudioContexts per document at
// a small number, after which creation throws and speaking indicators stop
// working for everybody, silently. Return the stop handle and the caller cannot
// leak one without ignoring the return value.
export function levelMeter(stream, onLevel, { threshold = 18 } = {}) {
  let raf = 0;
  let ctx = null;
  let live = true;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const loop = () => {
      if (!live) return;
      an.getByteFrequencyData(buf);
      let sum = 0;
      for (const v of buf) sum += v;
      const level = sum / buf.length;
      try { onLevel(level > threshold, level); } catch { /* a nicety, never fatal */ }
      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch {
    /* No analyser on this device: the indicator simply never lights. */
  }
  return () => {
    live = false;
    cancelAnimationFrame(raf);
    ctx?.close?.().catch?.(() => {});
  };
}
