#!/usr/bin/env node
// Port of the integrity workflow's syntax loop so the same gate runs locally
// via `npm test` on any OS. Excludes only node_modules/.git so new top-level
// JS lands guarded by default, matching .github/workflows/integrity.yml.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const SKIP = new Set(['node_modules', '.git']);
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.m?js$/.test(entry)) files.push(full);
  }
}

walk(root);

let fails = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  if (r.status !== 0) {
    fails++;
    console.error('SYNTAX FAIL: ' + relative(root, f));
    if (r.stderr) process.stderr.write(r.stderr);
  }
}

console.log(`node --check: ${files.length} files, ${fails} failures`);
process.exit(fails === 0 ? 0 : 1);
