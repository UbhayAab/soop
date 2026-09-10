// The Admin badge beside a name.
//
// Reported: "I assigned Aashika and Sourabh as admins. Although their admin
// permissions appear to be active, there is no visible Admin tag beside their
// names." There was no client anywhere that knew: get_bootstrap told you whether
// YOU were an admin and said nothing about anybody else, and the Members panel
// worked it out by reading public.member_roles, a table RLS hides from ordinary
// members - so the one pill that existed was drawn only for people who already
// knew the answer.
//
// This drives the real modules and asserts:
//
//   1. setBadges/roleTagOf rank Owner over Admin over Moderator, and an ordinary
//      member gets nothing rather than a "Member" pill on every row
//   2. a message row carries the pill beside the author's name, and an ordinary
//      author's row carries none
//   2b. a badge that lands AFTER the row was painted still reaches it, a
//      demotion takes it away again, and neither leaves a duplicate
//   3. the DM list row carries it beside the other person's name
//   4. the Members panel asks get_member_badges - the RPC any member may call -
//      and NOT the member_roles table it used to read
//   5. the panel labels an admin, a moderator and an owner, all three
//   6. switching Space clears the map, so nobody keeps a badge they only hold
//      somewhere else
//   7. zero pageerror.
//
// Usage: node scripts/probe-rolebadge.mjs [--root <dir>]
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
console.log(`probe-rolebadge: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };

const BADGES = [
  { user_id: "u-me", member_type: "member", is_admin: false, is_owner: false },
  { user_id: "u-aashika", member_type: "member", is_admin: true, is_owner: false },
  { user_id: "u-sourabh", member_type: "member", is_admin: true, is_owner: false },
  { user_id: "u-mehak", member_type: "moderator", is_admin: false, is_owner: false },
  { user_id: "u-priyanka", member_type: "member", is_admin: true, is_owner: true },
  { user_id: "u-dev", member_type: "member", is_admin: false, is_owner: false },
];

let badgeCalls = 0;
let memberRolesReads = 0;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 780 } });
  await context.route("**/rest/v1/rpc/get_member_badges", (route) => {
    badgeCalls++;
    return route.fulfill({ status: 200, contentType: "application/json", headers: CORS,
      body: JSON.stringify(BADGES) });
  });
  // The tables the panel used to read. Answered, so a regression back to them
  // still renders - and counted, so the regression is still a failure.
  for (const t of ["member_roles", "roles", "workspace_members"]) {
    await context.route(`**/rest/v1/${t}**`, (route) => {
      if (t === "member_roles") memberRolesReads++;
      return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: "[]" });
    });
  }
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
  console.log("probe-rolebadge: app booted");

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
      { id: "u-aashika", display_name: "Aashika Aggarwal", username: "aashika" },
      { id: "u-sourabh", display_name: "Sourabh Singh", username: "sourabh" },
      { id: "u-mehak", display_name: "Mehak Pahwa", username: "mehak" },
      { id: "u-priyanka", display_name: "Priyanka Joshi", username: "priyanka" },
      { id: "u-dev", display_name: "Dev Kumar", username: "dev" },
    ]) store.profiles.set(p.id, p);
    setBadges(badges);
  }, BADGES);
  await page.evaluate((b) => { window.__badges = b; }, BADGES);

  // 1. ranking, and silence for an ordinary member.
  const tags = await page.evaluate(() => {
    const { roleTagOf } = window.__p.s;
    return {
      admin: roleTagOf("u-aashika"), mod: roleTagOf("u-mehak"),
      owner: roleTagOf("u-priyanka"), plain: roleTagOf("u-dev"),
      unknown: roleTagOf("u-nobody"),
    };
  });
  ok(tags.admin === "Admin", `an admin reads "${tags.admin}"`);
  ok(tags.mod === "Moderator", `a moderator reads "${tags.mod}"`);
  ok(tags.owner === "Owner", `an owner who is also an admin reads "${tags.owner}", expected Owner`);
  ok(tags.plain === null, `an ordinary member got a "${tags.plain}" pill`);
  ok(tags.unknown === null, `an unknown user got a "${tags.unknown}" pill`);

  // 2. the message row.
  const msgPills = await page.evaluate(() => {
    const build = (id, author) => window.__p.msgs.buildMessage(
      { id, author_id: author, body_text: "hello", created_at: new Date().toISOString(), seq: 1 },
      { context: "channel" });
    const pill = (row) => row.querySelector(".mhead .pill-role")?.textContent.trim() || null;
    const nameThenPill = (row) => {
      const head = row.querySelector(".mhead");
      const who = head.querySelector(".who");
      const p = head.querySelector(".pill-role");
      return p ? !!(who.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    };
    const a = build("m1", "u-aashika");
    const d = build("m2", "u-dev");
    return { admin: pill(a), plain: pill(d), afterName: nameThenPill(a) };
  });
  ok(msgPills.admin === "Admin", `a message from an admin shows "${msgPills.admin}" in its header`);
  ok(msgPills.plain === null, `a message from an ordinary member shows a "${msgPills.plain}" pill`);
  ok(msgPills.afterName === true, "the pill is not beside (after) the name in the message header");

  // 2b. a badge that arrives AFTER the row was painted still lands. On a cold
  //     start pagecache paints the previous conversation before the bootstrap,
  //     so this is the ordinary case, not the edge case - and the repaint used
  //     to skip any row whose NAME was already right, which is all of them.
  const late = await page.evaluate(async () => {
    const { store, setBadges, bus } = window.__p.s;
    const host = document.getElementById("messages");
    host.innerHTML = "";
    setBadges([]);                       // badges not in yet
    host.appendChild(window.__p.msgs.buildMessage(
      { id: "m3", author_id: "u-aashika", body_text: "early", created_at: new Date().toISOString(), seq: 1 },
      { context: "channel" }));
    const before = host.querySelector(".mhead .pill-role")?.textContent.trim() || null;
    setBadges(window.__badges);          // bootstrap lands
    bus.emit("profiles");
    await new Promise((r) => setTimeout(r, 50));
    const after = host.querySelector(".mhead .pill-role")?.textContent.trim() || null;
    // ...and a demotion takes it away again.
    setBadges([{ user_id: "u-aashika", member_type: "member", is_admin: false, is_owner: false }]);
    bus.emit("profiles");
    await new Promise((r) => setTimeout(r, 50));
    const demoted = host.querySelector(".mhead .pill-role")?.textContent.trim() || null;
    const dupes = host.querySelectorAll(".mhead .pill-role").length;
    setBadges(window.__badges);
    return { before, after, demoted, dupes };
  });
  ok(late.before === null, `a row painted before the badges arrived already had a "${late.before}" pill`);
  ok(late.after === "Admin", `the badge arriving after the row did not land (pill is "${late.after}")`);
  ok(late.demoted === null, `a demotion left a "${late.demoted}" pill behind`);
  ok(late.dupes === 0, `the repaint left ${late.dupes} pills on one row`);

  // 3. the DM list row.
  await page.evaluate(() => {
    window.__p.s.store.dms = [
      { conversation_id: "c1", other_user_ids: ["u-sourabh", "u-me"], last_message_at: new Date().toISOString(), unread: 0 },
      { conversation_id: "c2", other_user_ids: ["u-dev", "u-me"], last_message_at: new Date(Date.now() - 6e4).toISOString(), unread: 0 },
    ];
    window.__p.ui.openPanel("dms");
  });
  await page.waitForSelector("#panelContent .dmrow", { state: "attached", timeout: 5000 });
  const dmPills = await page.$$eval("#panelContent .dmrow .nm", (ns) =>
    ns.map((n) => ({ text: n.textContent.trim(), pill: n.querySelector(".pill-role")?.textContent.trim() || null })));
  ok(dmPills.find((r) => /Sourabh/.test(r.text))?.pill === "Admin",
    `the DM row for an admin shows ${JSON.stringify(dmPills)}`);
  ok(dmPills.find((r) => /Dev/.test(r.text))?.pill === null,
    `the DM row for an ordinary member carries a pill: ${JSON.stringify(dmPills)}`);

  // 4 + 5. the Members panel.
  badgeCalls = 0;
  memberRolesReads = 0;
  await page.evaluate(() => window.__p.ui.openPanel("members"));
  await page.waitForSelector("#panelContent .member", { state: "attached", timeout: 8000 });
  ok(badgeCalls === 1, `the Members panel called get_member_badges ${badgeCalls} times, expected 1`);
  ok(memberRolesReads === 0,
    `the Members panel still read the member_roles table ${memberRolesReads} times - ordinary members cannot`);
  const panelPills = await page.$$eval("#panelContent .member", (ns) => ns.map((n) => ({
    name: n.querySelector(".ux-mem-name .truncate")?.textContent.trim(),
    pill: n.querySelector(".pill-role")?.textContent.trim() || null,
  })));
  const pillFor = (frag) => panelPills.find((r) => new RegExp(frag, "i").test(r.name || ""))?.pill;
  ok(pillFor("Aashika") === "Admin", `Members panel labels Aashika "${pillFor("Aashika")}"`);
  ok(pillFor("Sourabh") === "Admin", `Members panel labels Sourabh "${pillFor("Sourabh")}"`);
  ok(pillFor("Mehak") === "Moderator", `Members panel labels Mehak "${pillFor("Mehak")}"`);
  ok(pillFor("Priyanka") === "Owner", `Members panel labels Priyanka "${pillFor("Priyanka")}"`);
  ok(pillFor("Dev") === null, `Members panel put a "${pillFor("Dev")}" pill on an ordinary member`);

  // 6. a badge is a fact about a person IN A SPACE.
  const afterSwitch = await page.evaluate(async () => {
    const { store, setBadges, roleTagOf } = window.__p.s;
    setBadges([]);                       // what switchWorkspace does
    store.ws = { id: "ws-2", name: "Safalta Setu" };
    return roleTagOf("u-aashika");
  });
  ok(afterSwitch === null, `an admin of one Space kept a "${afterSwitch}" pill after switching to another`);

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
