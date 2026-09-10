// Reopening a channel you already have must not re-download it.
//
// Reported: "a lot of downloading happens every time I open the app... all the
// messages are downloading every time and everything everything everything is
// happening every time."
//
// The page cache has painted the last page from disk since the efficiency pass,
// and the THREADS read has been a delta since then too - but the messages read
// was not. Every channel open asked for a full fifty-row page, including the
// channel you were in ninety seconds ago whose rows were already on screen
// before the request went out. openChannel now asks resume(channel, cursor)
// instead when the rows are already painted and the cursor is known, which is
// the same call reconcile() makes after a dropped socket.
//
// The thing that must not break is message delivery, so most of this probe is
// about correctness rather than bytes:
//
//   1. a channel with NO cache still takes a full page (nothing regressed for a
//      first visit)
//   2. reopening a cached channel asks resume, NOT get_channel_messages
//   3. a message that arrived while you were away is ON SCREEN after the delta
//      open - this is the one that matters
//   4. an edit and a delete that happened while away are applied too
//   5. too_old falls back to a full page and the list is still right
//   6. the delta open still loads reactions for the rows it painted
//   7. zero pageerror.
//
// Usage: node scripts/probe-coldbytes.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "--root") args.root = process.argv[++i];
const ROOT = path.resolve(args.root || path.dirname(fileURLToPath(import.meta.url)), args.root ? "." : "..");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (e, b) => {
    if (e) { try { res.writeHead(404).end("nope"); } catch {} return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-coldbytes: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (c, l) => { if (!c) problems.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };
const iso = (d) => new Date(d).toISOString();
const NOW = Date.now();

const msg = (seq, text, extra = {}) => ({
  id: `m-${seq}`, channel_id: "ch-1", workspace_id: "w1", seq,
  author_id: "u-lead", body_text: text, body: {}, attachments: [],
  created_at: iso(NOW - (100 - seq) * 60000), edited_at: null, deleted_at: null,
  mention_user_ids: [], mention_scope: null, thread_id: null, ...extra,
});
// The server's whole idea of this channel, which both the page read and the
// heal read are served from, so the two can never disagree.
const ALL = new Map();
for (const m of [msg(1, "first"), msg(2, "second"), msg(3, "third")]) ALL.set(m.id, m);

let pageCalls = 0;
let resumeCalls = [];
let reactionCalls = 0;
let resumeAnswer = { events: [], more: false, too_old: false };

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  // get_channel_messages answers NEWEST FIRST (order by seq desc); the client
  // reverses it. Serving it oldest-first paints the conversation upside down and
  // tells you nothing about the code.
  await context.route("**/rest/v1/rpc/get_channel_messages", (route) => {
    pageCalls++;
    return route.fulfill(json([...ALL.values()].filter((m) => !m.deleted_at)
      .sort((a, b) => b.seq - a.seq)));
  });
  // applyEvents does NOT trust the event payload: it takes the ids out of the
  // log and re-reads the rows from public.messages. A probe that only serves the
  // events proves the log was read and nothing about whether anything appeared.
  await context.route("**/rest/v1/messages**", (route) => {
    const u = new URL(route.request().url());
    const inFilter = u.searchParams.get("id") || "";
    const ids = (inFilter.match(/\(([^)]*)\)/)?.[1] || "").split(",")
      .map((x) => x.replace(/^"|"$/g, "").trim()).filter(Boolean);
    return route.fulfill(json(ids.map((id) => ALL.get(id)).filter(Boolean)));
  });
  await context.route("**/rest/v1/rpc/resume", (route) => {
    let b = {};
    try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    resumeCalls.push(b);
    return route.fulfill(json(resumeAnswer));
  });
  await context.route("**/rest/v1/message_reactions**", (route) => {
    reactionCalls++;
    return route.fulfill(json([]));
  });

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(e.message));
  let ready;
  const line = new Promise((r) => { ready = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) ready(); });
  const booted = Promise.race([line.then(() => true), sleep(45_000).then(() => false)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  ok(await booted, "app never reached the features-loaded boot line within 45s");
  if (problems.length) throw new Error(problems.join("; "));
  console.log("probe-coldbytes: app booted");

  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const ch = await import("/js/core/channels.js");
    window.__p = { store, ch };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "w1", name: "W" };
    store.profiles.set("u-me", { id: "u-me", display_name: "Abhay" });
    store.profiles.set("u-lead", { id: "u-lead", display_name: "Priyanka" });
    store.categories = [{ id: "c-1", name: "General", position: 1 }];
    store.channels = [
      { id: "ch-1", name: "founders-office", kind: "text", category_id: "c-1", position: 1, last_seq: 3 },
      { id: "ch-2", name: "other", kind: "text", category_id: "c-1", position: 2, last_seq: 0 },
    ];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  });

  const open = async (id) => {
    await page.evaluate(async (x) => {
      const { store } = await import("/js/store.js");
      const ch = await import("/js/core/channels.js");
      await ch.openChannel(store.channels.find((c) => c.id === x));
    }, id);
    await sleep(900);
  };
  const bodies = () => page.$$eval("#messages .msg .body", (ns) =>
    ns.map((n) => n.textContent.trim()));

  // 1. no cache: a full page, as before.
  pageCalls = 0; resumeCalls = [];
  await open("ch-1");
  ok(pageCalls === 1, `a first visit made ${pageCalls} full-page calls, want exactly 1`);
  ok(resumeCalls.length === 0, "a first visit asked resume with no cursor to resume from");
  ok(JSON.stringify(await bodies()) === JSON.stringify(["first", "second", "third"]),
    `the first visit painted ${JSON.stringify(await bodies())}`);

  // 2. reopen: the rows are cached, so a DELTA.
  await open("ch-2");
  pageCalls = 0; resumeCalls = []; reactionCalls = 0;
  resumeAnswer = { events: [], more: false, too_old: false };
  await open("ch-1");
  ok(pageCalls === 0, `reopening a cached channel still fetched ${pageCalls} full page(s)`);
  ok(resumeCalls.length >= 1, "reopening a cached channel did not ask resume at all");
  ok(resumeCalls[0]?.p_channel === "ch-1" && +resumeCalls[0]?.p_seq === 3,
    `resume was asked from ${JSON.stringify(resumeCalls[0])}, want ch-1 at the cached cursor 3`);
  ok(JSON.stringify(await bodies()) === JSON.stringify(["first", "second", "third"]),
    `the delta open painted ${JSON.stringify(await bodies())}`);

  // 6. and it still asks for the reactions on the rows it painted.
  ok(reactionCalls >= 1, "the delta open never loaded reactions - the rows would sit bare");

  // 3. THE ONE THAT MATTERS: a message that arrived while away must appear.
  await open("ch-2");
  ALL.set("m-4", msg(4, "arrived while you were away"));
  resumeAnswer = {
    events: [{ seq: 4, kind: "msg", channel_id: "ch-1", message_id: "m-4" }],
    more: false, too_old: false,
  };
  pageCalls = 0; resumeCalls = [];
  await open("ch-1");
  const withNew = await bodies();
  ok(withNew.includes("arrived while you were away"),
    `a message that arrived while away is MISSING after a delta open: ${JSON.stringify(withNew)}`);
  ok(pageCalls === 0, "the delta open fell back to a full page when it did not need to");

  // 4. an edit and a delete replayed the same way.
  await open("ch-2");
  ALL.set("m-1", { ...ALL.get("m-1"), body_text: "first, corrected", edited_at: iso(NOW) });
  resumeAnswer = {
    events: [
      { seq: 5, kind: "edit", channel_id: "ch-1", message_id: "m-1" },
      { seq: 6, kind: "delete", channel_id: "ch-1", message_id: "m-2" },
    ],
    more: false, too_old: false,
  };
  await open("ch-1");
  const after = await bodies();
  ok(after.some((t) => /corrected/.test(t)),
    `an edit that happened while away was not applied: ${JSON.stringify(after)}`);
  ok(after.some((t) => /message deleted/i.test(t)) || !after.includes("second"),
    `a delete that happened while away was not applied: ${JSON.stringify(after)}`);

  // 5. too_old: our position predates retention, so a full page and a correct list.
  await open("ch-2");
  resumeAnswer = { events: [], more: false, too_old: true };
  pageCalls = 0;
  await open("ch-1");
  await sleep(600);
  ok(pageCalls >= 1, "too_old did not fall back to a full page - the list would be stale forever");
  const healed = await bodies();
  ok(healed.length >= 3, `after a too_old re-snapshot the list holds ${JSON.stringify(healed)}`);

  ok(pageerrors.length === 0, `pageerror: ${pageerrors.join(" | ")}`);
} catch (e) {
  problems.push("probe threw: " + (e?.message || e));
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("PROBE FAILED");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN");
