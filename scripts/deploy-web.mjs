// Publish ONLY what a browser loads.
//
// `wrangler pages deploy .` uploads the working directory, which is this whole
// repository. Verified against production before this script existed:
//
//   /scripts/db-query.mjs               200
//   /scripts/probe-apps.mjs             200   <- the demo password is its default
//   /supabase/migrations/0112_apps.sql  200   <- every table, policy and function
//   /preview                            200   <- a mockup naming a real customer
//
// No access token was ever in any of them - db-query reads one from a path
// outside the repo - but the entire database schema and a working set of demo
// credentials were downloadable by anybody who guessed a filename.
//
// A .assetsignore file does NOT fix this: it is honoured by Workers Assets, not
// by `wrangler pages deploy`, which was confirmed by deploying one and finding
// /scripts/db-query.mjs still 200 on the fresh deployment URL. So the directory
// that gets uploaded has to genuinely contain only web assets.
//
// This DENIES rather than allows. An allow-list is the version that silently
// stops shipping a stylesheet somebody added last week; a deny-list fails in the
// safe direction, by shipping one file too many rather than one too few.
//
// Usage: node scripts/deploy-web.mjs [--dry]
import { cpSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();

// Tooling, history, secrets-adjacent things, and anything a browser never asks
// for. Directory names and exact filenames; extensions are handled below.
const DENY_DIRS = new Set([
  'scripts', 'supabase', 'node_modules', 'shots', 'screenshots', 'docs', 'qa',
  '.git', '.github', '.githooks', '.wrangler', '.claude',
]);
const DENY_FILES = new Set([
  'package.json', 'package-lock.json', 'server.cjs', 'smoketest.mjs',
  '.assetsignore', '.gitignore',
]);
const DENY_EXT = ['.md', '.sql', '.log'];

// Probe scripts live at the repo root as well as in scripts/.
const isProbe = (n) => /^probe-.*\.mjs$/.test(n);

const denied = (name) => DENY_DIRS.has(name)
  || DENY_FILES.has(name)
  || DENY_EXT.some((e) => name.endsWith(e))
  || isProbe(name);

const staged = mkdtempSync(join(tmpdir(), 'dek-web-'));
const kept = [];
const skipped = [];

for (const name of readdirSync(ROOT)) {
  if (denied(name)) { skipped.push(name); continue; }
  const from = join(ROOT, name);
  cpSync(from, join(staged, name), { recursive: statSync(from).isDirectory() });
  kept.push(name);
}

console.log('publishing :', kept.sort().join(' '));
console.log('withheld   :', skipped.sort().join(' '));

// A deploy that has quietly dropped the application is worse than one that
// shipped a stray file, so refuse rather than publish a broken site.
for (const must of ['index.html', 'sw.js', 'js', 'css']) {
  if (!existsSync(join(staged, must))) {
    console.error(`REFUSING: ${must} is missing from the staged directory`);
    rmSync(staged, { recursive: true, force: true });
    process.exit(1);
  }
}

if (process.argv.includes('--dry')) {
  console.log('dry run, staged at', staged);
  process.exit(0);
}

try {
  // shell: true because node refuses to spawn a .cmd shim directly on Windows,
  // and the staged path is one we made ourselves in the OS temp dir.
  execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler.cmd'), [
    'pages', 'deploy', `"${staged}"`,
    '--project-name=dek', '--branch=main', '--commit-dirty=true',
  ], { stdio: 'inherit', shell: true });
} finally {
  rmSync(staged, { recursive: true, force: true });
}
