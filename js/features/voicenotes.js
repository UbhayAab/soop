// Voice notes, the way the phone in a depot actually expects them to work.
//
// WHAT SHIPPED FIRST AND WHY IT FAILED IN THE FIELD: a mic button that flipped
// state with no visible change, a toast nobody read, and a race that could
// attach the PREVIOUS recording to the current send. On a phone the person had
// no idea anything was happening, so they tapped again - and the first take
// landed in the chat as a surprise.
//
// THIS VERSION: tapping the mic takes over the composer bar with a WhatsApp
// style live strip - pulsing red dot, running timer, cancel and send. There is
// exactly one obvious way to stop, and the strip says "Sending…" until the
// message is actually out. Playback refreshes its signed URL on demand, so a
// note recorded an hour ago still plays.
import { store } from '../store.js';
import { api } from '../api.js';
import { toast, escPush } from '../ui.js';
import { uploadFile } from '../core/media.js';
import { esc } from '../util.js';

const TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];
const MAX_MS = 5 * 60 * 1000;

let rec = null;
let chunks = [];
let stream = null;
let startedAt = 0;
let tick = null;
let autoStop = null;
let liveBar = null;

const MIME = () => TYPES.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || '';
const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

function findMic() {
  const host = document.getElementById('composerTools');
  if (!host) return null;
  return [...host.querySelectorAll('button')].find((x) =>
    x.title === 'Voice note' || x.title === 'Stop recording' || x.classList.contains('vn-rec')) || null;
}

function showLiveBar() {
  const bar = document.getElementById('composerBar');
  if (!bar) return;
  const crow = bar.querySelector('.crow');
  if (crow) crow.style.display = 'none';
  liveBar = document.createElement('div');
  liveBar.className = 'vn-live';
  liveBar.innerHTML = `
    <span class="vn-dot" aria-hidden="true"></span>
    <span class="vn-timer" id="vnTimer">0:00</span>
    <span class="vn-hint">Recording voice note…</span>
    <span class="sp"></span>
    <button class="icon vn-cancel" id="vnCancel" title="Cancel" type="button">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>
    </button>
    <button class="send vn-send" id="vnSend" title="Stop and send" type="button">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 7 5 5-5 5"/><path d="M20 12H9a6 6 0 0 0-6 6v1"/></svg>
    </button>`;
  bar.appendChild(liveBar);
  liveBar.querySelector('#vnCancel').onclick = () => stop(true);
  liveBar.querySelector('#vnSend').onclick = () => stop(false);
}

function hideLiveBar() {
  liveBar?.remove();
  liveBar = null;
  const crow = document.querySelector('#composerBar .crow');
  if (crow) crow.style.display = '';
  const mic = findMic();
  if (mic) { mic.classList.remove('vn-rec'); mic.title = 'Voice note'; }
}

function paintTimer() {
  const t = document.getElementById('vnTimer');
  if (t) t.textContent = fmt(Date.now() - startedAt);
}

async function start() {
  if (typeof MediaRecorder === 'undefined') {
    toast('Voice notes are not supported in this browser', 'error');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Microphone permission is needed for voice notes', 'error');
    return;
  }
  chunks = [];
  const mime = MIME();
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch {
    toast('Could not start recording here', 'error');
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  // ondataavailable fires ASYNC after stop(); collecting in the handler (not
  // reading chunks synchronously after stop) is the whole fix for the
  // "my previous recording got sent" bug.
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = onStop;
  startedAt = Date.now();
  rec.start(500);
  showLiveBar();
  paintTimer();
  tick = setInterval(paintTimer, 250);
  const mic = findMic();
  if (mic) { mic.classList.add('vn-rec'); mic.title = 'Stop recording'; }
  escDispose = escPush(() => stop(true));
  autoStop = setTimeout(() => stop(false), MAX_MS);
}

function stop(cancelled) {
  if (!rec || rec.state === 'inactive') return;
  if (escDispose) { const d = escDispose; escDispose = null; d(); }
  clearInterval(tick);
  clearTimeout(autoStop);
  rec._cancelled = !!cancelled;
  try { rec.stop(); } catch { cleanup(); }
}

function cleanup() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  rec = null;
  hideLiveBar();
}

async function onStop() {
  const cancelled = rec?._cancelled;
  const type = rec?.mimeType || MIME() || 'audio/webm';
  const blob = new Blob(chunks, { type });
  cleanup();
  // Sub-1.2KB is a pocket or an immediate cancel - never a voice note.
  if (cancelled || blob.size < 1200) return;

  if (!store.current) { toast('Open a channel first', 'info'); return; }
  const dur = Date.now() - startedAt;
  const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
  const file = new File([blob], `voice-note-${fmt(dur).replace(':', 'm')}s.${ext}`, { type });
  const sendingBar = document.getElementById('composerBar');
  let note = null;
  if (sendingBar) {
    note = document.createElement('div');
    note.className = 'vn-live vn-sending';
    note.innerHTML = `<span class="vn-dot"></span><span class="vn-hint">Sending voice note…</span>`;
    sendingBar.querySelector('.crow')?.style.setProperty('display', 'none');
    sendingBar.appendChild(note);
  }
  try {
    const up = await uploadFile(file);
    await api.send({
      channel: store.current.id,
      nonce: crypto.randomUUID(),
      text: '',
      attachments: [{
        object_key: up.object_key, name: file.name,
        mime: up.mime, size: file.size,
        width: null, height: null, duration_ms: dur,
      }],
    });
  } catch (e) {
    toast(e.message || 'The voice note failed to send', 'error');
  } finally {
    note?.remove();
    const crow = sendingBar?.querySelector('.crow');
    if (crow) crow.style.display = '';
  }
}

export function register(app) {
  const { ui } = app;
  const s = document.createElement('style');
  s.textContent = `
.vn-live{display:flex;align-items:center;gap:10px;padding:10px var(--s-4);border-radius:var(--r-lg);
  background:color-mix(in srgb, var(--c-danger) 8%, var(--c-surface));border:1px solid color-mix(in srgb, var(--c-danger) 35%, transparent)}
.vn-dot{width:11px;height:11px;border-radius:var(--r-full);background:var(--c-danger);flex:none;
  animation:vn-pulse 1.1s ease-in-out infinite}
@keyframes vn-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
.vn-timer{font-variant-numeric:tabular-nums;font-weight:var(--t-semibold);color:var(--c-text)}
.vn-hint{color:var(--c-text-2);font-size:var(--t-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vn-cancel,.vn-send{flex:none}
.vn-sending .vn-dot{animation:vn-pulse .6s ease-in-out infinite}`;
  document.head.appendChild(s);

  ui.addComposerButton({
    id: 'voice-note',
    order: 45,
    label: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    title: 'Voice note',
    show: () => !!store.current,
    onClick: () => {
      if (rec && rec.state === 'recording') stop(false);
      else start();
    },
  });
  // The tool row paints during initComposer, BEFORE features register. Without
  // this repaint the mic existed in the registry and nowhere on screen.
  ui.renderComposerButtons();
}

// Escape during a live recording stops it instead of peeling whatever is
// behind the bar. The claim lives on the LIFO close stack (ui.js), pushed for
// exactly the recording's lifetime - a static registration would spend every
// later Escape on a dead check. On CloseWatcher browsers the Android back
// gesture stops the recording too, which is the grouping you want.
let escDispose = null;
