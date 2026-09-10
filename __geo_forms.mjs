// Headless geometry audit for the two new forms surfaces. Reads the REAL CSS
// out of js/features/forms.js so the harness cannot drift from the shipped rule
// set, mounts the exact markup renderList/importDialog produce, and checks for
// horizontal overflow and sub-36px tap targets at phone and desktop widths.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = 'C:/Users/abhay/Desktop/claude/soop';
const src = readFileSync(ROOT + '/js/features/forms.js', 'utf8');
const m = src.match(/s\.textContent = `([\s\S]*?)`;\n\s*document\.head\.appendChild\(s\);/);
if (!m) { console.error('could not extract the injected CSS'); process.exit(2); }
const css = m[1].replace(/\$\{CLS\}/g, 'frm');
if (css.includes('${')) { console.error('unexpanded interpolation left in CSS'); process.exit(2); }

const links = ['tokens', 'base', 'components', 'layout', 'messages', 'panels', 'features', 'reading', 'shell']
  .map((f) => `<link rel="stylesheet" href="./css/${f}.css">`).join('\n');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${links}
<style>${css}</style>
<style>body{margin:0}.harness{padding:12px}</style>
</head><body><div class="harness">

<h4 class="sec">panel</h4>
<div id="panelbody">
  <div class="frm-tools">
    <input class="frm-find" type="search" placeholder="Search forms in this Space">
    <button class="sm" type="button">Import from organisation</button>
  </div>
  <div class="frm-list">
    <h4 class="sec">Open</h4>
    <div class="result frm-row">
      <div><b>Monthly field report for the Bhiwandi outreach team</b></div>
      <div class="frm-meta muted">
        <span class="frm-pill open">OPEN</span>
        #general &middot; Rakesh Kulkarni &middot; 2 days ago &middot; 14 answered
      </div>
      <div class="frm-rowacts">
        <button class="sm ghost" type="button">See answers</button>
        <button class="sm ghost" type="button">Save to organisation</button>
      </div>
    </div>
  </div>
</div>

<h4 class="sec">import dialog</h4>
<div class="modal" style="max-width:640px"><div class="modal-body">
  <div class="frm-imp">
    <input class="frm-impq" type="search" placeholder="Search by name, by who made it, or paste a form ID">
    <label class="field"><span class="field-label">Post it into</span>
      <select class="frm-impch"><option>#general</option></select></label>
    <div class="frm-impres">
      <div class="result frm-improw">
        <div class="frm-impname">
          <b>Leave Request Form</b>
          <div class="frm-desc">Fill this in before Friday so we can plan cover.</div>
          <div class="frm-meta muted">3 questions &middot; Priya Deshmukh &middot; updated 4 days ago &middot; in 3 channels</div>
        </div>
        <button class="sm" type="button">Import</button>
      </div>
      <div class="result frm-improw">
        <div class="frm-impname">
          <b>Expense claim (travel, printing and hall hire for camps)</b>
          <div class="frm-meta muted">6 questions &middot; someone &middot; updated 3 weeks ago &middot; not used yet</div>
        </div>
        <button class="sm" type="button">Import</button>
      </div>
    </div>
  </div>
</div></div>

</div></body></html>`;

writeFileSync(ROOT + '/__geo_forms.html', html);

const browser = await chromium.launch();
let bad = 0;
for (const [label, width] of [['phone 390', 390], ['phone 320', 320], ['desktop 1280', 1280]]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto('file:///' + ROOT + '/__geo_forms.html');
  await page.waitForTimeout(150);
  const out = await page.evaluate((w) => {
    const rep = { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, small: [], wide: [] };
    for (const sel of ['.frm-find', '.frm-tools button', '.frm-rowacts button', '.frm-improw > button', '.frm-impq', '.frm-impch']) {
      for (const n of document.querySelectorAll(sel)) {
        const r = n.getBoundingClientRect();
        if (r.height < 36) rep.small.push([sel, Math.round(r.width) + 'x' + Math.round(r.height)]);
      }
    }
    for (const n of document.querySelectorAll('.harness *')) {
      const r = n.getBoundingClientRect();
      if (r.right > w + 0.5) rep.wide.push([n.className || n.tagName, Math.round(r.right)]);
    }
    return rep;
  }, width);
  const overflow = out.scrollW > out.clientW;
  if (overflow || out.small.length || out.wide.length) bad++;
  console.log(`${label}: scrollW=${out.scrollW} clientW=${out.clientW} overflow=${overflow}`
    + ` under36px=${JSON.stringify(out.small)} pastViewport=${JSON.stringify(out.wide)}`);
  await page.close();
}
await browser.close();
console.log(bad === 0 ? 'GEOMETRY CLEAN' : 'GEOMETRY PROBLEMS: ' + bad);
