// Activity with a read state, filters, and a way to clear one item without
// opening it.
//
// The core panel is a flat list you can read and nothing else: no unread state
// anywhere, so the only way to make something stop nagging you is to open it and
// the only way to know whether anything is there is to open the tab and read all
// of it. features/activity.js takes it over (replaces:true, the takeover
// uxfix.js already does for Members and Search) and 0128 supplies the server
// half.
//
//   1. the panel opens on Unread - the single most repeated complaint about
//      Slack's own tab is that it does not - with chips, a count and Mark all read
//   2. an unread row carries a dot, a read row does not, and a row addressed to
//      you BY NAME is marked differently from one that merely happened near you
//   3. the mark-read control clears one item and does NOT open anything
//   4. it toggles back to unread - "seen it and I still have to act" is a real
//      answer a watermark cannot express
//   5. clicking a row DOES open it, and marks it read on the way
//   6. a DM row opens the conversation, a channel row opens the channel, a task
//      row opens Later - three destinations, one list
//   7. the filter is sent to the server and remembered across a reopen
//   8. a server that does not know p_filter falls back rather than erroring
//   9. the tab bar carries the count, a NUMBER only for things addressed to you
//      by name and a bare dot for the rest
//  10. zero pageerror.
//
// Usage: node scripts/probe-activity.mjs [--root <dir>]
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
console.log(`probe-activity: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };
const iso = (d) => new Date(d).toISOString();
const NOW = Date.now();

// One of each kind, and the read state starts on the server.
const READ = new Set();
const ITEMS = [
  { kind: "mention", channel_id: "ch-1", message_id: "m-1", actor_id: "u-lead",
    created_at: iso(NOW - 20 * 60000), snippet: "@abhay can you send the board pack",
    conversation_id: null, item_key: "mention:m-1:u-lead", task_id: null, title: null },
  { kind: "dm_mention", channel_id: null, message_id: "m-2", actor_id: "u-neha",
    created_at: iso(NOW - 90 * 60000), snippet: "@abhay taking this one?",
    conversation_id: "cv-1", item_key: "dm_mention:m-2:u-neha", task_id: null, title: null },
  { kind: "dm", channel_id: null, message_id: "m-3", actor_id: "u-neha",
    created_at: iso(NOW - 3 * 3600e3), snippet: "morning",
    conversation_id: "cv-1", item_key: "dm:m-3:u-neha", task_id: null, title: null },
  { kind: "task", channel_id: "ch-1", message_id: "m-4", actor_id: "u-lead",
    created_at: iso(NOW - 30 * 3600e3), snippet: "Call the twelve patients",
    conversation_id: null, item_key: "task:t-1:u-lead", task_id: "t-1", title: "Call the twelve patients" },
  { kind: "reaction", channel_id: "ch-1", message_id: "m-5", actor_id: "u-mehak",
    created_at: iso(NOW - 50 * 3600e3), snippet: "the roster is updated",
    conversation_id: null, item_key: "reaction:m-5:u-mehak", task_id: null, title: null },
];
const MATCH = {
  unread: () => ITEMS.filter((i) => !READ.has(i.item_key)),
  all: () => ITEMS,
  mentions: () => ITEMS.filter((i) => i.kind === "mention" || i.kind === "dm_mention"),
  dms: () => ITEMS.filter((i) => i.kind.startsWith("dm")),
  tasks: () => ITEMS.filter((i) => i.kind === "task"),
  replies: () => ITEMS.filter((i) => i.kind === "reaction" || i.kind === "thread_reply"),
};

let filterCalls = [];
let markCalls = [];
let markAllCalls = 0;
let pretendOldServer = false;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  await context.route("**/rest/v1/rpc/get_activity", (route) => {
    let b = {};
    try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    if (pretendOldServer && b.p_filter !== undefined) {
      return route.fulfill({ status: 404, contentType: "application/json", headers: CORS,
        body: JSON.stringify({ code: "PGRST202", message: "Could not find the function public.get_activity(p_filter, p_limit, p_workspace) in the schema cache" }) });
    }
    filterCalls.push(b.p_filter ?? "(none)");
    const rows = (MATCH[b.p_filter] || MATCH.all)()
      .map((i) => ({ ...i, is_read: READ.has(i.item_key) }));
    return route.fulfill(json(rows));
  });
  await context.route("**/rest/v1/rpc/activity_unread", (route) => {
    const un = ITEMS.filter((i) => !READ.has(i.item_key));
    return route.fulfill(json({
      total: un.filter((i) => !i.kind.includes("reaction")).length,
      in_feed: un.length,
      mentions: un.filter((i) => i.kind === "mention" || i.kind === "dm_mention").length,
      dms: un.filter((i) => i.kind.startsWith("dm")).length,
      tasks: un.filter((i) => i.kind === "task").length,
    }));
  });
  await context.route("**/rest/v1/rpc/mark_activity_read", (route) => {
    let b = {};
    try { b = JSON.parse(route.request().postData() || "{}"); } catch {}
    markCalls.push(b);
    for (const k of b.p_keys || []) { if (b.p_read === false) READ.delete(k); else READ.add(k); }
    return route.fulfill(json((b.p_keys || []).length));
  });
  await context.route("**/rest/v1/rpc/mark_all_activity_read", (route) => {
    markAllCalls++;
    for (const i of ITEMS) READ.add(i.item_key);
    return route.fulfill(json(ITEMS.length));
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
  console.log("probe-activity: app booted");

  await page.evaluate(async () => {
    const { store, bus } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, bus, ui, jumps: [], dms: [], panels: [] };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "w1", name: "Jarurat Care" };
    for (const p of [
      { id: "u-me", display_name: "Abhay" }, { id: "u-lead", display_name: "Priyanka Joshi" },
      { id: "u-neha", display_name: "Neha Sharma" }, { id: "u-mehak", display_name: "Mehak Pahwa" },
    ]) store.profiles.set(p.id, p);
    store.channels = [{ id: "ch-1", name: "founders-office", kind: "text", position: 1 }];
    bus.on("message:jump", (p) => window.__p.jumps.push(p));
    bus.on("dm:request", (p) => window.__p.dms.push(p));
    localStorage.setItem("dak.notifyNudge", "off");
    localStorage.removeItem("dak.activity.filter");
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  });

  const open = async (f) => {
    await page.evaluate((x) => window.__p.ui.openPanel("activity", x ? { filter: x } : {}), f || null);
    await page.waitForSelector("#panelContent .act-bar", { state: "attached", timeout: 6000 });
    await sleep(250);
  };
  const rows = () => page.$$eval("#panelContent .act-row", (ns) => ns.map((n) => ({
    text: n.textContent.replace(/\s+/g, " ").trim(),
    read: n.classList.contains("act-read"),
    dot: n.querySelector(".act-dot")?.className || "",
  })));

  await open("all");

  // 1. the chips and the count. Opened on `all` for this leg so every kind is
  //    present; the DEFAULT is asserted separately below.
  const dflt = await page.evaluate(() => localStorage.getItem("dak.activity.filter"));
  const chrome = await page.evaluate(() => {
    const b = document.getElementById("panelContent");
    return {
      chips: [...b.querySelectorAll(".act-bar button")].map((n) => n.textContent.replace(/\s+/g, " ").trim()),
      on: b.querySelector(".act-bar button.on")?.textContent.trim(),
      count: b.querySelector(".act-count")?.textContent.trim(),
      markAll: !!([...b.querySelectorAll("button")].find((n) => /mark all read/i.test(n.textContent))),
      barFirst: b.children[0]?.classList.contains("act-bar"),
    };
  });
  ok(chrome.barFirst, "the filter chips are not the first thing in the panel");
  ok(chrome.chips.length === 5, `expected five filters, got ${JSON.stringify(chrome.chips)}`);
  ok(/^Everything/.test(chrome.on || ""), `opening on "all" lit "${chrome.on}"`);

  // The DEFAULT, with nothing remembered: Unread. "The activity tab not
  // defaulting to unread-only is the most perplexing design in history" is the
  // most repeated complaint about Slack's own version, and it is free to fix.
  await page.evaluate(() => localStorage.removeItem("dak.activity.filter"));
  await open();
  const onFresh = await page.$eval("#panelContent .act-bar button.on", (n) => n.textContent.trim());
  ok(/^Unread/.test(onFresh), `with nothing remembered the tab opens on "${onFresh}", want Unread`);
  await open("all");
  ok(/Mentions 2/.test(chrome.chips.join(" ")), `Mentions does not carry its unread count: ${JSON.stringify(chrome.chips)}`);
  ok(/Unread 5/.test(chrome.chips.join(" ")), `Unread does not carry the whole count: ${JSON.stringify(chrome.chips)}`);
  ok(/5 unread/.test(chrome.count || ""), `the header count reads "${chrome.count}"`);
  ok(chrome.markAll, "there is no Mark all read");

  // 2. dots: by-name is louder than incidental, read has none.
  const r0 = await rows();
  ok(r0.length === 5, `expected five rows, got ${r0.length}`);
  ok(/mentioned you/.test(r0[0].text), `the first row reads "${r0[0].text}"`);
  ok(/tagged you in a direct message/.test(r0[1].text),
    `a DM tag is not called one: "${r0[1].text}"`);
  ok(!r0[0].dot.includes("act-quiet") && !r0[0].dot.includes("act-none"),
    "a mention does not get the by-name dot");
  const plainDm = r0.find((x) => /sent you a direct message/.test(x.text));
  ok(plainDm && plainDm.dot.includes("act-quiet"),
    "an ordinary DM is marked as loudly as a mention");
  const dayHeads = await page.$$eval("#panelContent .act-day", (ns) => ns.map((n) => n.textContent.trim()));
  ok(dayHeads.includes("Today"), `no day grouping: ${JSON.stringify(dayHeads)}`);

  // 3. mark one read WITHOUT opening it.
  markCalls = [];
  const jumpsBefore = await page.evaluate(() => window.__p.jumps.length + window.__p.dms.length);
  await page.evaluate(() => {
    document.querySelector("#panelContent .act-row .act-mark").click();
  });
  await sleep(700);
  ok(markCalls.length === 1 && markCalls[0].p_keys?.[0] === "mention:m-1:u-lead" && markCalls[0].p_read === true,
    `marking one read sent ${JSON.stringify(markCalls)}`);
  const jumpsAfter = await page.evaluate(() => window.__p.jumps.length + window.__p.dms.length);
  ok(jumpsAfter === jumpsBefore, "marking an item read also navigated somewhere");
  const r1 = await rows();
  ok(r1[0].read === true, "the row did not repaint as read");
  ok(r1[0].dot.includes("act-none"), "a read row still carries a dot");
  const count1 = await page.$eval("#panelContent .act-count", (n) => n.textContent.trim());
  ok(/4 unread/.test(count1), `the count did not fall after marking one: "${count1}"`);

  // 4. and back to unread.
  markCalls = [];
  await page.evaluate(() => document.querySelector("#panelContent .act-row .act-mark").click());
  await sleep(700);
  ok(markCalls[0]?.p_read === false, `marking unread sent ${JSON.stringify(markCalls)}`);
  ok((await rows())[0].read === false, "the row did not come back as unread");

  // 5 + 6. clicking opens, and marks read on the way.
  markCalls = [];
  await page.evaluate(() => document.querySelector("#panelContent .act-row .act-main").click());
  await sleep(700);
  ok(markCalls.some((c) => c.p_read === true), "opening an item did not mark it read");
  const jumped = await page.evaluate(() => window.__p.jumps.map((j) => j.messageId));
  ok(jumped.includes("m-1"), `clicking a channel mention did not jump to it: ${JSON.stringify(jumped)}`);

  await open("dms");
  await page.evaluate(() => document.querySelector("#panelContent .act-row .act-main").click());
  await sleep(600);
  const dmOpened = await page.evaluate(() => window.__p.dms.map((d) => d.conversationId));
  ok(dmOpened.includes("cv-1"), `clicking a DM did not open the conversation: ${JSON.stringify(dmOpened)}`);

  // 7. the filter reaches the server and survives a reopen.
  filterCalls = [];
  await open("tasks");
  ok(filterCalls.includes("tasks"), `the chosen filter did not reach the server: ${JSON.stringify(filterCalls)}`);
  const taskRows = await rows();
  ok(taskRows.length === 1 && /gave you a task/.test(taskRows[0].text),
    `the Tasks filter shows ${JSON.stringify(taskRows.map((r) => r.text))}`);
  await page.evaluate(() => window.__p.ui.closePanel());
  await open();
  const remembered = await page.$eval("#panelContent .act-bar button.on", (n) => n.textContent.trim());
  ok(/tasks/i.test(remembered), `reopening landed on "${remembered}", want the filter last used`);

  // Mark all read.
  await open("all");
  markAllCalls = 0;
  await page.evaluate(() => {
    [...document.querySelectorAll("#panelContent button")]
      .find((b) => /mark all read/i.test(b.textContent)).click();
  });
  await sleep(800);
  ok(markAllCalls === 1, `Mark all read called the server ${markAllCalls} times`);
  const after = await page.$eval("#panelContent .act-count", (n) => n.textContent.trim());
  ok(/caught up/i.test(after), `after Mark all read the header reads "${after}"`);
  ok((await rows()).every((r) => r.read), "some rows survived Mark all read as unread");

  // 8. an older server that does not know p_filter must not break the tab.
  READ.clear();
  pretendOldServer = true;
  await open("all");
  const legacy = await rows();
  ok(legacy.length === 5, `the fallback for a pre-0128 server rendered ${legacy.length} rows, want 5`);
  pretendOldServer = false;

  // 9. the tab bar carries the number, and only for things addressed to you by
  //     name. A dot for the rest: badging "somebody reacted" as loudly as
  //     "somebody is waiting on you" is how a notification tab stops meaning
  //     anything, which is the state this one was in.
  READ.clear();
  await page.evaluate(async () => {
    const { bus } = await import("/js/store.js");
    bus.emit("activity:unread", { total: 5, mentions: 2, dms: 2, tasks: 1 });
  });
  await sleep(250);
  const badge = await page.evaluate(() => {
    const d = document.querySelector('#tabbar .tab[data-tab="activity"] .tab-dot');
    return { shown: d?.classList.contains("show"), text: d?.textContent.trim() };
  });
  ok(badge.shown === true, "the Activity tab shows no badge with five things waiting");
  ok(badge.text === "2", `the Activity badge reads "${badge.text}", want the 2 addressed to you by name`);

  await page.evaluate(async () => {
    const { bus } = await import("/js/store.js");
    bus.emit("activity:unread", { total: 3, mentions: 0, dms: 0, tasks: 0 });
  });
  await sleep(250);
  const quiet = await page.evaluate(() => {
    const d = document.querySelector('#tabbar .tab[data-tab="activity"] .tab-dot');
    return { shown: d?.classList.contains("show"), text: d?.textContent.trim() };
  });
  ok(quiet.shown === true, "things happened but the tab shows nothing at all");
  ok(quiet.text === "", `nothing is addressed to you by name yet the badge reads "${quiet.text}" - want a bare dot`);

  await page.evaluate(async () => {
    const { bus } = await import("/js/store.js");
    bus.emit("activity:unread", { total: 0, mentions: 0, dms: 0, tasks: 0 });
  });
  await sleep(250);
  const clear = await page.evaluate(() =>
    document.querySelector('#tabbar .tab[data-tab="activity"] .tab-dot')?.classList.contains("show"));
  ok(clear === false, "the Activity badge survived everything being read");

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
