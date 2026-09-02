// The three ways somebody gets stuck on the way in.
//
// All three were reported from real use, and all three are about a person who
// is signed in but cannot get where they need to be:
//
//   A  Signed in with the wrong email, landed on "you are not part of a team
//      yet", and there is no way to sign out. That screen adds body.no-team,
//      which hides #navToggle, which is the only route to the sidebar, which is
//      the only place Sign out has existed since it left the top bar.
//
//   B  Created an account with a code and was never asked to choose a password,
//      so every future sign-in needs another code. The set-password screen and
//      the must_set_password latch that drives it both already existed; nothing
//      ever set the latch for an account born this way.
//
//   C  The invite row that hands somebody a link and a QR code was reachable
//      only by long-pressing an org tile. It is now a labelled sidebar row.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.env.DEK_EMAIL || 'demo@dek.app';
const PASS = process.env.DEK_PASS || 'dek-demo-2026';

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};
const sql = (q) => JSON.parse(execFileSync('node', ['scripts/db-query.mjs', q], { encoding: 'utf8' }));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  fs.readFile(f, (err, body) => {
    if (err) { try { res.writeHead(404).end('nope'); } catch {} return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(body);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.env.PROBE_BASE || `http://127.0.0.1:${server.address().port}`;
console.log(`probe-loginux: serving ${ROOT} on ${BASE}`);

// The demo account's latch is restored in the finally block whatever happens,
// because leaving it set would lock the account every other probe signs in with.
const [demo] = sql(`select p.id, p.must_set_password latched from public.profiles p
                    join auth.users u on u.id = p.id where u.email = '${EMAIL}';`);
const restoreLatch = () => sql(
  `update public.profiles set must_set_password = ${demo.latched} where id = '${demo.id}'; select 1;`);

const browser = await chromium.launch();
const signIn = async (page) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.click('button:has-text("Sign in")');
  await page.waitForTimeout(6000);
  for (let i = 0; i < 4; i++) {
    const d = page.locator('.modal,[role="dialog"]').last();
    if (await d.count() && await d.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    } else break;
  }
};

try {
  // ---- A: the no-team screen has a way out ------------------------------
  // Driven on a PHONE viewport, because that is where the trap is total: the
  // nav toggle is hidden, so on 390px there is genuinely nothing else to press.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await signIn(page);
    await page.evaluate(() => import('./js/main.js').then((m) => m.showNoTeam()));
    await page.waitForTimeout(700);
    await page.evaluate(() => document.getElementById('noteamOut')
      ?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);

    const seen = await page.evaluate(() => {
      const b = document.getElementById('noteamOut');
      if (!b) return { present: false };
      const r = b.getBoundingClientRect();
      // Hit-test the middle of the button: "in the DOM" is not the same claim as
      // "a thumb can press it", and this whole screen is a lesson in that.
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        present: true,
        visible: r.width > 0 && r.height > 0,
        onScreen: r.top >= 0 && r.bottom <= innerHeight,
        hitsButton: !!(hit && (hit === b || b.contains(hit))),
        label: b.textContent.trim(),
        who: document.querySelector('.noteam-who')?.textContent.replace(/\s+/g, ' ').trim() || '',
        // The real trap, measured rather than assumed. Not "is a CSS rule
        // winning" but "can this person reach the only other Sign out there
        // is": the user menu hangs off #meName in the sidebar.
        userMenuReachable: (() => {
          const n = document.getElementById('meName');
          if (!n) return false;
          const q = n.getBoundingClientRect();
          return q.width > 0 && q.height > 0 && getComputedStyle(n).visibility !== 'hidden';
        })(),
      };
    });

    // Measured on a phone: the sidebar's user menu is NOT reachable here, which
    // is why this screen needed its own way out. On a desktop it IS reachable,
    // so the trap was mobile-only - which matches where it was reported from.
    check('no-team: on a phone the user menu really is unreachable (the trap is real)',
      seen.userMenuReachable === false);
    check('no-team: a Sign out control exists', seen.present === true);
    check('no-team: it is visible and on screen', !!seen.visible && !!seen.onScreen);
    check('no-team: a thumb actually lands on it', seen.hitsButton === true);
    check('no-team: the screen names the account you are signed into',
      /Signed in as/.test(seen.who) && seen.who.includes('@'), seen.who);

    // Press it for real and require the session to be gone.
    if (seen.hitsButton) {
      await page.click('#noteamOut');
      await page.waitForTimeout(4000);
      const out = await page.evaluate(async () => {
        const { sb } = await import('./js/sb.js');
        const { data } = await sb.auth.getSession();
        return { session: !!data.session, onAuth: !!document.querySelector('#email') };
      });
      check('no-team: pressing it clears the session', out.session === false);
      check('no-team: and lands back on the sign-in screen', out.onAuth === true);
    }
    check('no-team: no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
    await page.close();
  }

  // ---- B: a latched account is made to choose a password ----------------
  {
    sql(`update public.profiles set must_set_password = true where id = '${demo.id}'; select 1;`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#email', { state: 'visible', timeout: 60000 });
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASS);
    await page.click('button:has-text("Sign in")');
    await page.waitForTimeout(7000);

    const at = await page.evaluate(() => {
      const vis = (id) => {
        const n = document.getElementById(id);
        return !!n && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().height > 0;
      };
      return { setPw: vis('setPwStep'), chat: vis('chat'), newPwField: !!document.getElementById('newPw') };
    });
    check('otp/latch: signing in with a latched account shows the password screen', at.setPw === true);
    check('otp/latch: it does NOT drop them into the app first', at.chat === false);
    check('otp/latch: the new-password field is there to type into', at.newPwField === true);
    await page.close();
    restoreLatch();
  }

  // ---- C: sharing is on the sidebar, not behind a long-press ------------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signIn(page);
    const row = await page.evaluate(() => {
      const n = document.querySelector('[data-anav="invitelink"]');
      if (!n) return { present: false };
      const r = n.getBoundingClientRect();
      return { present: true, label: n.textContent.trim(), visible: r.width > 0 && r.height > 0 };
    });
    check('share: an "Invite with a link" row is in the sidebar', row.present === true, row.label || '');
    check('share: it is visible', !!row.visible);
    if (row.present && row.visible) {
      await page.click('[data-anav="invitelink"]');
      await page.waitForTimeout(3500);
      const sheet = await page.evaluate(() => ({
        open: !!document.querySelector('.oshare-url'),
        link: document.querySelector('.oshare-url')?.value || '',
        qr: !!document.querySelector('.oshare-qr'),
      }));
      check('share: it opens the sheet with a link already minted',
        sheet.open && /#\/join-org\/[0-9a-f]{32}$/.test(sheet.link), sheet.link || 'no link');
      check('share: with a QR beside it', sheet.qr === true);
    }
    await page.close();
  }

  // ---- D: nobody is left unable to choose a password --------------------
  {
    // The precise population, not the loose one. "password_set_at is null" also
    // catches accounts with a working password set out of band - latching those
    // locks out a person whose sign-in works fine, which is what happened to
    // demo@dek.app on the first attempt at this.
    const [row] = sql(`select count(*) n from public.profiles p join auth.users u on u.id = p.id
                        where not p.is_app and u.banned_until is null
                          and not p.must_set_password and p.password_set_at is null
                          and u.raw_user_meta_data ? 'display_name'
                          and not (u.raw_user_meta_data ? 'sub')
                          and u.raw_user_meta_data->>'display_name' = split_part(u.email,'@',1)
                          and (u.raw_user_meta_data->>'email_verified')::boolean is true;`);
    check('backfill: every OTP account has been asked to choose a password',
      Number(row.n) === 0, `${row.n} still stranded`);

    // And the other half of that lesson: an account with a working password must
    // NOT have been swept up. demo signs the whole probe suite in.
    const [d] = sql(`select p.must_set_password l from public.profiles p
                     join auth.users u on u.id = p.id where u.email = '${EMAIL}';`);
    check('backfill: an account with a working password was left alone', d.l === false);
  }
} catch (e) {
  check('probe ran to completion', false, e.message);
} finally {
  restoreLatch();
  await browser.close();
  server.close();
}

console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
