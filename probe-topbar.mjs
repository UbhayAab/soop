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
  return r;
};

const problems = [];
const base = "http://127.0.0.1:4177";
const phone = await probe(base + "/", { width: 390, height: 844 }, "standalone-phone:");
await probe(base + "/", { width: 1400, height: 900 }, "standalone-wide:");

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
  // d2102c2's recorded proof: the container query fires in a 400px box on a
  // wide window while the viewport media query correctly stays off.
  if (r.mediaNarrow) problems.push("400px-box: media query fired on a wide window");
  if (r.spaceNameDisplay !== "none") problems.push(`400px-box: spaceName display ${r.spaceNameDisplay}, want none (container query did not fire)`);
  if (Math.abs(r.appW - 400) > 2) problems.push(`400px-box: app width ${r.appW}, test invalid`);
  await ctx.close();
}

// Phone box: merged-header regime hides the identity label.
if (phone.spaceNameDisplay !== "none") problems.push(`phone: spaceName display ${phone.spaceNameDisplay}, want none`);
if (!Number.isFinite(phone.appW) || phone.appW > 480) problems.push(`phone: app width ${phone.appW}, test invalid`);

console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
process.exitCode = problems.length ? 1 : 0;
await browser.close();
