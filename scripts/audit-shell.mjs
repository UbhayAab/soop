// Standing shell/offline-integrity auditor.
//
// Three incidents made this a tool instead of a memory: a concurrent session
// downgraded sw.js VERSION and stamped a BOM (5210a29), another landed
// reskin.css linked from index.html but absent from SHELL_FILES so offline
// boots silently lost the whole reskin layer (f88c63d), and the 442f875
// ground-up pass needed a hand-written audit to prove its assets precached.
// Each time the audit was an ad-hoc throwaway script. This is the reusable
// form of it: run `node scripts/audit-shell.mjs` (optionally passing a repo
// root) before any deploy or after any foreign landing. Exit 1 = do not ship.
//
// Checks:
//   1. ref sync     every local asset referenced by index.html is in SHELL_FILES
//   2. disk sync    every SHELL_FILES entry exists on disk
//   3. feature sync every FEATURES name in js/features/index.js is precached,
//                   via either the feature spread or an explicit standalone
//                   entry, and exists on disk
//   4. version      sw.js VERSION matches dek-v<N> (reported, and fails if absent)
//   5. orphan sync  every js/features/*.js on disk is either registered in
//                   FEATURES or statically imported somewhere under js/ - a
//                   file nobody references loads never and reports nothing
//                   (the people.js near-miss class)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] || '.');
const read = (p) => readFileSync(join(root, p), 'utf8');

const failures = [];
const fail = (msg) => failures.push(msg);
const uniq = (a) => [...new Set(a)];

function shellEntries(swSrc) {
  const start = swSrc.indexOf('const SHELL_FILES = [');
  if (start < 0) fail('sw.js: SHELL_FILES declaration not found');
  const end = swSrc.indexOf('];', start);
  const body = swSrc.slice(start, end);

  const entries = [];
  for (const m of body.matchAll(/'(\.[^']*)'/g)) entries.push(m[1]);

  const spreadNames = [];
  const spreadRe = /\.\.\.\[([^\]]*)\]\s*\.map\(\s*\(?n\)?\s*=>\s*`([^`]*)`/g;
  let spreadCount = 0;
  for (const m of body.matchAll(spreadRe)) {
    const names = m[1].match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
    for (const n of names) {
      spreadNames.push(n);
      entries.push(m[2].replace(/\$\{n\}/g, n));
      spreadCount++;
    }
  }
  return { entries, spreadNames, spreadCount };
}

const swSrc = read('sw.js');
const html = read('index.html');
const featSrc = read(join('js', 'features', 'index.js'));

const { entries, spreadNames, spreadCount } = shellEntries(swSrc);
const shellSet = new Set(entries);

const verMatch = swSrc.match(/const VERSION = '([^']+)';/);
if (!verMatch) fail('sw.js: VERSION constant not found');
else if (!/^dek-v\d+$/.test(verMatch[1])) fail(`sw.js: VERSION "${verMatch[1]}" is not dek-v<N>`);
const version = verMatch ? verMatch[1] : '(none)';

const refs = uniq(
  [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|mailto:|#|\/\/)/.test(u))
);
const skipped = refs.filter((r) => r.includes('sw.js'));
const localRefs = refs.filter((r) => !skipped.includes(r));

let refMissing = 0;
for (const ref of localRefs) {
  if (!shellSet.has(ref)) {
    fail(`ref-sync: index.html references "${ref}" but it is not in SHELL_FILES`);
    refMissing++;
  }
}

let diskMissing = 0;
for (const e of entries) {
  if (e === './') continue;
  if (!existsSync(join(root, e))) {
    fail(`disk-sync: SHELL_FILES entry "${e}" does not exist on disk`);
    diskMissing++;
  }
}

const featNames = uniq([...featSrc.matchAll(/^\s*'([A-Za-z0-9_-]+)',?\s*$/gm)].map((m) => m[1]));
const featMissingShell = [];
const featMissingDisk = [];
for (const n of featNames) {
  const p = `./js/features/${n}.js`;
  if (!shellSet.has(p)) featMissingShell.push(n);
  else if (!existsSync(join(root, p))) featMissingDisk.push(n);
}
for (const n of featMissingShell) fail(`feature-sync: FEATURES entry "${n}" is not precached (neither spread nor standalone entry)`);
for (const n of featMissingDisk) fail(`feature-sync: precached feature "${n}.js" does not exist on disk`);

function walkJs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const jsSources = walkJs(join(root, 'js')).map((p) => ({ p, src: readFileSync(p, 'utf8') }));
const regSet = new Set(featNames);
const diskFeatures = readdirSync(join(root, 'js', 'features'))
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .map((f) => f.slice(0, -3));
let importedOnly = 0;
for (const n of diskFeatures) {
  if (regSet.has(n)) continue;
  const referenced = jsSources.some(({ src }) =>
    src.includes(`/${n}.js'`) || src.includes(`/${n}.js"`));
  if (!referenced) fail(`orphan-sync: js/features/${n}.js is neither registered in FEATURES nor imported anywhere`);
  else importedOnly++;
}

console.log(`audit-shell @ ${version}`);
console.log(`  index.html local refs checked : ${localRefs.length}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`);
console.log(`  SHELL_FILES entries           : ${entries.length} (${spreadCount} via feature spread)`);
console.log(`  FEATURES registry             : ${featNames.length} named, ${spreadNames.length} in spread`);
console.log(`  features files on disk        : ${diskFeatures.length} (${importedOnly} imported-only, 0 orphans expected)`);
console.log(failures.length ? `\nAUDIT FAIL (${failures.length})` : '\nAUDIT CLEAN');
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
