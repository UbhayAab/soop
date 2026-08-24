import { chromium } from 'playwright';
const base = 'http://127.0.0.1:8098';
const browser = await chromium.launch();

async function read(p) {
  return p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const bar = document.getElementById('composerBar');
    return {
      kbDeclared: cs.getPropertyValue('--kb').trim(),
      inlineKb: document.documentElement.style.getPropertyValue('--kb').trim(),
      padBottom: bar ? getComputedStyle(bar).paddingBottom : null,
    };
  });
}

// --- standalone, wide viewport: exercises the base #composerBar rule
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const s0 = await read(page);
console.log('standalone baseline:', JSON.stringify(s0));

// --- embed, narrow viewport: exercises the phone #composerBar rule through
// the REAL bridge path (page is its own parent top-level, origin matches :8098)
const p2 = await browser.newPage({ viewport: { width: 400, height: 700 } });
const errs2 = [];
p2.on('pageerror', (e) => errs2.push(e.message));
await p2.goto(base + '/index.html?embed=1&host=' + encodeURIComponent(base), { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(1500);
const e0 = await read(p2);
console.log('embed baseline:', JSON.stringify(e0));

await p2.evaluate(() => window.postMessage({ Dek: 'tokens', tokens: { '--kb': '300px' } }, '*'));
await p2.waitForTimeout(400);
const e1 = await read(p2);
console.log('after --kb=300px:', JSON.stringify(e1));

await p2.evaluate(() => window.postMessage({ Dek: 'tokens', tokens: { '--kb': '0px' } }, '*'));
await p2.waitForTimeout(400);
const e2 = await read(p2);
console.log('after reset:', JSON.stringify(e2));

const pb = (r) => parseFloat(r.padBottom) || 0;
const checks = [
  ['standalone --kb declared 0px', s0.kbDeclared === '0px'],
  ['standalone composer pad > 0', pb(s0) > 0],
  ['embed baseline pad == standalone-ish', pb(e0) > 0],
  ['push raises pad by ~300', Math.abs(pb(e1) - pb(e0) - 300) < 1],
  ['inline --kb reads 300px', e1.inlineKb === '300px'],
  ['reset restores baseline', Math.abs(pb(e2) - pb(e0)) < 1],
  ['zero pageerror standalone', errors.length === 0],
  ['zero pageerror embed', errs2.length === 0],
];
let fail = 0;
for (const [name, ok] of checks) {
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name);
}
console.log(fail === 0 ? 'PROBE CLEAN' : 'PROBE FAILED ' + fail);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
