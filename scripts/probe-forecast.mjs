// Behavioral guard for the roadmap-18 forecast kernel, js/lib/forecast.js.
// d4fb60a shipped the whole measured kernel (WINDOW_DAYS/MIN_SAMPLES/pct/
// cycleDays/refClass/conditionalRemaining/ageBand/dailyThroughput/mcWhen/
// phrase/forecast) verified statically against PLAN.md's spec - its own header
// says "Pure and DOM-free ... which is what makes it checkable" - but nothing
// ever checked it behaviorally. Every claim below is deterministic, so the
// asserts are EXACT VALUES, not shapes:
//
//   LEG A  pct() is nearest-rank, never interpolated, never a mean; empty is
//          null; single element clamps at both ends.
//   LEG B  cycleDays() drops cancelled/rejected/no-done/negative/non-finite,
//          prefers started_at over created_at, returns ascending days.
//   LEG C  refClass() narrows person+channel -> person -> channel -> Space,
//          caps any tier at MAX_SAMPLES(50), reports 'thin' under 12.
//   LEG D  conditionalRemaining() compares STRICTLY greater than age (an item
//          that lasted exactly `age` cannot speak about it), needs 3 survivors,
//          and reads p50/p85 off the survivors nearest-rank.
//   LEG E  ageBand() cuts at pct80/pct90/pct95 into ok/amber/red/stale and is
//          'unknown' under MIN_SAMPLES regardless of age.
//   LEG F  dailyThroughput() bins index 0 = today, keeps zero days, drops
//          out-of-window and future entries, honours the window argument.
//   LEG G  mcWhen() is exact on deterministic histories ([1],n=1 -> 1 day;
//          [2],n=5 -> 3 days) and null on empty/all-zero/n<=0.
//   LEG H  forecast() end to end: done -> null; future start -> null; thin
//          path quotes the worst; started_at beats created_at for age; the
//          full path narrows to the right tier, computes remaining percentiles
//          and printable dates; an age past everything finished goes stale.
//
// Negative test (separate run): loosen the strict filter in
// conditionalRemaining (`>` -> `>=`) - leg D must fail on its exact p50 while
// every other leg stays green, attributing the proof to that comparison alone.
//
// Usage: node scripts/probe-forecast.mjs [--root <dir>]
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
console.log(`probe-forecast: serving ${ROOT} on ${BASE}`);

const problems = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  // Boot the real app so the module under test is the SERVED file loaded in
  // the real page context, then import it in-page (probe-tabbar precedent:
  // in-page dynamic import gets the real bytes, not a copy bundled by Node).
  await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const out = await page.evaluate(async () => {
    const DAY = 86400000;
    const F = await import("/js/lib/forecast.js");
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };

    // ---- LEG A: pct nearest-rank
    eq(F.pct([10, 20, 30], 50), 20, "A pct median-of-3");
    eq(F.pct([10, 20], 85), 20, "A pct p85-of-2 rounds up");
    eq(F.pct([10, 20], 50), 10, "A pct p50-of-2 lower");
    eq(F.pct([], 50), null, "A pct empty null");
    eq([F.pct([7], 99), F.pct([7], 1)], [7, 7], "A pct single clamps");

    // ---- LEG B: cycleDays filtering + started_at preference + ordering
    const now = Date.now();
    const rows = [
      // kept: started_at preferred over earlier created_at -> 10 days
      { id: "k1", done_at: now, created_at: now - 40 * DAY, started_at: now - 10 * DAY },
      // kept: falls back to created_at -> 3 days
      { id: "k2", done_at: now - 1 * DAY, created_at: now - 4 * DAY },
      // dropped: state cancelled without cancelled_at
      { id: "c1", state: "cancelled", done_at: now, created_at: now - 2 * DAY },
      // dropped: cancelled_at even with a live state
      { id: "c2", state: "done", cancelled_at: now, done_at: now, created_at: now - 2 * DAY },
      // dropped: rejected
      { id: "c3", state: "rejected", done_at: now, created_at: now - 2 * DAY },
      // dropped: never finished
      { id: "c4", created_at: now - 9 * DAY },
      // dropped: negative duration (finished before it began)
      { id: "c5", done_at: now - 5 * DAY, created_at: now - 1 * DAY },
      // dropped: non-finite duration (neither timestamp)
      { id: "c6", done_at: now },
    ];
    eq(F.cycleDays(rows), [3, 10], "B cycleDays filters+orders");

    // ---- LEG C: refClass narrowing + MAX_SAMPLES cap + thin
    const doneRows = (n, assignee, chan, durFn) =>
      Array.from({ length: n }, (_, i) => {
        const d = durFn(i);
        return {
          assignee_id: assignee, channel_id: chan,
          created_at: now - d * DAY, done_at: now - d * DAY + 12 * 3600000,
        };
      });
    // 14 rows for P@C1 plus 30 noise rows elsewhere
    const pool = [
      ...doneRows(14, "P", "C1", (i) => 1 + (i % 14)),
      ...doneRows(30, "Q", "C2", () => 2),
    ];
    eq(
      (({ basis, n }) => ({ basis, n }))(F.refClass(pool, { assignee_id: "P", channel_id: "C1" })),
      { basis: "this person in this channel", n: 14 },
      "C narrows to person+channel"
    );
    // only 11 for P -> fall to channel tier (14 P@C1 count toward C1 too)
    const pool2 = [...doneRows(11, "P", "C1", () => 2), ...doneRows(12, "R", "C1", () => 3)];
    eq(F.refClass(pool2, { assignee_id: "P", channel_id: "C1" }).basis, "this channel", "C falls to channel tier");
    // nothing reaches 12 anywhere
    const pool3 = doneRows(11, "P", "C1", () => 2);
    const thin = F.refClass(pool3, { assignee_id: "P", channel_id: "C1" });
    eq({ basis: thin.basis, n: thin.n }, { basis: "thin", n: 11 }, "C thin under MIN_SAMPLES");
    // cap at MAX_SAMPLES
    eq(F.refClass(doneRows(55, "P", "C1", () => 2), { assignee_id: "P", channel_id: "C1" }).n, 50, "C caps at MAX_SAMPLES");

    // ---- LEG D: conditionalRemaining strictness + exact percentiles
    eq(F.conditionalRemaining([2, 4, 6, 8], 4), null, "D fewer than 3 survivors null");
    eq(F.conditionalRemaining([5, 7, 9, 11], 5), { p50: 4, p85: 6, n: 3 }, "D strict > age, exact ranks");
    eq(F.conditionalRemaining([], 1), null, "D empty null");

    // ---- LEG E: ageBand cut points (days 1..12 sorted)
    const d12 = Array.from({ length: 12 }, (_, i) => i + 1);
    eq(
      [F.ageBand(9.5, d12), F.ageBand(10, d12), F.ageBand(11, d12), F.ageBand(12, d12)],
      ["ok", "amber", "red", "stale"],
      "E bands at pct80/90/95"
    );
    eq(F.ageBand(99, d12.slice(0, 11)), "unknown", "E unknown under MIN_SAMPLES");

    // ---- LEG F: dailyThroughput binning
    const iso = (ageDays) => new Date(Date.now() - ageDays * DAY).toISOString();
    const hist = F.dailyThroughput([iso(0), iso(1), iso(1), iso(55), iso(56), iso(120), iso(-3)]);
    eq(hist.length, F.WINDOW_DAYS, "F window length default");
    eq([hist[0], hist[1], hist[55]], [1, 2, 1], "F bins today/yesterday/edge");
    eq(hist.some((v, i) => v !== 0 && i !== 0 && i !== 1 && i !== 55), false, "F zeros preserved elsewhere");
    eq(F.dailyThroughput([iso(0)], 7).length, 7, "F honours window arg");

    // ---- LEG G: mcWhen exact on deterministic histories
    eq(F.mcWhen([1], 1), { p50: 1, p85: 1 }, "G one-per-day history exact");
    eq(F.mcWhen([2], 5), { p50: 3, p85: 3 }, "G twos history exact");
    eq([F.mcWhen([], 1), F.mcWhen([0, 0], 3), F.mcWhen([1], 0)], [null, null, null], "G guards");

    // ---- LEG H: forecast() end to end at a FIXED now
    const NOW = Date.UTC(2026, 0, 15);
    const mkDone = (id, assignee, chan, dur) => ({
      id, assignee_id: assignee, channel_id: chan,
      created_at: NOW - dur * DAY, done_at: NOW,
    });
    eq(F.forecast([{ done_at: NOW }], { created_at: NOW - DAY, done_at: NOW }, NOW), null, "H done task null");
    eq(F.forecast([], { created_at: NOW + DAY }, NOW), null, "H negative age null");

    // thin: 5 finished, open task aged 2 days
    const thinPool = [1, 2, 3, 4, 9].map((d, i) => mkDone("t" + i, "P", "C1", d));
    const fThin = F.forecast(thinPool, { assignee_id: "P", channel_id: "C1", created_at: NOW - 2 * DAY }, NOW);
    eq(
      fThin && { thin: fThin.thin, band: fThin.band, n: fThin.n, worst: fThin.worst, basis: fThin.basis },
      { thin: true, band: "unknown", n: 5, worst: 9, basis: "thin" },
      "H thin path quotes the worst"
    );

    // full: 15 finished for P@C1 lasting 1..15 days, 30 noise rows, open task aged 6
    const fullPool = [
      ...Array.from({ length: 15 }, (_, i) => mkDone("f" + i, "P", "C1", i + 1)),
      ...Array.from({ length: 30 }, (_, i) => mkDone("q" + i, "Q", "C2", 4)),
    ];
    const fFull = F.forecast(fullPool, { assignee_id: "P", channel_id: "C1", created_at: NOW - 6 * DAY }, NOW);
    eq(
      fFull && {
        thin: fFull.thin, band: fFull.band, basis: fFull.basis, n: fFull.n,
        p50Days: fFull.p50Days, p85Days: fFull.p85Days,
        p50At: fFull.p50At - NOW, p85At: fFull.p85At - NOW, ageDays: fFull.ageDays,
      },
      {
        thin: false, band: "ok", basis: "this person in this channel", n: 15,
        p50Days: 5, p85Days: 8, p50At: 5 * DAY, p85At: 8 * DAY, ageDays: 6,
      },
      "H full path exact remaining + dates"
    );

    // stale: aged past everything the team ever finished
    const fStale = F.forecast(fullPool, { assignee_id: "P", channel_id: "C1", created_at: NOW - 20 * DAY }, NOW);
    eq(
      fStale && { stale: fStale.stale, band: fStale.band, thin: fStale.thin },
      { stale: true, band: "stale", thin: false },
      "H older-than-everything goes stale"
    );

    // started_at preferred for AGE too: created long ago but picked up 2 days ago
    const fStart = F.forecast(
      fullPool,
      { assignee_id: "P", channel_id: "C1", created_at: NOW - 20 * DAY, started_at: NOW - 2 * DAY },
      NOW
    );
    eq(fStart && fStart.ageDays, 2, "H age rides started_at");

    // phrase(): thin and full wording, null is empty
    eq(F.phrase(null), "", "H phrase null empty");
    eq(
      F.phrase({ thin: true, n: 5, worst: 9 }).includes("Not enough finished work"),
      true, "H phrase thin wording"
    );
    eq(
      F.phrase({ p50Date: "Jan 20", p85Date: "Jan 23", n: 15, basis: "this person in this channel" })
        .indexOf("Most likely Jan 20") === 0 &&
        F.phrase({ p50Date: "x", p85Date: "y", n: 15, basis: "b" }).includes("85 times out of 100"),
      true, "H phrase full wording"
    );

    return { bad };
  });

  problems.push(...out.bad);
} catch (e) {
  console.error("SETUP FAILURE:", e.message);
  process.exitCode = 2;
} finally {
  if (errors.length) problems.push(`pageerrors: ${errors.length} (${errors[0]})`);
  await browser.close();
  server.close();
}

if (process.exitCode !== 2) {
  console.log("legs: A pct | B cycleDays | C refClass | D conditionalRemaining | E ageBand | F dailyThroughput | G mcWhen | H forecast+phrase");
  console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
  process.exitCode = problems.length ? 1 : 0;
}
