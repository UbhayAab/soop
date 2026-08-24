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

const r = await page.evaluate(async () => {
  const out = {};
  // Fire the real paths: an uncaught-style error event and a core toast.
  window.dispatchEvent(new ErrorEvent("error", { error: new Error("probe-error") }));
  const ui = await import("./js/ui.js");
  ui.toast("probe toast");

  await new Promise((res) => setTimeout(res, 350));

  const bar = document.querySelector(".errbar");
  const col = document.querySelector("section.msgs");
  const list = document.getElementById("messages");
  const comp = document.getElementById("composerBar");

  if (!bar) { out.errbar = "ABSENT"; return out; }
  out.errbarParent = bar.parentElement === col ? "section.msgs" : bar.parentElement?.tagName;
  out.errbarAfterList = bar.previousElementSibling === list;
  out.errbarPosition = getComputedStyle(bar).position;
  out.errbarZ = getComputedStyle(bar).zIndex;

  // Overlap: bar must sit fully above the composer box (or composer hidden).
  const b = bar.getBoundingClientRect();
  const c = comp.getBoundingClientRect();
  out.composerVisible = c.height > 0 && getComputedStyle(comp).display !== "none";
  out.overlapWithComposer = out.composerVisible
    ? (b.bottom > c.top + 0.5 && b.top < c.bottom - 0.5)
    : false;

  // Fallback rule sanity: moving it to body flips it to the ladder overlay.
  document.body.appendChild(bar);
  out.bodyPosition = getComputedStyle(bar).position;
  out.bodyZ = getComputedStyle(bar).zIndex;

  // Toast anchoring: unhide the composer so it has real height, let the
  // ResizeObserver publish --composer-h, then read .toasts geometry.
  document.body.classList.remove("no-team");
  await new Promise((res) => setTimeout(res, 250));
  const h = comp.offsetHeight;
  out.composerH = h;
  out.varComposerH = document.documentElement.style.getPropertyValue("--composer-h");
  const th = document.querySelector(".toasts");
  out.toastsBottom = parseFloat(getComputedStyle(th).bottom);
  out.toastClearsComposer = out.toastsBottom >= h + 32 - 1;

  // Leave a visible bar back in flow + toast for the screenshot.
  col.insertBefore(bar, list.nextSibling);
  return out;
});
console.log("probe:", JSON.stringify(r, null, 2));

await page.screenshot({ path: "shots/errbar9-phone.png" });

const expect = [
  ["errbarParent", "section.msgs"], ["errbarAfterList", true], ["errbarPosition", "static"],
  ["bodyPosition", "fixed"], ["bodyZ", "300"],
];
for (const [k, v] of expect) if (r[k] !== v) problems.push(`MISMATCH ${k}=${r[k]} want ${v}`);
if (r.overlapWithComposer) problems.push("errbar overlaps composer");
if (!r.toastClearsComposer) problems.push(`toasts bottom ${r.toastsBottom} does not clear composer ${r.composerH}`);

console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "PROBE CLEAN");
await browser.close();
process.exit(problems.length ? 1 : 0);
