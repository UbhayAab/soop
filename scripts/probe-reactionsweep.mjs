// Behavioral guard for the rank-4 reaction-sweep contract (f1df785): the 9s
// reconciliation loop in presence.js only exists to heal realtime `reaction`
// broadcasts that never arrived, so it must cost nothing while nobody can see
// the tab, heal IMMEDIATELY on return instead of waiting out the 9s tick, ask
// about exactly the rows ON SCREEN in DOM order (store.seen is insertion order
// and names the oldest prepended rows after paging up), stay quiet inside the
// 60s idle window once nothing changed, pay nothing for an empty screen, and
// bound every query to the last 60 screen rows. Drives the REAL booted app:
// initPresence() started manually off its shared module instance (the app only
// starts it post-sign-in; it installs both the 9s interval and the merged
// visibilitychange handler that calls sweepReactions), dirty state forced
// through the real bus 'message:new' path (rxnDirty is module-private and this
// broadcast is what production arms it with), synthetic visibilitychange events
// through the shipped handler, counts taken off the wire at
// /rest/v1/message_reactions with the exact message_id=in.(...) list parsed
// from every query. Nothing mocked except the answers.
//
//   LEG A hidden pays nothing: rows on screen and the dirty flag set, a hide
//        event plus one full 9s interval tick under hidden must produce ZERO
//        reaction reads (and Later's badge poll stays silent too).
//   LEG B heal-on-return in DOM order: restoring visibility fires the sweep
//        immediately (milliseconds, not up to 9s), costs exactly ONE read, and
//        the wire list is exactly the four screen ids in DOM order INCLUDING a
//        uuid-noned optimistic row - while store.seen was seeded in a DIFFERENT
//        order so insertion-order healing cannot pass. Later's badge refreshes
//        exactly once beside it.
//   LEG C idle coalescing: a second return-to-visible inside the 60s idle
//        window with nothing changed costs ZERO further reads.
//   LEG D empty screen free: no .msg rows, dirty flag set, the sweep returns
//        before any read.
//   LEG E last-60 bound: 64 screen rows cost exactly one read carrying exactly
//        the LAST 60 ids in DOM order.
//
// Accepted gaps, named: Later's own 90s interval sits past this window by
// design (a 90s sleep does not fit the burst budget); only its return-to-
// visible half and its hidden silence are asserted, and both share the
// predicate proven here.
//
// Usage: node scripts/probe-reactionsweep.mjs [--root <dir>]
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
console.log(`probe-reactionsweep: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();

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
  {
    // Every message_reactions GET lands here as { t, q }; every rpc/get_later
    // POST increments later[]. Everything else gets the empty answer it would
    // get from an empty workspace.
    const rxn = [];
    const later = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route("**/rest/v1/**", async (route) => {
      const u = new URL(route.request().url());
      const seg = u.pathname.split("/");
      if (seg[seg.length - 2] === "rpc") {
        if (seg[seg.length - 1] === "get_later") later.push(u.search);
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      const last = seg[seg.length - 1];
      if (last === "message_reactions") {
        rxn.push({ t: Date.now(), q: u.search });
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    const { page, pageerrors } = await boot(context);
    ok(rxn.length === 0,
      `boot must be quiet for message_reactions (${rxn.length})`);
    const baseL = later.length;

    // Seed a signed-in-looking session, THEN start the real presence module -
    // same shared import the running app uses. Rows are planted as real-shaped
    // .msg rows carrying only what the sweep reads (dataset.id), DOM order
    // chosen so store.seen's INSERTION order disagrees with it.
    await page.evaluate(() => {
      const NONCE = "11111111-2222-3333-4444-555555555555";
      const host = document.getElementById("messages");
      for (const [id, prepend] of [
        ["m-top", false], ["m-mid", true], ["m-old", true],
      ]) {
        const row = document.createElement("div");
        row.className = "msg";
        row.dataset.id = id;
        if (prepend) host.insertBefore(row, host.firstChild);
        else host.appendChild(row);
      }
      const nonceRow = document.createElement("div");
      nonceRow.className = "msg";
      nonceRow.dataset.id = NONCE;
      host.insertBefore(nonceRow, host.querySelector("[data-id='m-top']"));
      // seen insertion order: m-top, m-mid, m-old (nonce never seen) - the OLD
      // slice(-60)-of-seen source would heal m-top,m-mid,m-old; DOM order is
      // m-old,NONCE,m-mid,m-top.
    });

    // Seed the session and start presence, keeping the pre-hidden window SHORT
    // so the first 9s interval tick lands inside leg A's hidden window.
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      store.profiles = new Map([["u-x", { id: "u-x", name: "X" }]]);
      store.channels = [];
      store.unread = new Map();
      store.notify = new Map();
      store.dms = [];
      const { initPresence } = await import("/js/core/presence.js");
      initPresence();
      // Arm the module-private dirty flag through the ONLY path that arms it:
      // a realtime-shaped message:new arrival.
      const { bus } = await import("/js/store.js");
      bus.emit("message:new", { msg: { author_id: "u-x" }, healed: false });
      // Hidden NOW so the 9s tick fires against the visibility guard.
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Wait past ONE full interval tick (9s) under hidden plus margin.
    await sleep(9800);

    // ------------------------------------------------------------------ leg A
    ok(rxn.length === 0,
      `A: a hidden tab must pay ZERO reaction reads across a hide event and a full 9s tick (+${rxn.length})`);
    ok(later.length - baseL === 0,
      `A: Later's badge poll must stay silent while hidden (+${later.length - baseL})`);

    // ------------------------------------------------------------------ leg B
    // Return to visible: the sweep heals IMMEDIATELY with exactly the screen
    // ids in DOM order, once, and Later refreshes once beside it.
    const expectedIds = await page.evaluate(() =>
      [...document.querySelectorAll("#messages .msg")]
        .map((r) => r.dataset.id).filter(Boolean).slice(-60));
    const t0 = Date.now();
    await page.evaluate(async () => {
      // Re-arm through the real broadcast path so this leg's assertion cannot
      // be starved by whatever an earlier leg consumed.
      const { bus } = await import("/js/store.js");
      bus.emit("message:new", { msg: { author_id: "u-x" }, healed: false });
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Settle = first read seen, then 1s of wire silence, so every read this
    // return can possibly trigger lands inside leg B's own accounting.
    let saw = false;
    for (let i = 0; i < 80; i++) {
      await sleep(50);
      const last = rxn.length ? rxn[rxn.length - 1].t : 0;
      if (!saw && last >= t0) saw = true;
      else if (saw && Date.now() - last >= 1000) break;
      else if (!saw && Date.now() - t0 > 3000) break;
    }
    const grew = rxn.filter((r) => r.t >= t0);
    const lastB = grew.length ? grew[grew.length - 1].t : t0;
    ok(grew.length >= 1 && grew[0].t - t0 < 2500,
      `B: return-to-visible must heal immediately, not wait up to 9s (first read ${grew[0] ? grew[0].t - t0 : "never"}ms after the event)`);
    ok(grew.length === 1,
      `B: the return must cost exactly ONE reaction read (+${grew.length})`);
    const wireIds = (() => {
      const raw = new URLSearchParams(grew[0]?.q || "").get("message_id") || "";
      return raw.startsWith("in.(") ? raw.slice(4, -1).split(",") : null;
    })();
    ok(JSON.stringify(wireIds) === JSON.stringify(expectedIds),
      `B: the read must name exactly the screen rows in DOM order (wire ${JSON.stringify(wireIds)} vs dom ${JSON.stringify(expectedIds)})`);
    ok(expectedIds.includes("11111111-2222-3333-4444-555555555555"),
      "B: fixture must include the uuid-noned optimistic row");
    ok(later.length - baseL === 1,
      `B: Later must refresh exactly once on return-to-visible (+${later.length - baseL})`);

    // ------------------------------------------------------------------ leg C
    // Idle coalescing: nothing changed, well inside the 60s idle window.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await sleep(700);
    ok(!rxn.some((r) => r.t >= lastB + 100),
      `C: an immediate second return inside the idle window must cost ZERO reads (+${rxn.filter((r) => r.t >= lastB + 100).length}; timeline ${JSON.stringify(rxn.map((r) => r.t - t0))})`);

    // ------------------------------------------------------------------ leg D
    // Empty screen: dirty flag set, but there is nothing on screen to heal.
    await page.evaluate(async () => {
      document.getElementById("messages").replaceChildren();
      const { bus } = await import("/js/store.js");
      bus.emit("message:new", { msg: { author_id: "u-x" }, healed: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(700);
    ok(!rxn.some((r) => r.t >= lastB + 100),
      `D: an empty screen must cost no read even when dirty (+${rxn.length - grew.length})`);

    // ------------------------------------------------------------------ leg E
    // Bound: 64 screen rows cost exactly one read naming the LAST 60 in order.
    const expectedE = await page.evaluate(async () => {
      const host = document.getElementById("messages");
      for (let i = 0; i < 64; i++) {
        const row = document.createElement("div");
        row.className = "msg";
        row.dataset.id = "r" + String(i).padStart(2, "0");
        host.appendChild(row);
      }
      const { bus } = await import("/js/store.js");
      bus.emit("message:new", { msg: { author_id: "u-x" }, healed: false });
      return [...host.querySelectorAll(".msg")].map((r) => r.dataset.id).slice(-60);
    });
    const tE = Date.now();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    for (let i = 0; i < 120 && !rxn.some((r) => r.t >= tE); i++) await sleep(50);
    await sleep(600);
    const grewE = rxn.filter((r) => r.t >= tE);
    ok(grewE.length === 1,
      `E: the bounded sweep must cost exactly ONE read (+${grewE.length})`);
    const wireE = (() => {
      const raw = new URLSearchParams(grewE[0]?.q || "").get("message_id") || "";
      return raw.startsWith("in.(") ? raw.slice(4, -1).split(",") : null;
    })();
    ok(JSON.stringify(wireE) === JSON.stringify(expectedE) && wireE.length === 60,
      `E: the read must carry exactly the last 60 screen ids (got ${wireE ? wireE.length : "none"}, head ${JSON.stringify(wireE?.slice(0, 3))})`);

    ok(pageerrors.length === 0, `pageerrors: ${pageerrors.join(" | ")}`);
    await context.close();
  }
} catch (e) {
  problems.push(`harness: ${e?.stack || e}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

if (problems.length) {
  console.log("PROBE FAILED - probe-reactionsweep");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-reactionsweep");
process.exit(0);
