import { chromium } from "playwright";

const base = "http://127.0.0.1:4177";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`[console.error] ${m.text()}`); });

await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1800);

const r = await page.evaluate(() => {
  const out = {};
  const root = document.documentElement;

  // 1. Seed honesty: dataset.input must equal the any-pointer:fine answer.
  const fine = matchMedia("(any-pointer: fine)").matches;
  out.seedMatchesMedia = root.dataset.input === (fine ? "mouse" : "touch");
  out.seedValue = root.dataset.input;

  // 2. The pointer split itself: synthetic pointerdowns flip the attribute.
  window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
  out.afterTouch = root.dataset.input;
  window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
  out.afterMouse = root.dataset.input;
  // pen is not a mouse either; the doc maps everything non-mouse to touch.
  window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", bubbles: true }));
  out.afterPen = root.dataset.input;

  // 3. CSS gate, ctx-item tier: base -> 44px under touch, back under mouse.
  const probe = document.createElement("button");
  probe.className = "ctx-item";
  document.body.appendChild(probe);
  root.dataset.input = "touch";
  out.ctxTouch = getComputedStyle(probe).minHeight;
  root.dataset.input = "mouse";
  out.ctxMouse = getComputedStyle(probe).minHeight;

  // 4. Sidebar three tiers through a stand-in #sidebar (sign-in gate hides the
  //    real one): 34px bare base, 44px touch floor, 28px mouse compaction.
  const sb = document.createElement("div");
  sb.id = "sidebar";
  sb.innerHTML = '<div class="chan"></div>';
  document.body.appendChild(sb);
  const chan = sb.querySelector(".chan");
  delete root.dataset.input;
  out.chanBase = getComputedStyle(chan).minHeight;
  root.dataset.input = "touch";
  out.chanTouch = getComputedStyle(chan).minHeight;
  root.dataset.input = "mouse";
  out.chanMouse = getComputedStyle(chan).minHeight;

  probe.remove();
  sb.remove();
  // Leave the honest seed in place for the screenshot.
  root.dataset.input = matchMedia("(any-pointer: fine)").matches ? "mouse" : "touch";
  return out;
});
console.log("probe:", JSON.stringify(r, null, 2));

await page.screenshot({ path: "shots/burst-density5.png" });

if (!r.seedMatchesMedia) problems.push(`seed ${r.seedValue} disagrees with any-pointer media`);
if (r.afterTouch !== "touch") problems.push(`afterTouch=${r.afterTouch}`);
if (r.afterMouse !== "mouse") problems.push(`afterMouse=${r.afterMouse}`);
if (r.afterPen !== "touch") problems.push(`afterPen=${r.afterPen}`);
if (r.ctxTouch !== "44px") problems.push(`ctx-item touch minHeight=${r.ctxTouch} want 44px`);
if (!(parseFloat(r.ctxMouse) < 44)) problems.push(`ctx-item mouse minHeight=${r.ctxMouse} should drop below 44`);
if (r.chanBase !== "34px") problems.push(`chan base=${r.chanBase} want 34px`);
if (r.chanTouch !== "44px") problems.push(`chan touch=${r.chanTouch} want 44px`);
if (r.chanMouse !== "28px") problems.push(`chan mouse=${r.chanMouse} want 28px`);

console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "PROBE CLEAN");
await browser.close();
process.exit(problems.length ? 1 : 0);
