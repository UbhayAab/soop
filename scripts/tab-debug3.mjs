import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
p.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 120)));
await p.goto('https://dek-7o4.pages.dev', { waitUntil: 'networkidle' });
await p.fill('input[type="email"]', 'demo@dek.app');
await p.fill('input[type="password"]', 'dek-demo-2026');
await p.click('button:has-text("Sign in")');
await p.waitForTimeout(9000);
const info = await p.evaluate(() => {
  const navs = [...document.querySelectorAll('nav')].map((n) => ({
    id: n.id, cls: n.className, kids: n.children.length,
    inChat: !!n.closest('#chat'), display: getComputedStyle(n).display,
  }));
  return {
    navs,
    tabbars: document.querySelectorAll('#tabbar').length,
    featuresLoaded: document.title,
    hasChat: !!document.querySelector('#chat'),
  };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
