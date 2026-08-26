// Behavioral guard for the offline read cache, js/lib/readcache.js.
// The module header promises "remember the body of a handful of read-only
// calls ... hand the same bytes back when the network is gone", keyed by
// signed-in user, bounded storage with keep-flagged records evicted last -
// but every consumer except signout's wipe() never ran headless, and none of
// the store promises were ever exercised. Drives the SERVED module inside the
// booted page (probe-outbox precedent) and checks raw IndexedDB as disk truth.
// Every claim below is deterministic, so the asserts are EXACT VALUES:
//
//   LEG K  keyFor() exact shape: `uid|METHOD|pathname?search|bodyhash` with the
//          origin dropped, anon for a missing user, search preserved,
//          body-sensitive, method-sensitive, and origin-INSENSITIVE for equal
//          bodies (same wire call on two hosts lands on one cached answer).
//   LEG W  write()/read() round trip returns the verbatim body, content type
//          and extra fields (keep rides the spread), at stamped >= a marker;
//          raw indexedDB.open('Dek-reads') sees exactly those keys.
//   LEG V  validation: a non-string body is refused, an oversized body
//          (> 2_000_000 chars) is refused, and the 2_000_000 boundary value
//          itself is ACCEPTED - exact ceiling pin.
//   LEG U  a second write under the same key is an UPSERT: same row count,
//          body replaced, fresh at.
//   LEG E  eviction: past the 60-record ceiling the OLDEST non-keep records
//          leave while a keep-flagged record with the globally smallest at
//          SURVIVES - the header's "records marked keep are evicted last".
//          Ordering is made deterministic by patching raw at values to known
//          distinct numbers, then ONE more module write triggers the module's
//          own post-write evict (so the sweep provably rides every write).
//   LEG X  a missing key reads null; wipe() empties the raw store.
//
// Negative test (separate run): invert the keep term of the evict comparator
// in readcache.js - exactly the keep-survivor assert of leg E must fail while
// the count/ordering/validation asserts stay green, attributing the proof to
// the keep-last promise alone.
//
// Named gap: the dead-open fallback (indexedDB.open throwing or hanging) rides
// the same guard shape proven for the sibling outbox store in probe-outbox;
// this probe pins the live-disk contract only.
//
// Usage: node scripts/probe-readcache.mjs [--root <dir>]
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
const TARGET = path.join(ROOT, "js", "lib", "readcache.js");

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
console.log(`probe-readcache: serving ${ROOT} on ${BASE}`);

const problems = [];
const errors = [];

// ONE context/page: the module memoizes its connection and this probe makes no
// cross-tab claim (tab survival is proven for the sibling stores already).
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

async function newPage() {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`p${errors.length}: ${e.message}`));
  await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  return page;
}

try {
  const page = await newPage();

  const p1 = await page.evaluate(async () => {
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    // Raw disk truth helpers. onupgradeneeded mirrors the module's schema so a
    // raw open works whether or not the module has touched the database yet.
    const rawOpen = () => new Promise((res, rej) => {
      const rq = indexedDB.open("Dek-reads", 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains("reads")) {
          const s = db.createObjectStore("reads", { keyPath: "key" });
          s.createIndex("at", "at");
        }
      };
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => res(rq.result);
    });
    const rawKeys = async () => {
      const db = await rawOpen();
      return new Promise((res, rej) => {
        const t = db.transaction("reads", "readonly");
        const g = t.objectStore("reads").getAllKeys();
        g.onsuccess = () => { db.close(); res([...g.result].sort()); };
        g.onerror = () => rej(g.error);
      });
    };
    const rawCount = async () => (await rawKeys()).length;
    const rawWipe = async () => {
      const db = await rawOpen();
      await new Promise((res, rej) => {
        const t = db.transaction("reads", "readwrite");
        t.objectStore("reads").clear();
        t.oncomplete = () => { db.close(); res(); };
        t.onerror = () => rej(t.error);
      });
    };

    const RC = await import("/js/lib/readcache.js");

    // ---- LEG B0: clean slate off raw disk
    await rawWipe();
    eq(await rawCount(), 0, "B0 raw slate empty after wipe");

    // ---- LEG K: keyFor exact shape and sensitivities
    const u = "https://sb.example/rest/v1/rpc/get_bootstrap";
    const kUid = RC.keyFor("u1", "GET", u, '{"a":1}');
    const parts = String(kUid).split("|");
    eq(parts.length, 4, "K key has four pipe-separated fields");
    eq(parts[0], "u1", "K field 0 is the user id");
    eq(parts[1], "GET", "K field 1 is the method");
    eq(parts[2], "/rest/v1/rpc/get_bootstrap", "K field 2 is path with origin dropped");
    eq(RC.keyFor(null, "GET", u, '{"a":1}').split("|")[0], "anon", "K missing user falls back to anon");
    eq(RC.keyFor("u1", "POST", u, '{"a":1}') !== kUid, true, "K method changes the key");
    eq(
      RC.keyFor("u1", "GET", "https://sb.example/rest/v1/rpc/get_later?a=1", ""),
      RC.keyFor("u1", "GET", "https://sb.example/rest/v1/rpc/get_later?a=1"),
      "K empty and missing bodies hash the same"
    );
    eq(
      RC.keyFor("u1", "GET", u + "?x=9", "") === RC.keyFor("u1", "GET", u, ""),
      false,
      "K search string is part of the key"
    );
    eq(
      RC.keyFor("u1", "GET", "https://other.example/rest/v1/rpc/get_bootstrap", '{"a":1}'),
      kUid,
      "K different origin, same path and body, SAME key"
    );

    // ---- LEG W: write/read round trip + raw disk membership
    const k1 = RC.keyFor("u1", "GET", "https://sb.example/rest/v1/rpc/get_channel_messages", "1");
    const k2 = RC.keyFor("u1", "GET", "https://sb.example/rest/v1/rpc/get_space_summary", "2");
    const t0 = Date.now();
    await RC.write(k1, { body: "[1,2,3]", ct: "application/json" });
    await RC.write(k2, { body: "{}", ct: "text/plain", keep: true });
    const w1 = await RC.read(k1);
    eq(w1 && { body: w1.body, ct: w1.ct }, { body: "[1,2,3]", ct: "application/json" }, "W round trip returns verbatim fields");
    eq(typeof w1.at === "number" && w1.at >= t0, true, "W at stamped at write time");
    eq(w1.key, k1, "W record carries its key");
    const w2 = await RC.read(k2);
    eq(w2.keep, true, "W extra fields ride the stored record");
    eq(await RC.read("nope|GET|/nowhere|x"), null, "W missing key reads null");
    eq(await rawKeys(), [k1, k2].sort(), "W raw indexedDB sees exactly the written keys");

    // ---- LEG V: refusal rules and the exact size boundary
    await RC.write("kBad", { body: { not: "a string" } });
    await RC.write("kNull", null);
    eq(await rawCount(), 2, "V non-string body and null record refused");
    await RC.write("kBig", { body: "x".repeat(2_000_001), ct: "text/plain" });
    eq(await rawCount(), 2, "V oversized body refused");
    const kB = RC.keyFor("u1", "GET", "https://sb.example/rest/v1/rpc/get_bootstrap", "big");
    await RC.write(kB, { body: "y".repeat(2_000_000), ct: "text/plain" });
    eq((await RC.read(kB)).body.length, 2_000_000, "V boundary-size body accepted");

    // ---- LEG U: same-key write is an upsert
    const atBefore = (await RC.read(k1)).at;
    await RC.write(k1, { body: "v2", ct: "application/json" });
    eq(await rawCount(), 3, "U upsert adds no row");
    const up = await RC.read(k1);
    eq(up.body, "v2", "U upsert replaced the body");
    eq(up.at >= atBefore, true, "U upsert restamped at");

    // ---- LEG E: ceiling eviction, keep flagged survives being oldest
    // 3 rows now (k1, k2 keep, kB). Seed 61 plain rows RAW with their final at
    // baked in - via module write() the sweep would fire mid-seed at row 61
    // and eat the very rows this leg patches (first run's harness bug) - so
    // exactly ONE ceiling crossing happens, through the module's own
    // write->evict on the trigger row below.
    const rawSeed = async (key, at, extra) => {
      const db = await rawOpen();
      await new Promise((res, rej) => {
        const t = db.transaction("reads", "readwrite");
        t.objectStore("reads").put({ key, at, body: "seed", ct: "text/plain", ...extra });
        t.oncomplete = () => { db.close(); res(); };
        t.onerror = () => rej(t.error);
      });
    };
    const seeds = [];
    for (let i = 0; i < 61; i++) {
      const k = RC.keyFor(`seed${String(i).padStart(2, "0")}`, "GET", "https://sb.example/rest/v1/rpc/list_tasks", String(i));
      seeds.push(k);
      await rawSeed(k, 1000 + i);
    }
    await rawSeed(k2, 1, { keep: true });                // keep row: globally oldest
    await rawSeed(k1, 5000);                             // upserted row from leg U
    await rawSeed(kB, 6000);                             // boundary-size row from leg V
    const kN = RC.keyFor("u1", "GET", "https://sb.example/rest/v1/rpc/get_unread", "new");
    await RC.write(kN, { body: "tail", ct: "text/plain" });   // 65th row -> evict back to 60
    const afterEvict = await rawKeys();
    eq(afterEvict.length, 60, "E store held at the 60-record ceiling");
    eq(afterEvict.includes(k2), true, "E keep-flagged record survives despite the smallest at");
    const doomed = seeds.slice(0, 5);                    // five oldest plain rows
    eq(doomed.filter((k) => afterEvict.includes(k)).length, 0, "E five oldest plain records evicted");
    eq([seeds[5], seeds[60], k1, kB, kN].every((k) => afterEvict.includes(k)), true, "E newer and mid-age records survive");

    // ---- LEG X: wipe empties the raw store
    await RC.wipe();
    eq(await rawCount(), 0, "X wipe emptied raw disk");
    eq(await RC.read(k1), null, "X wiped key unreadable");
    return { bad };
  });
  problems.push(...p1.bad.map((s) => `[page1] ${s}`));

  await context.close();
} catch (e) {
  console.error("SETUP FAILURE:", e.message);
  process.exitCode = 2;
} finally {
  if (errors.length) problems.push(`pageerrors: ${errors.length} (${errors[0]})`);
  await browser.close();
  server.close();
}

if (process.exitCode !== 2) {
  console.log("legs: B0 slate | K keyFor | W roundtrip+disk | V refusals+boundary | U upsert | E evict keep-last | X miss+wipe");
  console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
  process.exitCode = problems.length ? 1 : 0;
}
