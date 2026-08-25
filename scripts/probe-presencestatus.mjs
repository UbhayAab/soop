// Behavioral guard for the rank-15 presenceStatus contract (a53d39f) plus the
// livelock defect found while probing it (fixed same burst): presence.js tick()
// keeps the census status column as store.presenceStatus, and features/status.js
// paints away/dnd member badges off that shared map instead of issuing its own
// user_presence fetch per panel mutation (the fetch, its 8s throttle and its
// in-flight machinery are deleted). Drives the REAL booted app: initPresence()
// started manually off its shared module instance (probe-presencetick
// precedent), real .member rows painted into #panelContent so the shipped
// MutationObserver and bus bindings are what fire, reads counted on the wire at
// /rest/v1/user_presence. Nothing mocked except the answers.
//
//   LEG A settle + census paint: starting presence while member rows exist must
//        leave the page responsive (an observer feedback loop here starves every
//        task - the exact defect this burst found), cost exactly ONE census
//        read, and decorate Alice with the moon badge titled Away plus her
//        profile status_text on the row, while online Bob gets none.
//   LEG B observer decorates new rows free of network: appending Dave (dnd in
//        the current map) fires the panel observer and paints his stop badge
//        with ZERO further reads.
//   LEG C presence-event repaint: a fresh census answer (Bob turns dnd, Alice
//        drops out) delivered through the real visibilitychange tick costs
//        exactly ONE more read and repaints both ways off the map - Bob gains
//        his badge, Alice loses hers because absent means offline-or-stale.
//   LEG D rapid mutations stay free: eight row appends/removals fire the
//        observer repeatedly and still cost zero reads (the deleted code paid a
//        fetch per panel mutation).
//
// Accepted gaps, named: the 30s interval itself sits past this probe's window
// by design; the interval shares every predicate proven here.
//
// Usage: node scripts/probe-presencestatus.mjs [--root <dir>]
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
console.log(`probe-presencestatus: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = new Date().toISOString();
const CENSUS_V1 = [
  { user_id: "u-alice", status: "away", last_seen_at: now },
  { user_id: "u-bob", status: "online", last_seen_at: now },
  { user_id: "u-dave", status: "dnd", last_seen_at: now },
];
const CENSUS_V2 = [
  { user_id: "u-alice", status: "online", last_seen_at: now },
  { user_id: "u-bob", status: "dnd", last_seen_at: now },
];
let censusAnswer = CENSUS_V1;

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
    const reads = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route("**/rest/v1/**", async (route) => {
      const u = new URL(route.request().url());
      const seg = u.pathname.split("/");
      if (seg[seg.length - 2] === "rpc") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      if (seg[seg.length - 1] === "user_presence") {
        reads.push(u.search);
        return route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify(censusAnswer),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    const { page, pageerrors } = await boot(context);
    const baseR = reads.length;
    ok(baseR === 0, `boot must be quiet for user_presence (${baseR})`);

    // Arm a task heartbeat BEFORE any member rows exist, so an observer
    // feedback loop shows up as a frozen counter instead of a hung harness.
    // Every later page touch races a timeout for the same reason.
    let dead = false;
    const evalSafe = async (fn, label, ms = 5000) => {
      try {
        return await Promise.race([
          page.evaluate(fn),
          sleep(ms).then(() => { throw new Error(`page starved at ${label}`); }),
        ]);
      } catch (e) {
        dead = true;
        problems.push(`${label}: ${e.message}`);
        return undefined;
      }
    };

    // ---------------------------------------------------------------- setup
    // Signed-in-looking store, two real-shaped member rows painted into the
    // panel host, then the REAL presence module started visible.
    await evalSafe(async () => {
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      store.profiles = new Map([
        ["u-alice", { id: "u-alice", name: "Alice", status_text: "Focusing hard" }],
        ["u-bob", { id: "u-bob", name: "Bob" }],
        ["u-dave", { id: "u-dave", name: "Dave" }],
      ]);
      window.__beat = 0;
      setInterval(() => { window.__beat++; }, 25);
      const host = document.querySelector("#panelContent");
      const row = (uid, name) => {
        const r = document.createElement("div");
        r.className = "member";
        r.innerHTML = `<span class="m-name" data-user="${uid}">${name}</span>`;
        host.appendChild(r);
        return r;
      };
      row("u-alice", "Alice");
      row("u-bob", "Bob");
      const { initPresence } = await import("/js/core/presence.js");
      initPresence();
    }, "setup");

    // ------------------------------------------------------------------ leg A
    await sleep(900);
    const beatA = dead ? undefined : await evalSafe(() => window.__beat, "A: heartbeat");
    ok(!dead && beatA > 5,
      `A: the page must stay task-responsive once badges exist (beat ${beatA})`);
    ok(reads.length - baseR === 1,
      `A: decorating off the census must cost exactly 1 user_presence read (got ${reads.length - baseR})`);
    const snapA = dead ? undefined : await evalSafe(async () => {
      const g = (uid) => {
        const row = [...document.querySelectorAll("#panelContent .member")]
          .find((r) => r.querySelector("[data-user]")?.dataset.user === uid);
        if (!row) return null;
        const b = row.querySelector(".hstatus-badge");
        return {
          badge: b ? b.textContent : null,
          badgeTitle: b ? b.title : null,
          title: row.title || null,
          hstatus: row.dataset.hstatus || null,
        };
      };
      return { alice: g("u-alice"), bob: g("u-bob") };
    }, "A: snapshot");
    if (snapA) {
      ok(snapA.alice?.badge === "\u{1F319}" && snapA.alice.badgeTitle === "Away",
        `A: Alice must carry the Away moon badge (got ${JSON.stringify(snapA.alice)})`);
      ok(snapA.alice?.title === "Focusing hard" && snapA.alice.hstatus === "1",
        `A: Alice's row must carry her profile status_text and the done-mark (${JSON.stringify(snapA.alice)})`);
      ok(snapA.bob && snapA.bob.badge === null,
        `A: online Bob must get no badge (got ${JSON.stringify(snapA.bob)})`);
    }

    // ------------------------------------------------------------------ leg B
    if (!dead) {
      await evalSafe(async () => {
        const host = document.querySelector("#panelContent");
        const r = document.createElement("div");
        r.className = "member";
        r.innerHTML = '<span class="m-name" data-user="u-dave">Dave</span>';
        host.appendChild(r);
      }, "B: append Dave");
      await sleep(450);
      const snapB = await evalSafe(() => {
        const row = [...document.querySelectorAll("#panelContent .member")]
          .find((r) => r.querySelector("[data-user]")?.dataset.user === "u-dave");
        const b = row?.querySelector(".hstatus-badge");
        return { badge: b ? b.textContent : null, title: b ? b.title : null };
      }, "B: snapshot");
      ok(snapB?.badge === "\u26D4" && snapB.title === "Do not disturb",
        `B: the observer must decorate the new dnd row off the existing map (got ${JSON.stringify(snapB)})`);
      ok(reads.length - baseR === 1,
        `B: decorating a new row must cost ZERO reads (got ${reads.length - baseR})`);
    }

    // ------------------------------------------------------------------ leg C
    if (!dead) {
      censusAnswer = CENSUS_V2;
      await evalSafe(() => document.dispatchEvent(new Event("visibilitychange")), "C: visible tick");
      await sleep(700);
      ok(reads.length - baseR === 2,
        `C: the return-to-visible tick is the only second read (got ${reads.length - baseR})`);
      const snapC = await evalSafe(async () => {
        const g = (uid) => {
          const row = [...document.querySelectorAll("#panelContent .member")]
            .find((r) => r.querySelector("[data-user]")?.dataset.user === uid);
          const b = row?.querySelector(".hstatus-badge");
          return b ? b.textContent : null;
        };
        return { alice: g("u-alice"), bob: g("u-bob") };
      }, "C: snapshot");
      ok(snapC?.bob === "\u26D4",
        `C: Bob must gain the dnd badge off the fresh answer (got ${JSON.stringify(snapC)})`);
      ok(snapC?.alice === null,
        `C: Alice dropped out of the census, so her badge must be gone (got ${JSON.stringify(snapC)})`);
    }

    // ------------------------------------------------------------------ leg D
    if (!dead) {
      await evalSafe(async () => {
        const host = document.querySelector("#panelContent");
        for (let i = 0; i < 8; i++) {
          const r = document.createElement("div");
          r.className = "member";
          r.innerHTML = `<span class="m-name" data-user="u-temp${i}">T${i}</span>`;
          host.appendChild(r);
          r.remove();
        }
      }, "D: hammer");
      await sleep(500);
      ok(reads.length - baseR === 2,
        `D: eight rapid panel mutations must cost ZERO reads (got ${reads.length - baseR})`);
      const beatD = await evalSafe(() => window.__beat, "D: heartbeat");
      ok(beatD > 5, `D: the page must still be alive after the hammer (beat ${beatD})`);
    }

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
  console.log("PROBE FAILED - probe-presencestatus");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-presencestatus");
process.exit(0);
