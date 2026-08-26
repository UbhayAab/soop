// Behavioral guard for the rank-1 realtime coalescing, workspace leg (6e650fb):
// channel_created/updated/deleted all arrive as payload-free 'channels:reload'
// emits and reloadChannels() is a full get_bootstrap on every connected client,
// so an admin renaming five channels in a row was five bootstraps everywhere
// before the leading-edge debounce. probe-heartbeat proved presence's eventBeat
// leg; this drives the REAL booted workspace binding and counts get_bootstrap
// POSTs on the wire at /rest/v1/rpc/get_bootstrap. Nothing mocked.
//
//   LEG A burst coalescing: five synchronous payload-free emits cost exactly TWO
//        reads - the leading edge immediately (well inside the 700ms window) and
//        exactly ONE trailing catch-up after the window closes - then silence.
//        The repaint is proven to come from the wire answer: #channels carries
//        the canned wire names, not the seeded ones.
//   LEG B {open} bypass: an emit carrying {open} must neither be swallowed nor
//        reordered behind an open batch - fired mid-window it goes out at once
//        with its payload (the named channel really opens), and the batch's own
//        trailing catch-up still lands afterwards, so the sequence costs exactly
//        three reads in that order.
//
// Choices: the 700ms window is hardcoded at the binding site, so every wait
// brackets it honestly rather than shrinking it; counts are taken per context
// with a zero baseline asserted after seeding so boot noise cannot pollute the
// deltas; fresh page per leg because the coalescer is module state and a shared
// page would leak one leg's window into the next.
//
// Accepted gaps, named: main.js's unread coalescer and voice.js's refreshVoice
// share the debounceLead helper but bind different events - their legs are not
// asserted here; the realtime broadcast handlers that PRODUCTION uses to arm
// this path need a socket, so the bus emit (which those handlers are thin
// wrappers around, workspace.js:695-697) is the arming surface.
//
// Usage: node scripts/probe-channelsreload.mjs [--root <dir>]
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
console.log(`probe-channelsreload: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();

// Hermetic Supabase: rpc/get_bootstrap POSTs are recorded with arrival
// timestamps and answered with a canned bootstrap whose channel names differ
// from anything seeded client-side, so a later DOM check proves the repaint
// came off the wire through the real reloadChannels.
function wireRoute(context, posts) {
  const BOOT = JSON.stringify({
    channels: [
      { id: "cW1", name: "wire-one", position: 1000, category_id: "cat1" },
      { id: "cW2", name: "wire-open", position: 2000, category_id: "cat1" },
      { id: "cW3", name: "wire-three", position: 3000, category_id: "cat1" },
    ],
    categories: [{ id: "cat1", name: "Wires", position: 100 }],
  });
  return context.route("**/rest/v1/**", async (route) => {
    const u = new URL(route.request().url());
    const seg = u.pathname.split("/");
    if (seg[seg.length - 2] !== "rpc") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    const name = seg[seg.length - 1];
    if (name === "get_bootstrap") {
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch {}
      posts.push({ t: Date.now(), p_workspace: body.p_workspace ?? null });
      return route.fulfill({ status: 200, contentType: "application/json", body: BOOT });
    }
    // The channel-open path the {open} bypass triggers reads messages as a bare
    // JSON array wrapped client-side ({rows: body}, channels.js:480); every
    // other RPC on this path tolerates an empty object.
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
    const posts = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wireRoute(context, posts);
    const { page, pageerrors } = await boot(context);

    // Seed a signed-in-looking session, THEN assert the baseline is zero so
    // every later count is attributable to the emits under test.
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      store.channels = [
        { id: "seedA", name: "seed-alpha", position: 1000, category_id: "" },
      ];
      store.categories = [];
      store.unread = new Map();
      store.notify = new Map();
      store.voiceParts = new Map();
      store.dms = [];
      const { renderChannels } = await import("/js/core/channels.js");
      await renderChannels();
    });
    await sleep(400);
    ok(posts.length === 0,
      `A: baseline must be zero get_bootstrap before arming (got ${posts.length})`);

    // Five renames in a row: the production shape is five payload-free emits.
    const t0 = Date.now();
    await page.evaluate(async () => {
      const { bus } = await import("/js/store.js");
      for (let i = 0; i < 5; i++) bus.emit("channels:reload");
    });

    // Leading edge only, and immediately - never delayed behind the window.
    await sleep(300);
    ok(posts.length === 1,
      `A: inside the window want ONLY the leading edge (got ${posts.length})`);
    ok(posts[0] && posts[0].t - t0 < 250,
      `A: leading edge must fire at once, not after the 700ms window (${posts[0] ? posts[0].t - t0 : "n/a"}ms after the burst)`);
    ok(posts[0]?.p_workspace === "ws-ws1",
      `A: the read must be a real reloadChannels bootstrap (${JSON.stringify(posts[0])})`);

    // Window closed: exactly one trailing catch-up, nothing more.
    await sleep(700);
    ok(posts.length === 2,
      `A: want exactly ONE trailing catch-up for a five-emit burst (total ${posts.length}, want 2)`);
    ok(posts[1].t - t0 >= 650,
      `A: trailing catch-up belongs AFTER the window closes (${posts[1].t - t0}ms after the burst)`);

    // Settled means settled.
    await sleep(900);
    ok(posts.length === 2,
      `A: silence after settle (got ${posts.length})`);

    // Provenance: the sidebar now shows the WIRE names, not the seeded ones -
    // proof the repaint rode the real answer through renderChannels.
    const painted = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#channels .chan[data-ch]")];
      return rows.map((r) => ({ id: r.dataset.ch, name: r.querySelector(".ch-name")?.textContent }));
    });
    ok(painted.some((r) => r.id === "cW1" && r.name === "wire-one")
      && painted.some((r) => r.id === "cW3" && r.name === "wire-three")
      && !painted.some((r) => r.id === "seedA"),
      `A: sidebar must carry the wire answer's channels (${JSON.stringify(painted)})`);
    const grouped = await page.evaluate(() =>
      !!document.querySelector('#channels h3[data-cat="cat1"]'));
    ok(grouped, `A: the wire answer's category heading must be painted too`);

    ok(pageerrors.length === 0, `A: pageerrors: ${pageerrors.join(" | ")}`);
    await context.close();
  }

  // ------------------------------------------------------------------ leg B
  {
    const posts = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wireRoute(context, posts);
    const { page, pageerrors } = await boot(context);
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      store.channels = [{ id: "seedB", name: "seed-bravo", position: 1000 }];
      store.categories = [];
      store.unread = new Map();
      store.notify = new Map();
      store.voiceParts = new Map();
      store.dms = [];
    });
    await sleep(400);
    ok(posts.length === 0,
      `B: baseline must be zero get_bootstrap before arming (got ${posts.length})`);

    // A batch already in flight when an {open} emit lands: the bypass must go
    // out NOW with its payload, ahead of the batch's trailing catch-up.
    const t0 = Date.now();
    await page.evaluate(async () => {
      const { bus } = await import("/js/store.js");
      bus.emit("channels:reload");
      bus.emit("channels:reload");
      bus.emit("channels:reload", { open: "cW2" });
    });

    await sleep(350);
    ok(posts.length === 2,
      `B: leading edge plus the {open} bypass must both be out well before the window closes (got ${posts.length}, want 2)`);
    const currentNow = await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      return store.current?.id || null;
    });
    ok(currentNow === "cW2",
      `B: the {open} bypass must really open the named channel (store.current=${currentNow})`);

    // The swallowed batch still gets its one trailing catch-up afterwards.
    await sleep(600);
    ok(posts.length === 3,
      `B: want exactly one trailing catch-up after the window (total ${posts.length}, want 3)`);
    ok(posts[1].t <= posts[2].t,
      `B: the bypass must precede the batch's catch-up, never be reordered behind it`);
    ok(posts.every((p) => p.p_workspace === "ws-ws1"),
      `B: every read must be a real reloadChannels bootstrap (${JSON.stringify(posts)})`);

    await sleep(800);
    ok(posts.length === 3,
      `B: silence after settle (got ${posts.length})`);

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
  console.log("PROBE FAILED - probe-channelsreload");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-channelsreload");
process.exit(0);
