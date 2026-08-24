import { chromium } from "playwright";

const browser = await chromium.launch();
const probe = async (url, vp, label) => {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const tb = document.getElementById("topbar");
    if (!tb) return { topbar: "absent" };
    const cs = getComputedStyle(tb);
    return {
      cols: cs.gridTemplateColumns,
      mediaNarrow: matchMedia("(max-width: 860px)").matches,
      spaceNameDisplay: getComputedStyle(document.getElementById("spaceName")).display,
      appW: document.getElementById("app").getBoundingClientRect().width,
    };
  });
  console.log(label, JSON.stringify(r));
  await ctx.close();
};

const base = "http://127.0.0.1:4177";
await probe(base + "/", { width: 1400, height: 900 }, "standalone-wide:");
await probe(base + "/", { width: 390, height: 844 }, "standalone-phone:");

// Simulate the host constraining the panel: same-document embed on a wide
// window whose app box is 400px. Media query must stay off; container query
// must fire.
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const s = document.createElement("style");
    s.textContent = "#app{width:400px !important}";
    document.head.appendChild(s);
    return new Promise((res) => requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const tb = document.getElementById("topbar");
        const cs = getComputedStyle(tb);
        res({
          appW: document.getElementById("app").getBoundingClientRect().width,
          cols: cs.gridTemplateColumns,
          mediaNarrow: matchMedia("(max-width: 860px)").matches,
          spaceNameDisplay: getComputedStyle(document.getElementById("spaceName")).display,
        });
      })));
  });
  console.log("wide-viewport-400px-box:", JSON.stringify(r));
  await ctx.close();
}

await browser.close();
