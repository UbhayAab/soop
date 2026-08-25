// Behavioral guard for EFFICIENCY rank 5 parts b+c (b95cf6f), whose proof line
// was boot screenshots only. Part b: refreshDMList must sync EVERY saved DM's
// badge against the get_dm_unread answer including conversations ABSENT from it
// - a DM read on another device used to keep its lit dot until a Space switch,
// because the old code returned early on an empty answer and only ever touched
// rows the answer still mentioned. Part c: api.spaceSummary() shares one 20s
// TTL plus an in-flight promise so duplicate rollup reads collapse into one
// POST, and a FAILED read must not poison that cache. The probe drives the
// REAL booted modules against canned answers fulfilled locally:
//
//   1. stale-lit dot cleared when absent from the answer, confirmed dot kept,
//     dark dot untouched - sidebar DOM repaints with dots exactly matching
//   2. an EMPTY answer clears every flag (the old early-return kept them lit)
//   3. a fresh conversation in the answer joins members+profiles hermetically
//     and renders as a new lit row labelled from its profile
//   4. last_message_at resyncs off the answer for mentioned rows
//   5. two concurrent spaceSummary calls = ONE POST, identical results, a
//     third call inside the TTL stays cached, past the TTL it re-fires, and a
//     FAILED read rejects without poisoning the cache (next call re-fires)
//   6. zero pageerror.
//
// Usage: node scripts/probe-dmunread.mjs [--root <dir>]
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
console.log(`probe-dmunread: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

let dmAnswer = [];            // what get_dm_unread serves right now
let dmUnreadBody = null;      // last outbound POST args captured
let summaryCalls = 0;
let summaryFail = false;
const SUMMARY = [{ workspace_id: "ws-ws2", unread_total: 3 }];

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  // Installed BEFORE navigation so the booted app's own supabase client is
  // driven unmodified - no module mocking anywhere.
  await context.route("**/rest/v1/rpc/get_dm_unread", (route) => {
    try { dmUnreadBody = JSON.parse(route.request().postData() || "{}"); } catch { dmUnreadBody = null; }
    return route.fulfill({
      status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(dmAnswer),
    });
  });
  await context.route("**/rest/v1/rpc/get_unread", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }));
  await context.route("**/rest/v1/rpc/get_space_summary", (route) => {
    summaryCalls++;
    if (summaryFail) {
      return route.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"message":"boom"}' });
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(SUMMARY) });
  });
  // Member resolution for a fresh conversation is answered hermetically.
  await context.route("**/rest/v1/conversation_members**", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify([{ conversation_id: "conv-new", user_id: "u-carol" }]),
    }));
  await context.route("**/rest/v1/profiles**", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify([{ id: "u-carol", display_name: "Carol" }]),
    }));

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (err) => pageerrors.push(err.message));

  let featuresLoaded;
  const bootedLine = new Promise((r) => { featuresLoaded = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) featuresLoaded(); });
  const booted = Promise.race([bootedLine.then(() => true), sleep(45_000).then(() => false)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  ok(await booted, "app never reached the features-loaded boot line within 45s");
  if (!problems.length) console.log("probe-dmunread: app booted");

  // Seed the exact stale state the fix targets: conv-a is LIT but the server
  // no longer lists it (someone read it on their phone), conv-b is lit AND
  // confirmed, conv-c is dark. Profiles pre-seeded so labels resolve offline.
  await page.evaluate(async ({ isoA, isoB, isoC, isoNew }) => {
    const { store, bus } = await import("/js/store.js");
    window.__probe = { store, bus };
    store.me = { id: "u-me", display_name: "Me" };
    store.myProfile = { id: "u-me", display_name: "Me" };
    store.ws = { id: "ws-ws1", name: "W" };
    store.profiles.set("u-alice", { id: "u-alice", display_name: "Alice" });
    store.profiles.set("u-bob", { id: "u-bob", display_name: "Bob" });
    store.dms = [
      { conversation_id: "conv-a", other_user_ids: ["u-alice"], last_message_at: isoA, unread: 1 },
      { conversation_id: "conv-b", other_user_ids: ["u-bob"], last_message_at: isoB, unread: 1 },
      { conversation_id: "conv-c", other_user_ids: [], last_message_at: isoC, unread: 0 },
    ];
  }, { isoA: iso(NOW - 600e3), isoB: iso(NOW - 300e3), isoC: iso(NOW - 900e3), isoNew: iso(NOW - 60e3) });

  const unreadEvents = () => page.evaluate(() => window.__unreadCount || 0);
  await page.evaluate(() => {
    window.__unreadCount = 0;
    window.__probe.bus.on("unread", () => { window.__unreadCount++; });
  });

  const dms = () => page.evaluate(() =>
    [...window.__probe.store.dms.map((d) => ({ id: d.conversation_id, unread: d.unread ? 1 : 0, lma: d.last_message_at }))]);
  const dots = () => page.evaluate(() => ({
    a: !!document.querySelector('#channels [data-dm="conv-a"] .dot-unread'),
    b: !!document.querySelector('#channels [data-dm="conv-b"] .dot-unread'),
    c: !!document.querySelector('#channels [data-dm="conv-c"] .dot-unread'),
    labelA: document.querySelector('#channels [data-dm="conv-a"] .ch-name')?.textContent || "",
  }));

  // ---- Leg 1: absent-from-answer clears, confirmed keeps, dark stays dark.
  dmAnswer = [{ conversation_id: "conv-b", unread: true, last_message_at: iso(NOW - 100e3) }];
  await page.evaluate(async () => { const ch = await import("/js/core/channels.js"); await ch.refreshDMList(); });
  let rows = await dms();
  ok(rows.find((r) => r.id === "conv-a")?.unread === 0, `stale-lit conv-a must clear when absent from the answer, got ${JSON.stringify(rows)}`);
  ok(rows.find((r) => r.id === "conv-b")?.unread === 1, `confirmed conv-b must stay lit, got ${JSON.stringify(rows)}`);
  ok(rows.find((r) => r.id === "conv-c")?.unread === 0, `dark conv-c must stay dark, got ${JSON.stringify(rows)}`);
  ok(rows.find((r) => r.id === "conv-b")?.lma === iso(NOW - 100e3), "last_message_at must resync off the answer for mentioned rows");
  ok(await unreadEvents() === 1, `exactly one 'unread' emit expected after the sync, got ${await unreadEvents()}`);
  let d = await dots();
  ok(!d.a && d.b && !d.c, `sidebar dots must repaint to match the answer (a/b/c = ${JSON.stringify(d)})`);
  ok(d.labelA === "Alice", `lit row label resolves from profiles, got ${d.labelA}`);

  // ---- Leg 2: EMPTY answer clears everything (the old early-return bug).
  await page.evaluate(() => { for (const x of window.__probe.store.dms) x.unread = 1; window.__unreadCount = 0; });
  dmAnswer = [];
  await page.evaluate(async () => { const ch = await import("/js/core/channels.js"); await ch.refreshDMList(); });
  rows = await dms();
  ok(rows.every((r) => r.unread === 0), `an empty answer must clear EVERY flag, got ${JSON.stringify(rows)}`);
  ok(await unreadEvents() === 1, `one 'unread' emit expected on the empty-answer wipe, got ${await unreadEvents()}`);
  d = await dots();
  ok(!d.a && !d.b && !d.c, `all dots must vanish after an empty answer, got ${JSON.stringify(d)}`);

  // ---- Leg 3: a fresh conversation appears, resolves members, paints lit.
  dmAnswer = [{ conversation_id: "conv-new", unread: true, last_message_at: iso(NOW - 60e3) }];
  await page.evaluate(async () => { const ch = await import("/js/core/channels.js"); await ch.refreshDMList(); });
  rows = await dms();
  const freshRow = rows.find((r) => r.id === "conv-new");
  ok(!!freshRow && freshRow.unread === 1, `fresh conversation must be appended lit, got ${JSON.stringify(rows)}`);
  const others = await page.evaluate(() => window.__probe.store.dms.find((x) => x.conversation_id === "conv-new")?.other_user_ids);
  ok(JSON.stringify(others) === JSON.stringify(["u-carol"]), `fresh row carries resolved member ids, got ${JSON.stringify(others)}`);
  const freshRowDom = await page.evaluate(() => {
    const el = document.querySelector('#channels [data-dm="conv-new"]');
    return { label: el?.textContent || "", lit: !!el?.querySelector(".dot-unread") };
  });
  ok(freshRowDom.label.includes("Carol") && freshRowDom.lit,
    `fresh row paints labelled+lit, got ${JSON.stringify(freshRowDom)}`);
  ok(dmUnreadBody && dmUnreadBody.p_workspace === "ws-ws1",
    `get_dm_unread POST must carry the seeded workspace, got ${JSON.stringify(dmUnreadBody)}`);

  // ---- Leg 4: rank 5c - concurrent dedup, TTL cache, failure resets it.
  const sum = await page.evaluate(async () => {
    const mod = await import("/js/api.js");
    const [r1, r2] = await Promise.all([mod.api.spaceSummary(), mod.api.spaceSummary()]);
    return { r1, r2 };
  });
  ok(summaryCalls === 1, `two concurrent spaceSummary calls must cost ONE post, got ${summaryCalls}`);
  ok(JSON.stringify(sum.r1) === JSON.stringify(sum.r2) && JSON.stringify(sum.r1) === JSON.stringify(SUMMARY),
    `both callers resolve the same rollup payload, got ${JSON.stringify(sum)}`);
  await page.evaluate(async () => { const mod = await import("/js/api.js"); await mod.api.spaceSummary(); });
  ok(summaryCalls === 1, `a third call inside the TTL must stay cached, posts=${summaryCalls}`);

  // Past the TTL the entry must expire - and the FIRST post after expiry is
  // made to fail, so the rejection propagates AND the failed promise cannot
  // poison the cache: the next call re-fires instead of serving the failure
  // for the rest of the window. (A forced failure before expiry would just be
  // masked by the cached success, which leg above already pins.)
  await sleep(20_500);
  summaryFail = true;
  const rejected = await page.evaluate(async () => {
    const mod = await import("/js/api.js");
    try { await mod.api.spaceSummary(); return false; } catch { return true; }
  });
  ok(rejected && summaryCalls === 2, `past the TTL the call must re-fire and a failed read must reject, got reject=${rejected} posts=${summaryCalls}`);
  summaryFail = false;
  const healed = await page.evaluate(async () => {
    const mod = await import("/js/api.js");
    try { return JSON.stringify(await mod.api.spaceSummary()); } catch { return null; }
  });
  ok(healed === JSON.stringify(SUMMARY) && summaryCalls === 3,
    `a failure must reset the TTL so the next call re-fires clean, got ${healed} posts=${summaryCalls}`);

  ok(pageerrors.length === 0, `pageerror(s): ${pageerrors.join(" | ")}`);

  await page.screenshot({ path: path.join(ROOT, "s", "probe-dmunread.png"), fullPage: false }).catch(() => {});
  await context.close();
} catch (err) {
  problems.push(`harness: ${err.message}`);
  console.error(err.stack);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("PROBE FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN: rank5 b+c proven (absent-clears/confirmed-keeps DOM dots, empty-answer wipe, fresh join, lma resync, ws arg, dedup=1 post, TTL hold, failure resets)");
process.exit(0);
