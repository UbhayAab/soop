// Behavioral guard for the three things the 2026-09-08 report named: "no
// option to start a DM", "not allowed to react in a DM", and "no Admin tag
// beside the admins". Drives the REAL booted app on PROBE_BASE (default
// 127.0.0.1:4177; scripts/probe-all.mjs serves it) in a phone viewport, with
// every Supabase REST call answered locally, so nothing here needs a network or
// a signed-in session - the wire is the evidence.
//
//   LEG A  the DMs panel opens with a search box and a New message button as
//          the FIRST thing in its content, not in a footer; the button emits
//          'dm:new' exactly once, and no New message button is left in the
//          footer (the tab bar covered it).
//   LEG B  typing part of a member's name lists them under People; tapping the
//          row emits 'dm:start' for exactly that user, reaches create_dm on
//          the wire with that id, and opens the conversation it answers with.
//   LEG C  a member who already has a 1:1 with you is offered ONCE: their
//          conversation row shows, no People row does.
//   LEG D  'dm:new' carrying an arrival-shaped payload (conversation_id) and
//          'dm:incoming' both open NO dialog; a bare 'dm:new' opens the picker
//          titled New message. (Every received DM used to pop the picker.)
//   LEG E  a panel footer clears the tab bar: with a footer-bearing panel open
//          at phone width, the footer button's bottom edge is at or above the
//          tab bar's top edge.
//   LEG F  reactions route by row kind: toggleReaction on a row whose cached
//          message carries conversation_id POSTs rpc/toggle_dm_reaction and
//          loadReactions for it reads dm_message_reactions; a channel row goes
//          to rpc/toggle_reaction and message_reactions.
//   LEG G  admin pills: buildMessage paints OWNER / ADMIN beside the author
//          from store.admins and nothing for anyone else, and a later 'admins'
//          emit patches rows already on screen in both directions.
//
// Usage: node scripts/probe-dmstart.mjs   (PROBE_BASE overrides the origin)
// Exit 0 PROBE CLEAN, 1 PROBE FAILED.
import { chromium, devices } from "playwright";

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:4177";
const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["iPhone 13 Pro"] });

// Every REST call lands here. rpc names + bodies and table reads are the wire
// facts legs B and F assert on; everything else gets an empty answer.
const wire = { rpc: [], tables: [] };
await context.route("**/rest/v1/**", async (route) => {
  const u = new URL(route.request().url());
  const seg = u.pathname.split("/");
  const last = seg[seg.length - 1];
  const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body });
  if (seg[seg.length - 2] === "rpc") {
    let body = null;
    try { body = route.request().postDataJSON(); } catch { /* no body */ }
    wire.rpc.push({ fn: last, body });
    if (last === "create_dm") return json(JSON.stringify({ id: "conv-new", kind: "dm" }));
    if (last === "toggle_reaction" || last === "toggle_dm_reaction") return json("true");
    return json("[]");
  }
  wire.tables.push(last.split("?")[0]);
  return json("[]");
});

const page = await context.newPage();
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
const booted = page.waitForEvent("console", {
  predicate: (m) => /features loaded/.test(m.text()), timeout: 45_000,
}).then(() => true, () => false);
await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
ok(await booted, "app never reached the features-loaded boot line within 45s");
// Signed-out boot hides the shell; reveal it the way a signed-in session sees
// it (probe-tabbar precedent), then seed a small Space.
await page.evaluate(async () => {
  document.getElementById("chat")?.classList.remove("hidden");
  document.body.classList.remove("no-team");
  const { store } = await import("/js/store.js");
  store.me = "u-me";
  store.ws = { id: "ws-1", name: "Probe" };
  store.profiles = new Map([
    ["u-me", { id: "u-me", display_name: "Me", username: "me" }],
    ["u-aashika", { id: "u-aashika", display_name: "Aashika", username: "aashika" }],
    ["u-sourabh", { id: "u-sourabh", display_name: "Sourabh", username: "sourabh" }],
    ["u-ravi", { id: "u-ravi", display_name: "Ravi", username: "ravi" }],
    ["u-bot", { id: "u-bot", display_name: "Sourdough Bot", username: "sourbot", is_app: true }],
  ]);
  store.admins = new Map([["u-aashika", "admin"], ["u-me", "owner"]]);
  store.dms.length = 0;
  store.dms.push({
    conversation_id: "c-ravi", kind: "dm", other_user_ids: ["u-ravi"],
    last_message_at: new Date().toISOString(), unread: 0,
  });
});
await sleep(200);

// ------------------------------------------------------------------ leg A
const a = await page.evaluate(async () => {
  const { bus } = await import("/js/store.js");
  const ui = await import("/js/ui.js");
  const dmNew = [];
  const off = bus.on("dm:new", () => dmNew.push(1));
  await ui.openPanel("dms");
  await new Promise((r) => setTimeout(r, 300));
  const content = document.getElementById("panelContent");
  const bar = content?.querySelector(".dmstart");
  const input = bar?.querySelector("input");
  const btn = [...(bar?.querySelectorAll("button") || [])].find((b) => /new message/i.test(b.textContent));
  btn?.click();
  await new Promise((r) => setTimeout(r, 120));
  const out = {
    hasBar: !!bar,
    first: content?.firstElementChild === bar,
    inputType: input?.type || null,
    hasBtn: !!btn,
    dmNew: dmNew.length,
    footerBtns: document.querySelectorAll("#panelFooter button").length,
    pickerTitle: document.querySelector(".modal-back .modal-head strong")?.textContent || "",
    convRows: [...content.querySelectorAll(".dmrow[data-dm]")].map((r) => r.dataset.dm),
  };
  // The click opened the real picker; close it before the next leg.
  document.querySelector(".modal-back .modal-head button")?.click();
  await new Promise((r) => setTimeout(r, 120));
  out.pickerClosed = document.querySelectorAll(".modal-back").length === 0;
  off();
  return out;
});
ok(a.hasBar && a.first, "DMs panel does not start with the search / New message bar");
ok(a.inputType === "search", `bar input type '${a.inputType}', want search`);
ok(a.hasBtn, "no New message button in the DMs panel bar");
ok(a.dmNew === 1, `New message button emitted dm:new ${a.dmNew} times, want 1`);
ok(/new message/i.test(a.pickerTitle), `dm:new opened a dialog titled '${a.pickerTitle}', want New message`);
ok(a.pickerClosed, "picker did not close from its own X");
ok(a.footerBtns === 0, `${a.footerBtns} button(s) still in #panelFooter, want none`);
ok(JSON.stringify(a.convRows) === JSON.stringify(["c-ravi"]), `conversation rows ${JSON.stringify(a.convRows)}, want the seeded one`);

// ------------------------------------------------------------------ leg B
const rpcBefore = wire.rpc.length;
const b = await page.evaluate(async () => {
  const { bus, store } = await import("/js/store.js");
  const starts = [];
  const off = bus.on("dm:start", (p) => starts.push(p));
  const input = document.querySelector("#panelContent .dmstart input");
  input.value = "sour";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));   // past the 120ms debounce
  const people = [...document.querySelectorAll("#panelContent .dm-person")].map((r) => r.dataset.user);
  const sections = [...document.querySelectorAll("#panelContent h4.sec")].map((h) => h.textContent.trim());
  const convRows = [...document.querySelectorAll("#panelContent .dmrow[data-dm]")].map((r) => r.dataset.dm);
  const pillOnRow = !!document.querySelector('#panelContent .dm-person[data-user="u-sourabh"] .pill-admin');
  document.querySelector('#panelContent .dm-person[data-user="u-sourabh"]')?.click();
  await new Promise((r) => setTimeout(r, 600));
  off();
  return {
    people, sections, convRows, starts, pillOnRow,
    currentDM: store.currentDM,
    inList: store.dms.some((d) => d.conversation_id === "conv-new"),
    header: document.getElementById("hdrName")?.textContent || "",
  };
});
ok(JSON.stringify(b.people) === JSON.stringify(["u-sourabh"]),
  `People for 'sour' = ${JSON.stringify(b.people)}, want Sourabh only (the app is not a person)`);
ok(JSON.stringify(b.sections) === JSON.stringify(["People"]), `sections ${JSON.stringify(b.sections)}, want People only`);
ok(b.convRows.length === 0, `'sour' matched conversations ${JSON.stringify(b.convRows)}, want none`);
ok(b.pillOnRow === false, "Sourabh is not an admin here but got a pill");
ok(b.starts.length === 1 && b.starts[0]?.userId === "u-sourabh", `dm:start payloads ${JSON.stringify(b.starts)}`);
const createCalls = wire.rpc.slice(rpcBefore).filter((r) => r.fn === "create_dm");
ok(createCalls.length === 1, `create_dm called ${createCalls.length} times, want 1`);
ok(JSON.stringify(createCalls[0]?.body?.p_users) === JSON.stringify(["u-sourabh"]),
  `create_dm p_users ${JSON.stringify(createCalls[0]?.body?.p_users)}`);
ok(b.currentDM === "conv-new" && b.inList, `conversation not opened (currentDM ${b.currentDM}, listed ${b.inList})`);
ok(/sourabh/i.test(b.header), `header '${b.header}' does not name Sourabh`);

// ------------------------------------------------------------------ leg C
const c = await page.evaluate(async () => {
  const ui = await import("/js/ui.js");
  await ui.openPanel("dms");
  await new Promise((r) => setTimeout(r, 300));
  const input = document.querySelector("#panelContent .dmstart input");
  input.value = "rav";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  const out = {
    people: [...document.querySelectorAll("#panelContent .dm-person")].map((r) => r.dataset.user),
    convRows: [...document.querySelectorAll("#panelContent .dmrow[data-dm]")].map((r) => r.dataset.dm),
  };
  // And an admin's row carries the pill where a 1:1 with them exists.
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  out.hintShown = getComputedStyle(document.querySelector("#panelContent .dm-hint")).display !== "none";
  ui.closePanel();
  return out;
});
ok(JSON.stringify(c.convRows) === JSON.stringify(["c-ravi"]), `'rav' conversations ${JSON.stringify(c.convRows)}`);
ok(c.people.length === 0, `'rav' offered People ${JSON.stringify(c.people)} although a 1:1 exists`);
ok(c.hintShown === true, "the 'type a name' hint is hidden with an empty query");

// ------------------------------------------------------------------ leg D
const d = await page.evaluate(async () => {
  const { bus } = await import("/js/store.js");
  const modals = () => document.querySelectorAll(".modal-back").length;
  const before = modals();
  bus.emit("dm:new", { conversation_id: "c-x", author_id: "u-ravi", seq: 3 });
  bus.emit("dm:incoming", { conversation_id: "c-x", author_id: "u-ravi", seq: 3 });
  await new Promise((r) => setTimeout(r, 150));
  const afterArrivals = modals();
  bus.emit("dm:new");
  await new Promise((r) => setTimeout(r, 150));
  const afterBare = modals();
  const title = document.querySelector(".modal-back .modal-head strong")?.textContent || "";
  document.querySelector(".modal-back .modal-head button")?.click();
  await new Promise((r) => setTimeout(r, 120));
  return { before, afterArrivals, afterBare, title, closed: modals() === before };
});
ok(d.afterArrivals === d.before, `a DM arrival opened ${d.afterArrivals - d.before} dialog(s)`);
ok(d.afterBare === d.before + 1 && /new message/i.test(d.title),
  `bare dm:new opened ${d.afterBare - d.before} dialog(s) titled '${d.title}'`);
ok(d.closed, "picker did not close");

// ------------------------------------------------------------------ leg E
const e = await page.evaluate(async () => {
  const ui = await import("/js/ui.js");
  ui.registerPanel({
    id: "probe-foot", title: "Probe", replaces: true,
    async render(body) { body.textContent = "probe"; },
    footer(foot) {
      const b = document.createElement("button");
      b.id = "probeFootBtn";
      b.textContent = "Foot";
      foot.appendChild(b);
    },
  });
  await ui.openPanel("probe-foot");
  await new Promise((r) => setTimeout(r, 400));   // past the sheet-in animation
  const btn = document.getElementById("probeFootBtn");
  const tb = document.getElementById("tabbar");
  const br = btn?.getBoundingClientRect();
  const tr = tb?.getBoundingClientRect();
  const out = {
    btnBottom: br ? Math.round(br.bottom) : null,
    tabTop: tr ? Math.round(tr.top) : null,
    tabDisplay: tb ? getComputedStyle(tb).display : null,
    panelPos: getComputedStyle(document.getElementById("panel")).position,
  };
  ui.closePanel();
  return out;
});
console.log(`leg E geometry: footer button bottom ${e.btnBottom}px, tab bar top ${e.tabTop}px`);
ok(e.tabDisplay && e.tabDisplay !== "none", `tab bar display '${e.tabDisplay}' at phone width (leg E invalid)`);
ok(e.panelPos === "fixed", `panel position '${e.panelPos}' at phone width (leg E invalid)`);
ok(e.btnBottom != null && e.tabTop != null && e.btnBottom <= e.tabTop,
  `footer button bottom ${e.btnBottom}px vs tab bar top ${e.tabTop}px: the footer sits under the tab bar`);

// ------------------------------------------------------------------ leg F
const rpcF = wire.rpc.length;
const tabF = wire.tables.length;
const f = await page.evaluate(async () => {
  const { store } = await import("/js/store.js");
  const msgs = await import("/js/core/messages.js");
  store.currentDM = null;
  store.current = null;
  store.msgCache.set("dm-1", { id: "dm-1", conversation_id: "c-ravi", author_id: "u-ravi", body_text: "hi" });
  store.msgCache.set("ch-1", { id: "ch-1", channel_id: "ch-a", author_id: "u-ravi", body_text: "hi" });
  await msgs.toggleReaction("dm-1", "👍");
  await msgs.toggleReaction("ch-1", "👍");
  await msgs.loadReactions(["dm-1"]);
  await msgs.loadReactions(["ch-1"]);
  await msgs.loadReactions(["dm-1"], { dm: true });
  return {
    isDM: msgs.isDMMessage("dm-1"), isCh: msgs.isDMMessage("ch-1"),
    toasts: [...document.querySelectorAll(".toast, .toasts > *")].map((t) => t.textContent),
  };
});
const rpcs = wire.rpc.slice(rpcF);
const dmToggle = rpcs.filter((r) => r.fn === "toggle_dm_reaction");
const chToggle = rpcs.filter((r) => r.fn === "toggle_reaction");
const reads = wire.tables.slice(tabF);
ok(f.isDM === true && f.isCh === false, `isDMMessage dm=${f.isDM} ch=${f.isCh}`);
ok(dmToggle.length === 1 && dmToggle[0].body?.p_message === "dm-1" && dmToggle[0].body?.p_emoji === "👍",
  `toggle_dm_reaction calls ${JSON.stringify(dmToggle)}`);
ok(chToggle.length === 1 && chToggle[0].body?.p_message === "ch-1",
  `toggle_reaction calls ${JSON.stringify(chToggle)}`);
ok(reads.filter((t) => t === "dm_message_reactions").length === 2,
  `dm_message_reactions reads ${JSON.stringify(reads)}, want 2`);
ok(reads.filter((t) => t === "message_reactions").length === 1,
  `message_reactions reads ${JSON.stringify(reads)}, want 1`);

// ------------------------------------------------------------------ leg G
const g = await page.evaluate(async () => {
  const { store, bus } = await import("/js/store.js");
  const { buildMessage } = await import("/js/core/messages.js");
  const now = new Date().toISOString();
  const mk = (id, author) => buildMessage(
    { id, author_id: author, body_text: "hello", created_at: now, channel_id: "ch-a", seq: 1 },
    { context: "static" });
  const rowA = mk("m-a", "u-aashika");
  const rowO = mk("m-o", "u-me");
  const rowR = mk("m-r", "u-ravi");
  const pill = (r) => r.querySelector(".mhead .pill-admin")?.textContent || null;
  const host = document.getElementById("messages");
  host.innerHTML = "";
  host.append(rowA, rowO, rowR);
  const before = { a: pill(rowA), o: pill(rowO), r: pill(rowR) };
  store.admins.set("u-ravi", "admin");
  store.admins.delete("u-aashika");
  bus.emit("admins");
  const after = { a: pill(rowA), o: pill(rowO), r: pill(rowR) };
  const dup = [...host.querySelectorAll(".pill-admin")].length;
  host.innerHTML = "";
  return { before, after, dup };
});
ok(g.before.a === "ADMIN" && g.before.o === "OWNER" && g.before.r === null,
  `pills at build ${JSON.stringify(g.before)}, want ADMIN / OWNER / none`);
ok(g.after.a === null && g.after.o === "OWNER" && g.after.r === "ADMIN",
  `pills after 'admins' ${JSON.stringify(g.after)}, want none / OWNER / ADMIN`);
ok(g.dup === 2, `${g.dup} pills on three rows after the repaint, want 2`);

console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
process.exitCode = problems.length ? 1 : 0;
await browser.close();
