import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
const reqs = [];
p.on('request', (r) => { if (r.url().includes('mail-otp')) reqs.push('REQ ' + r.url()); });
p.on('response', async (r) => {
  if (r.url().includes('mail-otp')) {
    let body = '';
    try { body = (await r.text()).slice(0, 160); } catch {}
    reqs.push('RES ' + r.status() + ' ' + body);
  }
});
p.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 140)); });
await p.goto('https://dek-7o4.pages.dev', { waitUntil: 'networkidle' });
const email = 'e2e' + Date.now().toString(36) + '@dek.app';
await p.fill('input[type="email"]', email);
const hasBtn = await p.locator('button:has-text("Email me a sign-in code")').count();
console.log('OTP button count:', hasBtn);
if (hasBtn) {
  await p.click('button:has-text("Email me a sign-in code")');
  await p.waitForTimeout(3000);
  console.log('network:', JSON.stringify(reqs, null, 1));
  const err = await p.locator('#authErr').textContent().catch(() => '');
  console.log('authErr:', JSON.stringify(err));
  console.log('otpStep visible:', await p.locator('#otpStep:not(.hidden)').count());
}
await b.close();
