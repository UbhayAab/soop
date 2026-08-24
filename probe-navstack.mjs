// Probe: panel drill-down navStack + back chevron + absolute sheet.
// Boot-level, no sign-in needed: drives js/ui.js directly in page context.
import { chromium, devices } from "playwright";

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["iPhone 13 Pro"] });
const page = await context.newPage();
const lines = [];
page.on("console", (m) => lines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message}`));

await page.goto("http://127.0.0.1:4177/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(800);

const r = await page.evaluate(async () => {
  const out = [];
  const ui = await import("/js/ui.js");
  const calls = { aClose: 0, bClose: 0 };
  ui.registerPanel({
    id: "probe-a", title: "Alpha",
    render: async (b) => { b.innerHTML = "<p>alpha-body</p>"; },
    onClose: () => { calls.aClose++; },
  });
  ui.registerPanel({
    id: "probe-b", title: "Beta",
    render: async (b) => { b.innerHTML = "<p>beta-body</p>"; },
    onClose: () => { calls.bClose++; },
  });
  const back = document.getElementById("panelBack");
  const panel = document.getElementById("panel");
  const title = () => document.getElementById("panelTitle").textContent;
  const backHidden = () => back.classList.contains("hidden");

  await ui.openPanel("probe-a", {});
  out.push(["open A: title", title(), "backHidden", backHidden()]);
  await ui.openPanel("probe-a", {}); // same-id reopen must not stack
  out.push(["reopen A: backHidden still", backHidden()]);
  await ui.openPanel("probe-b", {});
  out.push(["open B: title", title(), "backHidden", backHidden(),
    "sheet position", getComputedStyle(panel).position,
    "panel-open class", document.body.classList.contains("panel-open")]);
  await ui.popPanel();
  out.push(["pop -> A: title", title(), "backHidden", backHidden(),
    "B onClose count", calls.bClose]);
  await ui.popPanel();
  out.push(["pop empty -> closed: panel hidden", panel.classList.contains("hidden"),
    "A onClose count", calls.aClose,
    "panel-open class gone", !document.body.classList.contains("panel-open")]);
  // closePanel after a fresh drill must wipe the stack (no stale chevron).
  await ui.openPanel("probe-a", {});
  await ui.openPanel("probe-b", {});
  ui.closePanel();
  await ui.openPanel("probe-a", {});
  out.push(["after close+reopen A: backHidden (stack wiped)", backHidden()]);
  ui.closePanel();
  return out;
});

let fail = false;
for (const row of r) console.log(row.join(" | "));
const checks = {
  "title A": r[0][1] === "Alpha" && r[0][3] === true,
  "same-id no stack": r[1][1] === true,
  "drill B shows chevron + absolute sheet":
    r[2][3] === false && r[2][5] === "absolute" && r[2][7] === true,
  "pop restores A, B onClose fired": r[3][1] === "Alpha" && r[3][3] === true && r[3][5] === 1,
};
checks["pop empty closes surface, A onClose fired once total"] =
  r[4][1] === true && r[4][3] === 1 && r[4][5] === true;
checks["closePanel wipes stack for next session"] = r[5][1] === true;
for (const [k, v] of Object.entries(checks)) { console.log(`${v ? "PASS" : "FAIL"} ${k}`); if (!v) fail = true; }

const errs = lines.filter((l) => l.startsWith("[pageerror]"));
console.log(`pageerrors: ${errs.length}`);
if (errs.length) { console.log(errs.join("\n")); fail = true; }
await page.screenshot({ path: "shots/probe-navstack.png" });
await browser.close();
process.exit(fail ? 1 : 0);
