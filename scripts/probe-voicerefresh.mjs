// Behavioral guard for the voice.js leg of the EFFICIENCY coalescing work:
// bus.on('voice:refresh', debounceLead(refreshVoice, 700)) (voice.js:509) with
// the binding comment pricing a join-leave pair at one read instead of two.
// 6e650fb's siblings were proved in 2a164b9 (workspace) and d011b83 (main.js);
// this closes the last debounceLead binding. The probe boots the real app -
// initVoice() runs at main.js:611 on every boot signed-out, so the REAL bus
// binding is installed before anything is seeded - seeds one voice channel so
// refreshVoice's table() reaches the wire, and counts voice_participants GETs
// answered by context.route (the projected channel_id,user_id read with the
// in.(channel ids) filter is THE refreshVoice read; nothing else in the app
// polls that table):
//
//   LEG A  five same-tick voice:refresh emits cost exactly TWO reads - leading
//          edge inside 400ms carrying the projected in-filter, ONE trailing
//          catch-up landing only after the 700ms window closes, then silence;
//          the lead paints Alice off the wire answer, and because the catch-up
//          saw the SAME roster the sidebar is NOT repainted a second time
//          (marked DOM node survives despite the second read).
//   LEG B  twelve emits staggered across ~550ms (a realistic join/leave churn)
//          still cost exactly two.
//   LEG C  a roster that CHANGED between lead and catch-up repaints off the
//          wire: Bob arrives, the live count flips to 2, and the marked lead-
//          era node is gone - the swallow never loses the final state.
//   LEG D  two back-to-back calls of the exported refreshVoice() cost TWO
//          immediate reads: the capture lives only at the bus binding, not
//          inside the function.
//
// Negative test (separate run): replant the binding as direct calls
// (`bus.on('voice:refresh', () => { refreshVoice(); })`) - legs A/B/C must fail
// on their exact-count shapes while D stays green, attributing the proof to the
// coalescer alone.
//
// Usage: node scripts/probe-voicerefresh.mjs [--root <dir>]
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
console.log(`probe-voicerefresh: serving ${ROOT} on ${BASE}`);

const problems = [];
const ok = (cond, label) => { if (!cond) problems.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One leg = one context = one private counter + answer script, since the
// coalescer is module state and a shared page would leak one leg's window into
// the next (probe-channelsreload precedent).
async function bootLeg(scriptAnswers) {
  const reads = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route("**/rest/v1/**", async (route) => {
    const u = new URL(route.request().url());
    const seg = u.pathname.split("/");
    if (seg[seg.length - 1] === "voice_participants") {
      const next = scriptAnswers.length ? scriptAnswers.shift() : [];
      reads.push({
        t: Date.now(),
        select: u.searchParams.get("select") || "",
        filter: u.searchParams.get("channel_id") || "",
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(next),
      });
    }
    if (seg[seg.length - 2] === "rpc") {
      const name = seg[seg.length - 1];
      let body = "null";
      if (name === "must_set_password") body = "false";
      else if (name.startsWith("get_")) body = "[]";
      return route.fulfill({ status: 200, contentType: "application/json", body });
    }
    if (u.pathname.includes("profiles")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "u-me", display_name: "Me" }]),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  const pageerrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(String(e)));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const booted = await Promise.race([
    page.waitForEvent("console", { predicate: (m) => /features loaded/.test(m.text()), timeout: 45_000 }).then(() => true),
    sleep(45_000).then(() => false),
  ]);
  ok(booted, "setup: app never reached the features-loaded boot line within 45s");
  if (!booted) return { context, page, reads, pageerrors };

  // Seed one text channel + one voice room so renderChannels has both sections
  // and refreshVoice's vids filter names a real id. store.ws is seeded too so
  // any guard that wants a workspace passes; initPresence is NOT started
  // signed out, so nothing polls voice_participants behind our back.
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    store.me = { id: "u-me", name: "Me" };
    store.myProfile = { display_name: "Me" };
    store.ws = { id: "ws-v", name: "V" };
    store.channels = [
      { id: "cT1", name: "text-one", position: 1000, category_id: "" },
      { id: "cV1", name: "voice-one", kind: "voice", position: 2000 },
    ];
    store.categories = [];
    store.unread = new Map();
    store.notify = new Map();
    store.voiceParts = new Map();
    store.dms = [];
  });
  // Let any boot noise drain, then pin the accounting baseline at zero.
  await sleep(900);
  ok(reads.length === 0,
    `setup: baseline must be zero voice_participants reads before arming (got ${reads.length})`);
  return { context, page, reads, pageerrors };
}

const emitBurst = (page, n, gapMs = 0) => page.evaluate(([n, gap]) => {
  return (async () => {
    const { bus } = await import("/js/store.js");
    for (let i = 0; i < n; i++) {
      bus.emit("voice:refresh");
      if (gap) await new Promise((r) => setTimeout(r, gap));
    }
  })();
}, [n, gapMs]);

const browser = await chromium.launch();

try {
  // ------------------------------------------------------------------ LEG A
  {
    const answers = [
      [{ channel_id: "cV1", user_id: "u-alice" }],
      [{ channel_id: "cV1", user_id: "u-alice" }], // catch-up sees SAME roster
      [{ channel_id: "cV1", user_id: "u-alice" }],
    ];
    const { context, page, reads, pageerrors } = await bootLeg(answers);
    if (reads.length === 0 && !problems.some((p) => p.startsWith("setup:"))) {
      const t0 = Date.now();
      await emitBurst(page, 5);

      await sleep(350);
      ok(reads.length === 1,
        `A: inside the window want ONLY the leading edge (got ${reads.length})`);
      ok(reads[0] && reads[0].t - t0 < 400,
        `A: leading edge took ${reads[0] ? reads[0].t - t0 : "n/a"}ms - must never sit behind the 700ms window`);
      ok(reads[0]?.select === "channel_id,user_id",
        `A: the read must carry the projected column list (${JSON.stringify(reads[0])})`);
      ok(/^\(?in\.\(/.test(reads[0]?.filter || "") && (reads[0]?.filter || "").includes("cV1"),
        `A: the read must filter channel_id in(...) over the seeded rooms (${JSON.stringify(reads[0].filter)})`);

      // The lead painted Alice; mark her row's live node so a hidden repaint
      // cannot hide behind identical-looking content.
      const marked = await page.evaluate(() => {
        const n = document.querySelector('#channels [data-voice="cV1"]');
        if (!n) return false;
        n.dataset.probeMark = "lead";
        return true;
      });
      ok(marked, "A: the lead edge should have painted the cV1 sidebar row");

      await sleep(1050); // window is 700ms; catch-up must have landed by now
      ok(reads.length === 2,
        `A: five emits must cost exactly two reads (lead + one catch-up), got ${reads.length}`);
      ok(reads[1] && reads[1].t - t0 >= 650,
        `A: trailing catch-up belongs AFTER the window closes (${reads[1] ? reads[1].t - t0 : "n/a"}ms after the burst)`);

      // Provenance: the sidebar carries the WIRE roster through renderChannels.
      const painted = await page.evaluate(() => ({
        live: document.querySelector('#channels [data-voice="cV1"] .live')?.textContent ?? null,
        parts: [...document.querySelectorAll('#channels [data-vp]')].map((n) => n.dataset.vp),
      }));
      ok(painted.live === "1" && painted.parts.includes("u-alice"),
        `A: sidebar must show the wire answer's roster (${JSON.stringify(painted)})`);

      // Guard: the catch-up saw an IDENTICAL fingerprint, so the marked node
      // from the lead must still be the standing node despite read #2.
      const stillSame = await page.evaluate(() => {
        const n = document.querySelector('#channels [data-voice="cV1"]');
        return !!n && n.dataset.probeMark === "lead";
      });
      ok(stillSame,
        "A: an unchanged catch-up must NOT repaint the sidebar (marked lead-era node was replaced)");

      await sleep(900);
      ok(reads.length === 2, `A: silence after settle expected (got ${reads.length})`);
    }
    ok(pageerrors.length === 0, `A: pageerrors: ${pageerrors.join(" | ")}`);
    await context.close();
  }

  // ------------------------------------------------------------------ LEG B
  {
    const { context, page, reads, pageerrors } = await bootLeg([]);
    if (!problems.some((p) => p.startsWith("setup:"))) {
      const t0 = Date.now();
      await emitBurst(page, 12, 50); // twelve emits across ~550ms
      await sleep(1400);
      ok(reads.length === 2,
        `B: a twelve-emit staggered burst must still cost exactly two reads, got ${reads.length}`);
      ok(reads[0] && reads[0].t - t0 < 400,
        `B: leading edge took ${reads[0] ? reads[0].t - t0 : "n/a"}ms - must be immediate`);
      await sleep(800);
      ok(reads.length === 2, `B: silence after settle expected (got ${reads.length})`);
    }
    ok(pageerrors.length === 0, `B: pageerrors: ${pageerrors.join(" | ")}`);
    await context.close();
  }

  // ------------------------------------------------------------------ LEG C
  {
    const answers = [
      [{ channel_id: "cV1", user_id: "u-alice" }],
      [{ channel_id: "cV1", user_id: "u-alice" }, { channel_id: "cV1", user_id: "u-bob" }],
      [{ channel_id: "cV1", user_id: "u-alice" }, { channel_id: "cV1", user_id: "u-bob" }],
    ];
    const { context, page, reads, pageerrors } = await bootLeg(answers);
    if (reads.length === 0 && !problems.some((p) => p.startsWith("setup:"))) {
      await emitBurst(page, 3);
      await sleep(350);
      const marked = await page.evaluate(() => {
        const n = document.querySelector('#channels [data-voice="cV1"]');
        if (!n) return false;
        n.dataset.probeMark = "lead";
        return true;
      });
      ok(marked, "C: the lead edge should have painted the cV1 sidebar row");
      await sleep(1300);
      ok(reads.length === 2, `C: want exactly lead + catch-up (got ${reads.length})`);
      const after = await page.evaluate(() => ({
        live: document.querySelector('#channels [data-voice="cV1"] .live')?.textContent ?? null,
        parts: [...document.querySelectorAll('#channels [data-vp]')].map((n) => n.dataset.vp),
        leadNodeGone: !document.querySelector('#channels [data-voice="cV1"]')?.dataset.probeMark,
      }));
      ok(after.parts.includes("u-alice") && after.parts.includes("u-bob") && after.live === "2",
        `C: the changed roster must repaint off the catch-up's wire answer (${JSON.stringify(after)})`);
      ok(after.leadNodeGone,
        "C: a changed roster MUST repaint (the lead-era node should have been replaced)");
    }
    ok(pageerrors.length === 0, `C: pageerrors: ${pageerrors.join(" | ")}`);
    await context.close();
  }

  // ------------------------------------------------------------------ LEG D
  {
    const { context, page, reads, pageerrors } = await bootLeg([]);
    if (!problems.some((p) => p.startsWith("setup:"))) {
      const t0 = Date.now();
      await page.evaluate(async () => {
        const { refreshVoice } = await import("/js/core/voice.js");
        await refreshVoice();
        await refreshVoice();
      });
      await sleep(500);
      ok(reads.length === 2,
        `D: two direct exported calls must cost two immediate reads (capture lives only at the bus binding), got ${reads.length}`);
      ok(reads[1] && reads[1].t - t0 < 450,
        `D: direct calls must go out at once (${reads[1] ? reads[1].t - t0 : "n/a"}ms)`);
    }
    ok(pageerrors.length === 0, `D: pageerrors: ${pageerrors.join(" | ")}`);
    await context.close();
  }

  await browser.close();
} catch (e) {
  problems.push("harness: " + (e && e.message ? e.message : String(e)));
}

server.close();

if (problems.length) {
  console.log("PROBE FAILED:");
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("PROBE CLEAN");
process.exit(0);
