// Behavioral guard for offline.js's durable send path, the layer ABOVE the
// outbox store. The store itself is proved by probe-outbox.mjs, and
// tests/offline-outbox.test.js runs the send path against the LIVE database,
// but nothing ever ran the guarded-send contract headless against a counted
// wire: "on disk BEFORE the request goes out", an offline send costing zero
// wire attempts while painting the readable bar, a reconnect flushing the
// queue OLDEST FIRST with each body replayed byte-for-byte under its ORIGINAL
// nonce, and success deleting the row from disk.
//
//   SETUP   boot signed-in-shaped (seeded future-dated session, so flush's
//           accessToken() resolves without touching the network); baseline
//           asserts ZERO send_message POSTs during boot noise.
//   LEG B   (runs FIRST, while the queue is provably empty so the module's
//           5s tick cannot join the measurement - its flush gates on live.size):
//           route HUNG, fire send n3, and while the request is still
//           unanswered the raw IndexedDB row ALREADY exists (the disk write
//           provably precedes the wire). Release 200 -> the nonce leaves disk.
//   LEG A   context.setOffline(true), two sends via the real api.rpc:
//           both reject (nothing resolves), ZERO POSTs hit the wire, BOTH
//           rows are in RAW IndexedDB Dek-outbox/sends with verbatim bodies,
//           and #obBar paints ob-down with the plain-language text.
//   LEG C   dispatch the window 'online' event: EXACTLY TWO POSTs total, in
//           created_at order [n1, n2], each body field-identical to what was
//           queued (original nonces n1/n2 - not fresh ones), Authorization
//           minted at replay time and apikey carried, and raw IndexedDB ends
//           at ZERO rows (success drops).
//
// Accepted gap, named: the retry-status branch (401/500 requeue) and the
// failed-state human reason ride the same save/queue machinery this proves;
// they are left to the live-database test. Multi-record ordering here covers
// two records; deeper bursts belong to the store-level proof.
//
// Usage: node scripts/probe-offlineoutbox.mjs [--root <dir>]
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
console.log(`probe-offlineoutbox: serving ${ROOT} on ${BASE}`);

const problems = [];
const errors = [];
const ok = (cond, label) => {
  if (!cond) problems.push(label);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Signed-in shape so attempt()'s accessToken() answers from storage.
const REF = "ybddogqphinruyunnuwx";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SESSION = {
  access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u-seed", role: "authenticated" })}.sig`,
  refresh_token: "rt-probe",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: "u-seed", email: "probe@example.com", aud: "authenticated",
    role: "authenticated", app_metadata: {}, user_metadata: {},
  },
};

// Wire accounting for the two send RPCs only. Everything else gets a canned
// answer so boot noise cannot touch these counters.
let sendMode = "answer"; // or "hang"
const held = [];          // hung routes awaiting release
const sent = [];          // { name, body(raw string), auth, apikey }
function releaseAll() {
  const pending = held.splice(0);
  for (const route of pending) {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "r-hang", seq: 1, channel_id: "cA" }]) }).catch(() => {});
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.route("**/rest/v1/**", (route) => {
  const u = new URL(route.request().url());
  const seg = u.pathname.split("/");
  if (seg[seg.length - 2] === "rpc") {
    const name = seg[seg.length - 1];
    if (name === "send_message" || name === "send_dm") {
      const hs = route.request().headers();
      sent.push({
        name,
        body: route.request().postData() || "",
        auth: hs["authorization"] || "",
        apikey: hs["apikey"] || hs["api-key"] || "",
      });
      if (sendMode === "hang") { held.push(route); return; }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "r-" + sent.length, seq: sent.length, channel_id: "cA" }]),
      });
    }
    let body = "null";
    if (name === "must_set_password") body = "false";
    else if (name.startsWith("get_")) body = "[]";
    return route.fulfill({ status: 200, contentType: "application/json", body });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
});
await context.routeWebSocket("**/realtime/v1/websocket*", () => {});

async function idbRows(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open("Dek-outbox");
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction("sends", "readonly");
        const req = tx.objectStore("sends").getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); resolve([]); };
      } catch { db.close(); resolve([]); }
    };
    open.onerror = () => resolve([]);
  }));
}

try {
  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(String(e)));
  errors.push(...pageerrors.map((m, i) => `p${i}: ${m}`));

  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [`sb-${REF}-auth-token`, JSON.stringify(SESSION)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const booted = await Promise.race([
    page.waitForEvent("console", { predicate: (m) => /features loaded/.test(m.text()), timeout: 45_000 }).then(() => true),
    sleep(45_000).then(() => false),
  ]);
  ok(booted, "setup: app reached the features-loaded boot line within 45s");
  if (!booted) throw new Error("boot never completed");

  // Baseline: boot noise pays zero send RPCs.
  ok(sent.length === 0, `setup: zero send_message/send_dm POSTs during boot (saw ${sent.length})`);
  ok((await idbRows(page)).length === 0, "setup: outbox starts empty");

  const ARGS1 = { p_channel: "cA", p_body_text: "field report one", p_client_msg_id: "n1", p_attachments: [{ key: "k1" }], p_reply_to: null, p_also_send: false };
  const ARGS2 = { p_channel: "cA", p_body_text: "field report two", p_client_msg_id: "n2", p_attachments: [], p_reply_to: null, p_also_send: false };
  const ARGS3 = { p_channel: "cA", p_body_text: "in flight three", p_client_msg_id: "n3", p_attachments: [], p_reply_to: null, p_also_send: false };

  // ---- LEG B (first, empty queue): the disk write precedes the wire ----
  sendMode = "hang";
  const legBPromise = page.evaluate(async (a3) => {
    const { rpc } = await import("/js/api.js");
    try { await rpc("send_message", a3); return "resolved"; }
    catch (e) { return "rejected:" + (e && e.name); }
  }, ARGS3);
  let sawWire = false;
  for (let i = 0; i < 100 && !sawWire; i++) { await sleep(100); sawWire = sent.length > 0; }
  ok(sawWire, "leg B: hung send reached the wire");
  ok(held.length === 1, `leg B: exactly ONE request is ours and hung (held ${held.length} - more would mean tick interference)`);
  const rowsWhileHung = await idbRows(page);
  const n3WhileHung = rowsWhileHung.find((r) => r.nonce === "n3");
  ok(!!n3WhileHung && held.length === 1,
    `leg B: n3 already on disk WHILE the request is still hung (rows ${rowsWhileHung.map((r) => r.nonce).join(",")})`);
  releaseAll();
  const legB = await legBPromise;
  ok(legB === "resolved", `leg B: released send resolved (${legB})`);
  let droppedN3 = false;
  for (let i = 0; i < 30; i++) { await sleep(100); if (!(await idbRows(page)).some((r) => r.nonce === "n3")) { droppedN3 = true; break; } }
  ok(droppedN3, "leg B: successful send removed n3 from disk");

  // ---- LEG A: offline send queues to disk, costs the wire nothing ----
  sent.length = 0;
  await context.setOffline(true);
  const legA = await page.evaluate(async ([a1, a2]) => {
    const { rpc } = await import("/js/api.js");
    const outcomes = [];
    for (const args of [a1, a2]) {
      try { await rpc("send_message", args); outcomes.push("resolved"); }
      catch (e) { outcomes.push("rejected:" + (e && e.name)); }
    }
    const bar = document.getElementById("obBar");
    return { outcomes, barOn: bar ? bar.classList.contains("on") : false,
      barDown: bar ? bar.classList.contains("ob-down") : false,
      barText: bar ? bar.textContent : "" };
  }, [ARGS1, ARGS2]);
  ok(legA.outcomes.every((o) => o.startsWith("rejected")), `leg A: both offline sends rejected, none resolved (${legA.outcomes.join(" | ")})`);
  ok(sent.length === 0, `leg A: zero send POSTs hit the wire while offline (saw ${sent.length})`);
  const rowsA = await idbRows(page);
  ok(rowsA.length === 2, `leg A: exactly two rows in raw IndexedDB (saw ${rowsA.length})`);
  const byNonce = new Map(rowsA.map((r) => [r.nonce, r]));
  ok(byNonce.get("n1")?.kind === "channel" && byNonce.get("n1")?.scope_id === "cA"
    && byNonce.get("n1")?.state === "queued", "leg A: n1 row queued for channel cA");
  ok(byNonce.get("n2")?.kind === "channel" && byNonce.get("n2")?.state === "queued", "leg A: n2 row queued");
  let parsedOk = true;
  try {
    const b1 = JSON.parse(byNonce.get("n1").body);
    const b2 = JSON.parse(byNonce.get("n2").body);
    parsedOk = b1.p_client_msg_id === "n1" && b1.p_body_text === ARGS1.p_body_text
      && JSON.stringify(b1.p_attachments) === JSON.stringify(ARGS1.p_attachments)
      && b2.p_client_msg_id === "n2" && b2.p_body_text === ARGS2.p_body_text;
  } catch { parsedOk = false; }
  ok(parsedOk, "leg A: stored bodies carry the verbatim fields incl. attachments array");
  ok(legA.barOn && legA.barDown && /will send when you are back/.test(legA.barText),
    `leg A: obBar painted ob-down plain-language state ("${legA.barText.trim().slice(0, 60)}...")`);

  // ---- LEG C: reconnect flushes oldest-first under ORIGINAL nonces ----
  sendMode = "answer";
  sent.length = 0;
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  let flushedTwo = false;
  for (let i = 0; i < 100; i++) { await sleep(100); if (sent.length >= 2) { flushedTwo = true; break; } }
  ok(flushedTwo, `leg C: flush paid the two queued posts (saw ${sent.length} so far)`);
  await sleep(800); // let the serial loop finish, then require the count FROZEN
  ok(sent.length === 2, `leg C: EXACTLY two send POSTs flushed (saw ${sent.length})`);
  console.log("  [legC captures] " + JSON.stringify(sent.map((s) => {
    let nonce = "?"; try { nonce = JSON.parse(s.body).p_client_msg_id; } catch {}
    return { name: s.name, nonce, auth: s.auth.slice(0, 24), apikey: s.apikey.slice(0, 16) };
  })));
  let orderOk = false, verbatimOk = false, headersOk = false;
  try {
    const b0 = JSON.parse(sent[0].body);
    const b1 = JSON.parse(sent[1].body);
    orderOk = b0.p_client_msg_id === "n1" && b1.p_client_msg_id === "n2";
    verbatimOk = b0.p_body_text === ARGS1.p_body_text
      && JSON.stringify(b0.p_attachments) === JSON.stringify(ARGS1.p_attachments)
      && b1.p_body_text === ARGS2.p_body_text;
  } catch { /* keep false */ }
  ok(orderOk, "leg C: replay went out OLDEST FIRST as original nonces [n1, n2] (fresh nonces would mean double-posts)");
  ok(verbatimOk, "leg C: replayed bodies field-identical to the queued originals");
  headersOk = sent.every((s) => /^Bearer\s+.+/.test(s.auth)) && sent.every((s) => s.apikey.length > 0);
  ok(headersOk, "leg C: flush minted Authorization at replay time and carried apikey");
  const rowsEnd = await idbRows(page);
  ok(rowsEnd.length === 0, `leg C: raw IndexedDB ends EMPTY after successful flush (saw ${rowsEnd.length})`);

  ok(pageerrors.length === 0, `zero pageerror across the whole run (saw ${pageerrors.length}${pageerrors.length ? ": " + pageerrors[0] : ""})`);
} catch (e) {
  problems.push(`setup failure: ${e.message}`);
} finally {
  releaseAll();
}

await browser.close();
server.close();

if (problems.length || errors.length) {
  console.log("\nPROBE FAILED");
  for (const p of problems) console.log("  PROBLEM: " + p);
  for (const e of errors) console.log("  ERROR: " + e);
  process.exit(1);
}
console.log("\nPROBE CLEAN exit 0");
process.exit(0);
