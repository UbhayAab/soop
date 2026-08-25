import { chromium } from 'playwright';
const base = 'http://127.0.0.1:8098';
const browser = await chromium.launch();

async function attrs(p) {
  return p.evaluate(() => {
    const l = document.getElementById('messages');
    if (!l) return null;
    return {
      role: l.getAttribute('role'),
      rel: l.getAttribute('aria-relevant'),
      label: l.getAttribute('aria-label'),
      live: l.getAttribute('aria-live')
    };
  });
}

// --- standalone: base attributes + IntersectionObserver gate
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
console.log('standalone:', JSON.stringify(await attrs(page)));

await page.evaluate(() => { document.getElementById('app').style.display = 'none'; });
await page.waitForTimeout(400);
const offHidden = (await attrs(page)).live;
await page.evaluate(() => { document.getElementById('app').style.display = ''; });
await page.waitForTimeout(1000);
const backLive = (await attrs(page)).live;
console.log('IO hide -> aria-live:', offHidden, '| restore -> ', backLive);

// --- embed mode: full bridge path via real postMessage (page is its own
// parent in top-level embed mode, and origin matches because we serve on 8098)
const p2 = await browser.newPage({ viewport: { width: 400, height: 700 } });
const errs2 = [];
p2.on('pageerror', (e) => errs2.push(e.message));
await p2.goto(base + '/index.html?embed=1&host=' + encodeURIComponent(base), { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(1800);
console.log('embed:', JSON.stringify(await attrs(p2)));

await p2.evaluate(() => window.postMessage({ Dek: 'hidden' }, '*'));
await p2.waitForTimeout(300);
const bridgeOff = (await attrs(p2)).live;
await p2.evaluate(() => window.postMessage({ Dek: 'visible' }, '*'));
await p2.waitForTimeout(1000);
const bridgeLive = (await attrs(p2)).live;
console.log('bridge hidden -> aria-live:', bridgeOff, '| visible -> ', bridgeLive);

console.log('pageerrors standalone:', errors.length, errors.slice(0, 3));
console.log('pageerrors embed:', errs2.length, errs2.slice(0, 3));

// 6893a9f's recorded proof: hiding mutes to 'off', restore returns 'polite'
// through the quiet window, the bridge drives both transitions end to end.
const problems = [];
if (offHidden !== 'off') problems.push(`standalone IO hide -> aria-live ${offHidden}, want off`);
if (backLive !== 'polite') problems.push(`standalone restore -> aria-live ${backLive}, want polite`);
if (bridgeOff !== 'off') problems.push(`embed bridge hidden -> aria-live ${bridgeOff}, want off`);
if (bridgeLive !== 'polite') problems.push(`embed bridge visible -> aria-live ${bridgeLive}, want polite`);
if (errors.length) problems.push(`standalone pageerrors: ${errors.length}`);
if (errs2.length) problems.push(`embed pageerrors: ${errs2.length}`);
console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join('\n- ') : 'PROBE CLEAN');
process.exitCode = problems.length ? 1 : 0;
await browser.close();
