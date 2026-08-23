// Voice notes. The gap matrix ranked this the feature Indian field staff use
// more than any other on WhatsApp and Dek had no equivalent: no MediaRecorder
// anywhere in the tree. A sales officer who types slowly in English sends a
// 40-second Hindi voice note; without this they keep doing it in WhatsApp and
// the record lives outside the system.
//
// Design: one composer button. Tap to start, tap to stop-and-send, Esc cancels.
// The recording goes straight out as an audio attachment message - not into the
// chip queue - because "I said something" is a send, not a draft.
import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../ui.js';
import { uploadFile } from '../core/media.js';
import { esc } from '../util.js';

const TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

let rec = null;
let chunks = [];
let stream = null;
let startedAt = 0;
let tick = null;
let btn = null;
const MIME = () => TYPES.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || '';

function paint(state, extra = '') {
  if (!btn) return;
  btn.innerHTML = state === 'recording'
    ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg><span class="vn-time">${esc(extra)}</span>`
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
  btn.classList.toggle('vn-rec', state === 'recording');
  btn.title = state === 'recording' ? 'Stop and send' : 'Voice note';
}

function fmt(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
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
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = onStop;
  startedAt = Date.now();
  rec.start(500);
  paint('recording', '0:00');
  tick = setInterval(() => paint('recording', fmt((Date.now() - startedAt) / 1000)), 250);
}

function stop(cancelled) {
  if (!rec || rec.state === 'inactive') return;
  rec._cancelled = !!cancelled;
  clearInterval(tick);
  try { rec.stop(); } catch { cleanup(); }
}

function cleanup() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  rec = null;
  paint('idle');
}

// Hard cap at five minutes: a pocket-dial left running should end itself
// before it becomes a hundred-megabyte upload on a depot line.
function armAutoStop() {
  setTimeout(() => { if (rec && rec.state === 'recording') stop(false); }, 5 * 60 * 1000);
}

async function onStop() {
  const cancelled = rec?._cancelled;
  const blob = new Blob(chunks, { type: rec?.mimeType || MIME() || 'audio/webm' });
  cleanup();
  if (cancelled || blob.size < 1200) return;   // sub-1.2KB is silence/accident

  if (!store.current) { toast('Open a channel first', 'info'); return; }
  const ext = /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
  const dur = Math.round((Date.now() - startedAt) / 1000);
  const file = new File([blob], `voice-note-${fmt(dur).replace(':', 'm')}s.${ext}`, { type: blob.type });
  toast('Sending voice noteâ€¦');
  try {
    const up = await uploadFile(file);
    await api.send({
      channel: store.current.id,
      nonce: crypto.randomUUID(),
      text: '',
      attachments: [{
        object_key: up.object_key, name: file.name,
        mime: up.mime, size: file.size,
        width: null, height: null, duration_ms: dur * 1000,
      }],
    });
  } catch (e) {
    toast(e.message || 'The voice note failed to send', 'error');
  }
}

export function register(app) {
  const { ui } = app;
  const s = document.createElement('style');
  s.textContent = `
.vn-wrap{display:flex;align-items:center}
.vn-rec{color:var(--c-danger)!important}
.vn-time{font-size:var(--t-xs);font-weight:var(--t-semibold);margin-left:4px;font-variant-numeric:tabular-nums}`;
  document.head.appendChild(s);

  ui.addComposerButton({
    id: 'voice-note',
    order: 45,
    label: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    title: 'Voice note',
    show: () => !!store.current,
    onClick: () => {
      btn = findBtn();
      if (!btn) return;
      if (rec && rec.state === 'recording') stop(false);
      else start().then(armAutoStop);
    },
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && rec && rec.state === 'recording') stop(true);
  });
}

function findBtn() {
  const host = document.getElementById('composerTools');
  if (!host) return null;
  return [...host.querySelectorAll('button')].find((x) =>
    x.title === 'Voice note' || x.classList.contains('vn-rec')) || null;
}
