import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:4177/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const r = await page.evaluate(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const declared = ['--safe-t','--safe-b','--safe-l','--safe-r'].map(k => k + '=' + cs.getPropertyValue(k).trim());
  const d = document.createElement('div');
  d.style.paddingBottom = 'var(--safe-b)';
  document.body.appendChild(d);
  const consumed = getComputedStyle(d).paddingBottom;
  root.style.setProperty('--safe-b', '34px');
  const overridden = getComputedStyle(d).paddingBottom;
  root.style.removeProperty('--safe-b');
  const restored = getComputedStyle(d).paddingBottom;
  d.remove();
  const tabbar = document.querySelector('#tabbar');
  const tabbarH = tabbar ? getComputedStyle(tabbar).getPropertyValue('--tabbar-h') : '(no tabbar)';
  return { declared, consumed, overridden, restored, tabbarH };
});
console.log('declared:', r.declared.join(' | '));
console.log('consumer padding-bottom:', r.consumed);
console.log('after host override 34px:', r.overridden);
console.log('after override removed:', r.restored);
console.log('tabbar --tabbar-h:', r.tabbarH.trim());
console.log('pageerrors:', errors.length);
// embed mode boot
const p2 = await browser.newContext({ viewport: { width: 400, height: 700 } }).then(c => c.newPage());
const errs2 = [];
p2.on('pageerror', (e) => errs2.push(e.message));
await p2.goto('http://127.0.0.1:4177/index.html?embed=1&host=http://localhost:8098', { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(1500);
console.log('embed pageerrors:', errs2.length);

// f7a8e82's recorded proof: all four tokens resolve, a consumer computes
// through var(--safe-b), a synthetic override propagates and restores.
const problems = [];
for (const d of r.declared) {
  const v = d.split('=')[1];
  if (!v || !/^-?\d+(\.\d+)?px$/.test(v)) problems.push(`${d.split('=')[0]} does not resolve to a length: '${v}'`);
}
if (r.overridden !== '34px') problems.push(`override -> consumer padding ${r.overridden}, want 34px`);
if (r.restored !== r.consumed) problems.push(`restore ${r.restored} != pre-override ${r.consumed}`);
if (!/\dpx/.test(r.tabbarH.trim())) problems.push(`--tabbar-h does not follow var(--safe-b): '${r.tabbarH.trim()}'`);
if (errors.length) problems.push(`standalone pageerrors: ${errors.length}`);
if (errs2.length) problems.push(`embed pageerrors: ${errs2.length}`);
console.log(problems.length ? `PROBE FAIL (${problems.length}):\n- ` + problems.join('\n- ') : 'PROBE CLEAN');
process.exitCode = problems.length ? 1 : 0;
await browser.close();
