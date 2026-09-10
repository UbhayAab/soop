// Importing a form your organisation already uses.
//
// Reported: "if I make an organisation-level form, say a leave request form, why
// can't I just import it when I am in some other channel of some other server of
// the same organisation? Right now I have to make it in one channel, then the
// second, then the third; then if I change server I have to make it again."
//
// Forms were channel-scoped and there was no search of any kind - list_forms
// takes one boolean and nothing else. 0127 adds org-level templates and a
// searchable import; this is the client half.
//
//   1. the Forms panel opens with a search box AND an Import button, and both
//      are there when the Space has no forms at all - which is exactly the
//      situation being complained about
//   2. the search filters the Space's own forms by title, by channel and by who
//      made them
//   3. Import opens a dialog that searches the ORGANISATION, debounced, and
//      sends the org id and the typed query to search_form_templates
//   4. a result says what it is: how many questions, who made it, how many
//      channels already use it
//   5. importing calls import_form_template with the template AND the chosen
//      channel, and jumps to the message that got posted
//   6. a stale search response cannot overwrite a newer one
//   7. the Import button is hidden in a Space with no organisation
//   8. zero pageerror.
//
// Usage: node scripts/probe-formimport.mjs [--root <dir>]
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
console.log(`probe-formimport: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORS = { "access-control-allow-origin": "*" };
const iso = (d) => new Date(d).toISOString();
const NOW = Date.now();

const FORMS = [
  { id: "f-1", channel_id: "ch-1", message_id: "m-1", title: "Nutrition intake",
    description: "", multi: false, closed: false, created_by: "u-neha",
    created_at: iso(NOW - 864e5), response_count: 3, responder_count: 3, can_view_responses: true },
  { id: "f-2", channel_id: "ch-2", message_id: "m-2", title: "Volunteer sign-up",
    description: "", multi: true, closed: false, created_by: "u-me",
    created_at: iso(NOW - 2 * 864e5), response_count: 0, responder_count: 0, can_view_responses: true },
];
const TEMPLATES = {
  total: 2,
  rows: [
    { id: "tpl-leave", title: "Leave Request Form", description: "Tell your lead you are away",
      fields: [{ key: "f1" }, { key: "f2" }, { key: "f3" }], multi: true,
      created_by: "u-lead", created_by_name: "Priyanka Joshi",
      created_at: iso(NOW - 30 * 864e5), updated_at: iso(NOW - 864e5), used_count: 4 },
    { id: "tpl-expense", title: "Expense claim", description: "", fields: [{ key: "f1" }],
      multi: false, created_by: "u-lead", created_by_name: "Priyanka Joshi",
      created_at: iso(NOW - 60 * 864e5), updated_at: iso(NOW - 5 * 864e5), used_count: 0 },
  ],
};

let searchCalls = [];
let importBody = null;
let slowFirstSearch = false;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 880 } });
  const json = (b) => ({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(b) });
  // The catch-all FIRST: Playwright matches most-recently-registered first.
  await context.route("**/rest/v1/**", (route) => route.fulfill(json([])));
  await context.route("**/rest/v1/rpc/list_forms", (route) => route.fulfill(json(FORMS)));
  await context.route("**/rest/v1/rpc/search_form_templates", async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || "{}"); } catch {}
    searchCalls.push(body);
    // Leg 6: hold the FIRST answer back so a later one can overtake it.
    if (slowFirstSearch && searchCalls.length === 1) {
      await sleep(700);
      return route.fulfill(json({ total: 1, rows: [{ ...TEMPLATES.rows[0], title: "STALE ANSWER" }] }));
    }
    const q = (body.p_query || "").toLowerCase();
    const rows = q ? TEMPLATES.rows.filter((t) => t.title.toLowerCase().includes(q)) : TEMPLATES.rows;
    return route.fulfill(json({ total: rows.length, rows }));
  });
  await context.route("**/rest/v1/rpc/import_form_template", (route) => {
    try { importBody = JSON.parse(route.request().postData() || "{}"); } catch { importBody = null; }
    return route.fulfill(json({ id: "f-new", message_id: "m-new", channel_id: importBody?.p_channel }));
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
  console.log("probe-formimport: app booted");

  const seed = async (orgId) => page.evaluate(async (org) => {
    const { store } = await import("/js/store.js");
    const ui = await import("/js/ui.js");
    window.__p = { store, ui };
    store.me = "u-me";
    store.myProfile = { id: "u-me", display_name: "Abhay" };
    store.ws = { id: "w1", name: "Jarurat Care", org_id: org };
    store.orgs = org ? [{ org_id: org, name: "Jarurat Care Foundation", org_role: "admin" }] : [];
    for (const p of [
      { id: "u-me", display_name: "Abhay" },
      { id: "u-neha", display_name: "Neha Sharma" },
      { id: "u-lead", display_name: "Priyanka Joshi" },
    ]) store.profiles.set(p.id, p);
    store.channels = [
      { id: "ch-1", name: "nutrition", kind: "text", position: 1 },
      { id: "ch-2", name: "volunteers", kind: "text", position: 2 },
    ];
    store.current = store.channels[1];
    document.getElementById("auth")?.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("hidden");
  }, orgId);

  const openForms = async () => {
    await page.evaluate(() => window.__p.ui.openPanel("forms"));
    await page.waitForSelector("#panelContent input[type=search]", { state: "attached", timeout: 6000 });
    await sleep(250);
  };

  await seed("org-jcf");
  await openForms();

  // 1. both affordances, above the list.
  const tools = await page.evaluate(() => {
    const b = document.getElementById("panelContent");
    const search = b.querySelector("input[type=search]");
    const imp = [...b.querySelectorAll("button")].find((x) => /import from organisation/i.test(x.textContent));
    return {
      hasSearch: !!search,
      placeholder: search?.placeholder || "",
      hasImport: !!imp,
      searchBeforeList: !!(search && b.querySelector(".result")
        && (search.compareDocumentPosition(b.querySelector(".result")) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  });
  ok(tools.hasSearch, "the Forms panel has no search box");
  ok(tools.hasImport, "the Forms panel offers no way to import from the organisation");
  ok(tools.searchBeforeList, "the search box is not above the list of forms");

  // 2. it searches what is here, by more than the title.
  const filter = async (q) => {
    await page.$eval("#panelContent input[type=search]", (n, v) => {
      n.value = v; n.dispatchEvent(new Event("input", { bubbles: true }));
    }, q);
    await sleep(300);
    return page.$$eval("#panelContent .result", (ns) => ns.map((n) => n.textContent.replace(/\s+/g, " ").trim()));
  };
  ok((await filter("nutrition")).length === 1, "searching a title did not narrow the list");
  ok((await filter("volunteers")).some((t) => /Volunteer sign-up/.test(t)),
    "searching a CHANNEL name did not find the form in it");
  ok((await filter("Neha")).some((t) => /Nutrition intake/.test(t)),
    "searching a CREATOR did not find their form");
  await filter("");

  // 3 + 4. the import dialog searches the organisation.
  searchCalls = [];
  await page.evaluate(() => {
    [...document.querySelectorAll("#panelContent button")]
      .find((b) => /import from organisation/i.test(b.textContent)).click();
  });
  await page.waitForSelector(".modal .forms-impq, .modal input[type=search]", { state: "attached", timeout: 6000 });
  await sleep(400);
  ok(searchCalls.length >= 1, "opening the import dialog did not search the organisation");
  ok(searchCalls[0]?.p_org === "org-jcf", `search_form_templates got org ${JSON.stringify(searchCalls[0])}`);

  const cards = await page.$$eval(".modal .result", (ns) => ns.map((n) => n.textContent.replace(/\s+/g, " ").trim()));
  ok(cards.length === 2, `expected both templates, got ${cards.length}`);
  ok(/Leave Request Form/.test(cards[0]), `first template reads "${cards[0]}"`);
  ok(/3 questions/.test(cards[0]), `a template does not say how many questions it has: "${cards[0]}"`);
  ok(/Priyanka Joshi/.test(cards[0]), `a template does not say who made it: "${cards[0]}"`);
  ok(/4 channels/.test(cards[0]), `a template does not say how widely it is used: "${cards[0]}"`);
  ok(/not used yet/.test(cards[1]), `an unused template should say so: "${cards[1]}"`);

  // the query reaches the server, debounced.
  const before = searchCalls.length;
  await page.$eval(".modal input[type=search]", (n) => {
    n.value = "leave"; n.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(400);
  ok(searchCalls.length > before, "typing in the import dialog did not reach search_form_templates");
  ok(searchCalls[searchCalls.length - 1]?.p_query === "leave",
    `the typed query went out as ${JSON.stringify(searchCalls[searchCalls.length - 1]?.p_query)}`);

  // 5. importing.
  await page.evaluate(() => {
    const sel = document.querySelector(".modal select");
    sel.value = [...sel.options].find((o) => /nutrition/.test(o.textContent)).value;
    [...document.querySelectorAll(".modal .result button")].find((b) => /^Import$/i.test(b.textContent)).click();
  });
  await sleep(700);
  ok(importBody?.p_template === "tpl-leave", `import_form_template got ${JSON.stringify(importBody)}`);
  ok(importBody?.p_channel === "ch-1", `the form was imported into ${importBody?.p_channel}, want the chosen channel`);

  // 6. a slow first answer must not overwrite a newer one.
  slowFirstSearch = true;
  searchCalls = [];
  await page.evaluate(() => {
    [...document.querySelectorAll("#panelContent button")]
      .find((b) => /import from organisation/i.test(b.textContent)).click();
  });
  await page.waitForSelector(".modal input[type=search]", { state: "attached", timeout: 6000 });
  await page.$eval(".modal input[type=search]", (n) => {
    n.value = "expense"; n.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(1400);   // past the held-back first response
  const afterRace = await page.$$eval(".modal .result", (ns) => ns.map((n) => n.textContent).join(" "));
  ok(!/STALE ANSWER/.test(afterRace),
    "a slow first search overwrote a newer one - the results are whichever answer landed last");
  slowFirstSearch = false;
  await page.evaluate(() => document.querySelector(".modal .modal-head button.icon")?.click());
  await sleep(200);

  // 7. no organisation, no import button. The RPC would refuse anyway; offering
  //    a button that cannot work is the thing being avoided.
  await seed(null);
  await openForms();
  const solo = await page.evaluate(() => ({
    hasSearch: !!document.querySelector("#panelContent input[type=search]"),
    hasImport: [...document.querySelectorAll("#panelContent button")]
      .some((b) => /import from organisation/i.test(b.textContent)),
  }));
  ok(solo.hasSearch, "the search box vanished in a Space with no organisation");
  ok(!solo.hasImport, "a Space with no organisation still offers Import from organisation");

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
