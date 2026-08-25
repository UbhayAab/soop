// Behavioral guard for the embed host-signout teardown: the bridge's 'signout'
// verb used to drop only the credentials - markIntentionalSignOut() made the
// forced-kick handler stand down (by design), so nothing wiped pagecache,
// readcache or the attachment cache, the previous person's conversation stayed
// painted under the auth-wait screen and their message bodies stayed in
// IndexedDB indefinitely. shell.js:92 even claims "the bridge carries the
// signout verb with the full teardown" - this probe makes that sentence true
// and keeps it true. Drives the REAL booted app in top-level embed mode, where
// window.parent === self so an in-page postMessage passes both bridge checks
// (ev.source === window.parent, origin matches the allowlisted dev entry):
//
//   1. SIGNED-IN leg: seed store.me plus REAL on-device state (rows in
//      Dek-pages/Dek-reads, an entry in dek-storage-v1), drive 'signout',
//      require the outbound auth-needed, a real reload, the auth-wait frame,
//      every cache empty afterwards.
//   2. UNSIGNED-IN leg: 'signout' with nobody signed in must forward
//      auth-needed WITHOUT reloading - nothing painted to clear, no reload
//      fighting the host mid-handshake.
//
// Usage: node scripts/probe-embedsignout.mjs [--root <dir>]
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
// The embed host is pinned by js/config.js to exactly :8098 on localhost, so
// this probe has no port freedom. Bind it here; if something already holds it,
// reuse that server only if it answers /index.html (the runner pattern).
let server = http.createServer((req, res) => {
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
let ownedServer = true;
const BASE = "http://127.0.0.1:8098";
try {
  await new Promise((r, j) => { server.once("error", j); server.listen(8098, "127.0.0.1", r); });
} catch {
  ownedServer = false;
  const up = await fetch(BASE + "/index.html").then((r) => r.ok).catch(() => false);
  if (!up) {
    console.error("setup failed: port 8098 held by something that does not serve this repo");
    process.exit(2);
  }
  server.close();
  server = null;
}
console.log(`probe-embedsignout: serving ${ROOT} via ${BASE} (${ownedServer ? "own server" : "reused listener"})`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seeds raw rows shaped like the app's own stores. wipe() clears stores rather
// than deleting databases, so the honest assertion is record COUNTS going to 0.
async function SEED() {
  const open = (name, version, store) => new Promise((res, rej) => {
    const rq = indexedDB.open(name, version);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(store)) rq.result.createObjectStore(store); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  const put = (db, store, key, val) => new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  await put(await open("Dek-pages", 2, "pages"), "pages", "u-me|ch-probe", { rows: [{ id: "m-secret" }], seq: 1 });
  await put(await open("Dek-reads", 1, "reads"), "reads", "bootstrap:u-me", { body: '{"me":"secret"}' });
  const c = await caches.open("dek-storage-v1");
  await c.put("https://probe.example/photo.bin", new Response("attachment-bytes"));
  return "seeded";
}
async function COUNTS() {
  const open = (name, version, store) => new Promise((res, rej) => {
    const rq = indexedDB.open(name, version);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(store)) rq.result.createObjectStore(store); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  const count = (db, store) => new Promise((res, rej) => {
    const rq = db.transaction(store).objectStore(store).count();
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
  const pages = await count(await open("Dek-pages", 2, "pages"), "pages");
  const reads = await count(await open("Dek-reads", 1, "reads"), "reads");
  const c = await caches.open("dek-storage-v1");
  const attch = await c.match("https://probe.example/photo.bin") ? 1 : 0;
  return { pages, reads, attch };
}

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------- leg 1
  // Signed-in panel: the full teardown, end to end through the real bridge.
  {
    const context = await browser.newContext({ viewport: { width: 400, height: 700 } });
    await context.route("**/auth/v1/logout", (route) => route.fulfill({ status: 204 }));
    const pageerrors = [];
    const page = await context.newPage();
    page.on("pageerror", (err) => pageerrors.push(err.message));
    let featuresLoaded;
    const bootedLine = new Promise((r) => { featuresLoaded = r; });
    page.on("console", (m) => { if (/features loaded/.test(m.text())) featuresLoaded(); });
    const booted = Promise.race([bootedLine.then(() => true), sleep(45_000).then(() => false)]);
    await page.goto(BASE + "/index.html?embed=1&host=" + encodeURIComponent(BASE), { waitUntil: "domcontentloaded", timeout: 30_000 });
    ok(await booted, "leg1: app never reached the features-loaded boot line within 45s");

    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      window.__embedMarker = "alive-before-host-signout";
    });
    const seeded = await page.evaluate(SEED);
    ok(seeded === "seeded", "leg1: could not seed IndexedDB/cache fixtures");

    // Hear the bridge's outbound reply: send() posts to window.parent, which is
    // this same window in top-level embed mode.
    await page.evaluate(() => {
      // Persistent listener: {once:true} would be consumed by the first
      // unrelated bridge message (including the echo of our own signout post).
      window.__authNeeded = new Promise((res) => window.addEventListener("message", (ev) => {
        if (ev.origin !== location.origin) return;
        if (ev.data && ev.data.Dek === "auth-needed") res(ev.data.reason || null);
      }));
    });
    await page.evaluate(() => window.postMessage({ Dek: "signout", v: 1 }, location.origin));

    const reason = await Promise.race([page.evaluate(() => window.__authNeeded), sleep(8000).then(() => "TIMEOUT-no-auth-needed")]).catch(() => null);
    ok(reason === "host-signout", `leg1: bridge must answer auth-needed/host-signout before tearing down, got ${JSON.stringify(reason)}`);

    // Reload proof + post-state on the FRESH document.
    const waited = await page.waitForFunction(() =>
      document.documentElement.classList.contains("embed-awaiting-auth")
      && !!document.querySelector(".embed-wait"), null, { timeout: 20_000 }).then(() => true).catch(() => false);
    ok(waited, "leg1: after host-signout the reloaded panel must sit on the auth-wait frame");
    const after = await page.evaluate(() => ({
      markerGone: window.__embedMarker === undefined,
      nobodySignedIn: true,
    })).catch(() => ({ markerGone: false }));
    ok(after.markerGone, "leg1: the page must actually reload (window marker erased)");
    const counts = await page.evaluate(COUNTS).catch(() => null);
    ok(counts && counts.pages === 0, `leg1: Dek-pages must be empty after host-signout, got ${JSON.stringify(counts)}`);
    ok(counts && counts.reads === 0, `leg1: Dek-reads must be empty after host-signout, got ${JSON.stringify(counts)}`);
    ok(counts && counts.attch === 0, `leg1: dek-storage-v1 attachment entry must be gone after host-signout, got ${JSON.stringify(counts)}`);
    ok(pageerrors.length === 0, `leg1: pageerror(s): ${pageerrors.join(" | ")}`);
    await page.screenshot({ path: path.join(ROOT, "s", "probe-embedsignout.png"), fullPage: false }).catch(() => {});
    await context.close();
  }

  // ---------------------------------------------------------------- leg 2
  // Unsigned-in panel: forward the verb, touch nothing structural.
  {
    const context = await browser.newContext({ viewport: { width: 400, height: 700 } });
    await context.route("**/auth/v1/logout", (route) => route.fulfill({ status: 204 }));
    const pageerrors = [];
    const page = await context.newPage();
    page.on("pageerror", (err) => pageerrors.push(err.message));
    let featuresLoaded;
    const bootedLine = new Promise((r) => { featuresLoaded = r; });
    page.on("console", (m) => { if (/features loaded/.test(m.text())) featuresLoaded(); });
    const booted = Promise.race([bootedLine.then(() => true), sleep(45_000).then(() => false)]);
    await page.goto(BASE + "/index.html?embed=1&host=" + encodeURIComponent(BASE), { waitUntil: "domcontentloaded", timeout: 30_000 });
    ok(await booted, "leg2: app never reached the features-loaded boot line within 45s");

    await page.evaluate(() => { window.__embedMarker = "unsigned-in"; });
    await page.evaluate(() => {
      // Persistent listener: {once:true} would be consumed by the first
      // unrelated bridge message (including the echo of our own signout post).
      window.__authNeeded = new Promise((res) => window.addEventListener("message", (ev) => {
        if (ev.origin !== location.origin) return;
        if (ev.data && ev.data.Dek === "auth-needed") res(ev.data.reason || null);
      }));
    });
    await page.evaluate(() => window.postMessage({ Dek: "signout", v: 1 }, location.origin));
    const reason = await Promise.race([page.evaluate(() => window.__authNeeded), sleep(8000).then(() => "TIMEOUT-no-auth-needed")]).catch(() => null);
    ok(reason === "host-signout", `leg2: unsigned-in signout must still forward auth-needed, got ${JSON.stringify(reason)}`);
    await sleep(2000); // long enough for a wrongly-scheduled reload to have fired
    const stayed = await page.evaluate(() => ({
      markerAlive: window.__embedMarker === "unsigned-in",
      awaiting: document.documentElement.classList.contains("embed-awaiting-auth"),
    })).catch(() => ({ markerAlive: false, awaiting: false }));
    ok(stayed.markerAlive, "leg2: signout with nobody signed in must NOT reload (document survived)");
    ok(stayed.awaiting, "leg2: panel should remain on the auth-wait frame");
    ok(pageerrors.length === 0, `leg2: pageerror(s): ${pageerrors.join(" | ")}`);
    await context.close();
  }
} catch (err) {
  problems.push(`harness: ${err.message}`);
} finally {
  await browser.close();
  if (server) server.close();
}

if (problems.length) {
  console.error("PROBE FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN: embed host-signout proven (signed-in wipes pages+reads+attachments then reloads onto auth-wait, unsigned-in forwards without reloading)");
process.exit(0);
