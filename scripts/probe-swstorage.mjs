// Behavioral guard for the rank-10 attachment cache (sw.js storage branch):
// GETs under /storage/v1/object/ on supabase hosts are cached by origin+path
// with the signed query stripped and served stale-while-revalidate, backed by
// a ~150MB LRU - but 8f6e242 landed with only a boot screenshot, so nothing
// ever proved the SERVING behavior. This probe drives the real fetch handler
// end to end against a synthetic *.supabase.co host fulfilled locally:
//
//   1. first view fills from network (V1) and lands in dek-storage-v1
//   2. rotated signed query (?token=bbb) still serves the STALE V1 instantly,
//      while the background revalidation swaps the cached body to V2
//   3. with the network aborted the same path serves V2 from cache alone -
//      the offline half of SWR - keyed identically despite three signatures
//   4. rest/v1 traffic stays out of the storage cache (live data goes to net)
//   5. the dek-storage-lru bookkeeping entry exists and tracks one body
//   zero pageerror throughout.
//
// Usage: node scripts/probe-swstorage.mjs [--root <dir>]
// Exit 0 PROBE CLEAN, 1 PROBE FAILED, 2 setup failure.
import { chromium } from "playwright";
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
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (err, body) => {
    if (err) { try { res.writeHead(404).end("nope"); } catch {} return; }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`probe-swstorage: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const swSource = await fs.promises.readFile(path.join(ROOT, "sw.js"), "utf8");
const STORAGE_CACHE = swSource.match(/const STORAGE = '([^']+)'/)?.[1];
if (!STORAGE_CACHE) { console.error("PROBE SETUP FAILED: no STORAGE name in sw.js"); process.exit(2); }

const HOST = "https://swprobe.supabase.co";
const OBJ = "/storage/v1/object/sign/dek/p/photo.png";

let routeHits = 0;
let body = "V1";
let netDead = false;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  // Installed BEFORE navigation so the worker registers inside an already-
  // routed context and its fetches are interceptable.
  await context.route(`${HOST}/**`, (route) => {
    if (netDead) return route.abort("failed");
    routeHits++;
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(body.length),
        "cache-control": "no-store",
      },
      body,
    });
  });
  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (err) => pageerrors.push(err.message));

  // Boot: install + activate (skipWaiting/clients.claim), then reload so the
  // page is definitely controlled - same two-step as probe-offline.
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const swReady = await Promise.race([
    page.evaluate(() => navigator.serviceWorker.ready.then(() => true)).catch(() => false),
    sleep(15_000).then(() => false),
  ]);
  ok(swReady, "service worker never reached ready within 15s");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 })
    .catch(() => problems.push("page not controlled after reload"));
  if (!problems.length) console.log("probe-swstorage: worker controls the page");

  const urlWith = (t) => `${HOST}${OBJ}?token=${t}`;

  // 1. cold fill
  const first = await page.evaluate(async (u) => (await fetch(u)).text(), urlWith("aaa"));
  ok(first === "V1", `first view should be network V1, got ${first}`);
  ok(routeHits === 1, `expected exactly 1 network fill, saw ${routeHits}`);

  // 2. rotated signature: stale body now, refreshed body next
  body = "V2";
  const stale = await page.evaluate(async (u) => (await fetch(u)).text(), urlWith("bbb"));
  ok(stale === "V1", `rotated signature should serve STALE V1, got ${stale}`);
  await sleep(800); // background revalidation behind e.waitUntil

  // 3. network dead: cache is the only answer, and it holds the REFRESHED body
  netDead = true;
  const offline = await page.evaluate(async (u) => (await fetch(u)).text(), urlWith("ccc"));
  ok(offline === "V2", `offline view should serve refreshed V2 from cache, got ${offline}`);
  ok(routeHits === 2, `aborted network must add no hits, saw ${routeHits}`);

  // 4+5. inspect the cache from the page (same origin as the worker). The
  // storage branch keys entries by the SUPABASE origin+path on purpose, so
  // the exact expected composition is: one cross-origin object key + one
  // same-origin dek-storage-lru bookkeeping entry. Nothing else.
  const audit = await page.evaluate(async ([name, objPath]) => {
    const c = await caches.open(name);
    const keys = (await c.keys()).map((r) => r.url);
    const objKeys = keys.filter((u) => u.includes(objPath));
    const lruUrl = new URL("dek-storage-lru", location.href.replace(/[^/]*$/, "")).href;
    const lruHit = keys.includes(lruUrl);
    const lruList = lruHit ? await (await c.match(lruUrl)).json() : null;
    return {
      total: keys.length,
      objKeys,
      anyQuery: objKeys.some((u) => u.includes("?")),
      rpcKeys: keys.filter((u) => u.includes("/rest/v1/")).length,
      lruHit,
      lruCount: Array.isArray(lruList) ? lruList.length : null,
      lruSize: Array.isArray(lruList) && lruList[0] ? lruList[0].s : null,
    };
  }, [STORAGE_CACHE, OBJ]);
  ok(audit.total === 2, `cache should hold exactly object+lru, saw ${audit.total}`);
  ok(audit.objKeys.length === 1, `exactly one cache key for the object, saw ${JSON.stringify(audit.objKeys)}`);
  ok(!audit.anyQuery, "object cache key must carry no query string");
  ok(audit.rpcKeys === 0, "rest/v1 must never enter the storage cache");
  ok(audit.lruHit, "dek-storage-lru bookkeeping entry missing");
  ok(audit.lruCount === 1, `lru list should track 1 body, saw ${audit.lruCount}`);
  ok(audit.lruSize === 2, `lru size should come off content-length (2), saw ${audit.lruSize}`);

  ok(pageerrors.length === 0, `pageerror(s): ${pageerrors.join(" | ")}`);

  await context.close();
} catch (err) {
  problems.push(`harness: ${err.message}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("PROBE FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN: swstorage stale-while-revalidate proven (fill, stale-serve, bg-refresh, offline, keying, lru)");
process.exit(0);
