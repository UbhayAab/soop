import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('https://dek-7o4.pages.dev/', { waitUntil: 'domcontentloaded' });
const res = await p.evaluate(async () => {
  try {
    const m = await import('/js/tabbar.js');
    return { ok: true, fns: Object.keys(m) };
  } catch (e) { return { ok: false, err: String(e).slice(0, 300) }; }
});
console.log(JSON.stringify(res));
// also check the static markup
await p.evaluate(() => {});
const html = await p.content();
console.log('static tabbar markup present:', html.includes('nav id="tabbar"'));
console.log('markup snippet:', (html.match(/<nav id="tabbar"[^>]*>/) || ['none'])[0]);
await b.close();
