import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 390, height: 844 });
await page.goto("http://127.0.0.1:4177/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(async () => {
  const ui = await import("./js/ui.js");
  ui.toast("height probe");
  const comp = document.getElementById("composerBar");
  // Force past the signed-out gate: unhide every ancestor that is display:none,
  // then the bar itself.
  let n = comp;
  const undone = [];
  while (n && n !== document.body) {
    if (getComputedStyle(n).display === "none") {
      undone.push(n);
      n.style.display = "flex";
    }
    n = n.parentElement;
  }
  await new Promise((res) => setTimeout(res, 350));
  const h = comp.offsetHeight;
  const varH = document.documentElement.style.getPropertyValue("--composer-h");
  const bottom = parseFloat(getComputedStyle(document.querySelector(".toasts")).bottom);
  for (const e of undone) e.style.display = "";
  return { h, varH, bottom, clears: bottom >= h + 32 - 1, unhidden: undone.length };
});
console.log(JSON.stringify(r));
if (!r.h || r.h < 20) console.log("PROBLEM: composer height unrealistically small");
else if (r.varH !== `${r.h}px`) console.log(`PROBLEM: var ${r.varH} != measured ${r.h}px`);
else if (!r.clears) console.log("PROBLEM: toasts do not clear composer");
else console.log("RO NONZERO PATH OK");
await browser.close();
