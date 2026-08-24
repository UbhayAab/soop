import { chromium, devices } from "playwright";

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:4177";
const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices["iPhone 13 Pro"] })).newPage();
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);

// Signed out, boot hides #chat (auth gate) and marks body.no-team (channelbar
// hidden). The CSS facts under test are shell facts, so reveal the shell the
// way a signed-in session would see it.
await page.evaluate(() => {
  document.getElementById("chat")?.classList.remove("hidden");
  document.body.classList.remove("no-team");
});
await page.waitForTimeout(200);

const narrow = await page.evaluate(() => {
  const cs = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el) : null;
  };
  const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const app = rect("#app");
  const topbar = rect("#topbar");
  const bar = rect("#channelbar");
  const sw = rect("#placeSwitcher");
  const more = rect("#btnMore");
  const actions = cs("#headerActions");
  const invite = cs("#btnInvite");
  const caret = !!document.querySelector("#placeSwitcher .ps-caret .ico, #placeSwitcher .ps-caret svg");
  return {
    appW: app?.width,
    topH: topbar?.height,
    barH: bar?.height,
    swVisible: !!sw && sw.width > 0 && sw.height > 0,
    caret,
    moreVisible: !!more && more.width > 0,
    actionsDisplay: actions?.display,
    inviteDisplay: invite?.display,
    headerVar: getComputedStyle(document.querySelector("#chat")).getPropertyValue("--header-h").trim(),
  };
});
ok(narrow.appW <= 480, `app box ${narrow.appW}px, test invalid`);
ok(narrow.topH === 0, `topbar height ${narrow.topH}, want 0`);
ok(Math.round(narrow.barH) === 40, `channelbar height ${narrow.barH}, want 40`);
ok(narrow.swVisible, "place switcher not visible");
ok(narrow.caret, "switcher caret icon missing");
ok(narrow.moreVisible, "More button not visible");
ok(narrow.actionsDisplay === "none", `headerActions display ${narrow.actionsDisplay}`);
ok(narrow.inviteDisplay === "none", `btnInvite display ${narrow.inviteDisplay}`);
ok(narrow.headerVar === "0px", `--header-h ${narrow.headerVar}`);

// Switcher opens the drawer exactly like the old navToggle.
await page.evaluate(() => document.getElementById("placeSwitcher").click());
await page.waitForTimeout(250);
const drawerOpen = await page.evaluate(() => document.body.classList.contains("nav-open"));
ok(drawerOpen, "switcher click did not open the drawer");

// More menu carries the merged-header rows at this width.
await page.evaluate(() => document.getElementById("placeSwitcher").click()); // close drawer again
await page.waitForTimeout(250);
await page.evaluate(() => document.getElementById("btnMore").click());
await page.waitForTimeout(250);
const menuLabels = await page.evaluate(() =>
  [...document.querySelectorAll(".ctxmenu .ctx-item")].map((n) => n.textContent?.trim()).filter(Boolean)
);
const hasSearch = menuLabels.some((t) => t === "Search");
const hasMark = menuLabels.some((t) => t === "Mark everything read");
const hasKeys = menuLabels.some((t) => t === "Keyboard shortcuts");
ok(hasSearch && hasMark && hasKeys, `merged rows missing from More menu (got: ${menuLabels.slice(0, 12).join(" | ")})`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// Voicebar: single line strip when live.
const voice = await page.evaluate(() => {
  const v = document.getElementById("voicebar");
  v.classList.remove("hidden");
  const cs = getComputedStyle(v);
  const r = v.getBoundingClientRect();
  const leave = document.getElementById("vleave")?.getBoundingClientRect();
  const label = v.querySelector(".vlabel")?.getBoundingClientRect();
  const mid = (r) => r.top + r.height / 2;
  return {
    wrap: cs.flexWrap,
    pad: cs.padding,
    h: r.height,
    sameLine: !!leave && !!label && Math.abs(mid(leave) - mid(label)) < 4,
  };
});
ok(voice.wrap === "nowrap", `voicebar flex-wrap ${voice.wrap}`);
ok(voice.h <= 32, `voicebar height ${voice.h}, want a ~28px strip`);
ok(voice.sameLine, "voicebar wrapped onto two lines");
ok(voice.spBasis !== "100%", `spacer hack still present (flex-basis ${voice.spBasis})`);

// Connection banner floats under the one header when delivery is down.
const conn = await page.evaluate(() => {
  const c = document.getElementById("connState");
  c.classList.remove("hidden");
  const r = c.getBoundingClientRect();
  const bar = document.getElementById("channelbar").getBoundingClientRect();
  return { top: r.top, belowBar: r.top >= bar.bottom - 2, visible: r.height > 0 };
});
ok(conn.visible && conn.belowBar, `connState top ${conn.top} not pinned under merged header`);

// Wide sanity: nothing changed for desktop boxes.
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(400);
const wide = await page.evaluate(() => ({
  topH: document.getElementById("topbar").getBoundingClientRect().height,
  barH: document.getElementById("channelbar").getBoundingClientRect().height,
}));
ok(wide.topH > 40, `wide topbar height ${wide.topH}, should be restored`);
ok(Math.round(wide.barH) === 49, `wide channelbar height ${wide.barH}, want 49`);

console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
process.exitCode = problems.length ? 1 : 0;
await browser.close();
