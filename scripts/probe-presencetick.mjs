// Behavioral guard for the rank-13 census contract (64e256b): presence.js tick()
// is a backstop poll for dropped realtime broadcasts, and a poll nobody can see
// does not need healing - so it must cost nothing while the tab is hidden, heal
// immediately on return to visible instead of waiting out the 30s interval, and
// run its workspace_members backstop only every fourth visible tick. Drives the
// REAL booted app: initPresence() started manually off its shared module
// instance (the app only starts it post-sign-in), synthetic visibilitychange
// events through the shipped merged handler, counts taken off the wire at
// /rest/v1/user_presence and /rest/v1/workspace_members. Nothing mocked except
// the answers.
//
//   LEG A visible init: starting presence while visible costs exactly ONE
//        census read plus ONE members read (tickN 0 takes the %4 branch) and
//        paints store.online, the status map and #onlineCount off the answer.
//   LEG B hidden costs nothing: a visibilitychange into a hidden tab runs the
//        merged handler's own guard and must produce ZERO further reads.
//   LEG C heal-on-return: restoring visibility fires the census IMMEDIATELY
//        (not up to 30s later) with fresh data painted - online grows, the
//        status map follows - and no members read (tickN 1 misses %4).
//   LEG D backstop cadence: among the next four visible ticks the members
//        read lands exactly once, on the tick whose counter value is 4 mod 4 -
//        proving the every-fourth-visible-tick ladder, not every tick.
//   LEG E hidden init suppressed: calling initPresence() while already hidden
//        must not even let its synchronous init tick reach the wire.
//
// Accepted gaps, named: the 30s interval itself sits past this probe's window
// by design (a 30s sleep per assertion does not fit the burst budget); the
// interval shares the predicate proven here.
//
// Usage: node scripts/probe-presencetick.mjs [--root <dir>]
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
console.log(`probe-presencetick: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = new Date().toISOString();
const CENSUS_V1 = [
  { user_id: "u-alice", status: "away", last_seen_at: now },
  { user_id: "u-bob", status: "online", last_seen_at: now },
];
const CENSUS_V2 = [
  ...CENSUS_V1,
  { user_id: "u-dave", status: "online", last_seen_at: now },
];
let censusAnswer = CENSUS_V1;

const browser = await chromium.launch();

// Hermetic Supabase: table reads answered locally; the two tables under test
// are counted on the wire, everything else gets the empty answer it would get.
function wireCensus(context, census, members) {
  return context.route("**/rest/v1/**", async (route) => {
    const u = new URL(route.request().url());
    const seg = u.pathname.split("/");
    if (seg[seg.length - 2] === "rpc") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    const last = seg[seg.length - 1];
    if (last === "user_presence") {
      census.push(u.search);
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify(censusAnswer),
      });
    }
    if (last === "workspace_members") {
      members.push(u.search);
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
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
  {
    const census = [];
    const members = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wireCensus(context, census, members);
    const { page, pageerrors } = await boot(context);
    const baseC = census.length;
    const baseM = members.length;
    ok(baseC === 0 && baseM === 0,
      `boot must be quiet for both counted tables (census ${baseC}, members ${baseM})`);

    // Seed a signed-in-looking session, THEN start the real presence module -
    // same shared import the running app uses.
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      store.profiles = new Map([
        ["u-alice", { id: "u-alice", name: "Alice" }],
        ["u-bob", { id: "u-bob", name: "Bob" }],
        ["u-dave", { id: "u-dave", name: "Dave" }],
      ]);
      store.channels = [];
      store.unread = new Map();
      store.notify = new Map();
      store.dms = [];
      const { initPresence } = await import("/js/core/presence.js");
      initPresence();
    });
    await sleep(800);

    // ------------------------------------------------------------------ leg A
    // Visible init: exactly one census + one members read (counter 0 takes the
    // %4 branch), painted into the store and the header count.
    const snapA = await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      return {
        online: [...store.online].map((x) => x?.id || x).sort(),
        statuses: [...(store.presenceStatus || new Map())].sort(),
        count: document.querySelector("#onlineCount")?.textContent,
      };
    });
    ok(census.length - baseC === 1,
      `A: visible init must cost exactly 1 census read (got ${census.length - baseC})`);
    ok(members.length - baseM === 1,
      `A: visible init tickN=0 must take the %4 members branch exactly once (got ${members.length - baseM})`);
    ok(JSON.stringify(snapA.online) === JSON.stringify(["u-alice", "u-bob", "u-me"]),
      `A: store.online must be the filtered answer plus me (${JSON.stringify(snapA.online)})`);
    ok(snapA.statuses.length === 2,
      `A: the status column must be kept, not discarded (${JSON.stringify(snapA.statuses)})`);
    ok(snapA.count === "3",
      `A: #onlineCount must paint the kept count 3 (got ${JSON.stringify(snapA.count)})`);

    // ------------------------------------------------------------------ leg B
    // Hidden: the merged visibilitychange handler must bail before any read.
    await page.evaluate(async () => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(500);
    ok(census.length - baseC === 1 && members.length - baseM === 1,
      `B: a hide event must cost nothing (census +${census.length - baseC - 1}, members +${members.length - baseM - 1})`);

    // ------------------------------------------------------------------ leg C
    // Return to visible: the census heals IMMEDIATELY with the fresh answer,
    // no members read at counter 1, paint follows the new data.
    censusAnswer = CENSUS_V2;
    await page.evaluate(async () => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(600);
    ok(census.length - baseC === 2,
      `C: returning to visible must fire the census immediately, not wait 30s (+${census.length - baseC - 1})`);
    ok(members.length - baseM === 1,
      `C: the return tick is counter 1 and must skip the %4 members branch (+${members.length - baseM - 1})`);
    const snapC = await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      return {
        online: [...store.online].map((x) => x?.id || x).sort(),
        statuses: [...(store.presenceStatus || new Map())].length,
        count: document.querySelector("#onlineCount")?.textContent,
      };
    });
    ok(snapC.online.includes("u-dave"),
      `C: fresh answer must repaint store.online with the arrival (${JSON.stringify(snapC.online)})`);
    ok(snapC.statuses === 3 && snapC.count === "4",
      `C: paint must follow the fresh answer (statuses ${snapC.statuses}, count ${snapC.count})`);

    // ------------------------------------------------------------------ leg D
    // Backstop cadence: counters 2,3 miss, 4 takes the branch, 5 misses.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await sleep(450);
    }
    ok(members.length - baseM === 2,
      `D: the members backstop must land on counter 4, i.e. the third of these ticks (got +${members.length - baseM - 1})`);
    ok(census.length - baseC === 5,
      `D: each visible tick still pays its census read (+${census.length - baseC - 2})`);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await sleep(450);
    ok(members.length - baseM === 2,
      `D: counter 5 must miss the %4 branch (+${members.length - baseM - 2})`);

    // ------------------------------------------------------------------ leg E
    // A SECOND initPresence started while already hidden: its synchronous init
    // tick must be stopped by the guard before the wire.
    const cE = census.length;
    const mE = members.length;
    await page.evaluate(async () => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
      const { initPresence } = await import("/js/core/presence.js");
      initPresence();
    });
    await sleep(600);
    ok(census.length === cE && members.length === mE,
      `E: a hidden initPresence must not reach the wire at all (census +${census.length - cE}, members +${members.length - mE})`);

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
  console.log("PROBE FAILED - probe-presencetick");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-presencetick");
process.exit(0);
