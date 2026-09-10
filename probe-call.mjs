// Does the peer layer actually connect, and does audio actually flow?
//
// Every other probe in this repo measures geometry, because geometry is what
// silently regresses in CSS. This one measures the thing that silently regresses
// in js/core/rtc.js: a negotiation that half-works looks identical to one that
// works - two people are shown as present, both mute buttons light up, and
// neither hears anything. That is exactly the failure mode the TURN comment in
// that file warns about, and it has no error surface anywhere.
//
// So this drives the REAL module. It builds two PeerLinks in one page, wires
// each one's send() straight into the other's handle(), and asserts:
//
//   1. both connections reach 'connected',
//   2. a remote audio track arrives on both sides,
//   3. RTCStats says bytes were actually received - a connected transport with
//      zero bytes is the silent call, and it is the whole reason this exists,
//   4. the perfect-negotiation path survives BOTH sides offering at once, which
//      is the case voice rooms hit whenever two people press Share together and
//      calls hit whenever a third person joins,
//   5. an offer that arrives BEFORE its connection exists still lands. Both sides
//      start building off the same event and createLink is async, so whichever
//      resolves its ICE config second receives the other's offer with nowhere to
//      put it. That used to be dropped in silence, which is one person hearing
//      nothing while both are shown as connected.
//
// Chromium's fake capture device supplies the audio, so nothing here needs a
// microphone, a signalling server or a network beyond loopback.
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:4177';
const problems = [];

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1200);

const run = async (mode) => page.evaluate(async (how) => {
  const { createLink, signalInbox } = await import('./js/core/rtc.js');

  const mic = () => navigator.mediaDevices.getUserMedia({ audio: true });
  const [sa, sb] = [await mic(), await mic()];

  let A = null;
  let B = null;
  const got = { a: false, b: false };
  const inbox = signalInbox();
  // A microtask hop, so a link never re-enters its peer from inside its own
  // handler - which is not how a real transport behaves and would hide ordering
  // bugs the RPC relay and the realtime broadcast both have. When B does not
  // exist yet, the message goes where the app puts it: the inbox.
  const post = (to, msg) => Promise.resolve().then(() => {
    const link = to();
    if (link) link.handle(msg); else inbox.hold('b', msg);
  });

  A = await createLink({
    id: 'bbbb', me: 'aaaa',
    send: (m) => post(() => B, m),
    onTrack: (t) => { if (t.kind === 'audio') got.a = true; },
  });

  const makeB = async () => {
    B = await createLink({
      id: 'aaaa', me: 'bbbb',
      send: (m) => post(() => A, m),
      onTrack: (t) => { if (t.kind === 'audio') got.b = true; },
    });
    await B.addStream(sb);
    inbox.release('b', B);
  };

  await A.addStream(sa);

  if (how === 'late') {
    // A offers into thin air, exactly as it does when the far side is still
    // waiting on its ICE config, and B is built only afterwards.
    await A.offer();
    await new Promise((r) => setTimeout(r, 400));
    await makeB();
  } else if (how === 'glare') {
    await makeB();
    // Two offers crossing on one connection. Without the polite/impolite rule
    // this wedges and never recovers.
    await Promise.all([A.offer(), B.offer()]);
  } else {
    await makeB();
    await A.offer();
  }

  const settled = await new Promise((res) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const done = A.pc.connectionState === 'connected' && B.pc.connectionState === 'connected';
      if (done || Date.now() - t0 > 12000) { clearInterval(poll); res(done); }
    }, 150);
  });

  // Bytes, not just a state. Give the transport a moment to carry some.
  await new Promise((r) => setTimeout(r, 1200));
  const bytes = async (pc) => {
    let n = 0;
    for (const s of (await pc.getStats()).values()) {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') n += s.bytesReceived || 0;
    }
    return n;
  };
  const out = {
    connected: settled,
    a: A.pc.connectionState,
    b: B.pc.connectionState,
    tracks: got,
    bytesA: await bytes(A.pc),
    bytesB: await bytes(B.pc),
    polite: { a: A.polite, b: B.polite },
  };
  A.close(); B.close();
  [...sa.getTracks(), ...sb.getTracks()].forEach((t) => t.stop());
  return out;
}, mode);

for (const label of ['plain', 'glare', 'late']) {
  let r;
  try {
    r = await run(label);
  } catch (e) {
    problems.push(`${label}: threw - ${e.message}`);
    continue;
  }
  console.log(label + ':', JSON.stringify(r));
  if (!r.connected) problems.push(`${label}: never connected (a=${r.a} b=${r.b})`);
  if (!r.tracks.a || !r.tracks.b) problems.push(`${label}: no remote audio track (${JSON.stringify(r.tracks)})`);
  // The silent-call check. A connected pair carrying zero bytes is precisely
  // what a broken ICE config looks like from the outside.
  if (r.bytesA <= 0 || r.bytesB <= 0) {
    problems.push(`${label}: connected but silent (bytes a=${r.bytesA} b=${r.bytesB})`);
  }
  // The rule only has to be consistent and opposite. If it ever becomes the same
  // on both sides, glare stops being survivable and nothing else here would say so.
  if (r.polite.a === r.polite.b) problems.push(`${label}: politeness is not opposite (${JSON.stringify(r.polite)})`);
}

console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join('\n- ') : 'PROBE CLEAN');
process.exitCode = problems.length ? 1 : 0;
await browser.close();
