// Behavioral guard for the durable outbox store, js/lib/outbox.js.
// offline.js's header bets the queue survives the tab ("the record hits disk
// BEFORE the network is touched and is only deleted once Postgres has
// answered") and the module header promises a three-backend ladder, but
// nothing ever ran the STORE itself headless. Every claim below is
// deterministic, so the asserts are EXACT VALUES, not shapes:
//
//   PAGE 1, primary IndexedDB path (the very instance the booted app shares):
//   LEG B0  clear() empties the store and usingFallback() is false - the
//           primary backend is the one live.
//   LEG A   put() three records inserted newest-first lands all() as OLDEST
//           FIRST by created_at, a record with no created_at sorting as 0
//           (first), and get() returns the exact fields including the verbatim
//           request body and the attachments array; a RAW indexedDB.open of
//           Dek-outbox/sends sees exactly the same nonces, so the rows really
//           are on disk, not in the module's memory mirror.
//   LEG B   put() again under the SAME nonce is an UPSERT: still three rows on
//           disk, the text and attempts replaced.
//   LEG C   del() removes exactly that nonce from disk and leaves the others.
//   LEG D   after a FULL RELOAD the fresh page's all() still returns the two
//           survivors with no put having run - the queue survives the tab -
//           and clear() empties IndexedDB (raw count 0) plus the
//           localStorage mirror ('[]').
//   PAGE 2, localStorage fallback (fresh module instance off a cache-busting
//   import after window.indexedDB.open is made to throw, private-mode class):
//   LEG F   usingFallback() flips true, put() writes Dek.outbox.v1 exactly,
//           all() serves it oldest-first, the same-nonce put dedupes, del()
//           filters the LS array, clear() writes '[]'.
//   PAGE 3, memory last resort (localStorage.setItem made to throw as well,
//   so BOTH stores refuse):
//   LEG G   put() still resolves, all() serves the queue out of the RAM
//           mirror oldest-first (localStorage provably never received it),
//           get()/del()/clear() behave.
//
// Negative test (separate run): reverse the byAge comparator in outbox.js -
// every oldest-first assert (legs A/D/F/G) must fail naming its label while
// the raw-count, upsert, delete, clear and backend-flag asserts stay green,
// attributing the proof to the flush-order promise alone.
//
// Usage: node scripts/probe-outbox.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
const TARGET = path.join(ROOT, "js", "lib", "outbox.js");

function shaOf(file) {
  const raw = fs.readFileSync(file);
  const norm = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return {
    raw: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8),
    norm: crypto.createHash("sha256").update(norm).digest("hex").slice(0, 8),
  };
}
const SHA_BEFORE = shaOf(TARGET);

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
console.log(`probe-outbox: serving ${ROOT} on ${BASE}`);

const problems = [];
const errors = [];

// ONE explicit context: pages must share origin storage or the durability leg
// is meaningless (browser.newPage() isolates every call in its own context,
// which the first run caught as a false "queue did not survive").
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

async function newPage() {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`p${errors.length}: ${e.message}`));
  await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  return page;
}

// Shaped exactly like offline.js guardedSend builds them.
function rec(nonce, created_at, extra) {
  return {
    nonce,
    url: "https://sb.example/rest/v1/rpc/send_message",
    body: JSON.stringify({ p_channel: "cA", p_body_text: `text-${nonce}`, p_client_msg_id: nonce }),
    headers: { apikey: "pub", "content-type": "application/json" },
    kind: "channel",
    scope_id: "cA",
    thread_id: null,
    text: `text-${nonce}`,
    attachments: nonce === "r1" ? [{ path: "a/x.jpg", mime: "image/jpeg" }] : [],
    reply_to: null,
    also_send: false,
    created_at,
    attempts: 0,
    next_at: 0,
    state: "queued",
    error: null,
    ...(extra || {}),
  };
}

try {
  // ---------------------------------------------------------------- PAGE 1
  let page = await newPage();

  const p1 = await page.evaluate(async () => {
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    // Shaped exactly like offline.js guardedSend builds them.
    const rec = (nonce, created_at, extra) => ({
      nonce,
      url: "https://sb.example/rest/v1/rpc/send_message",
      body: JSON.stringify({ p_channel: "cA", p_body_text: `text-${nonce}`, p_client_msg_id: nonce }),
      headers: { apikey: "pub", "content-type": "application/json" },
      kind: "channel",
      scope_id: "cA",
      thread_id: null,
      text: `text-${nonce}`,
      attachments: nonce === "r1" ? [{ path: "a/x.jpg", mime: "image/jpeg" }] : [],
      reply_to: null,
      also_send: false,
      created_at,
      attempts: 0,
      next_at: 0,
      state: "queued",
      error: null,
      ...(extra || {}),
    });
    const OB = await import("/js/lib/outbox.js");

    // ---- LEG B0: clean slate, primary backend
    await OB.clear();
    eq(await OB.all(), [], "B0 all empty after clear");
    eq(OB.usingFallback(), false, "B0 primary backend live");

    // ---- LEG A: oldest-first ordering + exact round-trip + raw disk truth
    await OB.put(rec("r2", 2000));
    await OB.put(rec("r1", 1000));
    await OB.put(rec("r0", undefined));          // no created_at sorts as 0
    eq((await OB.all()).map((r) => r.nonce), ["r0", "r1", "r2"], "A all oldest-first");
    const got1 = await OB.get("r1");
    eq(
      got1 && {
        nonce: got1.nonce, kind: got1.kind, scope_id: got1.scope_id,
        text: got1.text, body: got1.body, state: got1.state,
        attachments: got1.attachments, created_at: got1.created_at,
      },
      {
        nonce: "r1", kind: "channel", scope_id: "cA",
        text: "text-r1", body: rec("r1", 1000).body, state: "queued",
        attachments: [{ path: "a/x.jpg", mime: "image/jpeg" }], created_at: 1000,
      },
      "A get exact record"
    );
    const rawNonces = await new Promise((res, rej) => {
      const rq = indexedDB.open("Dek-outbox", 1);
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => {
        const db = rq.result;
        const t = db.transaction("sends", "readonly");
        const g = t.objectStore("sends").getAll();
        g.onsuccess = () => { db.close(); res(g.result.map((r) => r.nonce)); };
        g.onerror = () => rej(g.error);
      };
    });
    rawNonces.sort();
    eq(rawNonces, ["r0", "r1", "r2"], "A raw indexedDB sees the same nonces");

    // ---- LEG B: same nonce is an upsert, not a duplicate
    await OB.put(rec("r1", 1000, { text: "text-r1-v2", attempts: 3 }));
    eq((await OB.all()).length, 3, "B upsert keeps three rows");
    const gotUp = await OB.get("r1");
    eq([gotUp.text, gotUp.attempts], ["text-r1-v2", 3], "B upsert replaced fields");

    // ---- LEG C: del removes exactly one
    await OB.del("r1");
    eq(await OB.get("r1"), null, "C deleted nonce unreadable");
    eq((await OB.all()).map((r) => r.nonce), ["r0", "r2"], "C survivors intact");
    const rawAfterDel = await new Promise((res, rej) => {
      const rq = indexedDB.open("Dek-outbox", 1);
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => {
        const db = rq.result;
        const t = db.transaction("sends", "readonly");
        const g = t.objectStore("sends").getAll();
        g.onsuccess = () => { db.close(); res(g.result.map((r) => r.nonce)); };
        g.onerror = () => rej(g.error);
      };
    });
    rawAfterDel.sort();
    eq(rawAfterDel, ["r0", "r2"], "C deletion reached raw disk");

    return { bad };
  });
  problems.push(...p1.bad.map((s) => `[page1] ${s}`));

  // ---- LEG D: the queue survives the tab (full reload, fresh evaluation)
  page = await newPage();
  const p2 = await page.evaluate(async () => {
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    const OB = await import("/js/lib/outbox.js");
    // No put has run on this page load.
    eq((await OB.all()).map((r) => r.nonce), ["r0", "r2"], "D rows survive a reload");
    await OB.clear();
    eq(await OB.all(), [], "D clear empties after reload");
    eq(localStorage.getItem("Dek.outbox.v1"), "[]", "D clear resets the LS mirror");
    const rawCount = await new Promise((res, rej) => {
      const rq = indexedDB.open("Dek-outbox", 1);
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => {
        const db = rq.result;
        const t = db.transaction("sends", "readonly");
        const g = t.objectStore("sends").count();
        g.onsuccess = () => { db.close(); res(g.result); };
        g.onerror = () => rej(g.error);
      };
    });
    eq(rawCount, 0, "D clear emptied raw disk");
    return { bad };
  });
  problems.push(...p2.bad.map((s) => `[page1-reload] ${s}`));

  // ---------------------------------------------------------------- PAGE 2
  // Private-mode class: indexedDB.open throws. Break it AFTER boot so the
  // app's own memoized connections are untouched, then pull a FRESH module
  // instance off a cache-busting import of the same served bytes.
  page = await newPage();
  await page.evaluate(() => {
    const broken = Object.create(window.indexedDB);
    broken.open = () => { throw new Error("private mode"); };
    Object.defineProperty(window, "indexedDB", { value: broken, configurable: true });
  });
  const p3 = await page.evaluate(async () => {
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    const mk = (nonce, created_at, text) => ({
      nonce, url: "u", body: `b-${nonce}`, headers: {}, kind: "dm",
      scope_id: "conv-a", thread_id: null, text, attachments: [],
      reply_to: null, also_send: false, created_at, attempts: 0,
      next_at: 0, state: "queued", error: null,
    });
    const OB = await import("/js/lib/outbox.js?fb=1");
    await OB.clear();
    eq(OB.usingFallback(), true, "F fallback flagged once idb refuses");
    await OB.put(mk("fA", 500, "five"));
    await OB.put(mk("fB", 100, "one-hundred"));
    eq((await OB.all()).map((r) => r.nonce), ["fB", "fA"], "F LS-backed all oldest-first");
    const ls = JSON.parse(localStorage.getItem("Dek.outbox.v1") || "null");
    eq(ls && ls.map((r) => r.nonce), ["fA", "fB"], "F rows really in localStorage");
    await OB.put(mk("fA", 500, "five-v2"));
    const ls2 = JSON.parse(localStorage.getItem("Dek.outbox.v1"));
    eq(ls2.length, 2, "F LS put dedupes by nonce");
    eq(ls2.find((r) => r.nonce === "fA").text, "five-v2", "F LS put replaced text");
    await OB.del("fB");
    eq(JSON.parse(localStorage.getItem("Dek.outbox.v1")).map((r) => r.nonce), ["fA"], "F LS del filters");
    eq(await OB.get("fB"), null, "F deleted nonce unreadable");
    await OB.clear();
    eq(localStorage.getItem("Dek.outbox.v1"), "[]", "F LS clear resets");
    return { bad };
  });
  problems.push(...p3.bad.map((s) => `[page2-lsfallback] ${s}`));

  // ---------------------------------------------------------------- PAGE 3
  // Last resort: BOTH stores refuse. The RAM mirror must keep the queue.
  page = await newPage();
  await page.evaluate(() => {
    const broken = Object.create(window.indexedDB);
    broken.open = () => { throw new Error("private mode"); };
    Object.defineProperty(window, "indexedDB", { value: broken, configurable: true });
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (this === window.localStorage) throw new Error("quota refused");
      return realSet.call(this, k, v);
    };
  });
  const p4 = await page.evaluate(async () => {
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    const mk = (nonce, created_at) => ({
      nonce, url: "u", body: `b-${nonce}`, headers: {}, kind: "channel",
      scope_id: "cA", thread_id: null, text: `t-${nonce}`, attachments: [],
      reply_to: null, also_send: false, created_at, attempts: 0,
      next_at: 0, state: "queued", error: null,
    });
    const OB = await import("/js/lib/outbox.js?mem=1");
    await OB.clear();   // trips openDb so the backend flag reflects this page
    eq(OB.usingFallback(), true, "G fallback flagged when both stores refuse");
    await OB.put(mk("mA", 900));
    await OB.put(mk("mB", 300));
    eq((await OB.all()).map((r) => r.nonce), ["mB", "mA"], "G mem mirror serves oldest-first");
    const lsRaw = JSON.parse(localStorage.getItem("Dek.outbox.v1") || "[]");
    eq(lsRaw.map((r) => r && r.nonce), [], "G localStorage never received the rows");
    eq((await OB.get("mA")).text, "t-mA", "G get works off the mirror");
    await OB.del("mA");
    eq((await OB.all()).map((r) => r.nonce), ["mB"], "G del removes from the mirror");
    await OB.clear();
    eq(await OB.all(), [], "G clear empties the mirror");
    return { bad };
  });
  problems.push(...p4.bad.map((s) => `[page3-memonly] ${s}`));

  await page.close();
} catch (e) {
  console.error("SETUP FAILURE:", e.message);
  process.exitCode = 2;
} finally {
  if (errors.length) problems.push(`pageerrors: ${errors.length} (${errors[0]})`);
  await browser.close();
  server.close();
}

if (process.exitCode !== 2) {
  console.log("legs: B0 slate | A order+disk | B upsert | C del | D reload-survival+clear | F LS fallback | G mem last resort");
  console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
  process.exitCode = problems.length ? 1 : 0;
}
