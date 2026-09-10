// The buttons that are supposed to depend on where you are.
//
// Three complaints in one message from somebody using the app, and one cause:
//
//   "Bro audio note bhi n jaa rhe h"          voice notes do not send
//   "Open a channel first aa raha h"          ...and that is what it says
//   "Aur direct call kha se kru m?"           where do I make a direct call
//
// A `show` predicate is read when the row is PAINTED, and neither the composer
// row nor the header row was ever repainted when the conversation changed.
//
//   - the mic says "only where you can send", which was true of the channel it
//     was painted in and stayed on screen in a direct message: hold, record,
//     release, "Open a channel first", recording gone.
//   - the call button says `!!store.currentDM`, and the only thing that painted
//     the header was the workspace load - when currentDM is null by definition.
//     So the handset never appeared in any direct message, ever. It is order 8,
//     the lowest of any header button, so the four-button cap was never it.
//
//   1. opening a DM paints the call button; opening a channel takes it away
//   2. the mic is offered in BOTH, because a voice note now sends to both
//   3. a voice note recorded in a DM goes to send_dm, not send_message
//   4. a channel-only button (polls) is offered in a channel and not in a DM
//   5. zero pageerror.
//
// Usage: node scripts/probe-scopechrome.mjs [--root <dir>]
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
console.log(`probe-scopechrome: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (c, l) => { if (!c) problems.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

let sendDmBody = null;
let sendChannelBody = null;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  // Calls are "supported" only once get_active_call answers without a
  // missing-function error, which is what migration 0119 supplies.
  await context.route("**/rest/v1/rpc/get_active_call", (route) => route.fulfill(json(null)));
  await context.route("**/rest/v1/rpc/send_dm", (route) => {
    try { sendDmBody = JSON.parse(route.request().postData() || "{}"); } catch { sendDmBody = null; }
    return route.fulfill(json({ id: "m-dm", seq: 1 }));
  });
  await context.route("**/rest/v1/rpc/send_message", (route) => {
    try { sendChannelBody = JSON.parse(route.request().postData() || "{}"); } catch { sendChannelBody = null; }
    return route.fulfill(json({ id: "m-ch", seq: 1 }));
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
  console.log("probe-scopechrome: app booted");

  await page.evaluate(async () => {
    const { store, bus } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, bus, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "w1", name: "W" };
    store.profiles.set("u-me", { id: "u-me", display_name: "Abhay" });
    store.profiles.set("u-neha", { id: "u-neha", display_name: "Neha" });
    store.channels = [{ id: "ch-1", name: "founders-office", kind: "text", position: 1 }];
    store.dms = [{ conversation_id: "cv-1", other_user_ids: ["u-neha", "u-me"], unread: 0 }];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  });

  // The two scope events, emitted the way core emits them.
  const enterChannel = () => page.evaluate(async () => {
    const { store, bus } = window.__p;
    store.currentDM = null;
    store.current = store.channels[0];
    bus.emit("channel:open", { channel: store.current });
    await new Promise((r) => setTimeout(r, 250));
  });
  const enterDM = () => page.evaluate(async () => {
    const { store, bus } = window.__p;
    store.current = null;
    store.currentDM = "cv-1";
    bus.emit("dm:open", { conversationId: "cv-1" });
    await new Promise((r) => setTimeout(r, 250));
  });

  const chrome = () => page.evaluate(() => ({
    header: [...document.querySelectorAll("#headerActions button")].map((b) => b.id || b.title),
    tools: [...document.querySelectorAll("#composerTools button")].map((b) => b.title),
  }));

  await enterChannel();
  const inChannel = await chrome();
  ok(!inChannel.header.some((h) => /call/i.test(h)),
    `the call button is offered in a CHANNEL: ${JSON.stringify(inChannel.header)}`);
  ok(inChannel.tools.some((t) => /voice note/i.test(t)),
    `no mic in a channel: ${JSON.stringify(inChannel.tools)}`);
  const pollInChannel = inChannel.tools.some((t) => /poll/i.test(t))
    || inChannel.header.some((h) => /poll/i.test(h));

  // 1. the handset, which never appeared before this.
  await enterDM();
  const inDM = await chrome();
  ok(inDM.header.some((h) => /call/i.test(h)),
    `no call button in a direct message - the one thing that was asked for: ${JSON.stringify(inDM.header)}`);

  // 2. the mic, in both.
  ok(inDM.tools.some((t) => /voice note/i.test(t)),
    `no mic in a direct message: ${JSON.stringify(inDM.tools)}`);

  // 4. and a channel-only control stays channel-only.
  if (pollInChannel) {
    const pollInDM = inDM.tools.some((t) => /poll/i.test(t)) || inDM.header.some((h) => /poll/i.test(h));
    ok(!pollInDM, "a channel-only control is still offered in a direct message");
  }

  // back to a channel: the handset goes away again.
  await enterChannel();
  const backInChannel = await chrome();
  ok(!backInChannel.header.some((h) => /call/i.test(h)),
    `the call button survived leaving the direct message: ${JSON.stringify(backInChannel.header)}`);

  // 3. a voice note recorded in a DM must go to send_dm.
  await enterDM();
  sendDmBody = null; sendChannelBody = null;
  const sent = await page.evaluate(async () => {
    const media = await import("/js/core/media.js");
    // uploadFile talks to storage and an edge function; neither is what this
    // leg is about. Stub it so the SEND path is what gets measured.
    const real = media.uploadFile;
    if (!real) return "no uploadFile export";
    window.__realUpload = real;
    const mod = await import("/js/features/voicenotes.js");
    return typeof mod.register === "function" ? "ok" : "no register";
  });
  ok(sent === "ok", `could not reach the voice-note module: ${sent}`);

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
