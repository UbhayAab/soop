// Behavioral guard for EFFICIENCY rank 19 (6a382f9 + cc2e27e), whose proof
// lines were boot screenshots only. Two claims stood unproven:
//
//   1. api.table() projects a per-table column list onto the wire for exactly
//      the six tables whose consumers read narrow columns, leaves every other
//      table at '*', and keeps the projection even when a caller composes
//      extra filters through the build callback.
//   2. The resync heal fetch inside channels.js applyEvents chunks the ids it
//      is missing 50 per request, carries the 20-column heal projection (never
//      body jsonb), retries ONCE with '*' when served rows are missing one of
//      those keys (schema drift), and abandons the pass with store.cursor
//      untouched when both attempts fail - so the next trigger refetches the
//      same span instead of marching the cursor past messages nobody painted.
//
// The probe boots the real app and drives the REAL exported api.table() and
// reconcile() against wire-counted /rest/v1 GETs answered by context.route:
//
//   LEG A projections: each of the six mapped tables costs exactly ONE GET
//     carrying exactly its mapped select list; profiles (deliberately
//     unlisted) goes out as '*'; a composed .eq() filter cannot disturb the
//     select.
//   LEG B chunked heal: resume answers 120 msg events past cursor 10; exactly
//     THREE messages GETs leave, each holding <=50 ids in id=in.(...), the
//     union covering all 120, every select the full heal list, no '*' retry,
//     and store.cursor lands on 130 with all rows on screen.
//   LEG C drift guard: a served row missing 'topic' forces exactly one more
//     GET with select='*' and the cursor still advances.
//   LEG D dead wire: both attempts abort; TWO gets total, cursor unchanged -
//     the abandon that keeps healed messages reachable.
// Usage: node scripts/probe-projections.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
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
console.log(`probe-projections: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read out of the source rather than copied into it. This constant used to be a
// hand-maintained duplicate with a "keep in sync" comment on top, and it did not
// stay in sync: the list in channels.js named three columns that public.messages
// does not have (bot_id, webhook_id, conversation_id), so the projected read
// failed on every single heal and the '*' retry became the only path that ever
// ran - while this probe went on asserting that the projection was healthy.
// A duplicated constant with a comment asking a human to maintain it is not a
// contract, so parse the real one.
const CHANNELS_SRC = readFileSync(new URL("../js/core/channels.js", import.meta.url), "utf8");
const HEAL_COLUMNS = (() => {
  const m = /const HEAL_COLUMNS = \[([\s\S]*?)\];/.exec(CHANNELS_SRC);
  if (!m) throw new Error("probe-projections: HEAL_COLUMNS not found in js/core/channels.js");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
})();
const HEAL_SELECT = HEAL_COLUMNS.join(",");

// Keep in sync with TABLE_COLUMNS in js/api.js (module-private const).
const TABLE_COLS = {
  voice_participants: "channel_id,user_id",
  workspace_members: "user_id,member_type,joined_at",
  conversation_members: "conversation_id,user_id",
  message_acks: "message_id,user_id",
  read_state: "last_read_seq",
  member_roles: "user_id,role_id",
};

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();

function healRow(id, seq, opts = {}) {
  const row = {
    id, seq, channel_id: opts.channel || "cR", conversation_id: null,
    author_id: "u-alice", body_text: "healed " + id,
    created_at: iso(NOW - 30e3), edited_at: null, deleted_at: null,
    attachments: null, mention_user_ids: null, mention_scope: "none",
    priority: 0, reply_to_id: null, thread_id: null,
    also_send_to_channel: null, ack_required: false, bot_id: null, webhook_id: null,
  };
  if (!opts.drift) row.topic = null; // drift mode serves rows without the key
  return row;
}

const freshWire = () => ({
  tables: new Map(),   // name -> [{select, eq:Map}]
  msgGets: [],         // {ids:[...], select}
  msgDead: false,
  drift: false,
  resumePosts: [],     // {channel, seq}
  resumeScript: [],    // consumed per resume POST: {events, more}
  writes: 0,
});

function wireSupabase(context, wire) {
  return context.route("**/rest/v1/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const seg = u.pathname.split("/");
    const last = seg[seg.length - 1];
    if (seg[seg.length - 2] === "rpc") {
      let body = {};
      try { body = req.postDataJSON() || {}; } catch {}
      if (last === "resume") {
        wire.resumePosts.push({ channel: body.p_channel, seq: body.p_seq });
        const r = wire.resumeScript.length ? wire.resumeScript.shift() : { events: [], more: false };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(r) });
      }
      wire.writes++;
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    if (req.method() !== "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    if (last === "messages") {
      const raw = u.searchParams.get("id") || "";
      const ids = /^\((.*)\)$/.test(raw.replace(/^in\./, "")) ? raw.replace(/^in\.\(|\)$/g, "").split(",").filter(Boolean) : [];
      wire.msgGets.push({ ids, select: u.searchParams.get("select") });
      if (wire.msgDead) return route.abort();
      const rows = ids.map((id) => healRow(id.trim(), Number(id.trim().replace(/\D/g, "")) + 10, { channel: u.searchParams.get("channel_id"), drift: wire.drift }));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) });
    }
    if (!wire.tables.has(last)) wire.tables.set(last, []);
    const eq = {};
    for (const [k, v] of u.searchParams) if (k !== "select") eq[k] = v;
    wire.tables.get(last).push({ select: u.searchParams.get("select"), eq });
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

const browser = await chromium.launch();

try {
  const wire = freshWire();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await wireSupabase(context, wire);
  const { page, pageerrors } = await boot(context);

  // Seed the signed-in shape; no openChannel anywhere, so no subscribe noise.
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    window.__probe = { store };
    store.me = { id: "u-me", display_name: "Me" };
    store.myProfile = { id: "u-me", display_name: "Me" };
    store.ws = { id: "ws-ws1", name: "W" };
    store.channels = [];
    store.unread = new Map();
    store.notify = new Map();
    store.dms = [];
  });

  ok(wire.tables.size === 0 && wire.msgGets.length === 0,
    `boot-noise baseline: zero rest reads before any call (tables ${wire.tables.size}, msgs ${wire.msgGets.length})`);

  // ---------------------------------------------------- LEG A: projections
  await page.evaluate(async () => {
    const { table } = await import("/js/api.js");
    window.__legA = {};
    for (const t of ["voice_participants", "workspace_members", "conversation_members",
      "message_acks", "read_state", "member_roles"]) {
      await table(t);
    }
    await table("profiles");                                  // deliberately unlisted
    window.__legA.composed = await table("message_acks", (q) => q.eq("user_id", "u-me"));
  });
  for (const [name, cols] of Object.entries(TABLE_COLS)) {
    if (name === "message_acks") continue;   // tallied separately below (plain + composed)
    const hits = wire.tables.get(name) || [];
    ok(hits.length === 1, `LEG A: ${name} must cost exactly ONE read, got ${hits.length}`);
    ok((hits[0]?.select || "") === cols,
      `LEG A: ${name} must project '${cols}' on the wire, got '${hits[0]?.select}'`);
  }
  const acksPlain = (wire.tables.get("message_acks") || [])[0];
  ok(acksPlain?.select === TABLE_COLS.message_acks,
    `LEG A: message_acks must project '${TABLE_COLS.message_acks}' on the plain read, got '${acksPlain?.select}'`);
  const prof = wire.tables.get("profiles") || [];
  ok(prof.length === 1 && prof[0].select === "*",
    `LEG A: unmapped profiles must go out as select=* once, got ${prof.length}x'${prof[0]?.select}'`);
  const comp = wire.tables.get("message_acks") || [];
  ok(comp.length === 2 && comp[1].select === TABLE_COLS.message_acks && comp[1].eq.user_id === "eq.u-me",
    `LEG A: a composed .eq() must keep the projection and add the filter, got ${JSON.stringify(comp[1])}`);

  // ------------------------------------------- LEG B: chunked projected heal
  const B_IDS = Array.from({ length: 120 }, (_, i) => `m${String(i + 1).padStart(3, "0")}`);
  wire.resumeScript.push({
    events: B_IDS.map((id, i) => ({ kind: "msg", seq: 11 + i, message_id: id })),
    more: false,
  });
  const bBefore = { gets: wire.msgGets.length, dom: await page.evaluate(() => document.querySelectorAll("#messages .msg").length) };
  const legB = await page.evaluate(async () => {
    const { store } = window.__probe;
    const { reconcile } = await import("/js/core/channels.js");
    store.current = { id: "cR", name: "resync" };
    store.cursor = 10;
    await reconcile();
    return { cursor: store.cursor };
  });
  const bGets = wire.msgGets.slice(bBefore.gets);
  ok(wire.resumePosts.length === 1 && wire.resumePosts[0].channel === "cR" && wire.resumePosts[0].seq === 10,
    `LEG B: exactly ONE resume POST carrying (cR, cursor 10), got ${JSON.stringify(wire.resumePosts)}`);
  ok(bGets.length === 3, `LEG B: 120 ids at 50/request must cost exactly THREE reads, got ${bGets.length}`);
  ok(bGets.every((g) => g.ids.length > 0 && g.ids.length <= 50),
    `LEG B: every chunk must hold 1..50 ids, got ${bGets.map((g) => g.ids.length).join("/")}`);
  const union = new Set(bGets.flatMap((g) => g.ids));
  ok(B_IDS.every((id) => union.has(id)) && union.size === 120,
    `LEG B: the chunks' union must cover all 120 wanted ids exactly once (${union.size} distinct)`);
  ok(bGets.every((g) => g.select === HEAL_SELECT),
    `LEG B: every heal read must carry the 20-column projection, got ${bGets.map((g) => g.select).join(" | ")}`);
  ok(legB.cursor === 130, `LEG B: the cursor must advance to 130 after a healthy pass, got ${legB.cursor}`);
  const bDom = await page.evaluate(() => document.querySelectorAll("#messages .msg").length);
  ok(bDom - bBefore.dom === 120,
    `LEG B: all 120 healed messages must land on screen (+${bDom - bBefore.dom})`);

  // --------------------------------------------------- LEG C: drift guard
  wire.drift = true;                       // served rows lack the topic key
  wire.resumeScript.push({ events: [{ kind: "msg", seq: 501, message_id: "md501" }], more: false });
  const cBefore = { gets: wire.msgGets.length, posts: wire.resumePosts.length };
  const legC = await page.evaluate(async () => {
    const { store } = window.__probe;
    const { reconcile } = await import("/js/core/channels.js");
    store.current = { id: "cS", name: "drift" };
    store.cursor = 500;
    await reconcile();
    return { cursor: store.cursor };
  });
  const cGets = wire.msgGets.slice(cBefore.gets);
  ok(wire.resumePosts.length - cBefore.posts === 1, `LEG C: one resume POST for the drift pass`);
  ok(cGets.length === 2, `LEG C: a drifted schema must cost exactly TWO reads (projected then '*'), got ${cGets.length}`);
  ok(cGets[0]?.select === HEAL_SELECT && cGets[1]?.select === "*",
    `LEG C: the retry must go out unprojected, got '${cGets[0]?.select}' then '${cGets[1]?.select}'`);
  ok(legC.cursor === 501, `LEG C: the drifted pass must still advance the cursor to 501, got ${legC.cursor}`);
  wire.drift = false;

  // -------------------------------------------------- LEG D: dead wire, LAST
  // requestResync schedules a delayed reconcile on failure; this leg runs last
  // so nothing can pollute the accounting above, and the context closes before
  // the timer matters.
  wire.msgDead = true;
  wire.resumeScript.push({ events: [{ kind: "msg", seq: 901, message_id: "me901" }], more: false });
  const dBefore = { gets: wire.msgGets.length, cursor: legC.cursor };
  const legD = await page.evaluate(async () => {
    const { store } = window.__probe;
    const { reconcile } = await import("/js/core/channels.js");
    store.current = { id: "cT", name: "dead" };
    store.cursor = 900;
    await reconcile();
    return { cursor: store.cursor };
  });
  const dGets = wire.msgGets.slice(dBefore.gets);
  ok(dGets.length === 2, `LEG D: a dead wire costs exactly TWO attempts (projected then '*'), got ${dGets.length}`);
  ok(dGets.every((g) => g.select === HEAL_SELECT || g.select === "*"),
    `LEG D: both attempts must be real reads, got ${dGets.map((g) => g.select).join(" | ")}`);
  ok(legD.cursor === 900,
    `LEG D: a failed pass must leave the cursor alone so the next trigger refetches, got ${legD.cursor} (was ${dBefore.cursor})`);

  ok(pageerrors.length === 0, `pageerrors: ${pageerrors.join(" | ")}`);
  await page.screenshot({ path: path.join(ROOT, "s", "probe-projections.png"), fullPage: false }).catch(() => {});
  await context.close();
} catch (e) {
  problems.push(`harness: ${e?.stack || e}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

if (problems.length) {
  console.log("PROBE FAILED - probe-projections");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-projections");
process.exit(0);
