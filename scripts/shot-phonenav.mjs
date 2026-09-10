// The phone drawer after the server rail was taken out of it.
//
// Reported: "on the phone view the left bar - the server bar - is not necessary,
// I can only see the alphabet of the team, it is so much not helpful. Better to
// not show that; I click the top left corner and go to the server and channel
// from that view itself."
//
// So: no rail under 860px, and a Servers section at the top of the drawer with
// full names. This takes the picture, at phone width, in both themes.
//
// Usage: node scripts/shot-phonenav.mjs [--out shots]
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

const browser = await chromium.launch();
const shots = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 820 }, deviceScaleFactor: 2 });
  await ctx.route("**/rest/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "[]" }));
  const page = await ctx.newPage();
  let ready;
  const line = new Promise((r) => { ready = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) ready(); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await Promise.race([line, sleep(45_000)]);

  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const ch = await import("/js/core/channels.js");
    window.__p = { store, ch };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.orgs = [
      { org_id: "o-jcf", name: "Jarurat Care Foundation" },
      { org_id: "o-ss", name: "Safalta Setu" },
    ];
    store.spaces = [
      { id: "w-jcf", org_id: "o-jcf", name: "Jarurat Care" },
      { id: "w-hr", org_id: "o-jcf", name: "HR PsyConnect" },
      { id: "w-design", org_id: "o-jcf", name: "Design" },
      { id: "w-ss", org_id: "o-ss", name: "Safalta Setu" },
    ];
    store.spaceBadges = new Map([["w-hr", { unread_total: 4, mention_total: 2 }], ["w-design", { unread_total: 1 }]]);
    store.ws = store.spaces[0];
    store.categories = [{ id: "c-1", name: "General", position: 1 }];
    store.channels = [
      { id: "ch-1", name: "announcements", kind: "announcement", category_id: "c-1", position: 1 },
      { id: "ch-2", name: "founders-office", kind: "text", category_id: "c-1", position: 2 },
      { id: "ch-3", name: "nutrition", kind: "text", category_id: "c-1", position: 3 },
      { id: "ch-4", name: "standup", kind: "voice", position: 4 },
    ];
    store.current = store.channels[1];
    store.unread = new Map([["ch-1", { unread: true, mention_count: 3 }]]);
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
    document.body.classList.add("nav-open");
    await ch.renderChannels();
  });
  await sleep(400);

  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-mode", t);
      document.documentElement.setAttribute("data-scheme", t);
    }, theme);
    await sleep(150);
    const out = path.join(OUT, `phonenav-${theme}.png`);
    await page.screenshot({ path: out });
    shots.push(out);
  }

  const railShown = await page.evaluate(() => {
    const r = document.getElementById("spaceRail");
    return r ? getComputedStyle(r).display : "missing";
  });
  console.log(`rail display at 420px: ${railShown}`);
  const rows = await page.$$eval("#channels .chan.srv .ch-name", (ns) => ns.map((n) => n.textContent.trim()));
  console.log(`server rows in the drawer: ${JSON.stringify(rows)}`);
} finally {
  await browser.close();
  server.close();
}
for (const s of shots) console.log("wrote", path.relative(ROOT, s));
