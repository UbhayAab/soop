// Behavioral guard for the Later/Tasks read-side merge (ROADMAP step 21):
// later.js joins get_later saved rows onto list_tasks({p_filter:'mine'}) by
// message_id and resections the queue into Overdue / Due today / Waiting on me
// above the plain To do / In progress / Done flow - but fd5c0e2 shipped with
// only boot screenshots, so nothing proved the join, the sectioning, the
// task-card contract or the personal-queue badge. This probe drives the REAL
// booted panel module against canned RPC answers fulfilled locally:
//
//   1. task-backed rows surface as sections with counts in due-date order,
//      undated assigned work lands in Waiting on me (no date is not overdue)
//   2. a task whose message_id has no saved row stays invisible - the join
//      rides the server-written saved row, never raw tasks
//   3. task cards offer Open-in-Tasks + Jump only (the board owns the state
//      machine), plain cards keep the To do/In progress/Done/Remove bar
//   4. badge #hb-later counts exactly overdue+today+waiting+plain-todo
//   5. the outbound list_tasks POST carries p_filter:'mine',
//      p_include_done:false, p_channel:null and the seeded workspace
//   6. a failed get_later renders one honest error card, zero pageerror.
//
// Usage: node scripts/probe-latermerge.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") { out.root = argv[++i]; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root || path.dirname(fileURLToPath(import.meta.url)), args.root ? "." : "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
console.log(`probe-latermerge: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failGetLater = false;
let listTasksBody = null;

// Anchored to 09:00 LOCAL, and the page is frozen to the same instant.
//
// This was Date.now(), and the two "Due today" fixtures sit at NOW + 1h and
// NOW + 2h. Run the suite after 22:00 local and both land on TOMORROW, so the
// Due today section is empty, every later section shifts up one, and the probe
// reports four failures that say nothing about the app. It did exactly that at
// 23:34 IST and cost a bisect. A probe whose result depends on the time of day
// is worse than no probe: it teaches you to ignore it.
//
// 09:00 is far enough from both midnights that a fixture two hours either side
// is still unambiguously the same local day, whatever time the suite runs.
const ANCHOR = (() => {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  return d.getTime();
})();
const NOW = ANCHOR;
const iso = (ms) => new Date(ms).toISOString();
// create_task writes the saved row server-side, so every task-bearing queue
// item arrives as BOTH a get_later row and a list_tasks row sharing
// message_id. The orphan task has no saved row and must stay invisible.
const saved = (id, body) => ({
  message_id: id, state: "todo", channel_name: "general",
  created_at: iso(NOW - 36e5), body_text: body,
});
const SAVED = [
  saved("m-over1", "context for ship the thing"),
  saved("m-over2", "context for second overdue"),
  saved("m-today", "context for review draft"),
  saved("m-wait", "context for undated work"),
  saved("m-todo", "plain saved item to work"),
  { message_id: "m-done", state: "done", channel_name: "general", created_at: iso(NOW - 72e5), body_text: "already finished item" },
];
const TASKS = [
  { id: "t1", message_id: "m-over1", title: "Ship the thing", due_at: iso(NOW - 72e5), state: "in_progress" },
  { id: "t2", message_id: "m-over2", title: "Second overdue", due_at: iso(NOW - 36e5), state: "in_progress" },
  { id: "t3", message_id: "m-today", title: "Review draft", due_at: iso(NOW + 72e5), state: "todo" },
  { id: "t4", message_id: "m-wait", title: "Undated work", due_at: null, state: "todo", blocker_note: "waiting on review" },
  { id: "t5", message_id: "m-orphan", title: "Orphan task", due_at: iso(NOW + 36e5), state: "todo" },
];

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  // Freeze the PAGE's clock to the same anchor the fixtures are built from.
  // Anchoring only the fixtures is not enough: the panel decides "overdue" and
  // "due today" by comparing due_at against its own idea of now, so the two
  // clocks have to be the same clock or the buckets disagree with the data.
  await context.clock.setFixedTime(new Date(NOW));
  // Installed BEFORE navigation so the booted app's RPCs are interceptable.
  const rpcRoute = (route) => {
    const req = route.request();
    const name = req.url().split("/rpc/")[1] || "";
    if (name === "get_later") {
      if (failGetLater) return route.fulfill({ status: 500, contentType: "application/json", body: '{"message":"boom"}' });
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(SAVED) });
    }
    if (name === "list_tasks") {
      try { listTasksBody = JSON.parse(req.postData() || "{}"); } catch { listTasksBody = null; }
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(TASKS) });
    }
    return route.fallback();
  };
  await context.route("**/rest/v1/rpc/get_later", rpcRoute);
  await context.route("**/rest/v1/rpc/list_tasks", rpcRoute);
  // Author names and reminders are niceties here - answer hermetically.
  await context.route("**/rest/v1/messages**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }));
  await context.route("**/rest/v1/reminders**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }));

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (err) => pageerrors.push(err.message));

  // The app's own boot-completion line is the only honest "modules ready".
  let featuresLoaded;
  const bootedLine = new Promise((r) => { featuresLoaded = r; });
  page.on("console", (m) => { if (/features loaded/.test(m.text())) featuresLoaded(); });
  const booted = Promise.race([bootedLine.then(() => true), sleep(45_000).then(() => false)]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  ok(await booted, "app never reached the features-loaded boot line within 45s");
  if (!problems.length) console.log("probe-latermerge: app booted");

  // Seed an identity the guards require, bring the Later header button inline
  // (order 90 sits behind the default overflow cap, so the badge element does
  // not exist at the default width - setInlineCap is the shell's shipped API
  // for exactly this), then drive the real registered panel.
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    store.me = { id: "u-me", name: "Me" };
    store.ws = { id: "ws-ws1", name: "W" };
    // Twelve ungated header buttons sort below order 90, so at the default
    // overflow cap of four - or any small cap - the Later badge element does
    // not exist. setInlineCap is the shell's shipped API for widening the
    // inline row; 24 puts every registered button inline.
    ui.setInlineCap(24);
    await ui.openPanel("later");
  });
  await page.waitForFunction(() => !document.querySelector("#panelContent .muted.pad"), null, { timeout: 15_000 })
    .catch(() => {}); // loading placeholder gone; assertions below judge the DOM
  await sleep(200);
  const dom = await page.evaluate(() => {
    const bodyEl = document.getElementById("panelContent");
    const sections = [...bodyEl.querySelectorAll("h4.later-sec")].map((h) => ({
      label: h.querySelectorAll("span")[1]?.textContent || "",
      count: h.querySelector(".later-n")?.textContent || "",
      wrapHidden: h.nextElementSibling ? h.nextElementSibling.style.display === "none" : null,
    }));
    const cards = [...bodyEl.querySelectorAll(".later-item")].map((c) => ({
      text: c.textContent,
      buttons: [...c.querySelectorAll("button")].map((b) => b.textContent.trim()),
      doneClass: c.classList.contains("later-done"),
      overBody: !!c.querySelector(".body.later-over"),
    }));
    return {
      sections,
      cards,
      badgeHasCount: !!document.querySelector("#hb-later .later-badge"),
      badgeText: document.querySelector("#hb-later .later-badge")?.textContent || "",
      emptyState: bodyEl.querySelector(".empty")?.textContent || "",
    };
  });

  const secLabel = (i) => dom.sections[i]?.label || "";
  const secCount = (i) => dom.sections[i]?.count || "";
  ok(secLabel(0) === "Overdue" && secCount(0) === "2", `Overdue section first with count 2, got ${JSON.stringify(dom.sections[0])}`);
  ok(secLabel(1) === "Due today" && secCount(1) === "1", `Due today second with count 1, got ${JSON.stringify(dom.sections[1])}`);
  ok(secLabel(2) === "Waiting on me" && secCount(2) === "1", `Waiting on me third with count 1, got ${JSON.stringify(dom.sections[2])}`);
  ok(secLabel(3) === "To do" && secCount(3) === "1", `To do fourth with count 1, got ${JSON.stringify(dom.sections[3])}`);
  ok(secLabel(5) === "Done" && secCount(5) === "1", `Done last with count 1, got ${JSON.stringify(dom.sections[5])}`);
  ok(!dom.emptyState.includes("Your Later queue is empty"), "non-empty queue must not show the empty explainer");

  const findCard = (needle) => dom.cards.find((c) => c.text.includes(needle));
  const first = findCard("Ship the thing");
  const second = findCard("Second overdue");
  ok(!!first && !!second, "both overdue task cards rendered");
  const cardIndex = (c) => dom.cards.indexOf(c);
  ok(!!first && !!second && cardIndex(first) < cardIndex(second),
    `overdue cards must sort earliest-due first, got [${dom.cards.map((c) => c.buttons.join("|")).join(" ; ")}]`);
  ok(!!first && first.text.includes("overdue"), `overdue card carries an overdue due-label, got ${first && first.text.slice(0, 120)}`);
  ok(!!first && first.buttons.includes("Open in Tasks") && first.buttons.includes("Jump"),
    `task card offers Open in Tasks + Jump, got ${first && JSON.stringify(first.buttons)}`);
  ok(!!first && !first.buttons.includes("Remove") && !first.buttons.includes("To do") && !first.buttons.includes("In progress") && !first.buttons.includes("Done"),
    `task card must not carry the saved-state buttons, got ${first && JSON.stringify(first.buttons)}`);

  const waiting = findCard("Undated work");
  ok(!!waiting && waiting.overBody && waiting.text.includes("waiting on review"),
    "undated task lands in Waiting on me with its blocker note");

  const orphanVisible = dom.cards.some((c) => c.text.includes("Orphan task"));
  ok(!orphanVisible, "a task with no matching saved row must stay invisible (join rides message_id)");

  const todoCard = findCard("plain saved item");
  ok(!!todoCard && todoCard.buttons.includes("Remove") && todoCard.buttons.some((b) => b === "To do"),
    `plain card keeps Remove + state buttons, got ${todoCard && JSON.stringify(todoCard.buttons)}`);
  const doneCard = findCard("already finished item");
  ok(!!doneCard && doneCard.doneClass, "done plain card carries the struck-through class");

  ok(dom.badgeHasCount && dom.badgeText === "5",
    `badge must count exactly overdue+today+waiting+todo = 5, got ${dom.badgeText || "(none)"}`);
  ok(listTasksBody && listTasksBody.p_filter === "mine" && listTasksBody.p_include_done === false
    && listTasksBody.p_channel === null && listTasksBody.p_workspace === "ws-ws1",
    `list_tasks POST must carry mine/include_done:false/null channel/seeded workspace, got ${JSON.stringify(listTasksBody)}`);

  // Error half: a failed get_later degrades to one honest card.
  failGetLater = true;
  await page.evaluate(async () => {
    const ui = await import("/js/ui.js");
    await ui.openPanel("later");
  });
  await sleep(400);
  const errText = await page.evaluate(() => document.getElementById("panelContent").textContent);
  ok(errText.includes("Could not load your queue."), `failed get_later must render the error card, got ${errText.slice(0, 120)}`);

  ok(pageerrors.length === 0, `pageerror(s): ${pageerrors.join(" | ")}`);

  await page.screenshot({ path: path.join(ROOT, "s", "probe-latermerge.png"), fullPage: false }).catch(() => {});
  await context.close();
} catch (err) {
  problems.push(`harness: ${err.message}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("PROBE FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN: latermerge join proven (sections+order, undated->waiting, orphan invisible, task-card contract, plain-card bar, badge=5, rpc params, error card)");
process.exit(0);
