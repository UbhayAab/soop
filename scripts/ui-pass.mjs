// Signed-in UI capture: logs the demo user in, provisions a Space through the
// real onboarding UI, and screenshots every major surface. This is the eyes
// the whole UI overhaul has been missing.
import { chromium } from 'playwright';

const BASE = process.env.DEK_URL || 'https://dek-7o4.pages.dev';
const OUT = process.env.DEK_SHOTS || 'shots';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 120)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await shot(page, '01-auth');

// Sign in
await page.fill('input[type="email"]', 'demo@dek.app');
await page.fill('input[type="password"]', 'dek-demo-2026');
await page.click('button:has-text("Sign in")');
await page.waitForTimeout(4000);
await shot(page, '02-after-signin');

// No-team screen -> create the demo organisation through the real UI
const body = await page.textContent('body');
if (/no team|Start a new organisation|join/i.test(body)) {
  await shot(page, '03-noteam');
  const plus = page.locator('#btnSpaces, button:has-text("Start a new organisation"), button:has-text("new organisation")').first();
  if (await plus.count()) {
    await plus.click().catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, '04-chooser');
    const start = page.locator('button:has-text("Start a new organisation")').first();
    if (await start.count()) { await start.click(); await page.waitForTimeout(600); }
    const nameInput = page.locator('input:visible').first();
    await nameInput.fill('Misho Demo').catch(() => {});
    await shot(page, '05-org-dialog');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
  }
}
await shot(page, '06-signed-in');

// Invite dialog may be open after creation - close it
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// Channel: post a message through the real composer
const composer = page.locator('#composer');
if (await composer.count()) {
  await composer.fill('First message in the demo Space - UI pass in progress.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await shot(page, '07-channel-with-message');
}

// Panels via slash commands (most reliable entry points)
for (const [cmd, name] of [['/tasks', '08-tasks'], ['/activity', '09-activity']]) {
  await composer.fill(cmd);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await shot(page, name);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// Profile editor
await page.locator('#userMenu').click().catch(() => {});
await page.waitForTimeout(500);
await shot(page, '10-user-menu');
await page.locator('text=Profile').first().click().catch(() => {});
await page.waitForTimeout(800);
await shot(page, '11-profile');
await page.keyboard.press('Escape');

// Mobile pass
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: 'networkidle' });
await mob.fill('input[type="email"]', 'demo@dek.app');
await mob.fill('input[type="password"]', 'dek-demo-2026');
await mob.click('button:has-text("Sign in")');
await mob.waitForTimeout(4000);
await shot(mob, '12-mobile-signed-in');
await mob.locator('#navToggle').click().catch(() => {});
await mob.waitForTimeout(600);
await shot(mob, '13-mobile-drawer');
await mob.keyboard.press('Escape').catch(() => {});
// back button should close drawer, not exit
await mob.goBack().catch(() => {});
await mob.waitForTimeout(500);
await shot(mob, '14-mobile-after-back');

await browser.close();
console.log('DONE - shots in', OUT);
