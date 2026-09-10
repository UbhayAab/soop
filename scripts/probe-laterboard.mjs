// Later as a work surface rather than a saved-message list.
//
// Eight tasks exist across every workspace on this deployment, which is the
// measurement that started this: the tab was there, the machinery behind it was
// there, and there was nothing on the other side worth coming back to. Three
// things were missing and 0126 supplies the server half of each - writing a task
// down without hunting for a message first, picking up work nobody has taken,
// and seeing who is carrying what.
//
//   1. the panel opens on a segmented control - Mine / Team / Up for grabs -
//      with the verb (+ New task) above all three
//   2. Mine lists what is late, what is due today and what is yours to move
//   3. Team asks team_workload and shows the three facts a lead acts on first,
//      then one row per person with late before stuck before size
//   4. Up for grabs lists unclaimed work and each card offers to take it;
//      taking one calls claim_task with that id
//   5. + New task collects a title, a channel, an assignee and a date, and calls
//      create_task_in_channel - the RPC that did not exist, which is why nobody
//      could write work down
//   6. the chosen view survives a reopen
//   7. a bare bus.emit('tasks:count') does not throw in the sidebar handler -
//      two features emit exactly that and the handler used to destructure it
//   8. zero pageerror.
//
// Usage: node scripts/probe-laterboard.mjs [--root <dir>]
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
console.log(`probe-laterboard: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };
const iso = (d) => new Date(d).toISOString();
const NOW = Date.now();

// Two of mine (one late, one undated), two nobody has taken.
const MINE = [
  { id: "t-late", workspace_id: "w1", channel_id: "ch-1", message_id: "m-late",
    title: "Send the board pack", assignee_id: "u-me", created_by: "u-lead", state: "accepted",
    due_at: iso(NOW - 864e5), done_at: null, channel_name: "founders-office", body_text: "Send the board pack" },
  { id: "t-open", workspace_id: "w1", channel_id: "ch-1", message_id: "m-open",
    title: "Update the nutrition sheet", assignee_id: "u-me", created_by: "u-lead", state: "in_progress",
    due_at: null, done_at: null, channel_name: "founders-office", body_text: "Update the nutrition sheet" },
];
const GRABS = [
  { id: "t-grab1", workspace_id: "w1", channel_id: "ch-1", message_id: "m-g1",
    title: "Call the twelve patients from Tuesday", assignee_id: null, created_by: "u-lead",
    state: "accepted", due_at: iso(NOW + 2 * 864e5), done_at: null,
    channel_name: "founders-office", body_text: "Call the twelve patients from Tuesday" },
  { id: "t-grab2", workspace_id: "w1", channel_id: "ch-1", message_id: "m-g2",
    title: "Book the venue", assignee_id: null, created_by: "u-lead", state: "accepted",
    due_at: null, done_at: null, channel_name: "founders-office", body_text: "Book the venue" },
];
const WORKLOAD = {
  people: [
    { user_id: "u-neha", open: 3, doing: 1, blocked: 0, overdue: 1, done_7d: 2 },
    { user_id: "u-sourabh", open: 1, doing: 0, blocked: 1, overdue: 0, done_7d: 0 },
  ],
  unclaimed: 2, blocked: 1, overdue: 1, done_7d: 4,
};
const LATER = [
  { message_id: "m-late", state: "todo", remind_at: null, created_at: iso(NOW - 3600e3),
    body_text: "Send the board pack", channel_id: "ch-1", channel_name: "founders-office", workspace_id: "w1" },
  { message_id: "m-open", state: "todo", remind_at: null, created_at: iso(NOW - 7200e3),
    body_text: "Update the nutrition sheet", channel_id: "ch-1", channel_name: "founders-office", workspace_id: "w1" },
  { message_id: "m-read", state: "todo", remind_at: null, created_at: iso(NOW - 1e5),
    body_text: "Read this when you get a minute", channel_id: "ch-1", channel_name: "founders-office", workspace_id: "w1" },
];

let claimBody = null;
let createBody = null;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  // The catch-all FIRST. Playwright matches routes most-recently-registered
  // first, so a trailing **/rest/v1/** swallows every specific handler above it
  // and the panel renders as if the server returned nothing - which is what the
  // first run of this probe measured, very convincingly.
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  await context.route("**/rest/v1/rpc/list_tasks", (route) => {
    let f = "mine";
    try { f = JSON.parse(route.request().postData() || "{}").p_filter || "mine"; } catch {}
    return route.fulfill(json(f === "unclaimed" ? GRABS : f === "mine" ? MINE : []));
  });
  await context.route("**/rest/v1/rpc/team_workload", (route) => route.fulfill(json(WORKLOAD)));
  await context.route("**/rest/v1/rpc/get_later", (route) => route.fulfill(json(LATER)));
  await context.route("**/rest/v1/rpc/claim_task", (route) => {
    try { claimBody = JSON.parse(route.request().postData() || "{}"); } catch { claimBody = null; }
    return route.fulfill(json({ id: "t-grab1", assignee_id: "u-me" }));
  });
  await context.route("**/rest/v1/rpc/create_task_in_channel", (route) => {
    try { createBody = JSON.parse(route.request().postData() || "{}"); } catch { createBody = null; }
    return route.fulfill(json({ id: "t-new" }));
  });

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(e.message));
  // A handler that throws inside bus.emit is CAUGHT and logged, never surfaced -
  // which is exactly how the sidebar badge broke silently. Watch the console too.
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  let ready;
  const line = new Promise((r) => { ready = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) ready(); });
  const booted = Promise.race([line.then(() => true), sleep(45_000).then(() => false)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  ok(await booted, "app never reached the features-loaded boot line within 45s");
  if (problems.length) throw new Error(problems.join("; "));
  console.log("probe-laterboard: app booted");

  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "w1", name: "Jarurat Care" };
    for (const p of [
      { id: "u-me", display_name: "Abhay" },
      { id: "u-lead", display_name: "Priyanka Joshi" },
      { id: "u-neha", display_name: "Neha Sharma" },
      { id: "u-sourabh", display_name: "Sourabh Singh" },
    ]) store.profiles.set(p.id, p);
    store.channels = [{ id: "ch-1", name: "founders-office", kind: "text", position: 1 }];
    store.current = store.channels[0];
    localStorage.setItem("dak.later.intro", "off");   // the intro is leg 9, not leg 1
    localStorage.removeItem("dak.later.view");
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  });

  const open = async (view) => {
    await page.evaluate((v) => window.__p.ui.openPanel("later", v ? { view: v } : {}), view || null);
    await page.waitForSelector("#panelContent .later-seg", { state: "attached", timeout: 6000 });
    await sleep(250);
  };

  // 1. the shape of the surface.
  await open();
  const shape = await page.evaluate(() => {
    const b = document.getElementById("panelContent");
    const kids = [...b.children];
    return {
      segFirst: kids[0]?.classList.contains("later-seg"),
      newSecond: kids[1]?.classList.contains("later-new"),
      segs: [...b.querySelectorAll(".later-seg button")].map((n) => n.textContent.replace(/\s+/g, " ").trim()),
      onSeg: b.querySelector(".later-seg button.on")?.textContent.trim(),
      newText: b.querySelector(".later-new")?.textContent.trim(),
    };
  });
  ok(shape.segFirst, "the view switcher is not the first thing in the panel");
  ok(shape.newSecond, "+ New task is not directly under the view switcher");
  ok(shape.segs.length === 3, `expected three views, got ${JSON.stringify(shape.segs)}`);
  ok(/mine/i.test(shape.segs[0]) && /team/i.test(shape.segs[1]) && /grabs/i.test(shape.segs[2]),
    `the three views read ${JSON.stringify(shape.segs)}`);
  ok(/^mine/i.test(shape.onSeg || ""), `the default view is "${shape.onSeg}", want Mine`);
  ok(/new task/i.test(shape.newText || ""), `the verb reads "${shape.newText}"`);
  ok(/2/.test(shape.segs[2]), `Up for grabs does not carry its count: "${shape.segs[2]}"`);

  // 2. Mine sorts by what is late.
  const mine = await page.$$eval("#panelContent h4.sec", (ns) => ns.map((n) => n.textContent.replace(/\s+/g, " ").trim()));
  // The heading carries its collapse chevron and its count, so it reads "▾Late1".
  ok(mine.some((h) => /late/i.test(h)), `Mine has no Late section: ${JSON.stringify(mine)}`);
  ok(mine.some((h) => /yours to move/i.test(h)), `Mine has no "Yours to move" section: ${JSON.stringify(mine)}`);
  const started = await page.evaluate(() =>
    [...document.querySelectorAll("#panelContent .later-item")].some((c) => /Done/.test(c.textContent)));
  ok(started, "a task card in Mine offers no way to finish it");

  // 3. Team.
  await open("team");
  const team = await page.evaluate(() => ({
    tiles: [...document.querySelectorAll("#panelContent .later-tile")].map((n) => n.textContent.replace(/\s+/g, " ").trim()),
    people: [...document.querySelectorAll("#panelContent .later-person")].map((n) => n.textContent.replace(/\s+/g, " ").trim()),
  }));
  ok(team.tiles.length === 4, `expected four headline tiles, got ${team.tiles.length}`);
  ok(team.tiles.some((t) => /2.*nobody has picked up/i.test(t)), `no unclaimed tile: ${JSON.stringify(team.tiles)}`);
  ok(team.tiles.some((t) => /1.*stuck/i.test(t)), `no stuck tile: ${JSON.stringify(team.tiles)}`);
  ok(team.tiles.some((t) => /1.*late/i.test(t)), `no late tile: ${JSON.stringify(team.tiles)}`);
  ok(team.people.length === 2, `expected two people, got ${JSON.stringify(team.people)}`);
  ok(/Neha/.test(team.people[0]) && /1 late/.test(team.people[0]),
    `the person carrying late work is not first or not marked: ${JSON.stringify(team.people)}`);

  // 4. Up for grabs, and taking one.
  await open("grabs");
  const grabs = await page.$$eval("#panelContent .later-item", (ns) => ns.map((n) => n.textContent.replace(/\s+/g, " ").trim()));
  ok(grabs.length === 2, `expected two unclaimed cards, got ${grabs.length}`);
  ok(/Call the twelve patients/.test(grabs[0]), `first unclaimed card reads "${grabs[0]}"`);
  ok(/I'll do it/.test(grabs[0]), "an unclaimed card offers no way to take it");
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("#panelContent .later-item button")]
      .find((x) => /I'll do it/.test(x.textContent));
    b.click();
  });
  await sleep(600);
  ok(claimBody?.p_task === "t-grab1", `claim_task was called with ${JSON.stringify(claimBody)}`);

  // 5. Writing one down. The dialog that had no RPC behind it until 0126.
  await open("mine");
  await page.evaluate(() => document.querySelector("#panelContent .later-new").click());
  await page.waitForSelector(".modal form", { state: "attached", timeout: 5000 });
  const form = await page.evaluate(() => ({
    title: document.querySelector(".modal .modal-head strong")?.textContent.trim(),
    names: [...document.querySelectorAll(".modal form [name]")].map((n) => n.name),
    channels: [...document.querySelectorAll('.modal form [name="channel"] option')].map((o) => o.textContent.trim()),
    firstAssignee: document.querySelector('.modal form [name="assignee"] option')?.textContent.trim(),
  }));
  ok(/new task/i.test(form.title || ""), `the dialog is titled "${form.title}"`);
  ok(JSON.stringify(form.names) === JSON.stringify(["title", "channel", "assignee", "due"]),
    `the dialog asks for ${JSON.stringify(form.names)}`);
  ok(form.channels.includes("#founders-office"), `the channel picker holds ${JSON.stringify(form.channels)}`);
  ok(/anyone/i.test(form.firstAssignee || ""),
    `the default assignee is "${form.firstAssignee}", want unclaimed to be the cheapest option`);

  await page.evaluate(() => {
    const f = document.querySelector(".modal form");
    f.querySelector('[name="title"]').value = "Call the twelve patients from Tuesday";
    f.querySelector('[name="due"]').value = "2026-09-30";
    [...document.querySelectorAll(".modal button")].find((b) => /add task/i.test(b.textContent))?.click();
  });
  await sleep(700);
  ok(createBody?.p_title === "Call the twelve patients from Tuesday",
    `create_task_in_channel got ${JSON.stringify(createBody)}`);
  ok(createBody?.p_channel === "ch-1", `the task was filed in ${createBody?.p_channel}, want the open channel`);
  ok(createBody?.p_assignee === null, `an unassigned task sent assignee ${JSON.stringify(createBody?.p_assignee)}`);
  // End of the chosen day, not the start of it: "by the 30th" means the 30th.
  ok(/^2026-09-30T/.test(createBody?.p_due_at || "") && !/T00:00/.test(createBody?.p_due_at || ""),
    `the due date went out as ${createBody?.p_due_at}, want the END of that day`);

  // 6. the view is remembered.
  await open("grabs");
  await page.evaluate(() => window.__p.ui.closePanel());
  await open();
  const remembered = await page.$eval("#panelContent .later-seg button.on", (n) => n.textContent.trim());
  ok(/grabs/i.test(remembered), `reopening landed on "${remembered}", want the view last used`);

  // 7. the sidebar badge handler survives a payload-less ping. Both
  //    taskprogress.js and quicktask.js emit exactly this.
  const before = consoleErrors.length;
  await page.evaluate(async () => {
    const { bus } = await import("/js/store.js");
    bus.emit("tasks:count");
    bus.emit("tasks:count", { open: 4, overdue: 1 });
  });
  await sleep(300);
  const thrown = consoleErrors.slice(before).filter((t) => /bus handler|destructur|undefined/i.test(t));
  ok(thrown.length === 0, `a bare tasks:count still throws in a handler: ${thrown.join(" | ")}`);

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
