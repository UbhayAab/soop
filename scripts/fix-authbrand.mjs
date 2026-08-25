// Restage the auth brand panel with a FIXED dark stage - themed tokens washed
// it out in light mode. Anchors on .authbrand { ... .authbrand-foot { ... }
import { readFileSync, writeFileSync } from 'node:fs';
const f = 'css/layout.css';
let t = readFileSync(f, 'utf8');
const start = t.indexOf('.authbrand {');
const footAnchor = t.indexOf('.authbrand-foot {', start);
if (start === -1 || footAnchor === -1) { console.error('anchors missing'); process.exit(1); }
const footEnd = t.indexOf('}', footAnchor) + 1;

const replacement = `.authbrand {
  display: none;
  flex-direction: column;
  flex: 0 0 44%;
  max-width: 560px;
  /* A fixed dark stage in BOTH themes - the brand panel is a poster, not a
     themed surface. Light-theme tokens would wash it to invisible. */
  background:
    radial-gradient(120% 90% at 0% 0%,
      rgba(64, 111, 224, 0.32), transparent 62%),
    linear-gradient(160deg, #10141c, #0a0d13 70%);
  color: #aeb7c4;
  padding: var(--s-11) var(--s-10);
}
.authbrand-inner { max-width: 400px; margin: auto 0; }
.authbrand .brand { margin-bottom: var(--s-6); }
.authbrand .brand h1 { color: #f2f5f9; font-size: 30px; letter-spacing: -0.02em; }
.authbrand-line {
  font-size: var(--t-xl);
  line-height: var(--t-tight);
  font-weight: var(--t-semibold);
  color: #f2f5f9;
  margin: 0 0 var(--s-7);
}
.authbrand-points { list-style: none; padding: 0; margin: 0 0 var(--s-9); }
.authbrand-points li {
  padding: var(--s-3) 0;
  font-size: var(--t-base);
  color: #aeb7c4;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}
.authbrand-points li:last-child { border-bottom: none; }
.authbrand-points b { color: #ffffff; font-weight: var(--t-semibold); }
.authbrand-foot { font-size: var(--t-xs); color: #6d7885; }`;

t = t.slice(0, start) + replacement + t.slice(footEnd);
writeFileSync(f, t);
console.log('brand panel restaged');
