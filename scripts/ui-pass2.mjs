// Focused continuation: create the Space via the real dialog, then capture everything.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'https://dek-7o4.pages.dev';
mkdirSync('shots', { recursive: true });
const shot = (p, n) => p.screenshot({ path: `shots/${n}.png` });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 100)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[type="email"]', 'demo@dek.app');
await page.fill('input[type="password"]', 'dek-demo-2026');
await page.click('button:has-text("Sign in")');
await page.waitForTimeout(4000);

// Open the space chooser and create the Space properly
await page.locator('#btnSpaces').click().catch(() => {});
await page.waitForTimeout(800);
const start = page.locator('button:has-text("Start a new organisation")').first();
if (await start.count()) { await start.click(); await page.waitForTimeout(700); }
// The dialog input sits inside .modal - target it precisely
const dlg = page.locator('.modal, [role="dialog"]').last();
await dlg.locator('input').first().fill('Misho Demo');
await shot(page, '20-dialog-filled');
await dlg.locator('button:has-text("Create Space")').click();
await page.waitForTimeout(3500);
await shot(page, '21-space-created');

// Invite dialog probably auto-opened - close it
await page.keyboard.press('Escape');
await page.waitForTimeout(800);

// Wait until the composer is enabled (a channel auto-opened)
const composer = page.locator('#composer');
await composer.waitFor({ state: 'visible', timeout: 10000 });
for (let i = 0; i < 10; i++) {
  if (await composer.isEnabled()) break;
  // No channel open? Click the first channel row.
  const row = page.locator('#channels .chan').first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(1200); }
}
await shot(page, '22-channel-open');
await composer.fill('First message in Misho Demo - the UI pass has eyes now.');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
await shot(page, '23-message-sent');

// Panels
for (const [cmd, name] of [['/tasks', '30-tasks'], ['/activity', '31-activity']]) {
  await composer.fill(cmd).catch(() => {});
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await shot(page, name);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// Profile via user menu
await page.locator('#userMenu').click().catch(() => {});
await page.waitForTimeout(500);
await page.locator('button:has-text("Profile"), button:has-text("Your profile")').first().click().catch(() => {});
await page.waitForTimeout(900);
await shot(page, '32-profile');
await page.keyboard.press('Escape');

// Mobile
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: 'networkidle' });
await mob.fill('input[type="email"]', 'demo@dek.app');
await mob.fill('input[type="password"]', 'dek-demo-2026');
await mob.click('button:has-text("Sign in")');
await mob.waitForTimeout(4500);
await shot(mob, '40-mobile-in');
await mob.locator('#navToggle').click().catch(() => {});
await mob.waitForTimeout(600);
await shot(mob, '41-mobile-drawer');
const back = mob.goBack();
await mob.waitForTimeout(600);
await shot(mob, '42-mobile-back');
await back.catch(() => {});

await browser.close();
console.log('DONE');
