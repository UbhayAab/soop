// Starting a NEW direct message from the DMs surface.
//
// Reported: "the DMs section only displays people who have already messaged me.
// There is no immediately visible option to search for a member and start a new
// conversation." The route that existed was Members -> the person -> their card
// -> Message, four screens deep, plus a "+ New message" button in the PANEL
// FOOTER, which on a phone with a dozen conversations is below the fold.
//
// This drives the real booted modules and asserts the entry point is in the
// panel BODY, above the conversations, and that it searches the whole Space:
//
//   1. opening the DMs panel paints a search box and a New message row in the
//      body, both before the first conversation row
//   2. an empty query lists conversations only - the Space roster does not
//      flood the list
//   3. a query matches an existing conversation by the other person's name
//   4. a query matches a member you have NEVER written to, under its own
//      "Start a new conversation" heading
//   5. clicking that row calls create_dm with exactly that user id
//   6. the DMs tab, tapped while the conversation it opened is on screen, goes
//      BACK to the list rather than reopening the same conversation - before
//      this there was no route back to the list at all once a DM was open
//   7. the footer's New message button clears the floating tab bar rather than
//      being painted underneath it - the root cause a parallel branch measured
//   8. dm:new still opens the picker (the only route to a GROUP), and it closes
//   9. an arriving DM does NOT open the picker
//  10. zero pageerror.
//
// Usage: node scripts/probe-newdm.mjs [--root <dir>]
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
console.log(`probe-newdm: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CORS = { "access-control-allow-origin": "*" };
let createDmBody = null;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 780 } });
  await context.route("**/rest/v1/rpc/create_dm", (route) => {
    try { createDmBody = JSON.parse(route.request().postData() || "{}"); } catch { createDmBody = null; }
    return route.fulfill({ status: 200, contentType: "application/json", headers: CORS,
      body: JSON.stringify({ id: "conv-new", kind: "dm" }) });
  });
  // Anything else the open path reaches for is answered empty rather than left
  // to hang: this probe is about the ENTRY POINT, not about loading a history.
  for (const pat of ["**/rest/v1/rpc/get_unread", "**/rest/v1/rpc/get_dm_unread",
    "**/rest/v1/rpc/get_space_summary", "**/rest/v1/rpc/get_dm_receipts",
    "**/rest/v1/dm_messages**", "**/rest/v1/dm_message_reactions**"]) {
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
  console.log("probe-newdm: app booted");

  // One conversation with Alice, plus Bhavna and Sourabh in the Space with no
  // conversation at all - the exact shape the report describes.
  await page.evaluate(async () => {
    const { store, bus } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, bus, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Me" };
    store.ws = { id: "ws-1", name: "Jarurat Care" };
    for (const p of [
      { id: "u-me", display_name: "Me", username: "me" },
      { id: "u-alice", display_name: "Alice Rao", username: "alice" },
      { id: "u-bhavna", display_name: "Bhavna Shah", username: "bhavna" },
      { id: "u-sourabh", display_name: "Sourabh Singh", username: "sourabh" },
      { id: "u-bot", display_name: "Standup Bot", username: "standup", is_app: true },
    ]) store.profiles.set(p.id, p);
    store.dms = [{ conversation_id: "conv-a", other_user_ids: ["u-alice", "u-me"],
      last_message_at: new Date().toISOString(), unread: 0 }];
  });

  const openPanel = async () => {
    await page.evaluate(() => window.__p.ui.openPanel("dms"));
    // state:attached, not visible: the probe never signs in, so the whole shell
  // sits behind the auth gate and nothing in it is "visible" to Playwright.
  // What is being tested is the panel's own structure.
  await page.waitForSelector("#panelContent .dmsearch", { state: "attached", timeout: 5000 });
  };
  const type = async (q) => {
    await page.$eval("#panelContent .dmsearch", (n, v) => {
      n.value = v; n.dispatchEvent(new Event("input", { bubbles: true }));
    }, q);
    await sleep(320);                    // past the 150ms input debounce
  };
  const rows = () => page.$$eval("#panelContent .dmrow .nm", (ns) => ns.map((n) => n.textContent.trim()));
  const heads = () => page.$$eval("#panelContent .dmsec", (ns) => ns.map((n) => n.textContent.trim()));

  await openPanel();

  // 1. both affordances are in the BODY, and both come before any conversation.
  const order = await page.evaluate(() => {
    const body = document.getElementById("panelContent");
    const kids = [...body.children];
    const idx = (sel) => kids.findIndex((k) => k.matches(sel));
    const firstRow = body.querySelector(".dmrow");
    return {
      search: idx("input.dmsearch"),
      newBtn: idx("button.dmnew"),
      newBtnText: body.querySelector("button.dmnew")?.textContent.trim() || "",
      searchBeforeRow: firstRow ? !!(body.querySelector("input.dmsearch").compareDocumentPosition(firstRow)
        & Node.DOCUMENT_POSITION_FOLLOWING) : false,
      footerBtn: !!document.querySelector("#panelFooter button"),
    };
  });
  ok(order.search === 0, `search box is not the first thing in the panel body (index ${order.search})`);
  ok(order.newBtn === 1, `New message row is not directly under the search box (index ${order.newBtn})`);
  ok(/new message/i.test(order.newBtnText), `New message row reads "${order.newBtnText}"`);
  ok(order.searchBeforeRow, "the search box is not above the conversation rows");
  ok(order.footerBtn, "the footer New message button was dropped");

  // 2. no query: conversations only.
  ok(JSON.stringify(await rows()) === JSON.stringify(["Alice Rao"]),
    `unsearched list is not just the conversations: ${JSON.stringify(await rows())}`);
  ok((await heads()).length === 0, "unsearched list should carry no section headings");

  // 3. an existing conversation is findable by name.
  await type("ali");
  ok(JSON.stringify(await rows()) === JSON.stringify(["Alice Rao"]),
    `searching "ali" did not match the Alice conversation: ${JSON.stringify(await rows())}`);
  ok((await heads())[0] === "Conversations", `expected a Conversations heading, got ${JSON.stringify(await heads())}`);

  // 4. somebody never written to is findable, under its own heading, and an app
  //    is not offered as a person to start a conversation with.
  await type("bhav");
  ok(JSON.stringify(await rows()) === JSON.stringify(["Bhavna Shah"]),
    `searching "bhav" did not surface the un-messaged member: ${JSON.stringify(await rows())}`);
  ok((await heads()).includes("Start a new conversation"),
    `expected the "Start a new conversation" heading, got ${JSON.stringify(await heads())}`);
  const sub = await page.$eval("#panelContent .dmrow .sub", (n) => n.textContent.trim());
  ok(/start a conversation/i.test(sub), `the un-messaged row does not say what clicking it does: "${sub}"`);

  await type("standup");
  ok((await rows()).length === 0, "an app was offered as somebody to start a DM with");

  // 5. clicking it starts exactly that conversation.
  await type("sourabh");
  ok(JSON.stringify(await rows()) === JSON.stringify(["Sourabh Singh"]),
    `searching "sourabh" matched ${JSON.stringify(await rows())}`);
  await page.$eval("#panelContent .dmrow", (n) => n.click());
  await sleep(700);
  ok(!!createDmBody, "clicking a person did not call create_dm");
  ok(JSON.stringify(createDmBody?.p_user_ids || createDmBody?.p_users || createDmBody?.p_members
    || Object.values(createDmBody || {}).find(Array.isArray)) === JSON.stringify(["u-sourabh"]),
    `create_dm was called with ${JSON.stringify(createDmBody)}`);

  // 6. the DMs tab, tapped while that conversation is on screen, shows the LIST.
  //    Before this it reopened the conversation you were already looking at, so
  //    once a DM was open the list - and everything at the top of it - could not
  //    be reached from the tab again.
  const currentDM = await page.evaluate(() => window.__p.store.currentDM);
  ok(currentDM === "conv-new", `openDM did not take hold (currentDM=${currentDM})`);
  const tab = await page.$('#tabbar .tab[data-tab="dms"]');
  ok(!!tab, "no DMs tab in the tab bar");
  if (tab) {
    await page.$eval('#tabbar .tab[data-tab="dms"]', (n) => n.click());
    await page.waitForSelector("#panelContent .dmsearch", { state: "attached", timeout: 5000 })
      .catch(() => problems.push("the DMs tab did not show the conversation list while a DM was open"));
    const marked = await page.$$eval("#panelContent .dmrow.on", (ns) => ns.length);
    ok(marked === 1, `the open conversation is not marked in the list (${marked} marked rows)`);
  }

  // 7. the footer button is reachable, not painted under the floating tab bar.
  //    This is the root cause a parallel branch measured: css/layout.css
  //    reserved --tabbar-h for .content and not for the sheet's own footer, so
  //    on a phone the one "+ New message" button that existed was drawn
  //    underneath the tab bar - in the DOM, untappable, and reported as "there
  //    is no option to start a DM". The bar sits at the bottom of the viewport,
  //    so the test is: does the button's box end above where the bar starts.
  //
  //    The shell is unhidden FIRST and stays that way. Toggling it inside the
  //    same evaluate as the measurement reads 16px low - the sheet-in keyframe
  //    starts at translateY(16px) and an element that had no layout a moment ago
  //    has not been through it yet. That is small enough to look like a real
  //    8px overlap, which is exactly the bug being tested for.
  await page.evaluate(() => {
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  });
  await page.evaluate(() => window.__p.ui.openPanel("dms"));
  await page.waitForSelector("#panelContent .dmsearch", { state: "attached", timeout: 5000 });
  await page.evaluate(() => Promise.all(
    document.getElementById("panel").getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})),
  ));
  const geo = await page.evaluate(() => {
    const btn = document.querySelector("#panelFooter button");
    const bar = document.getElementById("tabbar");
    if (!btn || !bar) return null;
    const b = btn.getBoundingClientRect();
    const t = bar.getBoundingClientRect();
    return { btnBottom: Math.round(b.bottom), barTop: Math.round(t.top), barShown: t.height > 0 };
  });
  ok(!!geo, "could not measure the footer button against the tab bar");
  // A skipped geometry check must not read as a passed one.
  ok(!!geo?.barShown, "the tab bar had no box to measure against, so this leg proved nothing");
  ok(!geo?.barShown || geo.btnBottom <= geo.barTop,
    `the footer New message button ends at ${geo?.btnBottom}px, under a tab bar that starts at ${geo?.barTop}px`);
  if (geo) console.log(`probe-newdm: footer button ends ${geo.btnBottom}px, tab bar starts ${geo.barTop}px`);

  // 8. the picker still opens from dm:new and closes again. It is the only route
  //    to a GROUP conversation, so it has to survive a search box above it.
  const picker = await page.evaluate(async () => {
    const { bus } = await import("/js/store.js");
    bus.emit("dm:new");
    await new Promise((r) => setTimeout(r, 250));
    const title = document.querySelector(".modal .modal-head strong")?.textContent.trim() || "";
    const opened = !!document.querySelector(".picker-list");
    document.querySelector(".modal .modal-head button.icon")?.click();
    await new Promise((r) => setTimeout(r, 200));
    return { title, opened, gone: !document.querySelector(".picker-list") };
  });
  ok(picker.opened, "dm:new did not open the New message picker");
  ok(/new message/i.test(picker.title), `the picker is titled "${picker.title}", want New message`);
  ok(picker.gone, "the New message picker did not close");

  // 9. an arriving DM must NOT open the picker. main.js used to announce an
  //    arrival on 'dm:new' - the same name the sidebar, this panel and
  //    Ctrl+Shift+K use to OPEN it - so every DM you received popped a dialog.
  const popped = await page.evaluate(async () => {
    const { bus } = await import("/js/store.js");
    bus.emit("dm:new", { conversation_id: "conv-a", id: "m1" });
    await new Promise((r) => setTimeout(r, 250));
    return !!document.querySelector(".picker-list");
  });
  ok(!popped, "an arrival-shaped payload on dm:new still opened the New message picker");

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
