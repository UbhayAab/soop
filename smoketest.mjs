import { chromium } from 'playwright';
import { readFile } from 'fs/promises';

const url = 'http://127.0.0.1:4321/';
const outPath = 's/test.png';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: outPath, fullPage });
    console.log(`wrote ${outPath}`);
    if (consoleLines.length) {
      console.log('--- page console ---');
      for (const l of consoleLines) console.log(l);
    } else {
      console.log('zero pageerror lines - PASS');
    }
  } catch (err) {
    console.error('screenshot failed:', err.message);
    if (consoleLines.length) {
      console.error('--- page console ---');
      for (const l of consoleLines) console.error(l);
    }
    process.exit(1);
  } finally {
    await context.close();
    await browser.close();
  }
})();