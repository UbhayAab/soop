// The Activity tab, phone width, both themes, All and Mentions.
// Usage: node scripts/shot-activity.mjs [--out shots]
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "--out") args.out = process.argv[++i];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, args.out || "shots");
fs.mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (e, b) => {
    if (e) { try { res.writeHead(404).end(); } catch {} return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };
const iso = (d) => new Date(d).toISOString();
const NOW = Date.now();

const ITEMS = [
  { kind: "mention", channel_id: "ch-1", message_id: "m1", actor_id: "u-lead", created_at: iso(NOW - 12 * 60000),
    snippet: "@abhay can you send the board pack before Friday", conversation_id: null,
    item_key: "k1", is_read: false, task_id: null, title: null },
  { kind: "dm_mention", channel_id: null, message_id: "m2", actor_id: "u-neha", created_at: iso(NOW - 95 * 60000),
    snippet: "@abhay are you taking the Tuesday calls or should I?", conversation_id: "cv1",
    item_key: "k2", is_read: false, task_id: null, title: null },
  { kind: "task", channel_id: "ch-1", message_id: "m3", actor_id: "u-lead", created_at: iso(NOW - 5 * 3600e3),
    snippet: "Call the twelve patients from Tuesday", conversation_id: null,
    item_key: "k3", is_read: false, task_id: "t1", title: "Call the twelve patients from Tuesday" },
  { kind: "dm", channel_id: null, message_id: "m4", actor_id: "u-mehak", created_at: iso(NOW - 26 * 3600e3),
    snippet: "morning, added Bhavna to the navigator", conversation_id: "cv2",
    item_key: "k4", is_read: false, task_id: null, title: null },
  { kind: "thread_reply", channel_id: "ch-1", message_id: "m5", actor_id: "u-sourabh", created_at: iso(NOW - 30 * 3600e3),
    snippet: "agreed, let us do it after the board call", conversation_id: null,
    item_key: "k5", is_read: true, task_id: null, title: null },
  { kind: "reaction", channel_id: "ch-1", message_id: "m6", actor_id: "u-neha", created_at: iso(NOW - 74 * 3600e3),
    snippet: "the volunteer roster is updated", conversation_id: null,
    item_key: "k6", is_read: true, task_id: null, title: null },
];

const browser = await chromium.launch();
const shots = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  await ctx.route("**/rest/v1/**", (r) => r.fulfill(json([])));
  await ctx.route("**/rest/v1/rpc/get_activity", (r) => {
    let b = {};
    try { b = JSON.parse(r.request().postData() || "{}"); } catch {}
    const rows = b.p_filter === "mentions"
      ? ITEMS.filter((i) => i.kind === "mention" || i.kind === "dm_mention") : ITEMS;
    return r.fulfill(json(rows));
  });
  await ctx.route("**/rest/v1/rpc/activity_unread", (r) =>
    r.fulfill(json({ total: 4, mentions: 2, dms: 2, tasks: 1 })));

  const page = await ctx.newPage();
  let ready; const line = new Promise((r) => { ready = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) ready(); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await Promise.race([line, sleep(45_000)]);

  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "w1", name: "Jarurat Care" };
    for (const p of [
      { id: "u-me", display_name: "Abhay" }, { id: "u-lead", display_name: "Priyanka Joshi" },
      { id: "u-neha", display_name: "Neha Sharma" }, { id: "u-mehak", display_name: "Mehak Pahwa" },
      { id: "u-sourabh", display_name: "Sourabh Singh" },
    ]) store.profiles.set(p.id, p);
    store.channels = [{ id: "ch-1", name: "founders-office", kind: "text", position: 1 }];
    localStorage.setItem("dak.notifyNudge", "off");
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  });

  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-mode", t);
      document.documentElement.setAttribute("data-scheme", t);
    }, theme);
    for (const f of ["all", "mentions"]) {
      await page.evaluate((x) => window.__p.ui.openPanel("activity", { filter: x }), f);
      await page.waitForSelector("#panelContent .act-bar", { state: "attached", timeout: 6000 });
      await sleep(350);
      const out = path.join(OUT, `activity-${theme}-${f}.png`);
      await page.locator("#panel").screenshot({ path: out });
      shots.push(out);
    }
  }
} finally {
  await browser.close();
  server.close();
}
for (const s of shots) console.log("wrote", path.relative(ROOT, s));
