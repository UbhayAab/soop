// One-off repair for double-encoded UTF-8 ("mojibake") across repo text files.
// Corruption: original UTF-8 bytes were each decoded as cp1252/Latin-1 chars,
// then re-saved as UTF-8 (e.g. ... = E2 80 A6 became C3 A2 C2 82 C2 AC).
// Repair: decode the file as UTF-8, find maximal runs of suspicious chars
// (C1 controls, Latin-1 supplement, cp1252 punctuation), map each char back to
// its original byte, and re-decode that byte run as strict UTF-8. Any run whose
// bytes are not valid UTF-8 is left untouched, so legitimate accented chars
// survive (a lone e-acute is a one-char run and is never even attempted).
// Usage: node scripts/fix-encoding.mjs [--apply]   (default: report only)
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const SKIP_DIRS = new Set(['node_modules', '.git', 'screenshots']);
const EXT_OK = /\.(js|mjs|cjs|ts|html|css|json|md|webmanifest|yml|yaml|sql|txt)$/i;

const CP1252_BACK = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A],
  [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92],
  [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C],
  [0x017E, 0x9E], [0x0178, 0x9F],
]);

const susp = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x80 && c <= 0xff) || CP1252_BACK.has(c);
};

function* walk2(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let stat;
    try { stat = statSync(p); } catch { continue; }
    if (stat.isDirectory()) yield* walk2(p);
    else if (EXT_OK.test(name)) yield p;
  }
}

const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
let totalFiles = 0, totalRuns = 0;

async function main() {
  for (const file of walk2(process.cwd())) {
    const buf = readFileSync(file);
    let high = false;
    for (const b of buf) if (b > 0x7f) { high = true; break; }
    if (!high) continue;
    let s;
    try { s = dec.decode(buf); } catch {
      console.log(`[skip] ${file}: not valid UTF-8 at top level`);
      continue;
    }

    const chars = [...s];
    let out = '';
    const notes = [];
    let i = 0;
    while (i < chars.length) {
      if (!susp(chars[i])) { out += chars[i]; i++; continue; }
      // Extend the run, but only START a repair if the run is >= 2 chars or
      // contains a C1 control / cp1252 special (lone accent chars are legit).
      let j = i;
      while (j < chars.length && susp(chars[j])) j++;
      const run = chars.slice(i, j);
      const c1 = run.some((c) => { const v = c.codePointAt(0); return v <= 0x9f; });
      const spec = run.some((c) => CP1252_BACK.has(c.codePointAt(0)));
      const worth = run.length >= 2 || c1 || spec;
      if (!worth) { out += run.join(''); i = j; continue; }
      const bytes = run.map((c) => {
        const v = c.codePointAt(0);
        return CP1252_BACK.has(v) ? CP1252_BACK.get(v) : v & 0xff;
      });
      try {
        const fixed = dec.decode(Uint8Array.from(bytes));
        const line = s.slice(0, i).split('\n').length;
        notes.push({ line, from: run.join(''), to: fixed });
        out += fixed;
      } catch {
        out += run.join('');
      }
      i = j;
    }

    if (notes.length) {
      totalFiles++;
      totalRuns += notes.length;
      console.log(`\n${APPLY ? '[fix]' : '[would fix]'} ${file} (${notes.length} runs)`);
      for (const n of notes.slice(0, 12)) {
        console.log(`  L${n.line}: ${JSON.stringify(n.from)} -> ${JSON.stringify(n.to)}`);
      }
      if (notes.length > 12) console.log(`  ... ${notes.length - 12} more`);
      if (APPLY) writeFileSync(file, out, 'utf8');
    }
  }
  console.log(`\n${totalRuns} runs across ${totalFiles} files ${APPLY ? 'FIXED' : '(report only)'}`);
}

main();
