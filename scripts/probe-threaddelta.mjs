// Behavioral guard for EFFICIENCY rank 7 (6e1e380), whose proof line was a boot
// screenshot only. The claim: on a warm open the pagecache snapshot already
// holds every thread that has not moved since it was written, so only the delta
// past snapshot.at crosses the wire and merges over the cached array - reply_count
// cannot change without last_message_at moving and nothing deletes threads -
// while a cold open still pays one full projected read and a dead network
// degrades to the cache instead of wiping it. The probe drives the REAL booted
// openChannel against counted /rest/v1/threads GETs answered by context.route:
//
//   LEG A cold open: exactly ONE threads GET carrying the six-column projection,
//     order last_message_at.desc, channel_id=eq.cB and NO gt cutoff; the answer
//     really lands in store.rootThreads.
//   LEG B warm open: with a snapshot seeded through the REAL pagecache module,
//     the one threads GET carries last_message_at=gt.<snapshot instant> (same
//     projection and order); a moved row merges its bumped reply_count OVER the
//     cached copy by id, untouched cached rows survive, a new thread joins, and
//     the re-remembered snapshot holds the merged array sorted newest-first.
//   LEG C dead network: with every threads GET aborted, a warm open resolves
//     WITHOUT throwing and the cached thread is still in store.rootThreads -
//     degradation to the cache, not a wipe.
//
// Usage: node scripts/probe-threaddelta.mjs [--root <dir>]
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
console.log(`probe-threaddelta: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const GUIDE = {
  channel_id: "", channel_name: "", purpose: "", body: "", topic: "",
  seen: true, pins: [], open_asks: [], can_edit: false, member_count: 1,
  updated_at: null, updated_by: null,
};
const THREAD_COLS = "id,channel_id,root_message_id,reply_count,last_message_at,title";

function wireSupabase(context, wire) {
  return context.route("**/rest/v1/**", async (route) => {
    const u = new URL(route.request().url());
    const seg = u.pathname.split("/");
    const last = seg[seg.length - 1];
    if (last === "threads" && route.request().method() === "GET") {
      wire.threads.push({
        channelId: u.searchParams.get("channel_id"),
        select: u.searchParams.get("select"),
        order: u.searchParams.get("order"),
        gt: u.searchParams.get("last_message_at"),
      });
      if (wire.threadsDead) return route.abort();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(wire.threadsRows) });
    }
    if (seg[seg.length - 2] !== "rpc") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    const name = last;
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch {}
    if (name === "get_channel_messages") {
      wire.msgFetch++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(wire.channelMsgs) });
    }
    if (name === "mark_read") {
      wire.markRead++;
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    if (name === "get_channel_guide") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...GUIDE, channel_id: String(body.p_channel || "") }) });
    }
    if (name === "get_dm_receipts" || name === "heartbeat") {
      return route.fulfill({ status: 200, contentType: "application/json", body: name === "get_dm_receipts" ? "[]" : "null" });
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

const freshWire = () => ({
  threads: [], threadsRows: [], threadsDead: false,
  msgFetch: 0, markRead: 0, channelMsgs: [],
});

const browser = await chromium.launch();

try {
  const wire = freshWire();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await wireSupabase(context, wire);
  const { page, pageerrors } = await boot(context);

  // Seed the signed-in shape the app has after bootstrap: two channels, me, ws.
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    window.__probe = { store };
    store.me = { id: "u-me", display_name: "Me" };
    store.myProfile = { id: "u-me", display_name: "Me" };
    store.ws = { id: "ws-ws1", name: "W" };
    store.channels = [
      { id: "cB", name: "bravo", position: 1000, last_seq: 5 },
      { id: "cA", name: "alpha", position: 2000, last_seq: 5 },
      { id: "cC", name: "charlie", position: 3000, last_seq: 5 },
    ];
    store.unread = new Map();
    store.notify = new Map();
    store.dms = [];
  });

  ok(wire.threads.length === 0, "boot-noise baseline: zero threads reads before any open");

  // ------------------------------------------------------------- LEG A: cold
  wire.channelMsgs = [{
    id: "mA1", seq: 5, channel_id: "cB", conversation_id: null, author_id: "u-alice",
    body_text: "cold open page", created_at: iso(NOW - 60e3), deleted_at: null,
  }];
  wire.threadsRows = [{
    id: "th-cold", channel_id: "cB", root_message_id: "mA1", reply_count: 7,
    last_message_at: iso(NOW - 30e3), title: "",
  }];
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const { openChannel } = await import("/js/core/channels.js");
    await openChannel(store.channels[0]);
  });
  const legA = await page.evaluate(() => ({
    root: window.__probe.store.rootThreads.get("mA1"),
    rows: document.querySelectorAll("#messages .msg").length,
  }));
  ok(wire.threads.length === 1, `LEG A: a cold open must cost exactly ONE threads read, got ${wire.threads.length}`);
  const a = wire.threads[0] || {};
  ok(a.channelId === "eq.cB", `LEG A: the read must be scoped to cB, got ${a.channelId}`);
  ok(a.select === THREAD_COLS, `LEG A: the read must carry the six-column projection, got ${a.select}`);
  ok(/last_message_at\.desc/.test(a.order || ""), `LEG A: the read must be ordered last_message_at.desc, got ${a.order}`);
  ok(a.gt === null, `LEG A: a COLD open must carry NO gt cutoff, got ${a.gt}`);
  ok(legA.root?.threadId === "th-cold" && legA.root?.count === 7,
    `LEG A: the answer must seed store.rootThreads for mA1, got ${JSON.stringify(legA.root)}`);
  ok(legA.rows >= 1, `LEG A: the served page must really be on screen (${legA.rows} rows)`);

  // ------------------------------------------------------------- LEG B: warm
  // Seed a snapshot through the REAL pagecache module: three cached threads.
  // th-2 is cached at count 4 but will come back moved at count 9; th-4 is new;
  // th-1/th-3 are older than the snapshot instant so the server never sends them.
  const seedAtMs = await page.evaluate(async ({ now }) => {
    const { store } = await import("/js/store.js");
    const pagecache = await import("/js/lib/pagecache.js");
    const ms = (d) => now - d;
    pagecache.remember(store.me, "cA", {
      msgs: [{ id: "m-seed", seq: 3, channel_id: "cA", author_id: "u-alice", body_text: "cached page", created_at: new Date(ms(40e3)).toISOString(), deleted_at: null }],
      threads: [
        { id: "th-2", channel_id: "cA", root_message_id: "m2", reply_count: 4, last_message_at: new Date(ms(50e3)).toISOString(), title: "" },
        { id: "th-1", channel_id: "cA", root_message_id: "m1", reply_count: 2, last_message_at: new Date(ms(100e3)).toISOString(), title: "" },
        { id: "th-3", channel_id: "cA", root_message_id: "m3", reply_count: 0, last_message_at: new Date(ms(200e3)).toISOString(), title: "" },
      ],
      cursor: 3, oldestSeq: 1,
    });
    return Date.now();
  }, { now: NOW });

  wire.channelMsgs = [{
    id: "mA2", seq: 6, channel_id: "cA", conversation_id: null, author_id: "u-alice",
    body_text: "warm open page", created_at: iso(NOW - 20e3), deleted_at: null,
  }];
  wire.threadsRows = [
    { id: "th-2", channel_id: "cA", root_message_id: "m2", reply_count: 9, last_message_at: iso(NOW - 10e3), title: "" },
    { id: "th-4", channel_id: "cA", root_message_id: "m4", reply_count: 1, last_message_at: iso(NOW - 5e3), title: "" },
  ];
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const { openChannel } = await import("/js/core/channels.js");
    await openChannel(store.channels.find((c) => c.id === "cA"));
  });
  ok(wire.threads.length === 2, `LEG B: a warm open must cost exactly ONE more threads read, got total ${wire.threads.length}`);
  const b = wire.threads[1] || {};
  ok(b.channelId === "eq.cA", `LEG B: the delta read must be scoped to cA, got ${b.channelId}`);
  ok(b.select === THREAD_COLS, `LEG B: the delta read must keep the projection, got ${b.select}`);
  ok(/last_message_at\.desc/.test(b.order || ""), `LEG B: the delta read must stay ordered, got ${b.order}`);
  const gtMs = b.gt ? Date.parse(String(b.gt).replace(/^gt\./, "")) : NaN;
  ok(Number.isFinite(gtMs) && Math.abs(gtMs - seedAtMs) < 20_000,
    `LEG B: the delta must cut at the snapshot instant (gt ${b.gt} vs seed ${new Date(seedAtMs).toISOString()})`);
  const legB = await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const pagecache = await import("/js/lib/pagecache.js");
    const snap = pagecache.peek(store.me, "cA");
    const g = (k) => { const t = store.rootThreads.get(k); return t ? { threadId: t.threadId, count: t.count } : null; };
    return {
      m2: g("m2"), m4: g("m4"), m1: g("m1"), m3: g("m3"),
      snapIds: (snap?.threads || []).map((t) => t.id),
    };
  });
  ok(legB.m2?.count === 9, `LEG B: the moved row's bumped reply_count must win the merge, got ${JSON.stringify(legB.m2)}`);
  ok(legB.m4?.count === 1, `LEG B: the brand-new thread must join through the merge, got ${JSON.stringify(legB.m4)}`);
  ok(legB.m1?.count === 2 && legB.m3?.count === 0,
    `LEG B: untouched cached threads must survive the merge, got ${JSON.stringify(legB.m1)} / ${JSON.stringify(legB.m3)}`);
  const wantOrder = ["th-4", "th-2", "th-1", "th-3"];
  ok(JSON.stringify(legB.snapIds) === JSON.stringify(wantOrder),
    `LEG B: the re-remembered snapshot must hold the merged array sorted newest-first, got ${JSON.stringify(legB.snapIds)}`);

  // ----------------------------------------------------- LEG C: dead network
  await page.evaluate(async ({ now }) => {
    const { store } = await import("/js/store.js");
    const pagecache = await import("/js/lib/pagecache.js");
    pagecache.remember(store.me, "cC", {
      msgs: [{ id: "mC1", seq: 4, channel_id: "cC", author_id: "u-alice", body_text: "cached charlie", created_at: new Date(now - 30e3).toISOString(), deleted_at: null }],
      threads: [
        { id: "th-c1", channel_id: "cC", root_message_id: "mC1", reply_count: 5, last_message_at: new Date(now - 25e3).toISOString(), title: "" },
      ],
      cursor: 4, oldestSeq: 2,
    });
  }, { now: NOW });
  wire.channelMsgs = [{
    id: "mC2", seq: 7, channel_id: "cC", conversation_id: null, author_id: "u-alice",
    body_text: "charlie page", created_at: iso(NOW - 15e3), deleted_at: null,
  }];
  wire.threadsDead = true;
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const { openChannel } = await import("/js/core/channels.js");
    try { await openChannel(store.channels.find((c) => c.id === "cC")); }
    catch (e) { window.__openThrew = String(e); }
  });
  const openThrew = await page.evaluate(() => window.__openThrew || null);
  ok(openThrew === null, `LEG C: an open whose threads read dies must resolve without throwing, got ${openThrew}`);
  ok(wire.threads.length === 3, `LEG C: exactly one attempted threads read on this open, got ${wire.threads.length - 2}`);
  const legC = await page.evaluate(() => {
    const t = window.__probe.store.rootThreads.get("mC1");
    return t ? { threadId: t.threadId, count: t.count } : null;
  });
  ok(legC?.count === 5, `LEG C: the cached thread must survive a dead network instead of being wiped, got ${JSON.stringify(legC)}`);

  ok(pageerrors.length === 0, `pageerrors: ${pageerrors.join(" | ")}`);
  await page.screenshot({ path: path.join(ROOT, "s", "probe-threaddelta.png"), fullPage: false }).catch(() => {});
  await context.close();
} catch (e) {
  problems.push(`harness: ${e?.stack || e}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

if (problems.length) {
  console.log("PROBE FAILED - probe-threaddelta");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-threaddelta");
process.exit(0);
