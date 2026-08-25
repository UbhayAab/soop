// Breakpoint-crossing teardown behavioral probe (7552bac shipped with only a
// boot screenshot). Drives the REAL booted shell across the 860px boundary
// with Playwright viewport resizes and asserts, against counted bus
// 'panel:close' emissions heard on the app's own singleton bus:
//   A. an open drawer is retired on widening - body.nav-open stripped and the
//      layout.css:984 scrim (#messages::after, outside every width query)
//      back to pointer-events none instead of eating every click;
//   B. an open panel sheet gets the FULL closePanel teardown on widening -
//      exactly one panel:close emission, body.panel-open gone, aside#panel
//      re-hidden, currentPanel() null, back chevron hidden;
//   C. idle crossings (nothing open) emit ZERO spurious panel:close.
// Module instances come from in-page dynamic import - the same singletons the
// app uses (probe-tabbar precedent), so registration wiring is exercised, not
// reimplemented. Accepted gaps, named: applyCap()'s inline-cap repaint on
// crossing is ui-internal and unobserved here; the matches=true early return
// is covered only negatively by leg C's narrow crossings.
import { chromium, devices } from "playwright";

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:4177";
const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices["iPhone 13 Pro"] })).newPage();
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);

// Signed out, boot hides #chat and marks body.no-team. The facts under test
// are shell facts, so reveal the shell the way a signed-in session sees it.
await page.evaluate(() => {
  document.getElementById("chat")?.classList.remove("hidden");
  document.body.classList.remove("no-team");
});
await page.waitForTimeout(200);

// Count panel:close on the app's own bus instance.
let count = 0;
await page.evaluate(() => import("/js/store.js").then(({ bus }) => {
  window.__bpCount = 0;
  bus.on("panel:close", () => { window.__bpCount++; });
}));
const readCount = async () => page.evaluate(() => window.__bpCount);
const resetCount = async () => page.evaluate(() => { window.__bpCount = 0; });

const scrimPE = () => page.evaluate(() => {
  const cs = getComputedStyle(document.getElementById("messages"), "::after");
  return cs.pointerEvents;
});

// ---- Leg A: widening retires an open drawer -------------------------------
await page.evaluate(() => document.getElementById("placeSwitcher").click());
await page.waitForTimeout(300);
ok(await page.evaluate(() => document.body.classList.contains("nav-open")),
  "leg A setup: switcher click did not open the drawer");
ok((await scrimPE()) === "auto", "leg A setup: scrim not alive under open drawer");

await resetCount();
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(600);
ok(!(await page.evaluate(() => document.body.classList.contains("nav-open"))),
  "leg A: nav-open survived the widening");
ok((await scrimPE()) === "none",
  "leg A: scrim still eats clicks at wide width (pointer-events not restored)");
ok((await readCount()) === 0,
  "leg A: drawer retire emitted panel:close (must strip the class silently)");

// ---- Leg B: widening gives an open sheet the full closePanel teardown -----
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);

const opened = await page.evaluate(async () => {
  const ui = await import("/js/ui.js");
  await ui.openPanel("forms", {});
  return {
    panelOpen: document.body.classList.contains("panel-open"),
    asideShown: !document.getElementById("panel").classList.contains("hidden"),
    cur: ui.currentPanel(),
  };
});
ok(opened.panelOpen && opened.asideShown && opened.cur === "forms",
  `leg B setup: forms panel did not open (${JSON.stringify(opened)})`);

await resetCount();
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(600);
const closed = await page.evaluate(async () => {
  const ui = await import("/js/ui.js");
  return {
    n: window.__bpCount,
    panelOpen: document.body.classList.contains("panel-open"),
    asideHidden: document.getElementById("panel").classList.contains("hidden"),
    backHidden: document.getElementById("panelBack")?.classList.contains("hidden"),
    contentEmpty: document.getElementById("panelContent")?.innerHTML === "",
    cur: ui.currentPanel(),
  };
});
ok(closed.n === 1, `leg B: expected exactly one panel:close on crossing, got ${closed.n}`);
ok(!closed.panelOpen, "leg B: body.panel-open survived the widening");
ok(closed.asideHidden, "leg B: aside#panel left visible (no closePanel teardown)");
ok(closed.backHidden, "leg B: panel back chevron left visible");
ok(closed.contentEmpty, "leg B: panelContent not emptied (teardown skipped)");
ok(closed.cur === null, `leg B: currentPanel() ${closed.cur}, want null`);

// ---- Leg C: idle crossings emit nothing -----------------------------------
// Reset surface state first so a leg-A/B failure cannot cascade into this
// leg's attribution (the idle guard is about emissions, not leftovers).
await page.evaluate(() => document.body.classList.remove("nav-open", "panel-open"));
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await resetCount();
for (const w of [1280, 390, 1280, 390]) {
  await page.setViewportSize({ width: w, height: 800 > w ? 800 : 844 });
  await page.waitForTimeout(350);
}
ok((await readCount()) === 0,
  "leg C: idle crossing emitted a spurious panel:close");
ok(!(await page.evaluate(() => document.body.classList.contains("nav-open"))),
  "leg C: nav-open appeared from nowhere during idle crossings");

console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
process.exitCode = problems.length ? 1 : 0;
await browser.close();
