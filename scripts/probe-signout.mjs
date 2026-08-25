// Behavioral guard for the forced-vs-intentional sign-out split: main.js
// registers an onAuthStateChange handler that treats every SIGNED_OUT while
// store.me is set as a REMOTE kick - stash dekKicked, wipe the shared-phone
// caches, reload onto the sign-in card with "Your session ended on this
// device". Deliberate sign-outs (shell menu, legacy button, embed host-signout)
// latch first via sb.js markIntentionalSignOut() and must take NEITHER the
// flag nor the greeting - but the latch had zero readers until this burst, so
// 34a1023's contract lived only in comments. Drives the REAL booted app:
//
//   1. FORCED leg: signOut() with no latch (what a revoked token looks like
//      to the handler) must set dekKicked and reload; after the reload the
//      card greets with the ended-session message exactly once.
//   2. INTENTIONAL leg: markIntentionalSignOut() then signOut() (the shell
//      menu's own sequence minus its reload) must leave no dekKicked, cause
//      no handler reload, and paint no greeting.
//   3. GUARD leg: SIGNED_OUT with store.me unset (boot-time null session)
//      must do nothing at all.
//
// Usage: node scripts/probe-signout.mjs [--root <dir>]
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
console.log(`probe-signout: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------- leg 1
  // FORCED: no latch anywhere - the exact shape of a revoked refresh token.
  {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    // Hermetic logout: signOut() tries to revoke server-side first; answer it
    // locally so the leg never touches the live project.
    await context.route("**/auth/v1/logout", (route) =>
      route.fulfill({ status: 204 }));
    const pageerrors = [];
    const page = await context.newPage();
    page.on("pageerror", (err) => pageerrors.push(err.message));
    let featuresLoaded;
    const bootedLine = new Promise((r) => { featuresLoaded = r; });
    page.on("console", (m) => { if (/features loaded/.test(m.text())) featuresLoaded(); });
    const booted = Promise.race([bootedLine.then(() => true), sleep(45_000).then(() => false)]);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    ok(await booted, "leg1: app never reached the features-loaded boot line within 45s");

    // Seed an identity so the handler's !store.me guard passes, and drop a
    // window marker that any reload must erase.
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      window.__signoutMarker = "alive-before-kick";
    });

    await page.evaluate(async () => {
      const { sb } = await import("/js/sb.js");
      await sb.auth.signOut();
    });
    // The handler reloads in .finally; the greeting on the reloaded card is
    // the end-to-end proof dekKicked was stashed before it fired.
    const greeted = await page
      .waitForFunction(() => (document.querySelector("#authErr")?.textContent || "").includes("Your session ended on this device"), null, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    ok(greeted, "leg1: forced sign-out must land on the card greeting 'Your session ended on this device'");
    const after = await page.evaluate(() => ({
      markerGone: window.__signoutMarker === undefined,
      flagConsumed: sessionStorage.getItem("dekKicked") === null,
    }));
    ok(after.markerGone, "leg1: the page must actually reload (window marker erased)");
    ok(after.flagConsumed, "leg1: the dekKicked flag must be consumed so the greeting cannot repeat forever");
    ok(pageerrors.length === 0, `leg1: pageerror(s): ${pageerrors.join(" | ")}`);
    await page.screenshot({ path: path.join(ROOT, "s", "probe-signout.png"), fullPage: false }).catch(() => {});
    await context.close();
  }

  // ---------------------------------------------------------------- leg 2+3
  // INTENTIONAL: the shell menu's sequence (latch, then signOut) minus its
  // own reload. Nothing may greet this person or force a reload on them.
  {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    await context.route("**/auth/v1/logout", (route) =>
      route.fulfill({ status: 204 }));
    const pageerrors = [];
    const page = await context.newPage();
    page.on("pageerror", (err) => pageerrors.push(err.message));
    let featuresLoaded;
    const bootedLine = new Promise((r) => { featuresLoaded = r; });
    page.on("console", (m) => { if (/features loaded/.test(m.text())) featuresLoaded(); });
    const booted = Promise.race([bootedLine.then(() => true), sleep(45_000).then(() => false)]);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    ok(await booted, "leg2: app never reached the features-loaded boot line within 45s");

    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      store.me = { id: "u-me", name: "Me" };
      store.ws = { id: "ws-ws1", name: "W" };
      window.__signoutMarker = "alive-before-deliberate";
    });
    await page.evaluate(async () => {
      const { sb, markIntentionalSignOut } = await import("/js/sb.js");
      markIntentionalSignOut();
      await sb.auth.signOut();
    });
    await sleep(2500); // long enough for the forced path's wipe+reload to have fired if it were going to
    const state = await page.evaluate(() => ({
      stayed: window.__signoutMarker === "alive-before-deliberate",
      noFlag: sessionStorage.getItem("dekKicked") === null,
      noGreeting: !(document.querySelector("#authErr")?.textContent || "").includes("Your session ended"),
    }));
    ok(state.stayed, "leg2: intentional sign-out must NOT trigger the handler's reload (document survived)");
    ok(state.noFlag, "leg2: intentional sign-out must NOT stash the dekKicked flag");
    ok(state.noGreeting, "leg2: intentional sign-out must NOT show the ended-session greeting");

    // GUARD: with store.me unset the handler must ignore SIGNED_OUT entirely -
    // the boot-time INITIAL_SESSION(null) case rides this same condition.
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      store.me = null;
      const { sb } = await import("/js/sb.js");
      await sb.auth.signOut();
    });
    await sleep(1200);
    const guarded = await page.evaluate(() => ({
      stayed: window.__signoutMarker === "alive-before-deliberate",
      noFlag: sessionStorage.getItem("dekKicked") === null,
    }));
    ok(guarded.stayed && guarded.noFlag, "leg3: SIGNED_OUT with no signed-in identity must do nothing");
    ok(pageerrors.length === 0, `leg2/3: pageerror(s): ${pageerrors.join(" | ")}`);
    await context.close();
  }
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
console.log("PROBE CLEAN: signout split proven (forced kicks flag+reload+greeting-once, intentional stays silent, unsigned-in SIGNED_OUT ignored)");
process.exit(0);
