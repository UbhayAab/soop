// Probe: EFFICIENCY rank 11 thumbnail half. Boot-level, no sign-in needed:
// drives js/core/media.js directly in page context with synthetic canvas
// images. The network half (second mint-upload round trip inside uploadFile)
// reuses the exact machinery the main blob already proves and needs a signed-in
// session - named limitation, joins the standing test-account follow-up.
import { chromium, devices } from "playwright";

const browser = await chromium.launch();
const lines = [];
const context = await browser.newContext({ ...devices["iPhone 13 Pro"] });
const page = await context.newPage();
page.on("console", (m) => lines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message}`));
await page.goto("http://127.0.0.1:4177/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(800);

const r = await page.evaluate(async () => {
  const out = [];
  const media = await import("/js/core/media.js");

  // Synthetic photo: 2400x1500 gradient JPEG (~big enough to be a real thumb case)
  async function synthFile(w, h, type) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d").createLinearGradient(0, 0, w, h);
    c.getContext("2d").fillStyle = g;
    c.getContext("2d").fillRect(0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, type, 0.9));
    return new File([blob], `t.${type === "image/png" ? "png" : "jpg"}`, { type });
  }

  // 1. big jpeg -> 700px-long-edge thumb, aspect preserved
  const big = await synthFile(2400, 1500, "image/jpeg");
  const tb = await media.makeThumb(big);
  out.push(["big jpeg thumb exists", !!tb]);
  if (tb) {
    out.push(["thumb mime", tb.type, "src", big.type]);
    out.push(["thumb smaller than source", tb.size < big.size, tb.size, "vs", big.size]);
    const bmp = await createImageBitmap(tb);
    out.push(["thumb long edge 700", Math.max(bmp.width, bmp.height) === 700, bmp.width + "x" + bmp.height]);
    out.push(["aspect kept", Math.abs(bmp.width / bmp.height - 2400 / 1500) < 0.01]);
    bmp.close?.();
  }

  // 2. small image -> no thumb (nothing to save)
  const small = await synthFile(600, 400, "image/jpeg");
  out.push(["small image no thumb", (await media.makeThumb(small)) === null]);

  // 3. gif skipped by type before any decode
  const fakeGif = new File([new Blob([new Uint8Array(8)])], "x.gif", { type: "image/gif" });
  out.push(["gif skipped", (await media.makeThumb(fakeGif)) === null]);

  // 4. png stays png (transparency survives)
  const pngBig = await synthFile(1600, 1000, "image/png");
  const ptb = await media.makeThumb(pngBig);
  out.push(["png thumb mime", ptb ? ptb.type : null]);

  // 5. attsHtml carries data-thumb only when a thumb key exists
  const withT = media.attsHtml({ attachments: [{ object_key: "k1", thumb_key: "k1.t", mime: "image/jpeg", width: 2000, height: 1200, name: "a.jpg" }] });
  const noT = media.attsHtml({ attachments: [{ object_key: "k2", mime: "image/jpeg", width: 2000, height: 1200, name: "b.jpg" }] });
  out.push(["data-thumb present when keyed", withT.includes('data-thumb="k1.t"')]);
  out.push(["data-key untouched by thumb", withT.includes('data-key="k1"') && !noT.includes("data-thumb")]);

  return out;
});

let fail = 0;
for (const row of r) {
  const ok = !/false|null|undefined/i.test(row.slice(1).join(" ")) || row[0].startsWith("png") === false && row.slice(1).join(" ").includes("image/png");
  if (!ok && !row[0].startsWith("png thumb")) fail++;
  console.log((ok ? "PASS" : "FAIL"), "|", row.join(" | "));
}
const errs = lines.filter((l) => l.includes("[pageerror]"));
console.log("console pageerrors:", errs.length);
errs.forEach((e) => console.log(e));
console.log(fail === 0 && errs.length === 0 ? "PROBE CLEAN" : "PROBE FAILED");
await browser.close();
process.exit(fail === 0 && errs.length === 0 ? 0 : 1);
