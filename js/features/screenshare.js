// Screen sharing: the button that starts it and the window that shows it.
//
// The mechanics live in js/core/voice.js, next to the peer connections they have
// to reach into. This is the part somebody touches.
//
// WHAT THIS HONESTLY IS. A peer mesh with no SFU, which means the person sharing
// uploads one copy of their screen to every other person in the room. Three
// people watching is three uploads. That is fine for a huddle and it is not a
// webinar, and core caps the encode at 800 kbit/s and 8 frames a second so a
// share cannot starve the audio - because a call where you can see the screen
// and not hear the person is worse than one with no screen at all.
//
// AND WHAT IT IS NOT. iPhones and iPads cannot do this. Not in Safari, not in
// Chrome for iOS, which is Safari underneath: iOS has no web screen-capture API
// at all. The button is not shown there, and the reason is said out loud, because
// a control that silently does nothing is worse than one that is absent.
import { store, bus, nameOf } from '../store.js';
import { $, el, esc } from '../util.js';
import { icon } from '../icons.js';
import { voice, canShareScreen, startScreenShare, stopScreenShare } from '../core/voice.js';

const CLS = 'shr';
let uiRef = null;
let viewer = null;

// ------------------------------------------------------------------ viewer
// A floating window rather than a panel: you want to keep reading the channel
// while somebody points at their screen, and a panel would take the whole
// screen on a phone and hide the conversation the call is about.
function ensureViewer() {
  if (viewer && viewer.isConnected) return viewer;
  viewer = el('div', CLS + '-win');
  viewer.innerHTML = `
    <div class="${CLS}-bar">
      <span class="${CLS}-who"></span>
      <span class="sp"></span>
      <!-- A word, not a glyph. The icon set has nothing that means "expand",
           and a bar chart standing in for full screen is worse than no icon:
           people read it as something else entirely and never press it. -->
      <button class="${CLS}-full" title="Full screen">Full</button>
      <button class="icon ${CLS}-close" title="Hide">${icon('close')}</button>
    </div>
    <video class="${CLS}-vid" autoplay playsinline muted></video>`;
  document.body.appendChild(viewer);

  viewer.querySelector('.' + CLS + '-close').onclick = () => hideViewer();
  viewer.querySelector('.' + CLS + '-full').onclick = () => {
    const v = viewer.querySelector('video');
    // requestFullscreen on the VIDEO rather than the window, so the controls do
    // not come with it and iOS gets its native player.
    (v.requestFullscreen || v.webkitEnterFullscreen || (() => {})).call(v);
  };
  return viewer;
}

function hideViewer() {
  const v = viewer?.querySelector('video');
  if (v) v.srcObject = null;
  viewer?.remove();
  viewer = null;
}

function showRemote(peerId, stream) {
  const w = ensureViewer();
  w.querySelector('.' + CLS + '-who').textContent = nameOf(peerId) + ' is sharing';
  const v = w.querySelector('video');
  v.srcObject = stream;
  // The screen carries no audio, so muted is correct and it is also what lets
  // autoplay work at all without a gesture.
  v.muted = true;
  v.play?.().catch(() => {});
}

// ------------------------------------------------------------------ button
// Lives in the voice bar, which only exists while you are in a call - which is
// the only time sharing means anything.
function paintButton() {
  const bar = $('voicebar');
  if (!bar) return;
  let b = $('vshare');
  if (!voice.active || !canShareScreen()) { b?.remove(); return; }
  if (!b) {
    b = el('button', 'ghost sm');
    b.id = 'vshare';
    // Before Leave, which is the destructive one and belongs at the end.
    bar.insertBefore(b, $('vleave') || null);
    b.onclick = async () => {
      b.disabled = true;
      try {
        if (voice.screen) await stopScreenShare();
        else await startScreenShare();
      } finally { b.disabled = false; paintButton(); }
    };
  }
  const on = !!voice.screen;
  b.textContent = on ? 'Stop sharing' : 'Share screen';
  b.classList.toggle('on', on);
}

// ------------------------------------------------------------------ chrome
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-win{position:fixed;right:var(--s-5);bottom:var(--s-5);z-index:var(--z-modal,900);
  width:min(420px,calc(100vw - var(--s-8)));border:1px solid var(--c-border);
  border-radius:var(--r-lg);overflow:hidden;background:#000;box-shadow:var(--e-3);
  animation:${CLS}-in var(--m-base) var(--m-out)}
@keyframes ${CLS}-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.${CLS}-win{animation:none}}
.${CLS}-bar{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-2) var(--s-3);
  background:var(--c-surface);font-size:var(--t-xs);color:var(--c-text-2)}
.${CLS}-who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLS}-bar .sp{flex:1}
.${CLS}-bar button.icon{width:28px;height:28px;min-width:28px}
.${CLS}-bar button.icon .ico{width:14px;height:14px}
.${CLS}-full{flex:none;min-height:28px;padding:0 var(--s-4);border:1px solid var(--c-border);
  border-radius:var(--r-md);background:transparent;color:var(--c-text-2);font-size:var(--t-xs)}
.${CLS}-full:hover{color:var(--c-text);border-color:var(--c-text-2)}
/* A shared screen is nearly always landscape and must never dictate the height
   of the window it is in - letterboxing is correct here and cropping is not,
   because the thing being pointed at is often in a corner. */
.${CLS}-vid{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#000}
/* On a phone it docks to the full width above the composer rather than floating
   in a corner, where at 390px it would cover the conversation it is about. */
@media (max-width: 520px){
  .${CLS}-win{right:var(--s-3);left:var(--s-3);bottom:calc(var(--s-3) + env(safe-area-inset-bottom));
    width:auto}
}
#vshare.on{background:var(--c-danger);color:var(--c-text-inverse);border-color:transparent}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register(app) {
  uiRef = app.ui;
  style();

  bus.on('voice:screen', ({ peerId, on, stream }) => {
    if (on) showRemote(peerId, stream);
    // Only close the window if the person who stopped is the one being watched.
    else if (!voice.remoteScreens.size) hideViewer();
    else {
      const [id, s] = [...voice.remoteScreens.entries()][0];
      showRemote(id, s);
    }
  });

  bus.on('voice:sharing', ({ on }) => {
    paintButton();
    if (on) {
      uiRef.toast('Sharing your screen. Everyone in the room can see it.', 'success');
    }
  });

  // The bar is created by core when a call starts, so the button has to be
  // painted after that rather than once at registration.
  for (const e of ['voice:refresh', 'voice:state', 'voice:join']) {
    bus.on(e, () => setTimeout(paintButton, 300));
  }

  app.ui.addSlashCommand({
    name: 'share',
    description: 'Share your screen with the voice room you are in',
    run: async () => {
      if (!voice.active) { app.ui.toast('Join a voice room first', 'error'); return; }
      if (voice.screen) await stopScreenShare(); else await startScreenShare();
    },
  });

  paintButton();
}
