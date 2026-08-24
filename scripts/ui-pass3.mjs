// v3: login -> dismiss invite -> capture every surface.
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
await page.waitForTimeout(4500);

// Dismiss whatever is open (invite dialog from last session may persist)
for (let i = 0; i < 3; i++) {
  const dlg = page.locator('.modal, [role="dialog"]').last();
  if (await dlg.count() && await dlg.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  } else break;
}
await page.locator('#channels .chan').first().click().catch(() => {});
await page.waitForTimeout(1500);
await shot(page, '50-channel');

const composer = page.locator('#composer');
if (await composer.isEnabled().catch(() => false)) {
  await composer.fill('First message in Misho Demo. Reactions, threads, tasks and ack cards all hang off messages like this one.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
}
await shot(page, '51-message');

for (const [cmd, name] of [['/tasks', '52-tasks'], ['/activity', '53-activity']]) {
  await composer.fill(cmd);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1600);
  await shot(page, name);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

await page.locator('#userMenu').click().catch(() => {});
await page.waitForTimeout(500);
await shot(page, '54-user-menu');
await page.locator('button:has-text("Profile"), button:has-text("Your profile"), [data-a="full"]').first().click().catch(() => {});
await page.waitForTimeout(900);
await shot(page, '55-profile');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// Admin console via #btnMembers? Use slash
await composer.fill('/admin');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
await shot(page, '56-admin');
await page.keyboard.press('Escape');

// Mobile
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: 'networkidle' });
await mob.fill('input[type="email"]', 'demo@dek.app');
await mob.fill('input[type="password"]', 'dek-demo-2026');
await mob.click('button:has-text("Sign in")');
await mob.waitForTimeout(4500);
for (let i = 0; i < 2; i++) {
  const dlg = mob.locator('.modal, [role="dialog"]').last();
  if (await dlg.count() && await dlg.isVisible().catch(() => false)) { await mob.keyboard.press('Escape'); await mob.waitForTimeout(500); }
}
await shot(mob, '60-mobile-in');
await mob.locator('#navToggle').click().catch(() => {});
await mob.waitForTimeout(700);
await shot(mob, '61-mobile-drawer');
await mob.goBack();
await mob.waitForTimeout(600);
await shot(mob, '62-mobile-back');
// tab bar tap: Activity
await mob.locator('#tabbar .tab').nth(2).click().catch(() => {});
await mob.waitForTimeout(900);
await shot(mob, '63-mobile-activity-tab');

await browser.close();
console.log('DONE');
