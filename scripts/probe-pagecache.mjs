// Behavioral guard for the per-channel page snapshot cache, js/lib/pagecache.js.
// The module header promises "the last page of each channel, kept on this
// phone, so reopening a channel paints before the network is touched", a
// memory layer hit synchronously and an IndexedDB layer that "survives the
// tab being killed", keyed by signed-in user because "a shared phone must
// never paint one person's channel to the next person who signs in", writes
// debounced off the paint path, note/amend fold-ins for messages that move
// while cached, bounded storage (50 msgs / 400 threads / 16 channels /
// 14 days) and a sign-out wipe - but no dedicated probe ever ran it: sibling
// probes only used remember() as a seed or wipe() as teardown. Drives the
// SERVED module inside the booted page (probe-readcache precedent) and checks
// raw indexedDB.open('Dek-pages') as disk truth. Deterministic contract, so
// the asserts are EXACT VALUES:
//
//   LEG K  user keying: keyFor shape `uid|channelId` with anon fallback for a
//          missing/undefined user; u2 CANNOT see u1's snapshot (the shared-
//          phone rule); remember refuses falsy channelId, empty msgs.
//   LEG P  peek is the synchronous memory hit and returns THE live object:
//          stamping its at into the past makes the NEXT peek null (14-day
//          gate on the memory path) and restoring it revives the hit.
//   LEG R  recall is the disk layer: a raw-seeded valid row comes back exact
//          and populates memory for the next sync peek; wrong-version rows,
//          empty-msgs rows and missing keys read null and never populate.
//   LEG W  remember caps at the last 50 msgs and first 400 threads, stamps
//          v=2 with cursor/oldestSeq verbatim (missing oldestSeq -> null),
//          and lands on raw disk only after the 900ms debounce - absent
//          immediately after the call, present once the flush settles.
//   LEG N  note() folds post-cache arrivals: appends unseen ids, ignores
//          duplicates and id-less messages, bumps cursor to the max seq,
//          caps at 50 dropping the OLDEST, and no-ops without a snapshot.
//   LEG A  amend() patches exactly one message by id riding the spread,
//          leaving neighbours untouched; unknown id and unknown channel are
//          silent no-ops.
//   LEG E  ceiling eviction: past 16 stored channels the module's own
//          write->evict deletes the OLDEST-at row while all newer survive -
//          ordering made deterministic by seeding 16 raw rows with baked at
//          values so exactly ONE ceiling crossing happens through the
//          trigger write.
//   LEG X  wipe empties raw disk AND memory.
//
// Negative test (separate run): invert the age comparator in evict()
// ((a.at||0)-(z.at||0) -> newest-first) - exactly leg E must fail (the fresh
// trigger row evicted, the stale survivor kept) while every other leg stays
// green, attributing the proof to the oldest-first promise alone.
//
// Named gap: the dead-open fallback (open() throwing/hanging/dead-flagging)
// rides the same guard shape proven for the sibling stores; this probe pins
// the live-disk contract only. Tab survival of the disk layer follows from
// the raw-store membership asserts plus the sibling probes' shared-context
// proofs; this harness makes no cross-tab claim.
//
// Usage: node scripts/probe-pagecache.mjs [--root <dir>]
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
const TARGET = path.join(ROOT, "js", "lib", "pagecache.js");

function shaOf(file) {
  const raw = fs.readFileSync(file);
  const norm = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return {
    raw: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8),
    norm: crypto.createHash("sha256").update(norm).digest("hex").slice(0, 8),
  };
}
console.log(`probe-pagecache: kernel normalized sha ${shaOf(TARGET).norm}`);

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
console.log(`probe-pagecache: serving ${ROOT} on ${BASE}`);

const problems = [];
const errors = [];

// ONE context/page: the module memoizes its connection and this probe makes
// no cross-tab claim.
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
    // Raw disk truth helpers mirroring the module schema (Dek-pages v2,
    // store 'pages', keyPath 'key') so a raw open works either way.
    const rawOpen = () => new Promise((res, rej) => {
      const rq = indexedDB.open("Dek-pages", 2);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains("pages")) db.createObjectStore("pages", { keyPath: "key" });
      };
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => res(rq.result);
    });
    const rawAll = async () => {
      const db = await rawOpen();
      return new Promise((res, rej) => {
        const t = db.transaction("pages", "readonly");
        const g = t.objectStore("pages").getAll();
        g.onsuccess = () => { db.close(); res(g.result || []); };
        g.onerror = () => rej(g.error);
      });
    };
    const rawGet = async (key) => {
      const db = await rawOpen();
      return new Promise((res, rej) => {
        const t = db.transaction("pages", "readonly");
        const g = t.objectStore("pages").get(key);
        g.onsuccess = () => { db.close(); res(g.result || null); };
        g.onerror = () => rej(g.error);
      });
    };
    const rawPut = async (row) => {
      const db = await rawOpen();
      await new Promise((res, rej) => {
        const t = db.transaction("pages", "readwrite");
        t.objectStore("pages").put(row);
        t.oncomplete = () => { db.close(); res(); };
        t.onerror = () => rej(t.error);
      });
    };
    const rawWipe = async () => {
      const db = await rawOpen();
      await new Promise((res, rej) => {
        const t = db.transaction("pages", "readwrite");
        t.objectStore("pages").clear();
        t.oncomplete = () => { db.close(); res(); };
        t.onerror = () => rej(t.error);
      });
    };
    const waitFor = async (fn, ms = 5000) => {
      const t0 = Date.now();
      for (;;) {
        if (await fn()) return true;
        if (Date.now() - t0 > ms) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    const PC = await import("/js/lib/pagecache.js");

    // ---- LEG B0: clean slate off raw disk
    await PC.wipe();
    await rawWipe();
    eq((await rawAll()).length, 0, "B0 raw slate empty after wipe");

    // ---- LEG K: user keying, anon fallback, refusals
    PC.remember("u1", "cK", { msgs: [{ id: "k1", seq: 1 }] });
    eq(PC.peek("u1", "cK")?.msgs?.[0]?.id, "k1", "K own user sees the snapshot");
    eq(PC.peek("u2", "cK"), null, "K another user does NOT see it (shared-phone rule)");
    PC.remember(null, "anonCh", { msgs: [{ id: "a1", seq: 1 }] });
    eq(PC.peek(null, "anonCh")?.msgs?.[0]?.id, "a1", "K null user maps to anon");
    eq(PC.peek(undefined, "anonCh")?.msgs?.[0]?.id, "a1", "K undefined user maps to the SAME anon slot");
    PC.remember("u1", "", { msgs: [{ id: "x1" }] });
    eq(PC.peek("u1", ""), null, "K falsy channelId refused");
    PC.remember("u1", "cEmpty", { msgs: [] });
    eq(PC.peek("u1", "cEmpty"), null, "K empty msgs refused");

    // ---- LEG P: peek is the live synchronous memory object with the age gate
    const live = PC.peek("u1", "cK");
    eq(Array.isArray(live.msgs), true, "P memory hit returns the snapshot");
    live.at = Date.now() - 15 * 24 * 60 * 60 * 1000;
    eq(PC.peek("u1", "cK"), null, "P stale snapshot fails the 14-day gate on the memory path");
    live.at = Date.now();
    eq(PC.peek("u1", "cK")?.msgs?.[0]?.id, "k1", "P fresh stamp revives the memory hit");

    // ---- LEG R: recall reads raw disk truth and populates memory
    const now = Date.now();
    await rawPut({ key: "u9|cR", v: 2, at: now, channelId: "cR", msgs: [{ id: "r1", seq: 5 }], threads: [{ t: 1 }], cursor: 4, oldestSeq: 2 });
    await rawPut({ key: "u9|cV1", v: 1, at: now, channelId: "cV1", msgs: [{ id: "v1", seq: 1 }] });
    await rawPut({ key: "u9|cEmp", v: 2, at: now, channelId: "cEmp", msgs: [] });
    const rec = await PC.recall("u9", "cR");
    eq(rec?.msgs?.[0]?.id, "r1", "R recall returns the raw-seeded snapshot");
    eq(rec && { cursor: rec.cursor, oldestSeq: rec.oldestSeq, v: rec.v }, { cursor: 4, oldestSeq: 2, v: 2 }, "R recall fields verbatim incl version stamp");
    eq(PC.peek("u9", "cR")?.msgs?.[0]?.id, "r1", "R recall populated memory for the next sync peek");
    eq(await PC.recall("u9", "cV1"), null, "R wrong-version row refused");
    eq(PC.peek("u9", "cV1"), null, "R refused row never populated memory");
    eq(await PC.recall("u9", "cEmp"), null, "R empty-msgs row refused");
    eq(await PC.recall("u9", "cNope"), null, "R missing key reads null");
    // Stale disk row past MAX_AGE is refused too.
    await rawPut({ key: "u9|cOld", v: 2, at: now - 15 * 24 * 60 * 60 * 1000, channelId: "cOld", msgs: [{ id: "o1", seq: 1 }] });
    eq(await PC.recall("u9", "cOld"), null, "R stale disk row refused by the same 14-day gate");

    // ---- LEG W: caps + verbatim fields + debounced landing on raw disk
    const fiftyFive = Array.from({ length: 55 }, (_, i) => ({ id: `m${String(i + 1).padStart(2, "0")}`, seq: i + 1 }));
    const fourOhOne = Array.from({ length: 401 }, (_, i) => ({ root: `t${i}` }));
    PC.remember("u1", "cW", { msgs: fiftyFive, threads: fourOhOne, cursor: 7 });
    eq(await rawGet("u1|cW"), null, "W nothing on disk inside the debounce window");
    eq(await waitFor(async () => !!(await rawGet("u1|cW"))), true, "W flushed to raw disk after the window");
    const wRow = await rawGet("u1|cW");
    eq(wRow && { v: wRow.v, nMsgs: wRow.msgs.length, first: wRow.msgs[0].id, last: wRow.msgs[49].id }, { v: 2, nMsgs: 50, first: "m06", last: "m55" }, "W msg cap keeps the LAST 50");
    eq(wRow && { nThreads: wRow.threads.length, first: wRow.threads[0].root }, { nThreads: 400, first: "t0" }, "W thread cap keeps the FIRST 400");
    eq(wRow && { cursor: wRow.cursor, oldestSeq: wRow.oldestSeq, channelId: wRow.channelId, key: wRow.key }, { cursor: 7, oldestSeq: null, channelId: "cW", key: "u1|cW" }, "W bookkeeping fields verbatim, missing oldestSeq -> null");

    // ---- LEG N: note folds arrivals into the cached page
    const fortyEight = Array.from({ length: 48 }, (_, i) => ({ id: `n${String(i + 1).padStart(3, "0")}`, seq: i + 1 }));
    PC.remember("u1", "cN", { msgs: fortyEight, cursor: 5 });
    PC.note("u1", "cN", { id: "n049", seq: 10 });
    PC.note("u1", "cN", { id: "n049", seq: 10 });            // duplicate ignored
    PC.note("u1", "cN", { seq: 99 });                          // id-less ignored
    let nSnap = PC.peek("u1", "cN");
    eq(nSnap.msgs.map((m) => m.id).slice(-1), ["n049"], "N unseen arrival appended");
    eq(nSnap.msgs.length, 49, "N duplicate and id-less notes added nothing");
    eq(nSnap.cursor, 10, "N cursor bumped to the folded message's seq");
    PC.note("u1", "cN", { id: "n050", seq: 11 });
    PC.note("u1", "cN", { id: "n051", seq: 12 });
    nSnap = PC.peek("u1", "cN");
    eq(nSnap.msgs.length, 50, "N page held at the 50-msg cap");
    eq(nSnap.msgs[0].id, "n002", "N cap dropped the OLDEST, not the newest");
    eq(nSnap.cursor, 12, "N cursor tracks the max folded seq");
    PC.note("u1", "cGhost", { id: "g1", seq: 1 });
    eq(await PC.recall("u1", "cGhost"), null, "N note without a snapshot is a no-op");

    // ---- LEG A: amend patches one message by id
    PC.amend("u1", "cN", "n003", { body: "edited" });
    nSnap = PC.peek("u1", "cN");
    const amended = nSnap.msgs.find((m) => m.id === "n003");
    const neighbour = nSnap.msgs.find((m) => m.id === "n004");
    eq(amended && { body: amended.body, seq: amended.seq }, { body: "edited", seq: 3 }, "A patch rode the spread, own fields intact");
    eq(neighbour.body === undefined && neighbour.seq === 4, true, "A neighbour untouched");
    PC.amend("u1", "cN", "zzUnknown", { body: "x" });
    eq(PC.peek("u1", "cN").msgs.length, 50, "A unknown id changed nothing");
    let threw = false;
    try { PC.amend("u1", "cGhost", "g1", { body: "x" }); } catch { threw = true; }
    eq(threw, false, "A amend without a snapshot is a silent no-op");

    // ---- LEG E: ceiling eviction keeps the 16 freshest channels
    // Start from zero so the final raw set is exactly attributable. Wait out
    // any pending flush timer from earlier legs first, then seed 16 raw rows
    // with baked at values; the single module write crossing the ceiling
    // carries at=now (globally freshest).
    await PC.wipe();
    await rawWipe();
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 1; i <= 16; i++) {
      const ch = `e${String(i).padStart(2, "0")}`;
      await rawPut({ key: `ev|${ch}`, v: 2, at: 1000 + i, channelId: ch, msgs: [{ id: `${ch}m`, seq: 1 }] });
    }
    PC.remember("ev", "e17", { msgs: [{ id: "e17m", seq: 1 }] });
    // Wait for the TRIGGER ROW to land first: the seeded set alone already
    // satisfies length===16, so counting first would read the pre-flush state.
    eq(await waitFor(async () => !!(await rawGet("ev|e17"))), true, "E trigger write flushed");
    const settled = await waitFor(async () => (await rawAll()).length === 16);
    const keys = (await rawAll()).map((r) => r.key).sort();
    eq(settled, true, "E store settled back at the 16-channel ceiling");
    eq(keys.includes("ev|e01"), false, "E oldest-at channel evicted by the module's own write->evict");
    eq(keys.includes("ev|e17"), true, "E fresh trigger row survives");
    eq(keys.filter((k) => /^ev\|e(0[2-9]|1[0-6])$/.test(k)).length, 15, "E all mid-age rows survive");

    // ---- LEG X: wipe empties raw disk AND memory
    PC.remember("u1", "cX", { msgs: [{ id: "x1", seq: 1 }] });
    await waitFor(async () => !!(await rawGet("u1|cX")));
    await PC.wipe();
    eq((await rawAll()).length, 0, "X wipe emptied raw disk");
    eq(PC.peek("u1", "cK"), null, "X wipe cleared memory too");
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
  console.log("legs: B0 slate | K keying | P sync-memory+age | R recall disk | W caps+debounce | N note fold | A amend | E evict | X miss+wipe");
  console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
  process.exitCode = problems.length ? 1 : 0;
}
