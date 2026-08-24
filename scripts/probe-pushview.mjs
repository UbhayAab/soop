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
// are shell geometry, so reveal the shell the way a signed-in session sees it.
await page.evaluate(() => {
  document.getElementById("chat")?.classList.remove("hidden");
  document.body.classList.remove("no-team");
});
await page.waitForTimeout(200);

// Closed drawer stays parked off-canvas at this width.
const closed = await page.evaluate(() => {
  const sb = document.getElementById("sidebar");
  const cs = getComputedStyle(sb);
  return { pe: cs.pointerEvents, transform: cs.transform };
});
ok(closed.pe === "none", `closed drawer pointer-events ${closed.pe}, want none`);

// Open it through the real switcher path.
await page.evaluate(() => document.getElementById("placeSwitcher").click());
await page.waitForTimeout(350);

const pushed = await page.evaluate(() => {
  const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const app = rect("#app");
  const sb = rect("#sidebar");
  const rail = rect("#spaceRail") || rect("#sidebar").left ? null : null;
  return {
    navOpen: document.body.classList.contains("nav-open"),
    appL: app?.left,
    appR: app?.right,
    appW: app?.width,
    sbL: sb?.left,
    sbR: sb?.right,
    sbW: sb?.width,
    railR: (() => { const r = document.getElementById("spaceRail")?.getBoundingClientRect(); return r ? r.right : null; })(),
    shadow: getComputedStyle(document.getElementById("sidebar")).boxShadow,
  };
});
ok(pushed.navOpen, "switcher click did not open the drawer");
ok(pushed.appW <= 440, `app box ${pushed.appW}px, container gate not exercised`);
ok(Math.abs(pushed.sbL - pushed.appL) < 1.5, `drawer left ${pushed.sbL} vs app left ${pushed.appL}, want flush`);
ok(pushed.sbR >= pushed.appR - 1.5, `drawer right ${pushed.sbR} vs app right ${pushed.appR}, sliver still visible`);
ok(pushed.railR === null || pushed.sbR >= pushed.railR - 0.5, "drawer does not reach across the rail");
ok(pushed.shadow === "none" || pushed.shadow === "", `open drawer shadow ${pushed.shadow}, want none on a pushed view`);

// Close it again through the same switcher.
await page.evaluate(() => document.getElementById("placeSwitcher").click());
await page.waitForTimeout(250);
const shutAgain = await page.evaluate(() => !document.body.classList.contains("nav-open"));
ok(shutAgain, "switcher click did not close the pushed view");

// Mid-width sanity: between 441 and 860px the classic overlay drawer survives.
await page.setViewportSize({ width: 700, height: 900 });
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById("placeSwitcher").click());
await page.waitForTimeout(350);
const mid = await page.evaluate(() => {
  const app = document.getElementById("app").getBoundingClientRect();
  const sb = document.getElementById("sidebar").getBoundingClientRect();
  return { appW: app.width, sbW: sb.width, sbR: sb.right, appR: app.right };
});
ok(mid.appW > 440 && mid.appW <= 860, `mid app box ${mid.appW}px, test invalid`);
ok(mid.sbW <= 300, `mid drawer width ${mid.sbW}px, want the ~272px overlay drawer`);
ok(mid.sbR < mid.appR - 40, "mid drawer went full width above 440px");

console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
process.exitCode = problems.length ? 1 : 0;
await browser.close();
