// Behavioral guard for the offline promise: sw.js claims "The esm.sh
// dependencies are cached so the app opens offline instead of hanging on a
// module import", and the shell precache exists so a cold boot needs no
// network - but that was only ever proven by static import sweeps, never by
// actually cutting the wire. This probe drives the REAL pipeline end to end:
//
//   boot A (online):  registers the worker, installs the shell precache.
//   boot B (online):  the page is now controlled, so the vendored esm.sh
//                     module graph flows through the fetch handler and fills
//                     the VENDOR cache (it cannot fill during boot A - the
//                     worker is not controlling anything yet).
//   boot C (offline): context.setOfflineMode(true) AND the static server is
//                     closed, so literally nothing is reachable except the
//                     service-worker caches. The reload must produce the SAME
//                     feature list as the online boots with zero pageerror and
//                     zero failed code-asset requests.
//
// Usage: node scripts/probe-offline.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium, devices } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") { out.root = argv[++i]; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root || path.dirname(fileURLToPath(import.meta.url)), args.root ? "." : "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
let serverClosed = false;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (err, body) => {
    if (serverClosed || err) { try { res.writeHead(404).end("nope"); } catch {} return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-offline: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };

// Which cache names matter is read off the served sw.js, not hardcoded, so a
// VERSION bump cannot silently strand this probe.
const swSource = await fs.promises.readFile(path.join(ROOT, "sw.js"), "utf8");
const ver = swSource.match(/const VERSION = '([^']+)'/)?.[1];
if (!ver) { console.error("PROBE SETUP FAILED: no VERSION in sw.js"); process.exit(2); }
const SHELL_CACHE = ver + "-shell";
const VENDOR_CACHE = ver + "-vendor";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFeatures(seen, ms, label) {
  const n0 = seen.featureLines.length;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (seen.featureLines.length > n0) {
      const line = seen.featureLines[seen.featureLines.length - 1];
      return line.replace(/^\[dak\] features loaded:/, "").split(",").map((s) => s.trim()).filter(Boolean);
    }
    await sleep(200);
  }
  problems.push(`${label}: no features-loaded line within ${ms}ms`);
  return null;
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ...devices["iPhone 13 Pro"] });
  const page = await ctx.newPage();
  const seen = { featureLines: [], errors: [], netFails: [] };
  page.on("pageerror", (e) => seen.errors.push(e.message));
  page.on("console", (msg) => {
    const text = msg.text();
    if (/features loaded:/.test(text)) seen.featureLines.push(text);
  });
  page.on("requestfailed", (req) => {
    const u = new URL(req.url());
    const vendor = u.hostname === "esm.sh" || u.hostname.endsWith(".esm.sh") || u.hostname === "cdn.jsdelivr.net";
    if (u.hostname === new URL(BASE).hostname || vendor) {
      if (/\.(js|mjs|css|html|webmanifest)$/i.test(u.pathname)) {
        seen.netFails.push(`offline miss: ${req.url()} (${req.failure()?.errorText})`);
      }
    }
  });

  // Boot A: worker installs the shell precache. Not yet controlling the page,
  // so vendor deps ride the CDN directly this round.
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  const featsA = await waitFeatures(seen, 20000, "boot A (online)");
  ok(Array.isArray(featsA) && featsA.length > 0, `boot A produced no feature list (${seen.errors.length} pageerrors so far)`);

  // Wait for the worker to be active and the shell cache populated.
  const swReady = await Promise.race([
    page.evaluate(() => navigator.serviceWorker.ready.then(() => true)).catch(() => false),
    sleep(15000).then(() => false),
  ]);
  ok(swReady, "service worker never reached ready within 15s");

  // Boot B: controlled page - vendor graph flows through the fetch handler now.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  const featsB = await waitFeatures(seen, 20000, "boot B (online, controlled)");
  ok(Array.isArray(featsB) && featsB.length > 0, "boot B produced no feature list");
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  ok(controlled, "page not controlled by the worker after reload (clients.claim absent and reload did not adopt it)");
  const cacheState = await page.evaluate(async ([shellName, vendorName]) => {
    const names = await caches.keys();
    const count = async (n) => (await caches.open(n)).keys().then((k) => k.length);
    return {
      names,
      shell: names.includes(shellName) ? await count(shellName) : -1,
      vendor: names.includes(vendorName) ? await count(vendorName) : -1,
    };
  }, [SHELL_CACHE, VENDOR_CACHE]);
  ok(cacheState.names.includes(SHELL_CACHE), `cache ${SHELL_CACHE} absent (have: ${cacheState.names.join(", ")})`);
  ok(cacheState.shell > 50, `shell cache suspiciously small: ${cacheState.shell}`);
  ok(cacheState.vendor > 0, `vendor cache empty after a controlled online boot - esm.sh graph never flowed through the worker`);

  // The markdown-it import (util.js loadMarkdown) is fired at eval and not
  // awaited by first paint, so its esm.sh sub-graph keeps filling AFTER the
  // features line prints. Cutting the wire here would fail the run for a
  // harness race, not an app defect - wait until the vendor cache stops
  // growing before going offline.
  let settled = cacheState.vendor;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(500);
    const n = await page.evaluate(async (v) => (await (await caches.open(v)).keys()).length, VENDOR_CACHE);
    if (n === settled) break;
    settled = n;
  }
  console.log(`probe-offline: vendor cache settled at ${settled} entries`);

  // Cut everything: emulated offline PLUS the server itself shuts its listener,
  // so even if emulation ever leaks past localhost the cache is still the only
  // thing that can answer.
  await ctx.setOffline(true);
  const onlineFlag = await page.evaluate(() => navigator.onLine);
  ok(onlineFlag === false, "navigator.onLine still true after setOfflineMode(true)");
  serverClosed = true;
  server.close();

  // Boot C: the actual subject. Everything from caches or not at all.
  const failsBeforeC = seen.netFails.length;
  const errorsBeforeC = seen.errors.length;
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  const featsC = await waitFeatures(seen, 25000, "boot C (offline)");
  if (Array.isArray(featsA) && Array.isArray(featsC)) {
    const a = [...featsA].sort().join(",");
    const c = [...featsC].sort().join(",");
    ok(a === c, `offline feature list differs from online: online [${a}] offline [${c}]`);
  }
  ok(seen.errors.slice(errorsBeforeC).length === 0,
     `offline boot threw ${seen.errors.length - errorsBeforeC} pageerror(s): ${seen.errors.slice(errorsBeforeC).join(" | ")}`);
  ok(seen.netFails.slice(failsBeforeC).length === 0,
     `offline boot missed ${seen.netFails.length - failsBeforeC} code asset(s): ${seen.netFails.slice(failsBeforeC).join(" | ")}`);
  const appThere = await page.evaluate(() => !!document.querySelector("#app"));
  ok(appThere, "offline boot rendered no #app");

  await page.screenshot({ path: path.join(ROOT, "s", "probe-offline.png"), fullPage: false });
} catch (err) {
  problems.push(`harness: ${err && err.message}`);
} finally {
  await browser.close();
  if (!serverClosed) server.close();
}

if (problems.length) {
  console.error("PROBE FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`PROBE CLEAN: offline boot loaded the same feature set from ${SHELL_CACHE} + ${VENDOR_CACHE}, zero pageerror`);
process.exit(0);
