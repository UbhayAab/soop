// Getting into a voice room from a phone.
//
// The rooms have always existed and always worked. What did not exist was any
// way to FIND them without knowing where to look: they are rendered at the
// bottom of the channel list, and on a phone the channel list is a drawer behind
// the hamburger. So joining a call meant tap hamburger, scroll past every text
// channel, find VOICE, tap. Nobody discovers that, which is why the rooms went
// unused and meetings stayed on whatever app people were already on.
//
// Two things fix it, and the first one matters far more than the second.
//
// 1. WHEN SOMEBODY IS TALKING, SAY SO. A full-width strip under the channel bar:
//    "Standup - Priya and Karthik are here [Join]". You do not go looking for a
//    meeting, the meeting tells you it is happening. This is the whole feature.
//    Discord, Slack huddles and Teams all work this way and it is the only
//    reliable way a call in an app gets used.
//
// 2. A room list you can open on purpose, for starting one rather than joining
//    one. A panel, which on a phone is already a full-screen sheet.
//
// The strip is a SEPARATE element from #voicebar rather than a second mode of
// it. core/voice.js owns that one and hides and shows it by class on join and
// leave; sharing it would mean two owners for one element's visibility, which is
// the kind of thing that works until somebody drops a call at the wrong moment.
import { store, bus, nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { $, el, esc } from '../util.js';
import { icon } from '../icons.js';
import { voice, leaveVoice } from '../core/voice.js';
import { createChannelDialog } from '../core/channels.js';

// Opened already set to Voice, so pressing a speaker icon does not then ask you
// which kind of channel you meant.
const newRoom = () => createChannelDialog({ kind: 'voice' });

const CLS = 'vrm';
const PANEL = 'voice';
let uiRef = null;

// Voice channels in the Space, live ones only. An archived room takes no new
// audio, so offering it is offering a dead line.
const rooms = () => (store.channels || []).filter(
  (c) => c.kind === 'voice' && !c.archived_at);

const peopleIn = (id) => (store.voiceParts.get(id) || []).filter(Boolean);

// Everybody in any room, minus me. "minus me" is the important half: once you
// have joined, the invitation must stop inviting you.
function elsewhere() {
  const out = [];
  for (const c of rooms()) {
    const ids = peopleIn(c.id).filter((u) => u !== store.me);
    if (ids.length) out.push({ channel: c, ids });
  }
  return out;
}

// A list of names that reads like a sentence rather than a CSV.
function sayWho(ids) {
  const names = ids.slice(0, 3).map((u) => nameOf(u));
  const more = ids.length - names.length;
  const list = names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return more > 0 ? `${list} and ${more} more` : list;
}

// ------------------------------------------------------------------ the strip
function stripHost() {
  let n = $('voiceInvite');
  if (n) return n;
  const bar = $('voicebar');
  if (!bar || !bar.parentNode) return null;
  n = el('div', CLS + '-strip hidden');
  n.id = 'voiceInvite';
  bar.parentNode.insertBefore(n, bar.nextSibling);
  return n;
}

function paintStrip() {
  const host = stripHost();
  if (!host) return;

  // Already in a call: core's own bar is on screen with the controls that matter.
  // Two strips stacked would be noise, and the second one would be inviting
  // somebody to a room they are standing in.
  const live = voice.active ? [] : elsewhere();
  if (!live.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }

  // One room at a time. Two rooms both busy is rare at this size, and a strip
  // that grows a list is a strip that pushes the conversation down the screen.
  // The busiest wins; the rest are one tap away in the panel.
  live.sort((a, z) => z.ids.length - a.ids.length);
  const { channel, ids } = live[0];
  const others = live.length - 1;

  host.classList.remove('hidden');
  host.innerHTML = `
    <span class="${CLS}-ico">${icon('volume')}</span>
    <span class="${CLS}-text">
      <b>${esc(channel.name)}</b>
      <span class="${CLS}-who">${esc(sayWho(ids))} ${ids.length === 1 ? 'is' : 'are'} here${
        others ? ` &middot; ${others} other room${others > 1 ? 's' : ''} busy` : ''}</span>
    </span>`;

  const join = el('button', 'sm ' + CLS + '-join', 'Join');
  join.onclick = () => bus.emit('voice:join', { channelId: channel.id });
  host.appendChild(join);

  // Somewhere to go when the busiest room is not the one you wanted.
  if (others) {
    const all = el('button', 'sm ghost', 'All rooms');
    all.onclick = () => uiRef.openPanel(PANEL);
    host.appendChild(all);
  }
}

// ------------------------------------------------------------------ the panel
function renderPanel(body) {
  body.innerHTML = '';
  const list = rooms();
  if (!store.ws) { body.appendChild(el('div', 'empty', 'Open a Space first.')); return; }
  if (!list.length) {
    const e = el('div', 'empty');
    e.textContent = 'This Space has no voice rooms yet. A room is a door somebody '
      + 'can walk through - it does not need to be booked and it does not end.';
    body.appendChild(e);
    // The button, not the instructions. Telling somebody where a control is, is
    // what you do when you cannot put the control here.
    if (hasPerm(PERM.MANAGE_CHANNELS)) {
      const add = el('button', '', 'Make the first room');
      add.style.margin = '12px auto 0';
      add.style.display = 'block';
      add.onclick = () => { uiRef.closePanel(); newRoom(); };
      body.appendChild(add);
    } else {
      body.appendChild(el('div', 'muted pad',
        'Ask somebody who can manage channels to add one.'));
    }
    return;
  }

  body.appendChild(el('div', 'muted pad',
    'Rooms stay open. Walk in, talk, walk out - there is nothing to schedule.'));

  for (const c of list) {
    const ids = peopleIn(c.id);
    const here = voice.active && voice.channel?.id === c.id;
    const card = el('div', 'result ' + CLS + '-card' + (here ? ' ' + CLS + '-cardhere' : ''));
    card.innerHTML = `
      <div class="${CLS}-cardtop">
        <span class="${CLS}-ico">${icon('volume')}</span>
        <b>${esc(c.name)}</b>
        <span class="${CLS}-count">${ids.length ? `${ids.length} here` : 'empty'}</span>
      </div>
      ${ids.length ? `<div class="${CLS}-names muted">${esc(ids.map((u) => nameOf(u)).join(', '))}</div>` : ''}`;

    const bar = el('div', 'row gap ' + CLS + '-bar');
    if (here) {
      // Called directly rather than through the bus: there is no voice:leave
      // event, only the exported function that #vleave in the voice bar calls.
      const leave = el('button', 'sm danger', 'Leave');
      leave.onclick = async () => { await leaveVoice(); uiRef.openPanel(PANEL); };
      bar.appendChild(leave);
    } else {
      const join = el('button', 'sm', ids.length ? 'Join them' : 'Start talking here');
      join.onclick = () => { bus.emit('voice:join', { channelId: c.id }); uiRef.closePanel(); };
      bar.appendChild(join);
    }
    card.appendChild(bar);
    body.appendChild(card);
  }

  if (hasPerm(PERM.MANAGE_CHANNELS)) {
    const add = el('button', 'ghost sm', '＋ Another room');
    add.onclick = () => { uiRef.closePanel(); newRoom(); };
    body.appendChild(add);
  }

  // Said once, at the bottom, rather than as a warning nobody reads at the top.
  // It is the honest limit of a peer mesh and people should hear it from the app
  // rather than from a call that fell over.
  body.appendChild(el('div', 'muted pad',
    'Voice is peer to peer, so it is at its best up to about six people. '
    + 'Bigger than that, use a proper meeting link and put it in the channel.'));
}

// ------------------------------------------------------------------ chrome
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
#voiceInvite.${CLS}-strip{display:flex;align-items:center;gap:var(--s-3);
  padding:var(--s-3) var(--s-5);border-bottom:1px solid var(--c-border);
  background:color-mix(in srgb, var(--c-success) 12%, var(--c-surface));
  font-size:var(--t-sm);min-height:44px}
#voiceInvite.hidden{display:none}
.${CLS}-ico{display:inline-flex;align-items:center;color:var(--c-success);flex:none}
.${CLS}-ico .ico{width:16px;height:16px}
.${CLS}-text{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.${CLS}-text b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLS}-who{font-size:var(--t-xs);color:var(--c-text-2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLS}-join{flex:none;background:var(--c-success);color:var(--c-text-inverse);
  border-color:transparent;min-height:32px;padding-inline:var(--s-5)}
.${CLS}-join:hover{filter:brightness(1.08)}
#voiceInvite button.ghost{flex:none;min-height:32px}
/* ONE row, at every width. Wrapping this looked reasonable written down and
   measured 113px on a 390px phone once the icon, the name, the "who is here"
   line and a full-width button each took a row of their own. That is an eighth
   of the screen permanently spent on an invitation. The text column truncates
   instead: the room name and the button are what the strip is for, and a name
   cut short still tells you which room. */
@media (max-width: 420px){
  .${CLS}-who{font-size:var(--t-2xs)}
  #voiceInvite button.ghost{display:none}
}
.${CLS}-card{margin-bottom:var(--s-3)}
.${CLS}-cardhere{border-color:var(--c-success)}
.${CLS}-cardtop{display:flex;align-items:center;gap:var(--s-3)}
.${CLS}-cardtop b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLS}-count{font-size:var(--t-xs);color:var(--c-text-2);flex:none}
.${CLS}-names{font-size:var(--t-xs);margin-top:var(--s-2);word-break:break-word}
.${CLS}-bar{margin-top:var(--s-3)}
.${CLS}-bar button{min-height:36px}
@media (max-width: 520px){.${CLS}-bar button{flex:1}}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register(app) {
  uiRef = app.ui;
  style();

  app.ui.registerPanel({
    id: PANEL,
    title: 'Voice rooms',
    icon: 'volume',
    render: (body) => renderPanel(body),
  });

  // voice:state is emitted by core after it has rebuilt store.voiceParts, which
  // is the only moment "who is in a room" is actually known. The rest are the
  // edges around it: a Space change replaces the channel list underneath, and
  // sign-in is the first time there is anything to paint at all.
  for (const e of ['voice:state', 'channels', 'workspace', 'auth']) {
    bus.on(e, () => paintStrip());
  }
  // voice:join fires BEFORE the join completes - core binds it to joinVoice -
  // so at that instant the strip is still inviting you into the room you are
  // walking into. getUserMedia and the first signalling round trip land inside
  // this window on any normal connection.
  bus.on('voice:join', () => setTimeout(paintStrip, 600));

  app.ui.addSlashCommand({
    name: 'voice',
    description: 'Show the voice rooms in this Space',
    run: () => app.ui.openPanel(PANEL),
  });

  paintStrip();
}
