import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
p.on('console', (m) => console.log('[c]', m.type(), m.text().slice(0, 160)));
p.on('pageerror', (e) => console.log('[pe]', e.message.slice(0, 200)));
await p.goto('https://dek-7o4.pages.dev', { waitUntil: 'networkidle' });
const res = await p.evaluate(async () => {
  const out = {};
  try {
    const m = await import('/js/tabbar.js?v=' + Date.now());
    out.imported = Object.keys(m);
    try { m.initTabBar(); out.ran = true; } catch (e) { out.initErr = String(e).slice(0, 300); }
    const n = document.querySelector('#tabbar');
    out.kids = n ? n.children.length : -1;
    out.html = n ? n.innerHTML.slice(0, 120) : '';
  } catch (e) { out.importErr = String(e).slice(0, 300); }
  return out;
});
console.log(JSON.stringify(res, null, 1));
await b.close();
