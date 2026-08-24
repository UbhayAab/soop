// One-shot: replace mojibake emoji in composer.js with icon() calls.
import { readFileSync, writeFileSync } from 'node:fs';
const f = 'js/core/composer.js';
let t = readFileSync(f, 'utf8');
const before = t;

// The mojibake sequences are the UTF-8 bytes of the original emoji, decoded as
// Latin-1 by an earlier PowerShell write. Match them as literal characters.
const PERSON = '\u00C3\u00B0\u00C2\u009F\u00C2\u0091\u00C2\u00A4';   // 👤 mangled
const PEOPLE = '\u00C3\u00B0\u00C2\u009F\u00C2\u0091\u00C2\u00A5';   // 👥 mangled
const MEGA   = '\u00C3\u00B0\u00C2\u009F\u00C2\u0093\u00C2\u00A3';   // 📣 mangled
const IMG    = '\u00C3\u00B0\u00C2\u009F\u00C2\u0096\u00C2\u00BC';   // 🖼 mangled
const VID    = '\u00C3\u00B0\u00C2\u009F\u00C2\u008E\u00C2\u00AC';   // 🎬 mangled
const DOC    = '\u00C3\u00B0\u00C2\u009F\u00C2\u0093\u00C2\u0084';   // 📄 mangled

t = t.split(`icon: '${PERSON}'`).join("icon: icon('members')");
t = t.split(`icon: '${PEOPLE}'`).join("icon: icon('members')");
t = t.split(`icon: '${MEGA}'`).join("icon: icon('megaphone')");
t = t.split(`? '${IMG}' :`).join("? icon('doc') :");
t = t.split(`? '${VID}' :`).join("? icon('doc') :");
t = t.split(`: '${DOC}'}`).join(": icon('doc') }");

writeFileSync(f, t);
console.log('changed:', before !== t);
// report any leftover mojibake-looking sequences
const left = (t.match(/\u00C3\u00B0/g) || []).length;
console.log('remaining suspicious sequences:', left);
const lines = t.split('\n');
lines.forEach((l, i) => { if (l.includes('\u00C3\u00B0')) console.log(i + 1 + ': ' + JSON.stringify(l.slice(0, 120))); });
