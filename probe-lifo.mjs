// Probe: PLAN.md:822 LIFO close stack. Boot-level, no sign-in needed:
// drives js/ui.js directly in page context. Two passes: fallback keydown
// capture (flag forces it even on Chromium), then native CloseWatcher with
// real CDP keys (empirical: reported, not asserted - headless may not
// synthesize UA-level close requests).
import { chromium, devices } from "playwright";

const browser = await chromium.launch();
const lines = [];

async function newPage(disableCW) {
  const context = await browser.newContext({ ...devices["iPhone 13 Pro"] });
  const page = await context.newPage();
  if (disableCW) {
    await page.addInitScript(() => { window.DEK_DISABLE_CLOSEWATCHER = true; });
  }
  page.on("console", (m) => lines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message}`));
  await page.goto("http://127.0.0.1:4177/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(800);
  return { context, page };
}

// ---- pass 1: fallback keydown path ---------------------------------------
{
  const { context, page } = await newPage(true);
  const r = await page.evaluate(async () => {
    const out = [];
    const ui = await import("/js/ui.js");
    ui.wireEscLayers(); // idempotent; main calls it too but this page booted unsigned
    const depth = () => ui.escDepth();
    const q = (s) => !!document.querySelector(s);

    const m1 = ui.modal({ title: "Under", body: "<p>one</p>" });
    ui.contextMenu({ clientX: 40, clientY: 40 }, [{ label: "Item" }]);
    ui.popover(null, Object.assign(document.createElement("div"), { textContent: "pop" }));
    out.push(["opened 3 layers", "depth", depth(), "menu", q(".ctxmenu"), "pop", q(".popover")]);

    return { out, depth, q, closeM1: null };
  });

  // peel via REAL key events, asserted outside evaluate
  const snap = () => page.evaluate(() => ({
    d: window.__probeDepth?.() ?? null,
  }));
  // expose helpers for the press-assert loop
  await page.evaluate(() => {
    window.__probeState = () => ({
      menu: !!document.querySelector(".ctxmenu"),
      pop: !!document.querySelector(".popover"),
      modal: !!document.querySelector(".modal-back"),
    });
  });
  // re-import to read escDepth after presses
  const state = async () => ({
    ...(await page.evaluate(() => window.__probeState())),
    depth: await page.evaluate(async () => (await import("/js/ui.js")).escDepth()),
  });

  let s = await state();
  console.log(`pass1 start | depth=${s.depth} menu=${s.menu} pop=${s.pop} modal=${s.modal}`);

  await page.keyboard.press("Escape");
  s = await state();
  console.log(`press1      | depth=${s.depth} menu=${s.menu} pop=${s.pop} modal=${s.modal}`);
  const p1ok = s.depth === 2 && s.pop === false && s.menu === true && s.modal === true;

  await page.keyboard.press("Escape");
  s = await state();
  console.log(`press2      | depth=${s.depth} menu=${s.menu} pop=${s.pop} modal=${s.modal}`);
  const p2ok = s.depth === 1 && s.menu === false && s.modal === true;

  await page.keyboard.press("Escape");
  s = await state();
  console.log(`press3      | depth=${s.depth} menu=${s.menu} pop=${s.pop} modal=${s.modal}`);
  const p3ok = s.depth === 0 && s.modal === false;

  await page.keyboard.press("Escape"); // empty stack: falls through to main.js, no layer to eat it
  s = await state();
  console.log(`press4      | depth=${s.depth}`);
  const p4ok = s.depth === 0;

  // programmatic close must dispose its entry (no ghost spending Escapes)
  const ghost = await page.evaluate(async () => {
    const ui = await import("/js/ui.js");
    const m = ui.modal({ title: "Ghost", body: "<p>x</p>" });
    m.close();
    const dAfterClose = ui.escDepth();
    return dAfterClose;
  });
  console.log(`programmatic close leaves depth ${ghost}`);
  const p5ok = ghost === 0;

  // second menu retires the first THROUGH its closer (no stacked ghosts)
  const menuSwap = await page.evaluate(async () => {
    const ui = await import("/js/ui.js");
    ui.contextMenu({ clientX: 10, clientY: 10 }, [{ label: "A" }]);
    const d1 = ui.escDepth();
    ui.contextMenu({ clientX: 10, clientY: 10 }, [{ label: "B" }]);
    return [d1, ui.escDepth()];
  });
  console.log(`menu swap depths: ${menuSwap.join(" -> ")}`);
  const p6ok = menuSwap[0] === 1 && menuSwap[1] === 1;
  await page.evaluate(() => import("/js/ui.js").then((ui) => ui.closePopovers()));

  void r; void snap;
  await page.screenshot({ path: "shots/probe-lifo-fallback.png" });
  await context.close();

  let fail = false;
  for (const [name, ok] of [
    ["one press peels topmost (popover)", p1ok],
    ["next press peels menu", p2ok],
    ["next peels modal, stack empty", p3ok],
    ["empty-stack press harmless", p4ok],
    ["programmatic close disposes entry", p5ok],
    ["menu-over-menu retires through closer", p6ok],
  ]) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) fail = true; }

  const errs = lines.filter((l) => l.startsWith("[pageerror]"));
  console.log(`pass1 pageerrors: ${errs.length}`);
  if (errs.length) { console.log(errs.join("\n")); fail = true; }
  if (fail) { await browser.close(); process.exit(1); }
}

// ---- pass 2: CloseWatcher native path (empirical) -------------------------
{
  lines.length = 0;
  const { context, page } = await newPage(false);
  const native = await page.evaluate(() => typeof CloseWatcher === "function");
  await page.evaluate(async () => {
    const ui = await import("/js/ui.js");
    ui.modal({ title: "CW", body: "<p>x</p>" });
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => !!document.querySelector(".modal-back"));
  console.log(`pass2 CloseWatcher present=${native}; real-key Escape peeled modal=${!after}`);
  if (!native || after) {
    console.log("NOTE: CloseWatcher path not drivable by synthetic keys here; "
      + "fallback path is what ships on those browsers, native is standard-API on devices.");
  }
  await page.screenshot({ path: "shots/probe-lifo-cw.png" });
  await context.close();
}

await browser.close();
process.exit(0);
