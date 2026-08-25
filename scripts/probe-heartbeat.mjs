// Behavioral guard for the rank-16 heartbeat contract (a7ef3e3): the beat that
// keeps user_presence alive also carries the channel claim that makes
// channels.viewer_count real, and viewer_count is the only input to the digest
// safety valve - so a pocketed phone asserting a stale claim made that number a
// lie. Drives the REAL booted modules: initPresence() from its shared module
// instance, real openChannel() for the event beats, counts taken off the wire
// at /rest/v1/rpc/heartbeat. Nothing mocked.
//
//   LEG A visible claim + coalescing: the init beat claims the seeded current
//        channel; a rapid openChannel B->C->D burst costs exactly TWO writes -
//        the leading edge instantly (carrying B, the channel open at fire time)
//        and ONE trailing catch-up when the 10s window closes (carrying D, the
//        final channel) - never one write per switch, never a lost final state.
//   LEG B hidden honesty: with the tab hidden the init beat still sends (the
//        status half keeps presence correct) but the claim is null; a
//        presence:mine change beats directly with the new status and still no
//        claim; restoring visibility puts the claim back on the next beat.
//
// Accepted gaps, named: the 45s interval beat and the 30s unread/presence polls
// are past this probe's window by design (a 45s sleep per assertion does not
// fit the burst budget); the visibilitychange->beat() re-claim path shares its
// predicate with the beats proven here.
//
// Usage: node scripts/probe-heartbeat.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") { out.root = argv[++i]; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root || path.dirname(fileURLToPath(import.meta.url)), args.root ? "." : "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (err, body) => {
    if (err) { try { res.writeHead(404).end("nope"); } catch {} return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-heartbeat: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();

// Hermetic Supabase: every REST call answered locally; rpc/heartbeat POSTs are
// recorded in arrival order with their parsed bodies.
function wireHeartbeatRoute(context, beats) {
  return context.route("**/rest/v1/**", async (route) => {
    const u = new URL(route.request().url());
    const seg = u.pathname.split("/");
    if (seg[seg.length - 2] !== "rpc") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    const name = seg[seg.length - 1];
    if (name === "heartbeat") {
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch {}
      beats.push(body);
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    if (name === "get_channel_messages") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

async function boot(context) {
  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(String(e)));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const booted = await Promise.race([
    page.waitForEvent("console", { predicate: (m) => /features loaded/.test(m.text()), timeout: 45_000 }).then(() => true),
    sleep(45_000).then(() => false),
  ]);
  ok(booted, "app never reached the features-loaded boot line within 45s");
  return { page, pageerrors };
}

try {
  // ------------------------------------------------------------------ leg A
  {
    const beats = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wireHeartbeatRoute(context, beats);
    const { page, pageerrors } = await boot(context);

    // Seed a signed-in-looking session with cA already current, THEN start the
    // real presence module - same import the running app uses.
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      store.channels = [
        { id: "cA", name: "alpha", position: 1000 },
        { id: "cB", name: "bravo", position: 2000 },
        { id: "cC", name: "charlie", position: 3000 },
        { id: "cD", name: "delta", position: 4000 },
      ];
      store.unread = new Map();
      store.notify = new Map();
      store.dms = [];
      store.current = store.channels[0];
      const { initPresence } = await import("/js/core/presence.js");
      initPresence();
    });

    // Init beat: exactly one write, claiming the current channel.
    await sleep(700);
    ok(beats.length === 1,
      `A: expected exactly 1 init heartbeat, got ${beats.length}`);
    ok(beats[0]?.p_channel === "cA" && beats[0]?.p_status === "online",
      `A: init beat wrong shape (${JSON.stringify(beats[0])}, want p_status online + p_channel cA)`);

    // Rapid A->B->C->D burst through the REAL openChannel.
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      const { openChannel } = await import("/js/core/channels.js");
      await openChannel(store.channels[1]);
      await openChannel(store.channels[2]);
      await openChannel(store.channels[3]);
    });
    await sleep(1200);
    ok(beats.length === 2,
      `A: a three-switch burst must cost ONE leading write inside the window (got ${beats.length - 1} extra beats: ${JSON.stringify(beats)})`);
    ok(beats[1]?.p_channel === "cB",
      `A: leading edge fired late or stale - want the channel current at fire time cB (${JSON.stringify(beats[1])})`);

    // Window closes: exactly one trailing catch-up carrying the FINAL channel.
    await sleep(10_600);
    ok(beats.length === 3,
      `A: want exactly one trailing catch-up after the window (total ${beats.length}, want 3: ${JSON.stringify(beats.map((b) => b.p_channel))})`);
    ok(beats[2]?.p_channel === "cD",
      `A: trailing catch-up lost the final channel (${JSON.stringify(beats[2])}, want p_channel cD)`);

    ok(pageerrors.length === 0, `A: pageerrors: ${pageerrors.join(" | ")}`);
    await context.close();
  }

  // ------------------------------------------------------------------ leg B
  {
    const beats = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wireHeartbeatRoute(context, beats);
    const { page, pageerrors } = await boot(context);

    // Hidden BEFORE the module starts: the very first write must already drop
    // the claim while keeping the status half alive.
    await page.evaluate(async () => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      store.channels = [{ id: "cH", name: "hotel", position: 1000 }];
      store.unread = new Map();
      store.notify = new Map();
      store.dms = [];
      store.current = store.channels[0];
      const { initPresence } = await import("/js/core/presence.js");
      initPresence();
    });
    await sleep(700);
    ok(beats.length >= 1,
      `B: a hidden tab must STILL beat (status half) - got ${beats.length}`);
    ok(beats[0]?.p_status === "online" && beats[0]?.p_channel === null,
      `B: hidden init beat must carry the status and NO channel claim (${JSON.stringify(beats[0])})`);

    // Status change rides a DIRECT beat, not the coalescer.
    await page.evaluate(async () => {
      const { bus } = await import("/js/store.js");
      bus.emit("presence:mine", "dnd");
    });
    await sleep(500);
    const mine = beats.find((b, i) => i > 0 && b.p_status === "dnd");
    ok(!!mine,
      `B: presence:mine must beat immediately with the new status (${JSON.stringify(beats)})`);
    ok(mine?.p_channel === null,
      `B: hidden status beat must not smuggle a channel claim (${JSON.stringify(mine)})`);

    // Visible again: the next beat claims the current channel once more.
    await page.evaluate(async () => {
      delete document.visibilityState;
      const { bus } = await import("/js/store.js");
      bus.emit("presence:mine", "online");
    });
    await sleep(500);
    const back = beats[beats.length - 1];
    ok(back?.p_status === "online" && back?.p_channel === "cH",
      `B: visible again, the beat must re-claim the current channel (${JSON.stringify(back)})`);

    ok(pageerrors.length === 0, `B: pageerrors: ${pageerrors.join(" | ")}`);
    await context.close();
  }
} catch (e) {
  problems.push(`harness: ${e?.stack || e}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

if (problems.length) {
  console.log("PROBE FAILED - probe-heartbeat");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-heartbeat");
process.exit(0);
