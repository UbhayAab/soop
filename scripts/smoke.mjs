// Standing boot-smoke runner: boots its own static server, loads the app in
// headless Chromium, writes a screenshot, and fails the run (exit 1) on ANY
// pageerror. Institutionalises the per-burst ritual of hand-rolled
// http.server processes that kept outliving their sessions (ports 4173/4177
// zombies) plus eyeballing screenshot.mjs console dumps.
//
// Usage:
//   node scripts/smoke.mjs                          # repo root, dynamic port
//   node scripts/smoke.mjs --out s/burst.png        # custom shot path
//   node scripts/smoke.mjs --path "?embed=1&host=http://localhost:8098" --port 8098
//   node scripts/smoke.mjs --root /tmp/fixture      # negative tests
//   node scripts/smoke.mjs --expect-features 36     # also fail if the boot's
//                                                   # [hearth] features loaded
//                                                   # line counts under N
//
// Exit codes: 0 SMOKE CLEAN, 1 pageerror(s) found, 2 usage or launch failure.
// Console errors/warnings that are NOT pageerrors are echoed but do not fail:
// embed mode carries known host-origin postMessage noise.

import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root || args._[0] || ".");
const port = Number(args.port || 0);
const urlPath = typeof args.path === "string" ? args.path : "/";
const outPath = resolve(args.out || "s/smoke.png");
const wait = Number(args.wait || 1500);
const dark = Boolean(args.dark);
const fullPage = Boolean(args["full-page"]);
const deviceName = typeof args.device === "string" ? args.device : "iPhone 13 Pro";
if (args.width || args.height) {
  // explicit viewport beats the device profile
  args.device = "";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function serve(rootDir) {
  const server = createServer(async (req, res) => {
    try {
      let p;
      try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); }
      catch { res.writeHead(400).end("bad path"); return; }
      let file = normalize(join(rootDir, p));
      if (!file.startsWith(normalize(rootDir + sep))) { res.writeHead(403).end(); return; }
      let st = await stat(file).catch(() => null);
      if (st && st.isDirectory()) { file = join(file, "index.html"); st = await stat(file).catch(() => null); }
      if (!st) { res.writeHead(404, { "content-type": "text/plain" }).end("not found: " + p); return; }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream", "content-length": body.length });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(err && err.message || err));
    }
  });
  return new Promise((done, fail) => {
    server.on("error", fail);
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

await mkdir(dirname(outPath), { recursive: true });

let server;
try {
  server = await serve(root);
} catch (err) {
  console.error("smoke: server boot failed:", err.message);
  process.exit(2);
}
const actualPort = server.address().port;
const url = `http://127.0.0.1:${actualPort}${urlPath}`;
console.log(`smoke: serving ${root} on ${actualPort}, loading ${url}`);

let exitCode = 0;
try {
  const browser = await chromium.launch();
  const contextOptions = deviceName
    ? { ...devices[deviceName], colorScheme: dark ? "dark" : "light" }
    : { viewport: { width: Number(args.width || 1280), height: Number(args.height || 800) }, colorScheme: dark ? "dark" : "light" };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const pageerrors = [];
  const lines = [];
  let featureLine = null;
  page.on("pageerror", (err) => { pageerrors.push(err.message); lines.push(`[pageerror] ${err.message}`); });
  page.on("console", (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (text.startsWith("[hearth] features loaded:")) featureLine = text;
    if (t === "error" || t === "warning") lines.push(`[console.${t}] ${text}`);
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: outPath, fullPage });
  console.log(`smoke: wrote ${outPath}`);

  const want = args["expect-features"];
  let featureCount = null;
  if (featureLine) {
    const list = featureLine.slice("[hearth] features loaded:".length).trim();
    featureCount = list === "none" || !list ? 0 : list.split(",").filter((s) => s.trim()).length;
    console.log(`smoke: features loaded: ${featureCount}`);
  }
  if (want !== undefined && want !== true) {
    if (featureCount === null) {
      console.error("SMOKE FAILED: no [hearth] features loaded line seen");
      exitCode = 1;
    } else if (featureCount < Number(want)) {
      console.error(`SMOKE FAILED: expected >= ${want} features, saw ${featureCount}`);
      exitCode = 1;
    }
  }

  const fatal = pageerrors.length > 0;
  if (lines.length) {
    console.log("--- page console (errors/warnings only) ---");
    for (const l of lines) console.log(l);
  }
  if (!exitCode) {
    console.log(fatal
      ? `SMOKE FAILED: ${pageerrors.length} pageerror(s)`
      : "SMOKE CLEAN: zero pageerror");
    if (fatal) exitCode = 1;
  }
  await context.close();
  await browser.close();
} catch (err) {
  console.error("smoke failed:", err.message);
  exitCode = 2;
} finally {
  server.close();
}

process.exit(exitCode);
