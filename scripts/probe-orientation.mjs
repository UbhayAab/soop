// Behavioral guard for the rank-14 orientation half (e6d4b34): onChannelOpen()
// must read get_channel_guide through the cache-first load(), so a warm channel
// switch costs ZERO guide fetches; failures must never be cached (a dead open
// retries next time instead of blanking forever) and must never throw into the
// bus handler; and the About panel keeps its explicit force-refetch even when
// the open path is warm. Drives the REAL booted app through its exported
// openChannel() and the real panel registry, with get_channel_guide answered by
// context.route - nothing mocked, counts come off the wire.
//
//   LEG A warm open: first open of cA costs exactly one guide POST carrying
//        p_channel and paints the first-visit welcome banner; reopening cA
//        costs NO second POST and leaves the very same banner node standing.
//   LEG B forced reload: opening the About panel re-fetches despite the warm
//        cache and paints the answer's purpose into the panel.
//   LEG C failure isolation: with the route aborted, opening cB makes the
//        attempt, paints nothing and raises no pageerror; after the route
//        heals, the next open really goes back to the network (attempt #2)
//        and the welcome appears - proof the failure was never cached.
//
// Accepted gap, named: the guide_update broadcast invalidation rides the
// realtime subscription (bindChannel/getSub), which has no socket in this
// harness - the mutation-path invalidations (set_channel_guide/mark_guide_seen)
// are exercised indirectly by leg B's force path only.
//
// Usage: node scripts/probe-orientation.mjs [--root <dir>]
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
console.log(`probe-orientation: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();

// Hermetic Supabase: get_channel_guide counted per p_channel, everything else
// answered inertly. `failing` names channels whose guide RPC aborts right now -
// flipped mid-leg to prove a failed answer never entered the cache.
function wireGuideRoute(context, state) {
  return context.route("**/rest/v1/**", async (route) => {
    const u = new URL(route.request().url());
    const seg = u.pathname.split("/");
    if (seg[seg.length - 2] !== "rpc") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    const name = seg[seg.length - 1];
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch {}
    if (name === "get_channel_guide") {
      const ch = String(body.p_channel || "?");
      state.attempts.set(ch, (state.attempts.get(ch) || 0) + 1);
      state.lastArgs.set(ch, body);
      if (state.failing.has(ch)) return route.abort("connectionreset");
      const payload = {
        channel_id: ch,
        channel_name: state.names.get(ch) || ch,
        purpose: "Purpose of " + ch,
        body: "",
        topic: "",
        seen: false,
        pins: [],
        open_asks: [],
        can_edit: false,
        member_count: 3,
        updated_at: null,
        updated_by: null,
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    }
    if (name === "get_drafts" || name === "save_draft" || name === "delete_draft"
      || name === "mark_guide_seen" || name === "get_channel_messages") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

// Presence/content contract, not pixels: waitForSelector runs with
// state:'attached' because the signed-out shell can legitimately hide these
// surfaces at narrow widths without changing the behavior under test; viewport
// 1280x800 matches the smoke harness's desktop boot.
const ATTACHED = { state: "attached", timeout: 15_000 };

async function bootAndOpen(context, channelId, channels) {
  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(String(e)));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const booted = await Promise.race([
    page.waitForEvent("console", { predicate: (m) => /features loaded/.test(m.text()), timeout: 45_000 }).then(() => true),
    sleep(45_000).then(() => false),
  ]);
  ok(booted, `${channelId}: app never reached the features-loaded boot line within 45s`);
  await page.evaluate(async ([cid, chans]) => {
    const { store } = await import("/js/store.js");
    store.me = { id: "u-me", name: "Me" };
    store.ws = { id: "ws-ws1", name: "W" };
    store.channels = chans;
    store.unread = new Map();
    store.notify = new Map();
    store.dms = [];
    const { openChannel } = await import("/js/core/channels.js");
    await openChannel(store.channels.find((c) => c.id === cid));
  }, [channelId, channels]);
  return { page, pageerrors };
}

const state = { attempts: new Map(), lastArgs: new Map(), failing: new Set(), names: new Map() };

try {
  // ------------------------------------------------- legs A + B (one session)
  {
    state.names.set("cA", "alpha");
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wireGuideRoute(context, state);
    const chans = [{ id: "cA", name: "alpha", position: 1000 }];
    const { page, pageerrors } = await bootAndOpen(context, "cA", chans);

    // LEG A first open: one POST, correct argument, welcome banner painted.
    await page.waitForSelector(".ori-banner", ATTACHED)
      .catch(() => problems.push("A: first open of cA never painted the welcome banner"));
    ok(state.attempts.get("cA") === 1,
      `A: expected exactly 1 guide fetch after first open, got ${state.attempts.get("cA")}`);
    ok(state.lastArgs.get("cA")?.p_channel === "cA",
      `A: outbound guide POST did not carry p_channel:cA (${JSON.stringify(state.lastArgs.get("cA"))})`);
    const bannerText = await page.$eval(".ori-banner", (n) => n.textContent).catch(() => "");
    ok(/#?\s*alpha/.test(bannerText), `A: banner does not name the channel (${JSON.stringify(bannerText)})`);

    // Mark the painted banner so a repaint cannot hide behind the survivor.
    await page.evaluate(() => { document.querySelector(".ori-banner").dataset.probeMark = "1"; });

    // LEG A warm reopen: zero further fetches, same node still standing.
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      const { openChannel } = await import("/js/core/channels.js");
      await openChannel(store.channels.find((c) => c.id === "cA"));
    });
    await sleep(800);
    ok(state.attempts.get("cA") === 1,
      `A: warm reopen refetched the guide (${state.attempts.get("cA")} attempts - cache-first lost)`);
    const marked = await page.$$eval('.ori-banner[data-probe-mark="1"]', (ns) => ns.length).catch(() => 0);
    ok(marked === 1, `A: marked banner gone after warm reopen (${marked} found - repainted or wiped)`);
    const banners = await page.$$eval(".ori-banner", (ns) => ns.length).catch(() => 0);
    ok(banners === 1, `A: expected exactly one banner after reopen, got ${banners}`);

    // LEG B About panel: the registry render force-refetches past the warm cache.
    await page.evaluate(async () => {
      const ui = await import("/js/ui.js");
      await ui.openPanel("channel-guide", { channelId: "cA" });
    });
    await page.waitForSelector(".ori-card", ATTACHED)
      .catch(() => problems.push("B: About panel never rendered a guide card"));
    ok(state.attempts.get("cA") === 2,
      `B: panel render did not force a refetch (${state.attempts.get("cA")} attempts, want 2)`);
    const cardText = await page.$eval(".ori-card", (n) => n.textContent).catch(() => "");
    ok(cardText.includes("Purpose of cA"), `B: panel card missing the fresh answer (${JSON.stringify(cardText.slice(0, 120))})`);
    await page.evaluate(async () => { const ui = await import("/js/ui.js"); await ui.closePanel(); });

    ok(pageerrors.length === 0, `A/B: pageerrors on the happy path: ${pageerrors.join(" | ")}`);
    await context.close();
  }

  // ------------------------------------------------------------ leg C (fresh)
  {
    state.names.set("cB", "beta");
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wireGuideRoute(context, state);
    state.failing.add("cB");
    const chans = [{ id: "cB", name: "beta", position: 1000 }];
    const { page, pageerrors } = await bootAndOpen(context, "cB", chans);

    await sleep(1500); // let the aborted fetch settle through tryRpc's catch
    ok(state.attempts.get("cB") === 1,
      `C: dead open should still have attempted exactly one fetch, got ${state.attempts.get("cB")}`);
    const bannerWhileDead = await page.$$eval(".ori-banner", (ns) => ns.length).catch(() => -1);
    ok(bannerWhileDead === 0, `C: a failed guide must paint nothing (${bannerWhileDead} banners)`);
    ok(pageerrors.length === 0, `C: offline open threw into the page: ${pageerrors.join(" | ")}`);

    // Heal the route: the retry must be a REAL second network attempt.
    state.failing.delete("cB");
    await page.evaluate(async () => {
      const { store } = await import("/js/store.js");
      const { openChannel } = await import("/js/core/channels.js");
      await openChannel(store.channels.find((c) => c.id === "cB"));
    });
    await page.waitForSelector(".ori-banner", ATTACHED)
      .catch(() => problems.push("C: healed open never painted the welcome banner"));
    ok(state.attempts.get("cB") === 2,
      `C: healed open served from a cache that should not exist (${state.attempts.get("cB")} attempts, want 2)`);
    const bannerText2 = await page.$eval(".ori-banner", (n) => n.textContent).catch(() => "");
    ok(/#?\s*beta/.test(bannerText2), `C: healed banner does not name the channel (${JSON.stringify(bannerText2)})`);
    ok(pageerrors.length === 0, `C: pageerrors after heal: ${pageerrors.join(" | ")}`);
    await context.close();
  }
} catch (e) {
  problems.push(`harness: ${e?.stack || e}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

if (problems.length) {
  console.log("PROBE FAILED - probe-orientation");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN - probe-orientation");
process.exit(0);
