// The Later board, at phone width, in both themes, in all three views.
// This one is for looking at: the ask was "very very very clean UX" and no
// assertion measures that.
//
// Usage: node scripts/shot-laterboard.mjs [--out shots]
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

const MINE = [
  { id: "t1", channel_id: "ch-1", message_id: "m1", title: "Send the board pack to Priyanka",
    assignee_id: "u-me", created_by: "u-lead", state: "accepted", due_at: iso(NOW - 864e5),
    done_at: null, channel_name: "founders-office", body_text: "Send the board pack to Priyanka" },
  { id: "t2", channel_id: "ch-1", message_id: "m2", title: "Confirm the Thursday nutrition session",
    assignee_id: "u-me", created_by: "u-lead", state: "accepted", due_at: iso(NOW + 6 * 36e5),
    done_at: null, channel_name: "nutrition", body_text: "Confirm the Thursday nutrition session" },
  { id: "t3", channel_id: "ch-1", message_id: "m3", title: "Update the volunteer roster",
    assignee_id: "u-me", created_by: "u-me", state: "in_progress", due_at: null, done_at: null,
    channel_name: "hr", body_text: "Update the volunteer roster" },
];
const GRABS = [
  { id: "g1", channel_id: "ch-1", message_id: "mg1", title: "Call the twelve patients from Tuesday",
    assignee_id: null, created_by: "u-lead", state: "accepted", due_at: iso(NOW + 2 * 864e5),
    done_at: null, channel_name: "founders-office", body_text: "" },
  { id: "g2", channel_id: "ch-1", message_id: "mg2", title: "Book the venue for the caregiver meetup",
    assignee_id: null, created_by: "u-neha", state: "accepted", due_at: null, done_at: null,
    channel_name: "events", body_text: "" },
];
const WORKLOAD = {
  people: [
    { user_id: "u-neha", open: 4, doing: 1, blocked: 0, overdue: 2, done_7d: 3 },
    { user_id: "u-sourabh", open: 2, doing: 1, blocked: 1, overdue: 0, done_7d: 1 },
    { user_id: "u-mehak", open: 1, doing: 0, blocked: 0, overdue: 0, done_7d: 5 },
  ],
  unclaimed: 2, blocked: 1, overdue: 2, done_7d: 9,
};
const LATER = MINE.map((t) => ({ message_id: t.message_id, state: "todo", remind_at: null,
  created_at: iso(NOW - 36e5), body_text: t.title, channel_id: t.channel_id,
  channel_name: t.channel_name, workspace_id: "w1" }))
  .concat([{ message_id: "m9", state: "todo", remind_at: null, created_at: iso(NOW - 6e5),
    body_text: "Worth reading before the board call", channel_id: "ch-1",
    channel_name: "founders-office", workspace_id: "w1" }]);

const browser = await chromium.launch();
const shots = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  await ctx.route("**/rest/v1/**", (r) => r.fulfill(json([])));
  await ctx.route("**/rest/v1/rpc/list_tasks", (r) => {
    let f = "mine";
    try { f = JSON.parse(r.request().postData() || "{}").p_filter || "mine"; } catch {}
    return r.fulfill(json(f === "unclaimed" ? GRABS : f === "mine" ? MINE : []));
  });
  await ctx.route("**/rest/v1/rpc/team_workload", (r) => r.fulfill(json(WORKLOAD)));
  await ctx.route("**/rest/v1/rpc/get_later", (r) => r.fulfill(json(LATER)));

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
      { id: "u-neha", display_name: "Neha Sharma" }, { id: "u-sourabh", display_name: "Sourabh Singh" },
      { id: "u-mehak", display_name: "Mehak Pahwa" },
    ]) store.profiles.set(p.id, p);
    store.channels = [
      { id: "ch-1", name: "founders-office", kind: "text", position: 1 },
      { id: "ch-2", name: "nutrition", kind: "text", position: 2 },
      { id: "ch-3", name: "events", kind: "text", position: 3 },
    ];
    store.current = store.channels[0];
    localStorage.removeItem("dak.later.intro");
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  });

  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-mode", t);
      document.documentElement.setAttribute("data-scheme", t);
    }, theme);
    for (const view of ["mine", "team", "grabs"]) {
      await page.evaluate((v) => window.__p.ui.openPanel("later", { view: v }), view);
      await page.waitForSelector("#panelContent .later-seg", { state: "attached", timeout: 6000 });
      await sleep(350);
      const out = path.join(OUT, `later-${theme}-${view}.png`);
      await page.locator("#panel").screenshot({ path: out });
      shots.push(out);
    }
    // And the dialog that did not exist.
    await page.evaluate((v) => window.__p.ui.openPanel("later", { view: v }), "mine");
    await sleep(300);
    await page.evaluate(() => document.querySelector("#panelContent .later-new").click());
    await page.waitForSelector(".modal form", { state: "attached", timeout: 5000 });
    await sleep(300);
    const out = path.join(OUT, `later-${theme}-newtask.png`);
    await page.locator(".modal").screenshot({ path: out });
    shots.push(out);
    await page.evaluate(() => document.querySelector(".modal .modal-head button.icon")?.click());
    await sleep(200);
  }
} finally {
  await browser.close();
  server.close();
}
for (const s of shots) console.log("wrote", path.relative(ROOT, s));
