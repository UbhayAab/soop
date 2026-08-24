// Sweep every mojibake emoji in js/ by its real codepoints and replace with
// icon() calls or clean text. Run once, report, exit.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Discover files still containing U+00F0-led mojibake inside js/
const files = execSync('git ls-files js', { encoding: 'utf8' })
  .split('\n').filter((f) => f.endsWith('.js'));

let touched = 0;
for (const f of files) {
  let t = readFileSync(f, 'utf8');
  if (!/\u00F0/.test(t)) continue;
  const before = t;

  // Generic: any run of the mojibake pattern (U+00F0 followed by U+00C2/U+0178
  // range chars) inside quotes gets mapped by its exact codepoint signature.
  const MAP = {
    // composer autocomplete + chips (measured codepoints)
    '\u00F0\u0178\u2018\u00A4': "icon('members')",   // person
    '\u00F0\u0178\u2018\u00A5': "icon('members')",   // people
    '\u00F0\u0178\u201c\u00A3': "icon('megaphone')", // megaphone
    '\u00F0\u0178\u2013\u00BC': "icon('doc')",       // image
    '\u00F0\u0178\u017D\u00AC': "icon('doc')",       // video
    '\u00F0\u0178\u201c\u0084': "icon('doc')",       // file
    '\u00F0\u0178\u017d\u0088': "icon('doc')",       // card index
  };

  for (const [sig, replacement] of Object.entries(MAP)) {
    t = t.split(`'${sig}'`).join(replacement);   // quoted standalone (icon fields)
    t = t.split(sig).join(replacement);          // bare (inline ternaries)
  }

  if (t !== before) {
    writeFileSync(f, t);
    touched++;
    console.log('fixed:', f);
  }
}
console.log('files touched:', touched);

// Final report: any U+00F0 mojibake left anywhere in js/
const left = [];
for (const f of files) {
  const t = readFileSync(f, 'utf8');
  const lines = t.split('\n');
  lines.forEach((l, i) => {
    if (/\u00F0\u0178|\u00F0\u009F/.test(l) && !/^\s*\/\//.test(l)) left.push(`${f}:${i + 1}: ${l.trim().slice(0, 90)}`);
  });
}
console.log('remaining mojibake lines:', left.length);
left.slice(0, 12).forEach((l) => console.log('  ' + l));
