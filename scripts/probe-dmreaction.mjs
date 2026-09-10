// Reacting to a message in a direct message.
//
// Reported: "when someone sends me a DM, a smiley option appears on the message,
// but using it shows an error saying I am not allowed to perform this action."
// Both halves were true. DMs share buildMessage() with channels, so the picker
// has always been drawn on them; public.toggle_reaction only ever looked in
// public.messages, so a DM message id resolved to no channel and fell into the
// same branch as "you may not see that channel". The reaction has never once
// been stored, in any build.
//
// 0120 adds public.dm_message_reactions and teaches toggle_reaction to route by
// which table the id lives in. This probe covers the client half - that the
// right table is READ for each surface, that the RPC is called, and that a
// refusal now says something a person can act on:
//
//   1. a DM's existing reactions are read from dm_message_reactions and painted
//   2. a channel's are still read from message_reactions - one table each, never
//      both, because the healing sweep in presence.js runs every nine seconds
//   3. tapping a reaction in a DM calls toggle_reaction with that message id,
//      and paints optimistically before the server answers
//   4. a server refusal rolls the optimistic paint back and says why in words,
//      and a block is worded as a block rather than as a general refusal
//   5. the reaction broadcast on the dm: topic lands on the row
//   6. zero pageerror.
//
// Usage: node scripts/probe-dmreaction.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--root") args.root = process.argv[++i];
}
const ROOT = path.resolve(args.root || path.dirname(fileURLToPath(import.meta.url)), args.root ? "." : "..");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png",
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
console.log(`probe-dmreaction: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

let dmTableReads = 0;
let chTableReads = 0;
let toggleBody = null;
let toggleFails = false;
let toggleCode = null;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 780 } });
  await context.route("**/rest/v1/dm_message_reactions**", (route) => {
    dmTableReads++;
    return route.fulfill({ status: 200, contentType: "application/json", headers: CORS,
      body: JSON.stringify([{ message_id: "dm1", emoji: "❤️", user_id: "u-alice" }]) });
  });
  await context.route("**/rest/v1/message_reactions**", (route) => {
    chTableReads++;
    return route.fulfill({ status: 200, contentType: "application/json", headers: CORS,
      body: JSON.stringify([{ message_id: "ch1", emoji: "🎉", user_id: "u-alice" }]) });
  });
  await context.route("**/rest/v1/rpc/toggle_reaction", (route) => {
    try { toggleBody = JSON.parse(route.request().postData() || "{}"); } catch { toggleBody = null; }
    if (toggleCode) {
      return route.fulfill({ status: 403, contentType: "application/json", headers: CORS,
        body: JSON.stringify({ code: "42501", message: toggleCode }) });
    }
    if (toggleFails) {
      return route.fulfill({ status: 403, contentType: "application/json", headers: CORS,
        body: JSON.stringify({ code: "42501", message: "forbidden" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "true" });
  });
  for (const pat of ["**/rest/v1/rpc/get_unread", "**/rest/v1/rpc/get_dm_unread",
    "**/rest/v1/rpc/get_space_summary"]) {
    await context.route(pat, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "[]" }));
  }

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (err) => pageerrors.push(err.message));

  let featuresLoaded;
  const bootedLine = new Promise((r) => { featuresLoaded = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) featuresLoaded(); });
  const booted = Promise.race([bootedLine.then(() => true), sleep(45_000).then(() => false)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  ok(await booted, "app never reached the features-loaded boot line within 45s");
  if (problems.length) throw new Error(problems.join("; "));
  console.log("probe-dmreaction: app booted");

  // One DM row and one channel row, both really built by buildMessage and both
  // hung in #messages where paintReactions looks for them.
  await page.evaluate(async () => {
    const s = await import("/js/store.js");
    const msgs = await import("/js/core/messages.js");
    window.__p = { s, msgs, toasts: [] };
    const { store } = s;
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Me" };
    store.ws = { id: "ws-1", name: "W" };
    store.profiles.set("u-me", { id: "u-me", display_name: "Me" });
    store.profiles.set("u-alice", { id: "u-alice", display_name: "Alice" });
    const host = document.getElementById("messages");
    host.innerHTML = "";
    const at = new Date().toISOString();
    host.appendChild(msgs.buildMessage(
      { id: "dm1", author_id: "u-alice", body_text: "in a dm", created_at: at, seq: 1 }, { context: "dm" }));
    host.appendChild(msgs.buildMessage(
      { id: "ch1", author_id: "u-alice", body_text: "in a channel", created_at: at, seq: 1 }, { context: "channel" }));
    // The refusal copy only exists on screen, as a toast.
    window.__p.readToasts = () => [...document.querySelectorAll(".toast, #toasts > *")]
      .map((n) => n.textContent.trim());
  });

  // 1. the DM's reactions come from dm_message_reactions.
  await page.evaluate(() => window.__p.msgs.loadReactions(["dm1"], "dm"));
  await sleep(300);
  ok(dmTableReads === 1, `reading a DM's reactions hit dm_message_reactions ${dmTableReads} times, expected 1`);
  ok(chTableReads === 0, `reading a DM's reactions also hit message_reactions ${chTableReads} times`);
  let painted = await page.$eval('[data-rx="dm1"]', (n) => n.textContent.replace(/\s+/g, " ").trim());
  ok(/❤/.test(painted), `the DM's existing reaction was not painted: "${painted}"`);

  // 2. the channel's still come from message_reactions.
  dmTableReads = 0;
  await page.evaluate(() => window.__p.msgs.loadReactions(["ch1"]));
  await sleep(300);
  ok(chTableReads === 1, `reading a channel's reactions hit message_reactions ${chTableReads} times, expected 1`);
  ok(dmTableReads === 0, `reading a channel's reactions also hit dm_message_reactions ${dmTableReads} times`);

  // 3. tapping one in a DM calls the RPC, and paints before the answer.
  toggleBody = null;
  await page.evaluate(() => window.__p.msgs.toggleReaction("dm1", "👍"));
  await sleep(400);
  ok(!!toggleBody, "reacting in a DM did not call toggle_reaction at all");
  ok(toggleBody?.p_message === "dm1" && toggleBody?.p_emoji === "👍",
    `toggle_reaction was called with ${JSON.stringify(toggleBody)}`);
  painted = await page.$eval('[data-rx="dm1"]', (n) => n.textContent.replace(/\s+/g, " ").trim());
  ok(/👍/.test(painted), `the new reaction is not on the row: "${painted}"`);
  const mine = await page.$$eval('[data-rx="dm1"] .rxn.mine', (ns) => ns.map((n) => n.textContent.trim()));
  ok(mine.some((t) => /👍/.test(t)), `the reaction is not marked as mine: ${JSON.stringify(mine)}`);

  // 4. a refusal rolls back and explains itself.
  toggleFails = true;
  await page.evaluate(() => window.__p.msgs.toggleReaction("dm1", "🎉"));
  await sleep(600);
  painted = await page.$eval('[data-rx="dm1"]', (n) => n.textContent.replace(/\s+/g, " ").trim());
  ok(!/🎉/.test(painted), `a refused reaction stayed painted: "${painted}"`);
  let toastText = await page.evaluate(() => (window.__p.readToasts() || []).join(" | "));
  // A sentence, not the server's word. "forbidden" on a button the app itself
  // drew is the report this whole change came from.
  ok(/cannot react|refused|not switched on|removed from this conversation/i.test(toastText),
    `a refusal shows something other than an explanation: "${toastText}"`);
  ok(!/forbidden|42501/i.test(toastText), `the raw server error leaked into the toast: "${toastText}"`);

  // 'blocked' is its own outcome (0121/0123: somebody who has blocked you does
  // not receive your reactions) and must not be worded as a general refusal.
  await page.evaluate(() => { window.__p.readToasts().length; });
  toggleCode = "blocked";
  await page.evaluate(() => window.__p.msgs.toggleReaction("dm1", "😂"));
  await sleep(600);
  toastText = await page.evaluate(() => (window.__p.readToasts() || []).join(" | "));
  ok(/cannot react in this conversation/i.test(toastText),
    `a block is not worded as one: "${toastText}"`);
  toggleCode = null;
  toggleFails = false;

  // 5. somebody else's reaction arriving over the dm: topic lands on the row.
  await page.evaluate(() => window.__p.msgs.applyReaction(
    { message_id: "dm1", emoji: "👀", user_id: "u-alice", added: true }));
  await sleep(150);
  painted = await page.$eval('[data-rx="dm1"]', (n) => n.textContent.replace(/\s+/g, " ").trim());
  ok(/👀/.test(painted), `a broadcast reaction did not land: "${painted}"`);

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
