// A call, as a person experiences it: a button next to their name, a phone that
// rings, and a bar that says who you are talking to and how long for.
//
// The mechanics are in js/core/call.js and js/core/rtc.js. This file is the part
// somebody touches, and the three rules it is built around are the three things
// that make a call feel like a call rather than like a web page:
//
// 1. RINGING HAS TO BE IMPOSSIBLE TO MISS. It takes the screen, it makes a
//    sound, it vibrates, and it raises a system notification when the tab is not
//    the one being looked at. A call that shows up as a toast in the corner is a
//    call that gets missed, and a missed call is worse than no call button.
// 2. ANSWERING IS ONE TAP, AND DECLINING IS ANOTHER. No menu, no confirmation,
//    and the two buttons are far enough apart that a thumb reaching for one on a
//    390px phone cannot hit the other.
// 3. WHILE YOU ARE IN A CALL, THE APP STILL WORKS. The bar is a strip, not a
//    screen: people call each other in order to look at the same thing, and an
//    app that covers itself with a call UI is one they leave to use WhatsApp.
import { store, bus, nameOf } from '../store.js';
import { $, el, esc } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import {
  call, callActive, callTitle, callsSupported,
  startCall, answerCall, declineCall, hangUp, setMuted, setSpeaker,
} from '../core/call.js';
import { hasRelay } from '../core/rtc.js';
import { startDM } from '../core/dms.js';
import { avatarHtml } from '../core/messages.js';

const CLS = 'cll';
let uiRef = null;
let tick = null;
let ring = null;

// ------------------------------------------------------------------ sound
//
// Synthesised rather than a file. An .mp3 would be one more thing in the service
// worker's shell list, one more thing to 404 offline, and one more asset to get
// the licence wrong on - for two notes. The pattern is the part that matters
// anyway: people recognise the RHYTHM of a ringtone long before the pitch.
//
// It can be silent, and that is survivable. A browser that has had no user
// gesture yet refuses to start an AudioContext, so the visual ring, the vibration
// and the notification all have to stand on their own - which is why they exist
// and are not decoration on top of the sound.
function ringer({ incoming }) {
  let ctx = null;
  let timer = null;
  let stopped = false;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume?.().catch(() => {});
  } catch { ctx = null; }

  const beep = (freq, at, len, gain = 0.08) => {
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    // Ramped rather than switched. A square-edged gate on a sine wave is an
    // audible click on every beep, and forty of those is what a ringtone people
    // hate sounds like.
    g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
    g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + len);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + at);
    o.stop(ctx.currentTime + at + len + 0.05);
  };

  const cycle = () => {
    if (stopped) return;
    if (incoming) {
      // Two rising notes, twice - the shape of every phone ring since bells.
      beep(660, 0, 0.35); beep(880, 0.4, 0.35);
      beep(660, 1.0, 0.35); beep(880, 1.4, 0.35);
      navigator.vibrate?.([400, 200, 400, 1600]);
    } else {
      // Ringback: one long tone, the sound of waiting rather than of being called.
      beep(420, 0, 1.0, 0.04);
    }
  };
  cycle();
  timer = setInterval(cycle, incoming ? 3000 : 3200);

  return () => {
    stopped = true;
    clearInterval(timer);
    navigator.vibrate?.(0);
    ctx?.close?.().catch?.(() => {});
  };
}

function stopRing() { ring?.(); ring = null; }

function startRing(kind) {
  stopRing();
  ring = ringer({ incoming: kind === 'incoming' });
}

// ------------------------------------------------------------------ the bar
// A sibling of #voicebar rather than a second mode of it: core/voice.js owns
// that element's visibility, and two owners for one element is how a bar gets
// left on screen after a call ends.
function barHost() {
  let n = $('callbar');
  if (n) return n;
  const anchor = $('voicebar');
  if (!anchor?.parentNode) return null;
  n = el('div', CLS + '-bar hidden');
  n.id = 'callbar';
  anchor.parentNode.insertBefore(n, anchor.nextSibling);
  return n;
}

function elapsed() {
  if (!call.startedAt) return '';
  const s = Math.floor((Date.now() - call.startedAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function paintBar() {
  const host = barHost();
  if (!host) return;
  // Incoming has its own surface: a strip is not enough to answer a phone with.
  if (!callActive() || call.phase === 'incoming') {
    host.classList.add('hidden');
    host.innerHTML = '';
    clearInterval(tick);
    tick = null;
    return;
  }

  host.classList.remove('hidden');
  const ringing = call.phase === 'outgoing';
  host.innerHTML = `
    <span class="${CLS}-ico">${icon('phone')}</span>
    <span class="${CLS}-who">
      <b>${esc(callTitle())}</b>
      <span class="${CLS}-sub" id="callSub">${ringing ? 'Ringing…' : elapsed() || 'Connecting…'}</span>
    </span>
    <span class="sp"></span>`;

  if (!ringing) {
    const mute = el('button', 'ghost sm' + (call.muted ? '' : ' on'),
      icon(call.muted ? 'micOff' : 'mic') + (call.muted ? ' Unmute' : ' Mute'));
    mute.onclick = () => setMuted(!call.muted);
    host.appendChild(mute);

    const spk = el('button', 'ghost sm' + (call.speaker ? ' on' : ''),
      icon(call.speaker ? 'headphones' : 'volumeOff') + (call.speaker ? ' Sound on' : ' Sound off'));
    spk.onclick = () => setSpeaker(!call.speaker);
    host.appendChild(spk);
  }

  const end = el('button', 'danger sm ' + CLS + '-end',
    icon('phoneOff') + (ringing ? ' Cancel' : ' Hang up'));
  end.onclick = () => hangUp();
  host.appendChild(end);

  clearInterval(tick);
  if (!ringing) {
    tick = setInterval(() => {
      const sub = $('callSub');
      if (sub) sub.textContent = elapsed() || 'Connecting…';
    }, 1000);
  }
}

// The header row is a shared registry that only repaints when somebody asks it
// to, so a button whose show() answer has changed is still the old answer on
// screen. Two things change this one: moving in or out of a direct conversation,
// and being in a call or not. Compared rather than repainted unconditionally,
// because renderHeaderButtons rebuilds every button in the row.
let hadCall = null;
let wasLive = false;
function syncHeader() {
  const now = (!!store.currentDM) && !callActive();
  if (now === hadCall) return;
  hadCall = now;
  uiRef.renderHeaderButtons();
}

// ------------------------------------------------------------------ incoming
let sheet = null;

function closeSheet() {
  sheet?.remove();
  sheet = null;
  document.body.classList.remove(CLS + '-ringing');
}

function openSheet({ rejoin } = {}) {
  closeSheet();
  const from = call.info?.created_by;
  sheet = el('div', CLS + '-sheet');
  sheet.innerHTML = `
    <div class="${CLS}-card">
      <div class="${CLS}-av">${avatarHtml(from, 84)}</div>
      <div class="${CLS}-name">${esc(nameOf(from))}</div>
      <div class="${CLS}-state">${rejoin
        ? 'You were in this call when the page reloaded'
        : 'Incoming call'}</div>
      <div class="${CLS}-acts">
        <button class="${CLS}-no" type="button">${icon('phoneOff')}<span>Decline</span></button>
        <button class="${CLS}-yes" type="button">${icon('phone')}<span>${rejoin ? 'Rejoin' : 'Answer'}</span></button>
      </div>
    </div>`;
  document.body.appendChild(sheet);
  document.body.classList.add(CLS + '-ringing');
  sheet.querySelector('.' + CLS + '-no').onclick = () => { stopRing(); declineCall('declined'); };
  sheet.querySelector('.' + CLS + '-yes').onclick = () => { stopRing(); answerCall(); };
}

// The tab is not the one being looked at. A ring that only exists inside a
// hidden tab has not happened.
function notifyRing() {
  if (document.visibilityState === 'visible') return;
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(nameOf(call.info?.created_by), {
      body: 'is calling you',
      icon: './icons/icon-192.png',
      tag: 'dek-call',
      // The ring is the point. A silent, quietly-stacking notification is what
      // every other notification in this app should be and what this one must not.
      renotify: true,
      requireInteraction: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* notifications are a courtesy */ }
}

// ------------------------------------------------------------------ stall
//
// The failure this app cannot otherwise report. Audio is peer to peer, and on a
// network that needs a relay - carrier-grade NAT, which is what Indian mobile
// data is - the two browsers simply never find each other. Nothing throws. Both
// people sit there saying "hello?" while the timer counts up, because as far as
// the app is concerned the call is live.
//
// So it is timed, and the message names the actual cause: whether a relay is
// even configured is knowable from here, and it is nearly always the answer.
let connected = false;
let stall = null;

function watchConnect() {
  clearTimeout(stall);
  connected = false;
  stall = setTimeout(async () => {
    if (!callActive() || connected) return;
    const relay = await hasRelay();
    uiRef.toast(relay
      ? 'Still connecting. If this does not clear, one of you is on a network that is blocking the audio.'
      : 'The audio cannot get through, and this server has no relay set up '
        + '(the dek-turn function). On mobile data that is usually the reason.',
    'error');
  }, 9000);
}

// ------------------------------------------------------------------ starting
// Everything that wants to call somebody comes through here, so "make sure there
// is a conversation first" is written once.
async function callPerson(userId) {
  if (!store.ws) { uiRef.toast('Open a Space first', 'error'); return; }
  const conv = store.dms.find((d) => {
    const ids = (d.other_user_ids || []).filter((u) => u !== store.me);
    return ids.length === 1 && ids[0] === userId;
  });
  if (conv) { startCall(conv.conversation_id); return; }
  // No conversation yet. Open one - which is what create_dm is for - and call it.
  // The DM also becomes the place the call's record line lands.
  try {
    const created = await api.createDM(store.ws.id, [userId]);
    await startDM(userId);
    await startCall(created.id);
  } catch (e) {
    uiRef.toast(e.message || 'Could not start that call', 'error');
  }
}

// ------------------------------------------------------------------ chrome
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-bar{display:flex;align-items:center;gap:var(--s-3);padding:var(--s-2) var(--s-5);
  border-bottom:1px solid var(--c-border);min-height:44px;font-size:var(--t-sm);
  background:color-mix(in srgb, var(--c-success) 14%, var(--c-surface))}
.${CLS}-bar.hidden{display:none}
.${CLS}-ico{display:inline-flex;color:var(--c-success);flex:none}
.${CLS}-ico .ico{width:16px;height:16px}
/* flex:1 with min-width:0 is what lets a long name TRUNCATE instead of pushing
   Hang up off the right edge of a 390px phone. Without both halves the column
   sizes to its content and the one control that must always be reachable is the
   one that leaves. */
.${CLS}-who{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;gap:1px;overflow:hidden}
.${CLS}-who b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLS}-sub{font-size:var(--t-xs);color:var(--c-text-2);font-variant-numeric:tabular-nums}
.${CLS}-bar .sp{flex:1}
.${CLS}-bar button{flex:none;min-height:32px}
.${CLS}-bar button .ico{width:14px;height:14px;vertical-align:-2px}
/* At 390px the two secondary controls lose their words rather than their
   selves: mute is the control people reach for mid-sentence and it must not be
   the one that wrapped off the bar. */
@media (max-width: 480px){
  .${CLS}-bar{padding-inline:var(--s-3);gap:var(--s-2)}
  .${CLS}-bar button.ghost span,.${CLS}-bar button.ghost{font-size:var(--t-xs)}
}

/* ---- the ringing sheet ---- */
.${CLS}-sheet{position:fixed;inset:0;z-index:calc(var(--z-toast, 300) + 5);display:grid;place-items:center;
  background:color-mix(in srgb, var(--c-bg) 82%, transparent);backdrop-filter:blur(6px);
  animation:${CLS}-fade var(--m-base,.18s) var(--m-out,ease)}
@keyframes ${CLS}-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: reduce){.${CLS}-sheet{animation:none}}
.${CLS}-card{display:flex;flex-direction:column;align-items:center;gap:var(--s-4);
  padding:var(--s-8) var(--s-6);border-radius:var(--r-lg);background:var(--c-surface);
  border:1px solid var(--c-border);box-shadow:var(--e-3);
  width:min(360px,calc(100vw - var(--s-8)))}
.${CLS}-av .avatar,.${CLS}-av img{width:84px;height:84px;border-radius:50%}
/* The pulse is the only animation on this card, and it is on the avatar because
   that is where somebody is already looking. */
.${CLS}-av{animation:${CLS}-pulse 1.6s ease-in-out infinite}
@keyframes ${CLS}-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
@media (prefers-reduced-motion: reduce){.${CLS}-av{animation:none}}
.${CLS}-name{font-size:var(--t-lg);font-weight:600;text-align:center;word-break:break-word}
.${CLS}-state{font-size:var(--t-sm);color:var(--c-text-2)}
.${CLS}-acts{display:flex;gap:var(--s-6);margin-top:var(--s-4)}
/* The base button style carries a fill, a radius and an --e-1 shadow, all three
   of which drew a pale card behind each circle. Everything here is the circle
   and its word, so all three are taken off rather than painted over. */
.${CLS}-acts button{display:flex;flex-direction:column;align-items:center;gap:var(--s-2);
  border:none;background:transparent;color:var(--c-text-2);font-size:var(--t-xs);
  padding:0;min-height:0;box-shadow:none;border-radius:0}
.${CLS}-acts button:hover{background:transparent}
.${CLS}-acts button .ico{width:26px;height:26px;color:var(--c-text-inverse);
  padding:16px;border-radius:50%;box-sizing:content-box}
.${CLS}-yes .ico{background:var(--c-success)}
.${CLS}-no .ico{background:var(--c-danger)}
.${CLS}-acts button:hover .ico{filter:brightness(1.08)}
/* Fifty-eight pixels of dead space between the two, because the whole cost of
   getting this wrong is answering a call you meant to refuse. */
@media (max-width: 420px){.${CLS}-acts{gap:58px}}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register(app) {
  uiRef = app.ui;
  style();

  app.ui.addHeaderButton({
    id: 'call',
    order: 8,
    title: 'Call',
    label: icon('phone'),
    // Only in a direct conversation. A channel call is a voice room, which the
    // app already has and which scales past three people.
    show: () => callsSupported() && !!store.currentDM && !callActive(),
    onClick: () => startCall(store.currentDM),
  });

  // The member card's Call button. core/actions.js emits this rather than
  // importing the call engine, so nothing in core has to know that calls exist.
  bus.on('call:request', ({ userId }) => callPerson(userId));

  bus.on('call:incoming', ({ rejoin }) => {
    openSheet({ rejoin });
    // A rejoin offer is not a ringing phone. It is a question, and one somebody
    // may well answer with "no" - making it ring would be a lie about what is
    // happening on the other side.
    if (!rejoin) { startRing('incoming'); notifyRing(); }
    paintBar();
  });

  bus.on('call:peer', ({ state }) => { if (state === 'connected') connected = true; });

  bus.on('call:update', ({ phase }) => {
    if (phase !== 'incoming') closeSheet();
    if (phase === 'outgoing') { if (!ring) startRing('outgoing'); } else if (phase !== 'incoming') stopRing();
    // Entering the audio, once - watchConnect resets the flag it is watching, so
    // calling it on every repaint would restart the clock forever and the stall
    // would never be reported.
    if (phase === 'live' && !wasLive) watchConnect();
    wasLive = phase === 'live';
    if (phase === 'idle') clearTimeout(stall);
    paintBar();
    syncHeader();
  });

  bus.on('call:ended', ({ call: ended, reason }) => {
    stopRing();
    closeSheet();
    paintBar();
    syncHeader();
    // The same ending means two different things depending on which end you are.
    // "No answer" on the phone of the person who did not answer is nonsense, and
    // "Call declined" to the person who just pressed Decline is telling them what
    // they already did.
    const mine = ended?.created_by === store.me;
    const who = nameOf(ended?.created_by);
    const said = mine ? {
      declined: 'Call declined',
      missed: 'No answer',
      busy: 'They are already on a call',
      cancelled: 'Call cancelled',
      dropped: 'The call dropped',
    }[reason] : {
      missed: `Missed call from ${who}`,
      cancelled: `Missed call from ${who}`,
      dropped: 'The call dropped',
      gone: 'That call has already ended',
    }[reason];
    if (said) app.ui.toast(said, 'info');
  });

  // A ring this device refused on its owner's behalf, because they were already
  // on a call. It never became a call here, so call:ended never fires for it -
  // and "my phone never rang" is the single most damaging thing a call feature
  // can do, so it is said out loud.
  bus.on('call:missed', ({ call: info }) => {
    app.ui.toast(`${nameOf(info?.created_by)} called while you were on another call`, 'info');
  });

  app.ui.addSlashCommand({
    name: 'call',
    description: 'Call the person in this conversation',
    run: () => {
      if (!callsSupported()) { app.ui.toast('Calling is not switched on for this server yet', 'error'); return; }
      if (callActive()) { app.ui.toast('You are already in a call', 'info'); return; }
      if (store.currentDM) { startCall(store.currentDM); return; }
      app.ui.toast('Open a direct message first, or use a voice room for a channel', 'info');
    },
  });

  // A call outlives a channel switch and a Space switch, so the bar is repainted
  // on the events that rebuild the chrome around it.
  for (const e of ['channel:open', 'dm:open', 'workspace', 'profiles']) {
    bus.on(e, () => { paintBar(); syncHeader(); });
  }
  paintBar();
  syncHeader();
}
