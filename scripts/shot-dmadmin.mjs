// Pictures of the three things 0120 changed, in every theme, at phone and
// laptop width. Not a pass/fail probe - the probes next to it are that. This is
// for looking at: a badge is a colour and a size decision and neither survives
// being asserted about.
//
//   shots/dmadmin-<theme>-<width>-dmpanel.png   the DMs panel: search, New
//                                               message, conversations, and a
//                                               person you have never written to
//   shots/dmadmin-<theme>-<width>-messages.png  message rows with Owner, Admin,
//                                               Moderator and no pill at all
//   shots/dmadmin-<theme>-<width>-reactions.png a DM message carrying reactions
//
// Usage: node scripts/shot-dmadmin.mjs [--out shots]
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--out") args.out = process.argv[++i];
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, args.out || "shots");
fs.mkdirSync(OUT, { recursive: true });

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

const BADGES = [
  { user_id: "u-me", member_type: "member", is_admin: false, is_owner: false },
  { user_id: "u-priyanka", member_type: "member", is_admin: true, is_owner: true },
  { user_id: "u-aashika", member_type: "member", is_admin: true, is_owner: false },
  { user_id: "u-sourabh", member_type: "member", is_admin: true, is_owner: false },
  { user_id: "u-mehak", member_type: "moderator", is_admin: false, is_owner: false },
  { user_id: "u-dev", member_type: "member", is_admin: false, is_owner: false },
  { user_id: "u-bhavna", member_type: "member", is_admin: false, is_owner: false },
];

const browser = await chromium.launch();
const shots = [];
try {
  for (const [w, h, tag] of [[420, 780, "phone"], [1280, 860, "laptop"]]) {
    const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await context.route("**/rest/v1/rpc/get_member_badges", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(BADGES) }));
    await context.route("**/rest/v1/**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "[]" }));
    const page = await context.newPage();
    let ready;
    const line = new Promise((r) => { ready = r; });
    page.on("console", (m) => { if (/features loaded/.test(m.text())) ready(); });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await Promise.race([line, sleep(45_000)]);

    await page.evaluate(async (badges) => {
      const s = await import("/js/store.js");
      const msgs = await import("/js/core/messages.js");
      const ui = await import("/js/ui.js");
      window.__p = { s, msgs, ui };
      const { store, setBadges } = s;
      store.me = "u-me";
      store.myProfile = { id: "u-me", display_name: "Me" };
      store.ws = { id: "ws-1", name: "Jarurat Care" };
      for (const p of [
        { id: "u-me", display_name: "Me", username: "me" },
        { id: "u-priyanka", display_name: "Priyanka Joshi", username: "priyanka" },
        { id: "u-aashika", display_name: "Aashika Aggarwal", username: "aashika" },
        { id: "u-sourabh", display_name: "Sourabh Singh", username: "sourabh" },
        { id: "u-mehak", display_name: "Mehak Pahwa", username: "mehak" },
        { id: "u-dev", display_name: "Dev Kumar", username: "dev" },
        { id: "u-bhavna", display_name: "Bhavna Shah", username: "bhavna" },
      ]) store.profiles.set(p.id, p);
      setBadges(badges);
      store.online = new Set(["u-aashika", "u-bhavna"]);
      const mins = (n) => new Date(Date.now() - n * 60000).toISOString();
      store.dms = [
        { conversation_id: "c1", other_user_ids: ["u-aashika", "u-me"], last_message_at: mins(3), unread: 2 },
        { conversation_id: "c2", other_user_ids: ["u-mehak", "u-me"], last_message_at: mins(41), unread: 0 },
        { conversation_id: "c3", other_user_ids: ["u-dev", "u-me"], last_message_at: mins(190), unread: 0 },
      ];
      // Show the shell. Signed out, index.html keeps #chat hidden and #auth
      // visible; nothing here signs in, so the two are swapped by hand. The
      // surfaces below are the app's own, painted by its own modules.
      document.getElementById("auth")?.classList.add("hidden");
      document.getElementById("chat")?.classList.remove("hidden");
    }, BADGES);

    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => {
        document.documentElement.setAttribute("data-mode", t);
        document.documentElement.setAttribute("data-scheme", t);
      }, theme);

      // --- the DMs panel, mid-search, showing both kinds of row ---
      await page.evaluate(() => window.__p.ui.openPanel("dms"));
      await page.waitForSelector("#panelContent .dmsearch", { state: "attached", timeout: 5000 });
      await page.$eval("#panelContent .dmsearch", (n) => {
        n.value = "a"; n.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(300);
      let out = path.join(OUT, `dmadmin-${theme}-${tag}-dmpanel.png`);
      await page.locator("#panel").screenshot({ path: out });
      shots.push(out);

      // --- message rows with all three pills and one without ---
      await page.evaluate(() => {
        window.__p.ui.closePanel();
        const host = document.getElementById("messages");
        host.innerHTML = "";
        const at = (n) => new Date(Date.now() - n * 60000).toISOString();
        const lines = [
          ["u-priyanka", "Board pack goes out Friday - shout if anything is still missing.", 30],
          ["u-aashika", "I have the nutrition numbers. Sending them over now.", 24],
          ["u-sourabh", "Can somebody give Bhavna access to the navigator?", 18],
          ["u-mehak", "Done. Added her this morning.", 12],
          ["u-dev", "Thanks both - I will pick up the rest after standup.", 6],
        ];
        lines.forEach(([who, text, ago], i) => host.appendChild(window.__p.msgs.buildMessage(
          { id: "s" + i, author_id: who, body_text: text, created_at: at(ago), seq: i + 1 },
          { context: "channel" })));
      });
      await sleep(200);
      out = path.join(OUT, `dmadmin-${theme}-${tag}-messages.png`);
      await page.locator("#messages").screenshot({ path: out });
      shots.push(out);

      // --- a DM carrying reactions, which is the thing that used to refuse ---
      await page.evaluate(() => {
        const host = document.getElementById("messages");
        host.innerHTML = "";
        const at = (n) => new Date(Date.now() - n * 60000).toISOString();
        host.appendChild(window.__p.msgs.buildMessage(
          { id: "d1", author_id: "u-aashika", body_text: "Nutrition figures are in the sheet now.", created_at: at(9), seq: 1 },
          { context: "dm" }));
        host.appendChild(window.__p.msgs.buildMessage(
          { id: "d2", author_id: "u-me", body_text: "Perfect, thank you.", created_at: at(7), seq: 2 },
          { context: "dm" }));
        for (const [id, e, u] of [["d1", "👍", "u-me"], ["d1", "🎉", "u-mehak"], ["d1", "🎉", "u-me"], ["d2", "❤️", "u-aashika"]]) {
          window.__p.msgs.applyReaction({ message_id: id, emoji: e, user_id: u, added: true });
        }
      });
      await sleep(200);
      out = path.join(OUT, `dmadmin-${theme}-${tag}-reactions.png`);
      await page.locator("#messages").screenshot({ path: out });
      shots.push(out);
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
for (const s of shots) console.log("wrote", path.relative(ROOT, s));
