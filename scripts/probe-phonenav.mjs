// The phone drawer picks the server as well as the channel.
//
// Reported: "on the phone view the left bar - the server bar - is not necessary.
// I can only see the alphabet of the team and it's so much not helpful, better
// to not show that. I click on the top left corner and go to the server and
// channel from that view itself."
//
// The rail is 44px of tiles carrying two letters each, permanently taking the
// left edge of a 390px screen, and two letters cannot tell one server from
// another. So under 860px it is gone, and renderChannels() draws a Servers
// section at the top of the drawer with full names - reading the rail's own
// computed display rather than a duplicated breakpoint, the same trick the DM
// section already uses for the tab bar.
//
//   1. at phone width the rail is display:none and the drawer lists every
//      server by NAME, grouped under its organisation
//   2. the active server is marked, and unread rolls up onto its row
//   3. tapping one switches to it and closes the drawer
//   4. at laptop width the rail is back and the drawer does NOT list servers -
//      two switchers side by side is the thing being removed, not a second copy
//   5. the Servers heading collapses and remembers, like a category
//   6. zero pageerror.
//
// Usage: node scripts/probe-phonenav.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
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
console.log(`probe-phonenav: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

const SEED = `
  const { store } = await import("/js/store.js");
  const ch = await import("/js/core/channels.js");
  window.__p = { store, ch };
  store.me = "u-me";
  store.myProfile = { id: "u-me", display_name: "Abhay" };
  store.orgs = [{ org_id: "o-jcf", name: "Jarurat Care Foundation" },
                { org_id: "o-ss", name: "Safalta Setu" }];
  store.spaces = [
    { id: "w-jcf", org_id: "o-jcf", name: "Jarurat Care" },
    { id: "w-hr",  org_id: "o-jcf", name: "HR PsyConnect" },
    { id: "w-ss",  org_id: "o-ss",  name: "Safalta Setu" },
  ];
  store.spaceBadges = new Map([["w-hr", { unread_total: 4, mention_total: 2 }]]);
  store.ws = store.spaces[0];
  store.categories = [{ id: "c-1", name: "General", position: 1 }];
  store.channels = [{ id: "ch-1", name: "founders-office", kind: "text", category_id: "c-1", position: 1 }];
  store.current = store.channels[0];
  document.getElementById("auth")?.classList.add("hidden");
  document.getElementById("chat")?.classList.remove("hidden");
  document.body.classList.add("nav-open");
  await ch.renderChannels();
`;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 820 } });
  await context.route("**/rest/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "[]" }));

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
  console.log("probe-phonenav: app booted");

  await page.evaluate(`(async () => { ${SEED} })()`);
  await sleep(250);

  // 1. no rail, and the servers are in the drawer by name.
  const phone = await page.evaluate(() => ({
    rail: getComputedStyle(document.getElementById("spaceRail")).display,
    names: [...document.querySelectorAll("#channels .chan.srv .ch-name")].map((n) => n.textContent.trim()),
    orgs: [...document.querySelectorAll("#channels .nav-orglabel")].map((n) => n.textContent.trim()),
    head: [...document.querySelectorAll('#channels h3[data-cat="servers"]')].map((n) => n.textContent.trim()),
    active: [...document.querySelectorAll("#channels .chan.srv.active .ch-name")].map((n) => n.textContent.trim()),
    badge: document.querySelector('#channels .chan.srv[data-space="w-hr"] .badge')?.textContent.trim() || null,
  }));
  ok(phone.rail === "none", `the space rail is still ${phone.rail} at 420px`);
  ok(JSON.stringify(phone.names) === JSON.stringify(["Jarurat Care", "HR PsyConnect", "Safalta Setu"]),
    `the drawer lists ${JSON.stringify(phone.names)}`);
  ok(phone.orgs.length === 2, `expected both organisations named, got ${JSON.stringify(phone.orgs)}`);
  ok(/servers/i.test(phone.head[0] || ""), `no Servers heading, got ${JSON.stringify(phone.head)}`);

  // 2. the one you are in, and what is waiting in the ones you are not.
  ok(JSON.stringify(phone.active) === JSON.stringify(["Jarurat Care"]),
    `the current server is not the marked one: ${JSON.stringify(phone.active)}`);
  ok(phone.badge === "2", `the mention count did not roll up onto the server row (got ${phone.badge})`);

  // 3. tapping switches, and puts the drawer away.
  const tapped = await page.evaluate(async () => {
    // The real handler, the real switchWorkspace: every read it makes is
    // answered empty by the route above, which is enough for it to land.
    document.querySelector('#channels .chan.srv[data-space="w-hr"]').click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      drawerOpen: document.body.classList.contains("nav-open"),
      ws: (await import("/js/store.js")).store.ws?.id,
    };
  });
  ok(tapped.drawerOpen === false, "tapping a server left the drawer open over the conversation");
  ok(tapped.ws === "w-hr", `tapping a server did not switch to it (store.ws is ${tapped.ws})`);

  // 5. the heading collapses and remembers, like a category.
  const collapse = await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const ch = await import("/js/core/channels.js");
    store.ws = store.spaces[0];
    await ch.renderChannels();
    document.querySelector('#channels h3[data-cat="servers"]').click();
    await new Promise((r) => setTimeout(r, 120));
    const hidden = document.querySelector('#channels h3[data-cat="servers"]')
      ?.nextElementSibling?.style.display === "none";
    const stored = localStorage.getItem("dak.cat.servers");
    document.querySelector('#channels h3[data-cat="servers"]').click();
    await new Promise((r) => setTimeout(r, 120));
    const backAgain = [...document.querySelectorAll("#channels .chan.srv")].length;
    return { hidden, stored, backAgain };
  });
  ok(collapse.hidden, "the Servers heading did not collapse its group");
  ok(collapse.stored === "0", `collapse was not remembered (dak.cat.servers = ${collapse.stored})`);
  ok(collapse.backAgain === 3, `expanding did not bring the servers back (${collapse.backAgain} rows)`);

  // 4. at laptop width the rail is back and the drawer does NOT double it.
  await page.setViewportSize({ width: 1280, height: 860 });
  await sleep(200);
  const laptop = await page.evaluate(`(async () => {
    const ch = await import("/js/core/channels.js");
    await ch.renderChannels();
    return {
      rail: getComputedStyle(document.getElementById("spaceRail")).display,
      rows: document.querySelectorAll("#channels .chan.srv").length,
    };
  })()`);
  ok(laptop.rail !== "none", "the space rail did not come back at laptop width");
  ok(laptop.rows === 0, `the drawer still lists ${laptop.rows} servers next to a visible rail`);

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
