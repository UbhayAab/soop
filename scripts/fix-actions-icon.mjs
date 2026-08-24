// Final mojibake target: actions.js voice-switcher icon.
import { readFileSync, writeFileSync } from 'node:fs';
const f = 'js/core/actions.js';
let t = readFileSync(f, 'utf8');
// The speaker emoji's mangled signature, measured from the file itself.
const sig = '\u00F0\u0178\u201D\u0160';
const quoted = `'${sig}'`;
if (t.includes(quoted)) t = t.split(quoted).join("icon('volume')");
else t = t.split(sig).join("icon('volume')");
writeFileSync(f, t);
console.log('actions clean:', !/\u00F0\u0178/.test(t));
