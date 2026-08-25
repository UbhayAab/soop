// Standing probe-suite runner: discovers every probe-*.mjs (repo root +
// scripts/), boots the two static servers the probes expect (4177 for shell
// probes, 8098 for the embed-bridge self-parent trick), runs each probe
// serially and gates the run on EXIT CODES - institutionalising the
// post-reskin sweep that hand-ran 13 probes one at a time.
//
// Port reuse: if a needed port is already bound, /index.html is fetched and
// byte-compared against the local tree; an identical body is reused (the
// d2102c2 precedent), anything else aborts rather than testing against a
// foreign server.
//
// Usage:
//   node scripts/probe-all.mjs                 # whole suite
//   node scripts/probe-all.mjs --only lifo     # name substring filter, repeatable via comma
//   node scripts/probe-all.mjs --timeout 90    # per-probe kill timeout (s)
//
// Exit codes: 0 all probes passed, 1 any probe failed, 2 environment failure.

import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, normalize, resolve, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORTS = [4177, 8098];

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? argv[onlyIdx + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
const toIdx = argv.indexOf("--timeout");
const TIMEOUT_MS = (toIdx >= 0 ? Number(argv[toIdx + 1]) : 150) * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function serve(rootDir, port) {
  const server = createServer(async (req, res) => {
    try {
      let p;
      try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); }
      catch { res.writeHead(400).end(); return; }
      let file = normalize(join(rootDir, p));
      if (!file.startsWith(normalize(rootDir + sep))) { res.writeHead(403).end(); return; }
      const body = await readFile(file).catch(() => null);
      if (body === null) { res.writeHead(404, { "content-type": "text/plain" }).end("not found: " + p); return; }
      res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream", "content-length": body.length });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err && err.message || err));
    }
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done(server));
  });
}

async function servesOurTree(port) {
  try {
    const [remote, local] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/index.html`).then((r) => r.text()),
      readFile(join(ROOT, "index.html"), "utf8"),
    ]);
    return remote === local;
  } catch {
    return false;
  }
}

async function discover() {
  const out = [];
  const self = basename(fileURLToPath(import.meta.url));
  for (const dir of [ROOT, join(ROOT, "scripts")]) {
    for (const f of await readdir(dir)) {
      if (f === self) continue;
      if (/^probe-.+\.mjs$/.test(f)) out.push(join(dir, f));
    }
  }
  return [...new Set(out)].sort();
}

function runProbe(file) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const tag = basename(file);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    for (const stream of [child.stdout, child.stderr]) {
      let buf = "";
      stream.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          console.log(`  ${tag} | ` + buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
    }
    child.on("close", (code) => { clearTimeout(timer); done(timedOut ? -1 : code); });
    child.on("error", () => { clearTimeout(timer); done(-2); });
  });
}

const servers = [];
let exitCode = 0;
try {
  for (const port of PORTS) {
    try {
      servers.push(await serve(ROOT, port));
      console.log(`probe-all: serving ${ROOT} on ${port}`);
    } catch {
      if (await servesOurTree(port)) {
        console.log(`probe-all: port ${port} already bound but serving this exact tree, reusing`);
      } else {
        console.error(`probe-all: port ${port} is foreign-held (not serving this tree); aborting so probes never test a stranger's server`);
        process.exit(2);
      }
    }
  }

  const files = await discover();
  if (!files.length) { console.error("probe-all: no probe-*.mjs found"); process.exit(2); }
  const selected = only ? files.filter((f) => only.some((n) => basename(f).includes(n))) : files;

  const results = [];
  for (const f of selected) {
    const name = basename(f);
    console.log(`\nprobe-all: RUN ${name}`);
    const code = await runProbe(f);
    results.push({ name, code });
    console.log(`probe-all: ${code === 0 ? "PASS" : "FAIL"} ${name}${code === -1 ? " (timeout)" : code < 0 ? " (spawn error)" : ""}`);
  }

  const failed = results.filter((r) => r.code !== 0);
  const skipped = files.length - selected.length;
  console.log(`\nprobe-all: ${results.length - failed.length}/${results.length} clean` +
    (skipped ? `, ${skipped} filtered out` : "") +
    (failed.length ? `\nFAILED: ${failed.map((f) => f.name).join(", ")}` : ""));
  exitCode = failed.length ? 1 : 0;
} finally {
  for (const s of servers) await new Promise((done) => s.close(done));
}
process.exit(exitCode);
