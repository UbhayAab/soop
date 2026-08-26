// Behavioral guard for the NL-intake parser, js/lib/asks.js.
// The module shipped with its header betting "DETERMINISTIC ON PURPOSE ... it
// is also auditable: when it gets something wrong you can read the rule that
// did it", but nothing ever ran it. Every claim below is deterministic, so the
// asserts are EXACT VALUES, not shapes, at a fixed now (Thu 2026-01-15 10:30):
//
//   LEG A  parseDue absolute dates: ISO beats everything, day-first slash
//          (15/01 not 01/15), "3 mar" and "mar 25" both land this year.
//   LEG B  parseDue relative days: tomorrow / day after tomorrow / in N days /
//          in N weeks / next week (next Monday) / end of week (this Friday) /
//          end of month (Jan 31) / "the 3rd" on the 20th rolls to February.
//   LEG C  parseDue weekdays: bare dow is this week's, "next" skips a week,
//          said ON the day it still rolls forward, and "friday 5pm" ==
//          "5pm friday" wherever the clock time sits.
//   LEG D  parseDue times: clock-only lands today or tomorrow when past,
//          "by 7:30" with no am/pm means evening not morning, time words set
//          the hour, "in an hour"/"in 20 minutes" return exact ms offsets.
//   LEG E  precedence: an absolute date wins over a relative word in one line.
//   LEG F  sayDue: null empty, tomorrow/overdue/weekday names locale-stable,
//          today carries the 18:00 default as "6pm".
//   LEG G  parseAsk end to end on the header's own example: title stripped of
//          mention + politeness + date phrase, assignee off the mention,
//          Friday 18:00 due, score 7, legible why list.
//   LEG I  room ask ("someone please...") scores 7 but returns assignee null
//          + unowned true; the modal-aux variant ("can someone update...")
//          also strips clean through UNOWNED.
//   LEG J  self commitment rides SELF to me, tonight -> 20:00, score 5, no
//          "named someone" in why because the assignee IS me.
//   LEG K  longest member name wins the mention (@priya raghavan never leaves
//          a stranded surname) - and mention+verb alone stays below the line.
//   LEG L  rejections: acks, NOT_ASK list, bare links, plain chatter,
//          questions, and a sentence that is all scaffolding collapse to null.
//
// Negative test (separate run): lower the confidence threshold (`score < 4` ->
// `score < 3`) - exactly leg K's below-the-line assert must fail while every
// other leg stays green, attributing the proof to that comparison alone.
//
// Usage: node scripts/probe-asks.mjs [--root <dir>]
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
console.log(`probe-asks: serving ${ROOT} on ${BASE}`);

const problems = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  // Boot the real app so the module under test is the SERVED file loaded in
  // the real page context, then import it in-page (probe-forecast precedent:
  // in-page dynamic import gets the real bytes, not a copy bundled by Node).
  await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const out = await page.evaluate(async () => {
    const A = await import("/js/lib/asks.js");
    const NOW = new Date(2026, 0, 15, 10, 30, 0); // Thursday
    const bad = [];
    const eq = (got, want, label) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    };
    const t = (y, mo, d, h = 0, mi = 0) => +new Date(y, mo, d, h, mi, 0, 0);
    const MEMBERS = [
      { id: "u-priya", name: "Priya Raghavan" },
      { id: "u-kar", name: "Karthik" },
      { id: "u-me", name: "Me User" },
    ];
    const ME = "u-me";
    const ask = (text) => A.parseAsk(text, { members: MEMBERS, me: ME, now: NOW });

    // ---- LEG A: absolute dates
    let d = A.parseDue("submit the 2026-02-03 paperwork", NOW);
    eq(d && +d.at, t(2026, 1, 3, 18), "A iso lands 18:00");
    eq(d && d.text, "2026-02-03", "A iso text");
    d = A.parseDue("chase the 20/01 invoice run", NOW);
    eq(d && +d.at, t(2026, 0, 20, 18), "A slash day-first");
    eq(d && d.text, "20/01", "A slash text");
    d = A.parseDue("audit on 3 mar", NOW);
    eq(d && +d.at, t(2026, 2, 3, 18), "A day-month-name");
    eq(d && d.text, "3 mar", "A day-month text");
    d = A.parseDue("plan for mar 25 rollout", NOW);
    eq(d && +d.at, t(2026, 2, 25, 18), "A month-day-name");
    eq(d && d.text, "mar 25", "A month-day text");

    // ---- LEG B: relative days
    d = A.parseDue("finish it tomorrow", NOW);
    eq([d && +d.at, d && d.text], [t(2026, 0, 16, 18), "tomorrow"], "B tomorrow 18:00");
    d = A.parseDue("due the day after tomorrow", NOW);
    eq([d && +d.at, d && d.text], [t(2026, 0, 17, 18), "day after tomorrow"], "B day-after");
    d = A.parseDue("kickoff in 3 days", NOW);
    eq(+d.at, t(2026, 0, 18, 18), "B in 3 days");
    d = A.parseDue("review in 2 weeks", NOW);
    eq(+d.at, t(2026, 0, 29, 18), "B in 2 weeks");
    d = A.parseDue("stuff next week", NOW); // Thu -> next Monday Jan 19
    eq(+d.at, t(2026, 0, 19, 18), "B next week is next Monday");
    d = A.parseDue("wrap by end of week", NOW); // Thu -> this Friday Jan 16
    eq([d && +d.at, d && d.text], [t(2026, 0, 16, 18), "by end of week"], "B end of week is Friday");
    d = A.parseDue("close books end of month", NOW);
    eq(+d.at, t(2026, 0, 31, 18), "B end of month is Jan 31");
    d = A.parseDue("pay on the 3rd", new Date(2026, 0, 20, 10, 30));
    eq([d && +d.at, d && d.text], [t(2026, 1, 3, 18), "on the 3rd"], "B the 3rd on the 20th rolls months");

    // ---- LEG C: weekdays
    d = A.parseDue("sync friday", NOW);
    // leftmost-match artifact: the optional prefix group is skipped but its
    // \s* still eats the space, so the matched text carries a leading one
    eq([d && +d.at, d && d.text], [t(2026, 0, 16, 18), " friday"], "C bare dow this week");
    d = A.parseDue("sync by friday", NOW);
    eq([d && +d.at, d && d.text], [t(2026, 0, 16, 18), "by friday"], "C by-friday keeps prefix in text");
    d = A.parseDue("sync next friday", NOW);
    eq([d && +d.at, d && d.text], [t(2026, 0, 23, 18), "next friday"], "C next skips a week");
    d = A.parseDue("sync on friday", new Date(2026, 0, 16, 10, 30));
    eq(+d.at, t(2026, 0, 23, 18), "C friday-on-friday rolls forward");
    d = A.parseDue("demo friday 5pm", NOW);
    eq([d && +d.at, d && d.hadTime, d && d.timeText], [t(2026, 0, 16, 17), true, "5pm"], "C day then time");
    d = A.parseDue("demo 5pm friday", NOW);
    eq(+d.at, t(2026, 0, 16, 17), "C time then day same landing");

    // ---- LEG D: times without days
    d = A.parseDue("deploy the fix at 3pm", NOW);
    eq([d && +d.at, d && d.text, d && d.timeText, d && d.hadTime],
      [t(2026, 0, 15, 15), "at 3pm", "at 3pm", true], "D clock-only today");
    d = A.parseDue("send it by 9am", new Date(2026, 0, 15, 15, 0));
    eq([d && +d.at, d && d.text], [t(2026, 0, 16, 9), "by 9am"], "D past-time rolls to tomorrow");
    d = A.parseDue("finish by 7:30", NOW);
    eq([d && +d.at, d && d.text], [t(2026, 0, 15, 19, 30), "by 7:30"], "D bare early h:mm means working day");
    d = A.parseDue("walkthrough this evening", NOW);
    eq([d && +d.at, d && d.timeText], [t(2026, 0, 15, 18), "evening"], "D evening word sets hour");
    d = A.parseDue("ping me in an hour", NOW);
    eq([d && +d.at, d && d.text, d && d.timeText, d && d.hadTime],
      [+NOW + 3600000, "in an hour", "", true], "D in-an-hour exact ms");
    d = A.parseDue("ping me in 20 minutes", NOW);
    eq(+d.at, +NOW + 20 * 60000, "D in-20-minutes exact ms");
    eq(A.parseDue("no deadline in this line", NOW), null, "D plain line null");
    eq(A.parseDue("", NOW), null, "D empty line null");

    // ---- LEG E: absolute beats relative inside one line
    d = A.parseDue("submit 2026-02-03 tomorrow", NOW);
    eq([d && +d.at, d && d.text], [t(2026, 1, 3, 18), "2026-02-03"], "E absolute beats relative");

    // ---- LEG F: sayDue
    eq(A.sayDue(null, NOW), "", "F null empty");
    eq(A.sayDue(new Date(2026, 0, 16, 0, 0), NOW), "tomorrow", "F tomorrow midnight no time");
    eq(A.sayDue(new Date(2026, 0, 10), NOW), "overdue", "F past is overdue");
    eq(A.sayDue(new Date(2026, 0, 17, 0, 0), NOW), "saturday", "F weekday name lowercase");
    eq(A.sayDue(new Date(2026, 0, 15, 18, 0), NOW), "today 6pm", "F today carries default hour");

    // ---- LEG G: the header's own example end to end
    let r = ask("@karthik please get the vendor invoices reconciled by Friday");
    eq(r && r.title, "Get the vendor invoices reconciled", "G title stripped clean");
    eq(r && r.assignee, "u-kar", "G mention assigns");
    eq(r && +r.due, t(2026, 0, 16, 18), "G due friday 18:00");
    eq(r && [r.dueHadTime, r.unowned, r.selfCommit, r.score], [false, false, false, 7], "G exact flags+score");
    // "reconciled" is suffixed so the verb regex passes over it; "get" is the
    // first array-order verb that matches the line as written
    eq(r && r.why, ["named someone", "a request", "\"get\"", "a deadline"], "G why legible order");

    // ---- LEG I: asks addressed to the room
    r = ask("someone please reconcile the invoices by friday");
    eq(r && r.title, "Reconcile the invoices", "I room ask title");
    eq(r && [r.assignee, r.unowned, r.score], [null, true, 7], "I unowned nulls the assignee");
    eq(r && +r.due, t(2026, 0, 16, 18), "I room due");
    r = ask("can someone update the pricing doc by wednesday");
    eq(r && r.title, "Update the pricing doc", "I aux variant title");
    eq(r && [r.assignee, r.unowned, r.score], [null, true, 5], "I aux variant fields");
    eq(r && +r.due, t(2026, 0, 21, 18), "I wednesday next week from thu");

    // ---- LEG J: self commitment
    r = ask("i will send the report to priya by tonight");
    eq(r && r.title, "Send the report to priya", "J self title");
    eq(r && [r.assignee, r.selfCommit, r.dueHadTime, r.score], ["u-me", true, true, 5], "J self fields");
    eq(r && +r.due, t(2026, 0, 15, 20), "J tonight 20:00");
    eq(r && r.why, ["you said you would", "\"send\"", "a deadline"], "J self why has no named-someone");

    // ---- LEG K: longest member name wins; mention+verb alone is not enough
    r = ask("@priya raghavan please ping the vendor");
    eq(r && r.assignee, "u-priya", "K longest mention wins");
    eq(r && r.title, "Ping the vendor", "K no stranded surname");
    eq(r && r.score, 5, "K polite lifts it over the line");
    eq(ask("@priya raghavan ping the vendor"), null, "K mention+verb alone stays below the line");

    // ---- LEG L: things that look like requests and are not
    eq(ask("ok"), null, "L ack short null");
    eq(ask("done"), null, "L not-ask word null");
    eq(ask("thanks"), null, "L thanks null");
    eq(ask("https://example.com/a/very/long/path/segment"), null, "L bare link null");
    eq(ask("hey karthik how was the weekend"), null, "L plain chatter null");
    eq(ask("when is the offsite happening?"), null, "L question null");
    eq(ask("please fix today"), null, "L scaffolding-only title rejected");

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
  console.log("legs: A absolute | B relative | C weekdays | D clocks | E precedence | F sayDue | G end-to-end | I room | J self | K longest+threshold | L rejections");
  console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join("\n- ") : "PROBE CLEAN");
  process.exitCode = problems.length ? 1 : 0;
}
