// Install + offline. Two very different platforms:
//   Chromium (Android, desktop) fires beforeinstallprompt, so we stash it and
//   call prompt() from a real click - the only thing the browser accepts.
//   iOS Safari has no such API at all: the honest answer is a sheet that shows
//   the exact Share -> Add to Home Screen steps. Pretending otherwise would just
//   produce a button that does nothing.
import { $, el, esc } from './util.js';
import { modal, toast } from './ui.js';

let deferredPrompt = null;

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const ua = navigator.userAgent;
export const isIOS = /iPad|iPhone|iPod/.test(ua) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

export function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then((reg) => {
        // Never swap the running bundle mid-conversation. Offer it instead.
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw?.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(reg);
          });
        });

        // ASK. updatefound only fires if something actually re-fetches sw.js,
        // and nothing here ever did - the browser's own check happens on a hard
        // navigation and then roughly daily. So an installed app that somebody
        // leaves open, which is every phone on a shift, could sit on a bundle
        // for a day with no way to know a newer one existed and no reload
        // offered. Reported exactly that way: "it's still stuck on the old UI
        // and there's no option to refresh".
        //
        // Two triggers, both cheap: coming back to the tab, and a slow timer for
        // a screen that is simply left on. Throttled together so a person
        // flicking between apps does not fire a request per flick; sw.js is a
        // conditional GET, so a check with nothing new costs a 304.
        const CHECK_EVERY = 15 * 60 * 1000;
        let lastCheck = Date.now();
        const check = () => {
          if (Date.now() - lastCheck < CHECK_EVERY) return;
          lastCheck = Date.now();
          reg.update().catch(() => { /* offline, or the check simply failed */ });
        };
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
        setInterval(check, CHECK_EVERY);
      })
      .catch((e) => console.warn('sw register failed', e));
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    paintInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    paintInstallButton();
    toast('Dek installed. Look for it with your other apps.');
  });

  paintInstallButton();

  // Persistent storage keeps the offline cache and the session from being evicted.
  navigator.storage?.persist?.().catch(() => {});
}

export function canInstall() {
  if (isStandalone()) return false;
  return !!deferredPrompt || isIOSSafari;
}

export function paintInstallButton() {
  const b = $('installBtn');
  if (!b) return;
  b.classList.toggle('hidden', !canInstall());
  b.onclick = promptInstall;
}

export async function promptInstall() {
  if (isStandalone()) { toast('Already installed'); return; }
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') toast('Installing…');
    deferredPrompt = null;
    paintInstallButton();
    return;
  }
  if (isIOS) return iosSheet();
  modal({
    title: 'Install Dek',
    body: `<p>Your browser has not offered an install prompt yet. Use the browser menu and choose
      <b>Install app</b> or <b>Add to Home screen</b>.</p>
      <p class="muted">On Chrome or Edge desktop the install icon also appears at the right edge of the address bar.</p>`,
  });
}

function iosSheet() {
  modal({
    title: 'Add Dek to your Home Screen',
    body: `
      <ol class="ios-steps">
        <li>Tap the <b>Share</b> button <span class="ios-ico">📤</span> at the bottom of Safari.</li>
        <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
        <li>Tap <b>Add</b>. Dek opens full screen, like an app.</li>
      </ol>
      ${isIOSSafari ? '' :
        '<p class="muted">You are not in Safari. On iPhone only Safari can add an app to the Home Screen - open this page in Safari first.</p>'}`,
  });
}

function showUpdateToast(reg) {
  const t = toast('A new version of Dek is ready.', 'info', 20000);
  const b = el('button', 'sm', 'Reload');
  b.onclick = () => {
    reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(() => location.reload(), 250);
  };
  t.appendChild(b);
}
