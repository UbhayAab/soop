// Somewhere for a broken screen to be reported from.
//
// For four days the only channel was somebody describing a blank screen over
// WhatsApp, and every one of those took a round of questions to place: which
// screen, which phone, signed in as whom, and what did it actually say. Almost
// all of that is knowable from inside the page at the moment it goes wrong.
//
// Two rules, both about not making things worse:
//   - it NEVER covers the app. A modal over a working screen because some
//     background fetch failed would itself be the bug. It is a small bar, it is
//     dismissable, and it only appears for errors that are not already handled.
//   - it collects no message text and no personal content. Screen, route, agent,
//     the error, and the account id an admin can look up - nothing else.
import { store, bus } from '../store.js';
import { el, esc } from '../util.js';

const SEEN_CAP = 6;          // remember this many before repeating one
const QUIET_MS = 20000;      // and never more than one bar per this long
const recent = new Set();
let lastShown = 0;
let barEl = null;

function context(err) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  return {
    when: new Date().toISOString(),
    error: String(err?.message || err || 'unknown').slice(0, 300),
    where: (err?.stack || '').split('\n').slice(1, 4).join(' | ').slice(0, 400),
    // What screen they were on, in words rather than ids where possible.
    screen: document.getElementById('auth')?.classList.contains('hidden') ? 'app' : 'sign-in',
    space: store.ws?.name || null,
    channel: store.current?.name || null,
    route: (location.hash || '').slice(0, 80),
    // The account, so an admin can find them. Not their name, not their email.
    account: store.me || null,
    online: nav.onLine !== false,
    screenSize: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : null,
    agent: (nav.userAgent || '').slice(0, 200),
    installed: typeof window !== 'undefined'
      && window.matchMedia?.('(display-mode: standalone)')?.matches === true,
    version: document.querySelector('meta[name="app-version"]')?.content || null,
  };
}

function show(err, ui) {
  const now = Date.now();
  const key = String(err?.message || err).slice(0, 120);
  if (recent.has(key)) return;
  if (now - lastShown < QUIET_MS) return;
  lastShown = now;
  recent.add(key);
  if (recent.size > SEEN_CAP) recent.delete([...recent][0]);

  barEl?.remove();
  const info = context(err);
  barEl = el('div', 'errbar');
  barEl.innerHTML = `
    <span class="errbar-txt">Something went wrong on this screen.</span>
    <button class="errbar-btn" data-a="report">Send a report</button>
    <button class="errbar-x" data-a="close" aria-label="Dismiss">✕</button>`;
  document.body.appendChild(barEl);

  barEl.querySelector('[data-a="close"]').onclick = () => { barEl?.remove(); barEl = null; };
  barEl.querySelector('[data-a="report"]').onclick = () => {
    barEl?.remove();
    barEl = null;
    openReport(info, ui);
  };
  setTimeout(() => { if (barEl) { barEl.remove(); barEl = null; } }, 30000);
}

// The report itself is text, deliberately. There is no error-collection service
// wired to this project, and inventing one is a bigger decision than this file
// should make. Copyable text pasted into the group chat is worth far more than
// nothing, and it goes down the channel people already use.
function openReport(info, ui) {
  const lines = [
    'Soop problem report',
    `time     ${info.when}`,
    `screen   ${info.screen}${info.space ? ' / ' + info.space : ''}${info.channel ? ' / #' + info.channel : ''}`,
    `route    ${info.route || '(none)'}`,
    `account  ${info.account || '(signed out)'}`,
    `online   ${info.online}  installed ${info.installed}  ${info.screenSize}`,
    `error    ${info.error}`,
    `at       ${info.where || '(no trace)'}`,
    `agent    ${info.agent}`,
  ].join('\n');

  const box = el('div');
  box.innerHTML = `
    <p>Copy this and send it to whoever set up your Soop account. It says what
      screen you were on and what went wrong.</p>
    <p class="muted fineprint">It contains no messages and nothing you have written.</p>
    <textarea id="errReport" rows="10" readonly>${esc(lines)}</textarea>`;

  ui.modal({
    title: 'Report a problem',
    body: box,
    actions: [{
      label: 'Copy',
      onClick: async (close, body) => {
        const t = body.querySelector('#errReport');
        t.select();
        await navigator.clipboard?.writeText(lines).catch(() => {});
        ui.toast('Copied. Paste it to whoever runs your Soop.');
        close();
      },
    }],
  });
}

const CSS = `
.errbar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(12px + env(safe-area-inset-bottom));
  z-index:9999;display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 24px));
  padding:8px 10px 8px 14px;border-radius:10px;background:var(--c-surface,#fff);
  border:1px solid color-mix(in srgb,var(--c-danger,#c2451f) 40%,transparent);
  box-shadow:var(--e-3,0 10px 28px rgba(16,24,40,.18));font-size:13px;color:var(--c-text,#14171f)}
.errbar-txt{flex:1 1 auto;min-width:0}
.errbar-btn{flex:none;padding:4px 10px;min-height:0;border-radius:6px;font-size:12.5px}
.errbar-x{flex:none;background:transparent;border:0;padding:2px 6px;min-height:0;
  color:var(--c-text-2,#4e5768);font-size:14px;line-height:1}
@media (prefers-reduced-motion:no-preference){.errbar{animation:errin .18s ease-out}}
@keyframes errin{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
`;

export function register(app) {
  const { ui } = app;
  if (!document.getElementById('errbar-css')) {
    const s = document.createElement('style');
    s.id = 'errbar-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  window.addEventListener('error', (e) => {
    // Failing images and other resource loads are not what this is for.
    if (e.target && e.target !== window) return;
    show(e.error || new Error(e.message || 'script error'), ui);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    const msg = String(r?.message || r || '');
    // A dropped request is already reported by the screen that made it - the
    // Space and channel failure states exist precisely so this does not have to
    // shout about every lost fetch on a train.
    if (/Failed to fetch|NetworkError|Load failed|AbortError|aborted/i.test(msg)) return;
    show(r, ui);
  });

  // Anything that wants to report deliberately.
  bus.on('error:report', (err) => openReport(context(err), ui));
}
