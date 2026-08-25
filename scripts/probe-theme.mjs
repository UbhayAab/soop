// Behavioral guard for the theme pipeline: the index.html PRE-PAINT inline
// snippet, js/theme.js's storage contract and the dak.theme migration. The
// snippet reads localStorage during parse - before any module runs - so a
// key drift between it and theme.js paints the wrong theme for one frame on
// every load (the exact flash the snippet exists to prevent). Owned by no
// other probe; the rename and two reskins have touched this surface since.
//
// Self-serves the tree on an ephemeral port (no PID cleanup dance); embed leg
// omitted deliberately: the snippet ships in the same index.html either way.
import { chromium, devices } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (err, body) => {
    if (err) { res.writeHead(404).end("nope"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };

// Runs before ANY page script on every navigation: records every data-theme
// write to <html> in order, so sets[0] is provably the pre-paint snippet's
// application and later entries are module-era repaints.
const SPY = () => {
  window.__themeSets = [];
  const orig = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === "data-theme" && this === document.documentElement) {
      window.__themeSets.push(String(value));
    }
    return orig.call(this, name, value);
  };
};

const browser = await chromium.launch();
const boot = async (seed, colorScheme) => {
  const ctx = await browser.newContext({ ...devices["iPhone 13 Pro"], colorScheme });
  if (seed) {
    await ctx.addInitScript((s) => {
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, seed);
  }
  await ctx.addInitScript(SPY);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  return { ctx, page };
};

// ---- Case A: legacy hearth.theme only -> pre-paint honors it AND migrates ----
{
  const { ctx, page } = await boot({ "hearth.theme": "dark" });
  const r = await page.evaluate(() => ({
    sets: window.__themeSets,
    final: document.documentElement.getAttribute("data-theme"),
    migrated: localStorage.getItem("dak.theme"),
  }));
  ok(r.sets[0] === "dark", `A pre-paint painted '${r.sets[0]}', want dark (hearth.theme fallback)`);
  ok(r.final === "dark", `A final theme ${r.final}, want dark`);
  ok(r.migrated === "dark", `A dak.theme not migrated, got ${JSON.stringify(r.migrated)}`);
  await ctx.close();
}

// ---- Case B: current dak.theme only (every user since the rename) -> the
// pre-paint snippet MUST read it; reading only hearth.theme here is the
// wrong-theme-flash defect this probe exists to catch. Seeded DARK against a
// LIGHT-scheme context so the broken path's system resolution visibly
// disagrees instead of coinciding. ----
{
  const { ctx, page } = await boot({ "dak.theme": "dark" }, "light");
  const r = await page.evaluate(() => ({ sets: window.__themeSets, final: document.documentElement.getAttribute("data-theme") }));
  ok(r.sets[0] === "dark", `B pre-paint painted '${r.sets[0]}' first, want dark - user choice ignored until modules load (flash)`);
  ok(r.sets.length >= 1 && r.sets.every((v) => v === "dark"), `B repainted mid-boot: ${JSON.stringify(r.sets)} - first frame disagreed with storage`);
  ok(r.final === "dark", `B final theme ${r.final}, want dark`);
  await ctx.close();
}

// ---- Case C: no stored choice -> system resolution + live follow while on system ----
{
  const { ctx, page } = await boot(null, "dark");
  let r = await page.evaluate(() => ({ sets: window.__themeSets, final: document.documentElement.getAttribute("data-theme") }));
  ok(r.sets[0] === "dark", `C system-dark pre-paint painted '${r.sets[0]}'`);
  ok(r.final === "dark", `C system-dark final ${r.final}`);
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  ok(r === "light", `C system follow flipped to ${r}, want light`);
  // A concrete choice must STOP the following.
  await page.evaluate(() => import("/js/theme.js").then((m) => m.setTheme("dark")));
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(200);
  r = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  ok(r === "dark", `C pinned dark got dragged to ${r} by an OS flip`);
  await ctx.close();
}

// ---- Case D: setTheme persists under dak.theme, announces, keeps meta in step ----
{
  const { ctx, page } = await boot(null, "dark");
  const r = await page.evaluate(async () => {
    const m = await import("/js/theme.js");
    let evt = null;
    document.addEventListener("themechange", (e) => { evt = e.detail; }, { once: true });
    m.setTheme("colorful");
    const meta = document.querySelector('meta[name="theme-color"]');
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--c-nav-bg").trim();
    return {
      stored: localStorage.getItem("dak.theme"),
      attr: document.documentElement.getAttribute("data-theme"),
      evt,
      meta: meta ? meta.content : null,
      bg,
      effective: m.effectiveTheme(),
    };
  });
  ok(r.stored === "colorful", `D persisted ${JSON.stringify(r.stored)}, want colorful`);
  ok(r.attr === "colorful", `D attr ${r.attr}, want colorful`);
  ok(r.evt && r.evt.choice === "colorful", `D themechange detail ${JSON.stringify(r.evt)}`);
  ok(r.meta === r.bg && r.meta.length > 0, `D meta ${r.meta} != computed --c-nav-bg ${r.bg}`);
  ok(r.effective === "colorful", `D effectiveTheme ${r.effective}`);
  await ctx.close();
}

// ---- Case E: cycleTheme walks dark -> light -> colorful -> dark ----
{
  const { ctx, page } = await boot(null, "dark");
  const seq = await page.evaluate(async () => {
    const m = await import("/js/theme.js");
    const out = [];
    for (let i = 0; i < 3; i++) { m.cycleTheme(); out.push(m.effectiveTheme()); }
    return out;
  });
  ok(JSON.stringify(seq) === JSON.stringify(["light", "colorful", "dark"]), `E cycle gave ${JSON.stringify(seq)}`);
  await ctx.close();
}

// ---- Case F: picker renders four real options, marks the stored choice
// active (read-after-write, not the bare default) and applies a click ----
{
  const { ctx, page } = await boot(null, "dark");
  const r = await page.evaluate(async () => {
    try {
      const m = await import("/js/theme.js");
      m.setTheme("colorful");
      const anchor = document.createElement("button");
      document.body.appendChild(anchor);
      m.openThemePicker(anchor);
      await new Promise((r2) => setTimeout(r2, 100));
      const opts = [...document.querySelectorAll(".theme-picker .theme-option")];
      const out = {
        n: opts.length,
        ids: opts.map((o) => o.dataset.themeId),
        active: opts.filter((o) => o.classList.contains("is-active")).map((o) => o.dataset.themeId),
        swatches: opts.every((o) => o.querySelectorAll(".theme-swatch i").length === 3),
      };
      opts.find((o) => o.dataset.themeId === "light")?.click();
      await new Promise((r2) => setTimeout(r2, 300));
      out.afterClick = {
        stored: localStorage.getItem("dak.theme"),
        attr: document.documentElement.getAttribute("data-theme"),
      };
      return out;
    } catch (e) { return { err: String(e) }; }
  });
  if (r.err) problems.push(`F picker threw ${r.err}`);
  else {
    ok(r.n === 4, `F ${r.n} options, want 4`);
    ok(JSON.stringify(r.ids) === JSON.stringify(["dark", "light", "colorful", "system"]), `F ids ${JSON.stringify(r.ids)}`);
    ok(JSON.stringify(r.active) === JSON.stringify(["colorful"]), `F active ${JSON.stringify(r.active)}, want [colorful]`);
    ok(r.swatches, "F an option lost its three-swatch strip");
    ok(r.afterClick.stored === "light" && r.afterClick.attr === "light", `F click applied ${JSON.stringify(r.afterClick)}`);
  }
  await ctx.close();
}

await browser.close();
server.close();

if (problems.length) {
  console.error("PROBE FAIL - theme pipeline:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - theme pipeline: pre-paint snippet, migration, setTheme/cycle/picker, system follow all verified");
process.exit(0);
