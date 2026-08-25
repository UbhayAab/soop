// Behavioral guard for js/tabbar.js and js/features/dmlist.js - the two mobile
// surfaces no other probe owns. Drives the REAL modules the app booted (in-page
// dynamic import returns the same module instances) so registration wiring,
// bus bindings and panel registry are exercised, not reimplemented.
//
// Standalone needs a server on PROBE_BASE (default 127.0.0.1:4177); the embed
// leg needs one on :8098 (EMBED_ORIGINS dev-adds localhost:8098) - override
// with PROBE_EMBED_BASE. scripts/probe-all.mjs serves both ports itself.
import { chromium, devices } from "playwright";

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:4177";
const EMBED = process.env.PROBE_EMBED_BASE || "http://localhost:8098";
const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };

const browser = await chromium.launch();

// ---- Standalone boot ----
const page = await (await browser.newContext({ ...devices["iPhone 13 Pro"] })).newPage();
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);

// Signed-out boot hides the shell; reveal it the way a signed-in session sees
// it (probe-pushview precedent).
await page.evaluate(() => {
  document.getElementById("chat")?.classList.remove("hidden");
  document.body.classList.remove("no-team");
});
await page.waitForTimeout(200);

// 1. Bar structure: adopted static node sits in #chat with exactly four tabs.
const bars = await page.evaluate(() => {
  const tb = document.getElementById("tabbar");
  if (!tb) return null;
  return {
    inChat: tb.parentElement?.id === "chat",
    hiddenClass: tb.classList.contains("hidden"),
    display: getComputedStyle(tb).display,
    tabs: [...tb.querySelectorAll(".tab")].map((b) => b.dataset.tab),
    labels: [...tb.querySelectorAll(".tab")].map((b) => b.getAttribute("aria-label")),
  };
});
ok(bars !== null, "no #tabbar element after boot");
if (bars) {
  ok(bars.inChat, "tabbar not inside #chat");
  ok(!bars.hiddenClass && bars.display !== "none", `tabbar hidden at phone width (display ${bars.display})`);
  ok(JSON.stringify(bars.tabs) === JSON.stringify(["home", "dms", "activity", "later"]),
    `tabs ${JSON.stringify(bars.tabs)}, want home/dms/activity/later`);
  ok(bars.labels.every((l) => l), "a tab is missing its aria-label");
}

// 2. Badges follow the stores through the real bus binding. Seeding the same
// module instance main.js handed to tabbar.js is what makes this a wiring test.
const seedUnread = await page.evaluate(() =>
  import("/js/store.js").then(({ store, bus }) => {
    store.unread.set("ch1", { unread: false, mention_count: 2 });
    store.dms.push({ conversation_id: "dm1", other_user_ids: ["u1"], unread: 120 });
    bus.emit("unread", {});
    const dot = (id) => {
      const d = document.querySelector(`.tab[data-tab="${id}"] .tab-dot`);
      return d ? { show: d.classList.contains("show"), text: d.textContent } : null;
    };
    const r = { home: dot("home"), dms: dot("dms") };
    store.unread.clear();
    store.dms.length = 0;
    bus.emit("unread", {});
    r.homeAfter = dot("home");
    r.dmsAfter = dot("dms");
    return r;
  })
);
ok(seedUnread.home?.show === true, "home dot did not light on a mention");
ok(seedUnread.dms?.show === true, "dms dot did not light on an unread count");
ok(seedUnread.dms?.text === "99+", `dms count 120 rendered '${seedUnread.dms?.text}', want 99+ clamp`);
ok(seedUnread.homeAfter?.show === false, "home dot did not clear when unread emptied");
ok(seedUnread.dmsAfter?.show === false, "dms dot did not clear when dms emptied");

// 3. DMs tab with no active conversation opens the dedicated dms panel, not
// the drawer - the documented fallback reversal.
await page.evaluate(() => import("/js/ui.js").then((ui) => ui.closePanel()));
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector('.tab[data-tab="dms"]').click());
await page.waitForTimeout(400);
const dmsOpen = await page.evaluate(async () => {
  const ui = await import("/js/ui.js");
  return {
    panel: ui.currentPanel(),
    title: document.querySelector("#panelTitle")?.textContent || "",
    active: document.querySelector('.tab[data-tab="dms"]').classList.contains("on"),
  };
});
ok(dmsOpen.panel === "dms", `DMs tap opened '${dmsOpen.panel}', want dms panel`);
ok(/direct/i.test(dmsOpen.title), `panel title '${dmsOpen.title}', want Direct messages`);
ok(dmsOpen.active === true, "dms tab did not take the active state");

// 4. Any tab tap closes an open drawer.
await page.evaluate(() => document.getElementById("placeSwitcher").click());
await page.waitForTimeout(250);
const drawerWas = await page.evaluate(() => document.body.classList.contains("nav-open"));
await page.evaluate(() => document.querySelector('.tab[data-tab="home"]').click());
await page.waitForTimeout(250);
const drawerGone = await page.evaluate(() => !document.body.classList.contains("nav-open"));
ok(drawerWas === true, "drawer did not open via switcher (test invalid)");
ok(drawerGone === true, "tab tap left the drawer open");

// 5. Active state rides the same bus events core fires.
await page.evaluate(() =>
  import("/js/store.js").then(({ bus }) => {
    bus.emit("channel:open", { id: "x" });
    bus.emit("dm:open", {});
  })
);
await page.waitForTimeout(150);
const activeNow = await page.evaluate(() => ({
  dms: document.querySelector('.tab[data-tab="dms"]').classList.contains("on"),
}));
ok(activeNow.dms === true, "dm:open did not move active to the dms tab");

// 6. Panel content: sort, unread shapes, group label, footer verb, row verb.
const list = await page.evaluate(async () => {
  const { store, bus } = await import("/js/store.js");
  const t = Date.now();
  store.dms.push(
    { conversation_id: "c-old", other_user_ids: ["u1"], last_message_at: new Date(t - 36e5).toISOString(), unread: 0 },
    { conversation_id: "c-new", other_user_ids: ["u2"], last_message_at: new Date(t - 6e4).toISOString(), unread: true },
    { conversation_id: "c-grp", other_user_ids: ["u3", "u4"], last_message_at: new Date(t - 6e5).toISOString(), unread: 2 },
    { conversation_id: "c-never", other_user_ids: ["u5"], last_message_at: null, unread: false }
  );
  const dmNew = [];
  const dmReq = [];
  bus.on("dm:new", () => dmNew.push(1));
  bus.on("dm:request", (p) => dmReq.push(p.conversationId));
  const ui = await import("/js/ui.js");
  await ui.openPanel("dms");
  await new Promise((r) => setTimeout(r, 350));
  const body = document.getElementById("panelContent");
  const rows = [...body.querySelectorAll(".dmrow")];
  const out = {
    order: rows.map((r) => r.dataset.dm),
    newBadge: rows.find((r) => r.dataset.dm === "c-new")?.querySelector(".dot-unread") ? true : false,
    grpBadge: rows.find((r) => r.dataset.dm === "c-grp")?.querySelector(".badge")?.textContent,
    grpSub: rows.find((r) => r.dataset.dm === "c-grp")?.querySelector(".sub")?.textContent || "",
    quiet: (() => {
      const r = rows.find((x) => x.dataset.dm === "c-old");
      return r ? (!!r.querySelector(".badge") || !!r.querySelector(".dot-unread")) : null;
    })(),
    footerBtn: [...document.querySelectorAll("#panelFooter button")].some((b) => /new message/i.test(b.textContent)),
  };
  // Footer verb FIRST: a row click routes into openDM, which retires this very
  // panel and empties #panelFooter - the button must be exercised while alive.
  document.querySelector("#panelFooter button")?.click();
  await new Promise((r) => setTimeout(r, 100));
  out.dmNew = dmNew.length;
  rows.find((r) => r.dataset.dm === "c-new")?.click();
  await new Promise((r) => setTimeout(r, 100));
  out.dmReq = dmReq;
  // leave the stores exactly as found
  store.dms.length = 0;
  ui.closePanel();
  return out;
});
ok(JSON.stringify(list.order) === JSON.stringify(["c-new", "c-grp", "c-old", "c-never"]),
  `row order ${JSON.stringify(list.order)}, want newest-first with never-written last`);
ok(list.newBadge === true, "boolean-unread row shows no dot");
ok(list.grpBadge === "2", `group row badge '${list.grpBadge}', want 2`);
ok(list.grpSub.includes("group"), `group row sub '${list.grpSub.trim()}', want the group hint`);
ok(list.quiet === false, "read row painted an unread marker");
ok(list.footerBtn === true, "no New message footer button");
ok(JSON.stringify(list.dmReq) === JSON.stringify(["c-new"]), `row click emitted ${JSON.stringify(list.dmReq)}`);
ok(list.dmNew === 1, "footer button did not emit dm:new");

// ---- Embed skip ----
// initTabBar must never run under embed.active; the static markup stays hidden.
const epage = await (await browser.newContext({ ...devices["iPhone 13 Pro"] })).newPage();
epage.on("pageerror", (e) => problems.push(`embed pageerror: ${e.message}`));
await epage.goto(EMBED + "/?embed=1&host=" + encodeURIComponent(EMBED), { waitUntil: "domcontentloaded", timeout: 30000 });
await epage.waitForTimeout(1500);
const emb = await epage.evaluate(() => {
  const tb = document.getElementById("tabbar");
  if (!tb) return { absent: true };
  return {
    absent: false,
    hiddenClass: tb.classList.contains("hidden"),
    display: getComputedStyle(tb).display,
    populated: tb.children.length > 0,
  };
});
ok(emb.absent || emb.hiddenClass || emb.display === "none",
  `tabbar visible in embed mode (display ${emb.display}, populated ${emb.populated})`);

console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
process.exitCode = problems.length ? 1 : 0;
await browser.close();
