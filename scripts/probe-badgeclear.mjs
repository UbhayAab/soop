// Behavioral guard for EFFICIENCY rank 2 (06acf1f), whose proof line was boot
// screenshots only. The claim: opening a conversation clears ITS OWN badge
// locally - the write's outcome is known the moment we send it - instead of
// paying refreshUnread's full tail (get_unread + spaceSummary + DM list) for an
// outcome we authored, and the clear lands BEFORE the mark_read round trip
// resolves, surviving even a hung or failed write. The probe drives the REAL
// booted openChannel/openDM against canned answers fulfilled locally:
//
//   LEG A channel open: with mark_read gated on the wire, the seeded unread
//     row is already gone from store AND sidebar DOM the moment openChannel
//     resolves, exactly one 'unread' emit fired, ZERO get_unread posts paid,
//     and the released write really carried p_scope_id:cA/p_up_to_seq.
//   LEG B exported contract: clearUnreadLocal on an absent scope is a silent
//     no-op; refreshUnread({full:false}) costs one get_unread and NOTHING else,
//     and an answer matching local state repaints nothing (fingerprint holds);
//     refreshUnread(null) - the exact shape a bare .then(refreshUnread) hands
//     over for a void RPC - must not throw and must run the FULL tail.
//   LEG C DM open: with mark_dm_read gated, the boolean-lit bootstrap-shaped
//     row clears in store and DOM the moment openDM resolves (one emit, zero
//     get_unread), the write carried p_conversation/p_up_to_seq:5, and opening
//     an EMPTY conversation writes nothing and emits nothing.
//
// Usage: node scripts/probe-badgeclear.mjs [--root <dir>]
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
console.log(`probe-badgeclear: serving ${ROOT} on ${BASE}`);

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

// Hermetic Supabase. Wire counters live in `wire`; `gate` names RPCs whose
// fulfillment waits until released - that hang IS the timing instrument: the
// local clear must beat it.
function wireSupabase(context, wire) {
  return context.route("**/rest/v1/**", async (route) => {
    const u = new URL(route.request().url());
    const seg = u.pathname.split("/");
    if (seg[seg.length - 2] !== "rpc") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    const name = seg[seg.length - 1];
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch {}
    if (name === "get_unread") { wire.getUnread++; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(wire.unreadAnswer) }); }
    if (name === "get_space_summary") { wire.summary++; return route.fulfill({ status: 200, contentType: "application/json", body: "[]" }); }
    if (name === "get_dm_unread") { wire.dmUnread++; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(wire.dmAnswer) }); }
    if (name === "get_channel_messages") {
      wire.msgFetch++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(wire.channelMsgs) });
    }
    if (name === "mark_read") {
      wire.markRead++; wire.markReadBody = body;
      await wire.gateMarkRead;
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    if (name === "mark_dm_read") {
      wire.markDm++; wire.markDmBody = body;
      await wire.gateMarkDm;
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
  getUnread: 0, summary: 0, dmUnread: 0, msgFetch: 0, markRead: 0, markDm: 0,
  markReadBody: null, markDmBody: null,
  unreadAnswer: [], dmAnswer: [], channelMsgs: [],
  gateMarkRead: Promise.resolve(), gateMarkDm: Promise.resolve(),
});

const browser = await chromium.launch();

try {
  // --------------------------------------------- legs A + B (channel side)
  {
    const wire = freshWire();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wireSupabase(context, wire);
    const { page, pageerrors } = await boot(context);

    await page.evaluate(async () => {
      const { store, bus } = await import("/js/store.js");
      window.__probe = { store, bus };
      store.me = { id: "u-me", display_name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      store.channels = [
        { id: "cA", name: "alpha", position: 1000, last_seq: 5 },
        { id: "cB", name: "bravo", position: 2000 },
      ];
      store.unread = new Map([["cA", { scope_id: "cA", unread: 2, mention_count: 0 }]]);
      store.notify = new Map();
      store.dms = [];
      window.__emits = 0;
      bus.on("unread", () => { window.__emits++; });
      const ch = await import("/js/core/channels.js");
      ch.renderChannels();
    });

    // Baseline: the badge is really painted, boot noise counted zero.
    const before = await page.evaluate(() => ({
      dot: !!document.querySelector('#channels [data-ch="cA"] .dot-unread'),
      badge: document.querySelector('#channels [data-ch="cA"] .badge')?.textContent || "",
    }));
    ok(before.dot && !before.badge, `seeded plain unread must paint a dot, got ${JSON.stringify(before)}`);
    ok(wire.getUnread === 0 && wire.markRead === 0, `boot-noise baseline must be zero, got unread=${wire.getUnread} mark=${wire.markRead}`);

    // LEG A: hold mark_read on the wire, open the REAL channel, and require the
    // clear to have beaten the write.
    let release;
    wire.gateMarkRead = new Promise((r) => { release = r; });
    wire.channelMsgs = [{
      id: "mA1", seq: 5, channel_id: "cA", conversation_id: null, author_id: "u-alice",
      body_text: "hello world", created_at: iso(NOW - 60e3), deleted_at: null,
    }];
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      const { openChannel } = await import("/js/core/channels.js");
      window.__emits = 0;
      await openChannel(store.channels[0]);
    });
    const afterOpen = await page.evaluate(() => ({
      inMap: window.__probe.store.unread.has("cA"),
      dot: !!document.querySelector('#channels [data-ch="cA"] .dot-unread'),
      badge: !!document.querySelector('#channels [data-ch="cA"] .badge'),
      emits: window.__emits,
      painted: document.querySelectorAll('#messages .msg').length,
    }));
    ok(afterOpen.inMap === false, `LEG A: cA must be gone from store.unread BEFORE the write resolves, still present`);
    ok(!afterOpen.dot && !afterOpen.badge, `LEG A: sidebar badge must be repainted away BEFORE the write resolves, got dot=${afterOpen.dot} badge=${afterOpen.badge}`);
    ok(afterOpen.emits === 1, `LEG A: exactly one 'unread' emit for the authored outcome, got ${afterOpen.emits}`);
    ok(wire.getUnread === 0, `LEG A: the open must cost ZERO get_unread posts (the old code paid a full refresh), got ${wire.getUnread}`);
    ok(afterOpen.painted >= 1, `LEG A: the served page must really be on screen (${afterOpen.painted} rows)`);

    release?.();
    await sleep(500);
    ok(wire.markRead === 1 && wire.markReadBody?.p_scope_type === "channel"
      && wire.markReadBody?.p_scope_id === "cA" && wire.markReadBody?.p_up_to_seq === 5,
      `LEG A: released write must carry mark_read(channel,cA,up to seq 5), got ${JSON.stringify(wire.markReadBody)}`);

    // LEG B1: absent scope is a silent no-op.
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      const { clearUnreadLocal } = await import("/js/core/channels.js");
      window.__emits = 0;
      const sizeBefore = store.unread.size;
      clearUnreadLocal("cZZ");
      window.__sizeOk = store.unread.size === sizeBefore;
    });
    const b1 = await page.evaluate(() => ({ emits: window.__emits, sizeOk: window.__sizeOk }));
    ok(b1.emits === 0 && b1.sizeOk, `LEG B1: clearing an absent scope must touch nothing, got emits=${b1.emits} sizeKept=${b1.sizeOk}`);

    // LEG B2: {full:false} costs exactly one get_unread and nothing else, and an
    // answer matching local state repaints nothing.
    wire.unreadAnswer = [];
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      const { refreshUnread } = await import("/js/core/channels.js");
      window.__emits = 0;
      await refreshUnread({ full: false });
    });
    ok(wire.getUnread === 1, `LEG B2: full:false must read get_unread once, got ${wire.getUnread}`);
    ok(wire.summary === 0 && wire.dmUnread === 0, `LEG B2: full:false must skip the rollup and DM tail, got summary=${wire.summary} dm=${wire.dmUnread}`);
    ok(await page.evaluate(() => window.__emits) === 0, "LEG B2: an answer matching local state must repaint nothing");

    // LEG B3: refreshUnread(null) - the bare .then(refreshUnread) shape - must
    // not throw and must default to the FULL tail.
    await page.evaluate(async () => {
      const { refreshUnread } = await import("/js/core/channels.js");
      await refreshUnread(null);
    });
    ok(wire.getUnread === 2 && wire.summary === 1 && wire.dmUnread === 1,
      `LEG B3: a null opts must read as full=true (unread=${wire.getUnread}, summary=${wire.summary}, dm=${wire.dmUnread})`);

    ok(pageerrors.length === 0, `A/B: pageerrors: ${pageerrors.join(" | ")}`);
    await page.screenshot({ path: path.join(ROOT, "s", "probe-badgeclear.png"), fullPage: false }).catch(() => {});
    await context.close();
  }

  // ------------------------------------------------------ leg C (DM side)
  {
    const wire = freshWire();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wireSupabase(context, wire);
    const { page, pageerrors } = await boot(context);

    // conv-a lit with the BOOTSTRAP shape (boolean true, not a number).
    await page.evaluate(async ({ isoA, isoB }) => {
      const { store, bus } = await import("/js/store.js");
      window.__probe = { store, bus };
      store.me = { id: "u-me", display_name: "Me" };
      store.myProfile = { id: "u-me", display_name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      store.profiles.set("u-alice", { id: "u-alice", display_name: "Alice" });
      store.dms = [
        { conversation_id: "conv-a", other_user_ids: ["u-alice"], last_message_at: isoA, unread: true },
        { conversation_id: "conv-b", other_user_ids: ["u-alice"], last_message_at: isoB, unread: 0 },
      ];
      store.channels = [];
      window.__emits = 0;
      bus.on("unread", () => { window.__emits++; });
      const ch = await import("/js/core/channels.js");
      ch.renderChannels();
    }, { isoA: iso(NOW - 60e3), isoB: iso(NOW - 90e3) });
    const dmBefore = await page.evaluate(() => ({
      a: !!document.querySelector('#channels [data-dm="conv-a"] .dot-unread'),
      b: !!document.querySelector('#channels [data-dm="conv-b"] .dot-unread'),
    }));
    ok(dmBefore.a && !dmBefore.b, `boolean-lit bootstrap row must paint its dot, got ${JSON.stringify(dmBefore)}`);
    ok(wire.getUnread === 0 && wire.markDm === 0, "boot-noise baseline must be zero on the DM side");

    // Hold mark_dm_read; the clear must still land before openDM resolves.
    let releaseDm;
    wire.gateMarkDm = new Promise((r) => { releaseDm = r; });
    context.route("**/rest/v1/dm_messages**", (route) => {
      const conv = decodeURIComponent(new URL(route.request().url()).searchParams.get("conversation_id") || "");
      const rows = conv.includes("conv-a")
        ? [{ id: "d1", seq: 5, conversation_id: "conv-a", author_id: "u-alice", body_text: "hi there", created_at: iso(NOW - 30e3), deleted_at: null }]
        : [];
      return route.fulfill({
        status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(rows),
      });
    });
    await page.evaluate(async () => {
      const { openDM } = await import("/js/core/dms.js");
      window.__emits = 0;
      await openDM("conv-a");
    });
    const dmAfter = await page.evaluate(() => ({
      flag: window.__probe.store.dms.find((d) => d.conversation_id === "conv-a")?.unread,
      dot: !!document.querySelector('#channels [data-dm="conv-a"] .dot-unread'),
      emits: window.__emits,
      hdr: document.getElementById("hdrName")?.textContent || "",
      rows: document.querySelectorAll("#messages .msg").length,
    }));
    ok(dmAfter.flag === 0, `LEG C: boolean-lit row must read 0 in store BEFORE the write resolves, got ${JSON.stringify(dmAfter.flag)}`);
    ok(!dmAfter.dot, "LEG C: DM dot must be gone from the sidebar before the write resolves");
    ok(dmAfter.emits === 1, `LEG C: exactly one 'unread' emit, got ${dmAfter.emits}`);
    ok(wire.getUnread === 0, `LEG C: the DM open must pay ZERO get_unread posts, got ${wire.getUnread}`);
    ok(/Alice/.test(dmAfter.hdr) && dmAfter.rows === 1, `LEG C: the conversation must really be open (${dmAfter.hdr}, ${dmAfter.rows} rows)`);

    releaseDm?.();
    await sleep(500);
    ok(wire.markDm === 1 && wire.markDmBody?.p_conversation === "conv-a" && wire.markDmBody?.p_up_to_seq === 5,
      `LEG C: released write must carry mark_dm_read(conv-a, up to seq 5), got ${JSON.stringify(wire.markDmBody)}`);

    // Empty conversation: lastSeq 0 means "nothing to acknowledge" - no write,
    // no emit, no phantom clear of anything.
    const dmWrites = wire.markDm;
    await page.evaluate(async () => {
      const { openDM } = await import("/js/core/dms.js");
      window.__emits = 0;
      await openDM("conv-b");
    });
    await sleep(300);
    ok(wire.markDm === dmWrites, `LEG C: opening an EMPTY conversation must write nothing (${wire.markDm} vs ${dmWrites})`);
    ok(await page.evaluate(() => window.__emits) === 0, "LEG C: an empty open must emit nothing");

    ok(pageerrors.length === 0, `C: pageerrors: ${pageerrors.join(" | ")}`);
    await context.close();
  }
} catch (e) {
  problems.push(`harness: ${e?.stack || e}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

if (problems.length) {
  console.log("PROBE FAILED - probe-badgeclear");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-badgeclear");
process.exit(0);
