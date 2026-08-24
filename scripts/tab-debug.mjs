import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)); });
p.on('pageerror', (e) => errs.push('PAGE: ' + e.message.slice(0, 140)));
await p.goto('https://dek-7o4.pages.dev', { waitUntil: 'networkidle' });
await p.fill('input[type="email"]', 'demo@dek.app');
await p.fill('input[type="password"]', 'dek-demo-2026');
await p.click('button:has-text("Sign in")');
await p.waitForTimeout(5000);
const info = await p.evaluate(() => ({
  tabbars: document.querySelectorAll('#tabbar').length,
  states: [...document.querySelectorAll('#tabbar')].map((n) => ({ cls: n.className, kids: n.children.length, rect: n.getBoundingClientRect().height })),
  mainLast: (() => { const m = document.querySelector('main'); return m ? [...m.parentElement.children].map((c) => c.tagName + '.' + (c.id || c.className)) : []; })(),
}));
console.log(JSON.stringify(info, null, 1));
console.log('CONSOLE ERRORS:', JSON.stringify(errs.slice(0, 8), null, 1));
await b.close();
