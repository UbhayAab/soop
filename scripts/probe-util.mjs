// Behavioral guard for js/util.js pure primitives.
// Picked by fresh unprobed-claims sweep when QUEUE empty on read 2026-08-29;
// all js/lib modules and every wire-counted coalescer binding already have a
// probe, but the util.js KERNEL those bindings all lean on - debounceLead, the
// exact primitive behind every channels:reload / voice:refresh / user-topic
// coalescer - plus the deterministic formatting helpers (esc, plain, fmtSize,
// hueOf, initials, toLocalInput/fromLocalInput, the isPlain fast path of fmt,
// relTime, dayOf) never ran headless against their own headers. Every claim
// below is deterministic, so the asserts are EXACT VALUES, not shapes:
//
//   LEG A  debounceLead leading edge fires the FIRST call synchronously,
//          repeats inside the window are swallowed, and when the window closes
//          EXACTLY ONE trailing catch-up fires carrying the LAST swallowed
//          args, then silence.
//   LEG B  an isolated call after settle is a fresh leading edge: it fires
//          immediately and leaves NO trailing ghost behind.
//   LEG C  the window opens BEFORE fn runs, so a synchronous throw inside fn
//          still counts as handled - the next call is swallowed, and the
//          trailing catch-up still fires (the pending flag was armed).
//   LEG D  a single isolated call with nothing swallowed produces no trailing
//          catch-up at all - one call, one fire.
//   LEG E  esc() escapes & < > " ' and coerces null to "".
//   LEG F  plain() strips markdown sigils, collapses whitespace, and truncates
//          with a single ellipsis char at exactly n-1.
//   LEG G  fmtSize() coerces non-numeric input to 0 B (the XSS-fix claim),
//          shows KB integer and MB one-decimal, and its STRICTLY-greater tier
//          comparisons pin exact-tier-boundary inputs to the lower tier
//          (1024 -> "1024 B", 1048576 -> "1024 KB").
//   LEG H  hueOf() is a pure id hash with a pinned deterministic value.
//   LEG I  initials() takes the first two parts uppercased and falls back to
//          "?" on empty.
//   LEG J  toLocalInput/fromLocalInput round-trip a local datetime verbatim.
//   LEG K  fmt() isPlain fast path never needs the CDN: plain text escapes
//          verbatim into one <p>, newlines become <br>+newline, empty is "".
//   LEG L  relTime() pins the just now / m / h / d ladders off now.
//   LEG M  dayOf() pins Today and Yesterday boundaries.
//
// Negative test (separate run): delete the trailing catch-up line in
// debounceLead (drop `wrapped(...args)`) - legs A and C must fail on their
// trailing-catch-up shapes while B/D/E..M stay green, attributing the proof
// to that exact behavior.
//
// Usage: node scripts/probe-util.mjs [--root <dir>]
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
console.log(`probe-util: serving ${ROOT} on ${BASE}`);

const problems = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const out = await page.evaluate(async () => {
    const U = await import("/js/util.js");
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const MS = 40; // debounceLead window

    // ---- LEG A: leading edge + swallow + ONE trailing catch-up with LAST args
    {
      const calls = [];
      const w = U.debounceLead((...a) => calls.push(a), MS);
      w(1);          // leading edge fires immediately
      w(2);          // swallowed
      w(3);          // swallowed, LAST args remembered
      eq(calls.length, 1, "A leading edge fired immediately");
      eq(JSON.stringify(calls[0]), JSON.stringify([1]), "A first call args were 1");
      await sleep(MS * 2);
      eq(calls.length, 2, "A exactly one trailing catch-up after window");
      eq(JSON.stringify(calls[1]), JSON.stringify([3]), "A trailing catch-up carries LAST swallowed args");
      await sleep(MS * 2);
      eq(calls.length, 2, "A no further calls after the trailing (silence)");
    }

    // ---- LEG B: a post-settle isolated call is a fresh leading edge, no ghost
    {
      const calls = [];
      const w = U.debounceLead((...a) => calls.push(a), MS);
      w("solo");
      eq(calls.length, 1, "B isolated call fires as a fresh leading edge");
      await sleep(MS * 2);
      eq(calls.length, 1, "B no trailing ghost after an isolated call");
    }

    // ---- LEG C: window opens BEFORE fn runs - a synchronous throw is handled
    {
      const calls = [];
      let thrown = false;
      const w = U.debounceLead((...a) => {
        if (!thrown) { thrown = true; throw new Error("boom"); }
        calls.push(a);
      }, MS);
      let caught = null;
      try { w("x"); } catch (e) { caught = e; }
      eq(caught !== null, true, "C first call threw synchronously");
      w("y");        // window was already armed -> swallowed, not a new lead
      eq(calls.length, 0, "C swallowed call did not re-fire fn");
      await sleep(MS * 2);
      eq(calls.length, 1, "C trailing catch-up still fired after the throw");
      eq(JSON.stringify(calls[0]), JSON.stringify(["y"]), "C trailing carries the swallowed arg");
    }

    // ---- LEG D: nothing swallowed -> no trailing catch-up
    {
      const calls = [];
      const w = U.debounceLead((a) => calls.push(a), MS);
      w("one");
      await sleep(MS * 2);
      eq(calls.length, 1, "D one call one fire, no trailing");
    }

    // ---- LEG E: esc
    eq(U.esc("<b>\"x\" & 'y'</b>"), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;", "E esc escapes < > \" & '");
    eq(U.esc(null), "", "E esc null -> empty");
    eq(U.esc("plain"), "plain", "E esc passthrough");

    // ---- LEG F: plain
    eq(U.plain("a *bold* **b** `c` ~d~ >q #tag  th"), "a bold b c d q tag th", "F plain strips sigils + collapses whitespace");
    eq(U.plain("abcdefghij", 5), "abcd…", "F plain truncates at n-1 with one ellipsis");

    // ---- LEG G: fmtSize (comparisons are STRICTLY greater, so exact tier
    // boundaries render in the lower tier: 1024 -> "1024 B", 1048576 -> "1024 KB")
    eq(U.fmtSize(0), "0 B", "G zero bytes");
    eq(U.fmtSize(1023), "1023 B", "G under a KB stays bytes");
    eq(U.fmtSize(1024), "1024 B", "G exact 1024 boundary stays bytes (strict >)");
    eq(U.fmtSize(1025), "1 KB", "G KB integer above the boundary");
    eq(U.fmtSize(1048576), "1024 KB", "G exact 1 MB boundary stays KB (strict >)");
    eq(U.fmtSize(1048577), "1.0 MB", "G MB one decimal above the boundary");
    eq(U.fmtSize("garbage"), "0 B", "G non-numeric coerces to 0 B (the XSS defense)");

    // ---- LEG H: hueOf deterministic
    eq(U.hueOf("abc"), 234, "H hueOf fixed id hash (abc->234)");

    // ---- LEG I: initials
    eq(U.initials("Asha Kumar"), "AK", "I two-name initials");
    eq(U.initials("maya"), "M", "I single name initials");
    eq(U.initials("A  B  C"), "AB", "I first two parts only");
    eq(U.initials(""), "?", "I empty fallback");

    // ---- LEG J: toLocalInput/fromLocalInput round trip
    eq(U.toLocalInput(U.fromLocalInput("2026-08-29T15:45")), "2026-08-29T15:45", "J local datetime round-trips verbatim");

    // ---- LEG K: fmt isPlain fast path
    eq(U.fmt("hello world"), "<p>hello world</p>", "K plain single line -> one p");
    eq(U.fmt("line1\nline2"), "<p>line1<br>\nline2</p>", "K newline -> br + newline");
    eq(U.fmt(""), "", "K empty -> empty");

    // ---- LEG L: relTime ladder (now-anchored, deterministic off same clock)
    {
      const now = Date.now();
      eq(U.relTime(now - 30 * 1000), "just now", "L under a minute");
      eq(U.relTime(now - 2 * 60 * 1000), "2m ago", "L minutes");
      eq(U.relTime(now - 3 * 3600 * 1000), "3h ago", "L hours");
      eq(U.relTime(now - 2 * 86400 * 1000), "2d ago", "L days");
    }

    // ---- LEG M: dayOf Today / Yesterday
    {
      const now = new Date();
      eq(U.dayOf(now.getTime()), "Today", "M today");
      eq(U.dayOf(now.getTime() - 86400000), "Yesterday", "M yesterday");
    }

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
  console.log("legs: A debounceLead burst | B fresh lead | C throw-handled | D no-ghost | E esc | F plain | G fmtSize | H hueOf | I initials | J tz-roundtrip | K fmt-plain | L relTime | M dayOf");
  console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
  process.exitCode = problems.length ? 1 : 0;
}
