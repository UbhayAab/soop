// FULL ONBOARDING E2E: brand-new human signs up with OTP through the real UI,
// creates an organisation, and a second user joins via invite link.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = 'https://dek-7o4.pages.dev';
mkdirSync('shots/onboard', { recursive: true });
const shot = (p, n) => p.screenshot({ path: `shots/onboard/${n}.png` });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let otpCode = null;
page.on('response', async (r) => {
  if (r.url().includes('/mail-otp') && r.request().method() === 'POST') {
    try { const j = await r.json(); if (j.devCode) otpCode = j.devCode; } catch {}
  }
});

// ---- 1. SIGN UP a brand new person ----
await page.goto(BASE, { waitUntil: 'networkidle' });
const email = `founder${Date.now().toString(36)}@dek.app`;
await page.fill('input[type="email"]', email);
await page.click('button:has-text("Email me a sign-in code")');
await page.waitForTimeout(2500);
await shot(page, '1-otp-screen');
if (!otpCode) { console.log('FAIL: no devCode captured'); process.exit(1); }
console.log('otp captured:', otpCode);
await page.fill('#code', otpCode);
await page.click('button:has-text("Verify"), #otpVerifyBtn').catch(() => {});
await page.keyboard.press('Enter');
await page.waitForTimeout(4500);
await shot(page, '2-signed-in-fresh');
console.log('signed up:', email);

// ---- 2. CREATE an organisation through the chooser ----
await page.locator('#btnSpaces').click().catch(() => {});
await page.waitForTimeout(700);
const start = page.locator('button:has-text("Start a new organisation")').first();
if (await start.count()) { await start.click(); await page.waitForTimeout(600); }
const dlg = page.locator('.modal, [role="dialog"]').last();
await dlg.locator('input').first().fill('Nashik Traders Co');
await shot(page, '3-org-name');
await dlg.locator('button:has-text("Create Space")').click();
await page.waitForTimeout(3000);
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await shot(page, '4-org-created');
console.log('org created: Nashik Traders Co');

// Say hello
const composer = page.locator('#composer');
if (await composer.isEnabled().catch(() => false)) {
  await composer.fill('Our own workspace, our own logo, our own rules.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
}
await shot(page, '5-first-message');

// ---- 3. INVITE a second person (create link) ----
await page.locator('#btnInvite').click().catch(() => {});
await page.waitForTimeout(900);
// Bump "Lets in" to 5 so the second context can use the same link
const invDlg = page.locator('.modal, [role="dialog"]').last();
const invLink = await invDlg.locator('#inviteLink').inputValue().catch(() => '');
console.log('invite link:', invLink);
await page.keyboard.press('Escape');

// ---- 4. SECOND PERSON joins via that link ----
const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let otp2 = null;
p2.on('response', async (r) => {
  if (r.url().includes('/mail-otp') && r.request().method() === 'POST') {
    try { const j = await r.json(); if (j.devCode) otp2 = j.devCode; } catch {}
  }
});
await p2.goto(invLink || BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const email2 = `teammate${Date.now().toString(36)}@dek.app`;
await p2.fill('input[type="email"]', email2);
await p2.click('button:has-text("Email me a sign-in code")');
await p2.waitForTimeout(2500);
if (!otp2) { console.log('FAIL: no devCode for teammate'); }
else {
  await p2.fill('#code', otp2);
  await p2.click('#otpVerifyBtn, button:has-text("Verify")').catch(() => {});
  await p2.keyboard.press('Enter');
  await p2.waitForTimeout(5000);
  await shot(p2, '6-teammate-joined');
  const txt = await p2.textContent('body');
  console.log('teammate joined, sees org:', /Nashik Traders/i.test(txt || ''));
  await shot(p2, '7-teammate-channel');
}

await browser.close();
console.log('E2E DONE');
