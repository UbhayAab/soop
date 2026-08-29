// Embedded mode: Dek running as a panel inside somebody else's dashboard.
//
// The same build serves both jobs. There is no separate embed bundle, no fork,
// and no second deploy - the app notices it was opened with ?embed=1 and changes
// four things:
//
//   1. Identity comes from the host instead of the sign-in card. The dashboard
//      already knows who this person is; making them type a password into a
//      400px column beside the product they are already signed into is the whole
//      reason people refuse to use embedded chat.
//   2. One Space is pinned, because a dashboard is already team-specific. The
//      rail can go, and the 60px it held goes back to the conversation.
//   3. Chrome that only makes sense in a standalone tab is dropped: install
//      prompts, the service worker, the org switcher.
//   4. A postMessage bridge lets the host drive it (open this channel, sign out,
//      change theme) and lets it report back (unread count, who signed in).
//
// WHY AN IFRAME AND NOT A WEB COMPONENT. Measured, not assumed: loaded in a
// cross-site iframe at 400x900 the app boots with zero errors, every feature
// registers, and - the part that matters - the iframe gets its OWN viewport, so
// `@media (max-width: 860px)` fires and the narrow layout the app already has
// applies for free. Meanwhile (hover: none) does NOT match, so the 44px thumb
// floors stay off and the panel keeps desktop density. A web component would
// have inherited the host page's viewport, put the app in its desktop layout
// inside a 400px box, and inherited the host's CSS besides. The iframe is not a
// compromise here, it is the reason this works at all.
//
// WHY THE ORIGIN IS PINNED IN THE URL. An embedded app has to answer "who is
// allowed to talk to me". document.referrer is not dependable across navigations
// and referrer policies, and replying to '*' hands any page that frames us a
// channel it can post credentials into. So the host names itself in the iframe
// src (&host=https://dash.example.com), that value is checked against the
// allowlist in config.js, and every message in or out is bound to that exact
// origin. A host not on the list gets a plain refusal rather than a half-working
// panel.
import { EMBED_ORIGINS, EMBED_EXCHANGE_URL } from './config.js';
import { sb, markIntentionalSignOut, retryAllNow } from './sb.js';
import { bus, store } from './store.js';
import { debounce } from './util.js';

const PROTO = 'Dek';
const VERSION = 1;

// Filled by init(). Everything else in the file reads it and nothing else writes.
export const embed = {
  active: false,
  refused: false,      // asked to embed somewhere it is not allowed; do not boot
  host: null,          // the exact origin we will talk to, or null
  space: null,         // Space id or name the host pinned
  channel: null,       // channel to open once that Space is loaded
  chrome: 'minimal',   // 'minimal' hides the rail and the standalone-only chrome
  theme: null,         // host-forced theme, or null to let the person choose
  waitingForAuth: false,
};

// ------------------------------------------------------------------ allowlist
// A wildcard is allowed at the START of the hostname only: https://*.example.com
// matches a subdomain and nothing else. Deliberately no bare '*' and no path or
// port wildcards - "any origin may drive this panel" is not a configuration
// anybody should be able to reach by accident.
// Returns the NORMALISED origin when allowed, null when not. Normalised because
// every later comparison is `ev.origin !== embed.host` with ===, and ev.origin
// never carries a trailing slash while a hand-written query parameter easily
// does. Stored raw, one trailing slash meant every message from the host was
// discarded and the panel sat on its waiting screen for the full 15 seconds
// before falling back to a password prompt, with nothing anywhere saying why.
function allowedOrigin(value) {
  if (!value) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  const origin = u.origin;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !local) return null;

  const ok = (EMBED_ORIGINS || []).some((pat) => {
    if (typeof pat !== 'string') return false;
    // A wildcard is only meaningful as the whole first label. Matching '*.'
    // anywhere in the string meant `https://foo*.bar.com` parsed as something
    // else entirely, and String.replace only takes the first occurrence besides.
    const star = pat.indexOf('://*.');
    if (star === -1) return pat === origin;
    let p;
    try { p = new URL(pat.slice(0, star + 3) + pat.slice(star + 5)); } catch { return false; }
    // Subdomains, and not the apex. config.js promises exactly that, and an
    // allowlist that quietly means more than it says is not an allowlist.
    return u.protocol === p.protocol && u.port === p.port
      && u.hostname !== p.hostname && u.hostname.endsWith('.' + p.hostname);
  });
  return ok ? origin : null;
}

// ------------------------------------------------------------------ transport
function send(type, data) {
  if (!embed.active || !embed.host) return;
  try {
    window.parent.postMessage({ [PROTO]: type, v: VERSION, ...(data || {}) }, embed.host);
  } catch { /* the host went away; nothing useful to do about it */ }
}
export const notifyHost = send;

// ------------------------------------------------------------------ auth
// Reads the `sub` claim out of a JWT WITHOUT verifying it - only Supabase can
// verify a token, but base64-decoding the payload is enough to answer "who does
// this say it is", which is the only question the re-identify decision below
// needs answered. Returns null on anything malformed.
function subOf(jwt) {
  try {
    const p = JSON.parse(atob(String(jwt || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p?.sub || null;
  } catch { return null; }
}

// Two ways the host can hand over a person, and the difference matters.
//
// `session` is the blunt one: the host's BACKEND already minted a Supabase
// session and passes both tokens straight through. Fastest, and correct only if
// the host never lets that pair touch a place it could leak from.
//
// `handoff` is the one to prefer. The host's backend asks Dek's exchange
// endpoint for a single-use, short-lived token that names the person, and passes
// only that. This browser spends it. A stolen handoff token is worth one use
// inside its TTL; a stolen refresh token is worth the account.
async function applyAuth(msg) {
  try {
    // setSession already returns the user, so the id comes from its result -
    // sb.auth.getUser() here was a second network GET for a fact in hand. The
    // session fallback covers auth-js versions whose setSession fills only
    // data.session; worst case is userId: null, same as before.
    let uid = null;
    let token = null;
    if (msg.session?.access_token && msg.session?.refresh_token) {
      token = msg.session.access_token;
      const { data, error } = await sb.auth.setSession({
        access_token: msg.session.access_token,
        refresh_token: msg.session.refresh_token,
      });
      if (error) throw error;
      uid = data?.user?.id || data?.session?.user?.id || null;
    } else if (msg.handoff) {
      if (!EMBED_EXCHANGE_URL) throw new Error('no exchange endpoint configured');
      // text/plain is CORS-safelisted, so this POST skips its preflight -
      // application/json forced one OPTIONS per redeem. The function reads the
      // body with req.json(), which parses it regardless of the declared type.
      const r = await fetch(EMBED_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ token: msg.handoff, origin: embed.host }),
      });
      if (!r.ok) throw new Error('exchange refused: ' + r.status);
      const out = await r.json();
      if (!out?.access_token || !out?.refresh_token) throw new Error('exchange returned no session');
      token = out.access_token;
      const { data, error } = await sb.auth.setSession({
        access_token: out.access_token, refresh_token: out.refresh_token,
      });
      if (error) throw error;
      uid = data?.user?.id || data?.session?.user?.id || null;
    } else {
      throw new Error('auth message carried neither a session nor a handoff token');
    }
    embed.waitingForAuth = false;
    // uid comes from setSession's own result; the token claim is the fallback
    // for auth-js shapes that fill neither field. main.js's listener uses this
    // to tell a credential refresh (same person, ignore) from a re-identify
    // (different person, follow it with a clean reload).
    const claimed = uid || subOf(token);
    send('signed-in', { userId: uid });
    // main() parked on this rather than painting a sign-in card nobody in a
    // dashboard should ever be shown.
    bus.emit('embed:authed', { userId: claimed });
  } catch (e) {
    send('error', { where: 'auth', message: String(e?.message || e) });
    bus.emit('embed:authFailed', { message: String(e?.message || e) });
  }
}

// ------------------------------------------------------------------ inbound
// Does the app know this theme id? The question is put to theme.js itself and
// never answered from a copy of the list kept here. That copy is the bug this
// pass exists to remove: the set went from three ids to eight, and a hardcoded
// list silently refuses every id nobody remembered to add to it while looking,
// in the diff, exactly like it is still doing its job. Nothing in this file
// names a theme.
//
// Two independent ways to get the answer, neither trusting the other. First the
// module's own predicates: the look and the resolved mode are separate axes now
// and each exports the question for its own axis, which is authority rather than
// inference and cannot drift out of step with the table. Failing that, any array
// the module exports contributes its ids, which still covers a table exported
// without predicates, in either the record or the bare-string shape.
//
// Both axes count as valid input because setTheme() takes either and routes it:
// a host saying 'dark' means a mode, a host saying 'swiss' means a look, and the
// bridge has documented the first pair since before the looks existed.
//
// Returns true, false, or null for "cannot tell" - which is the honest answer
// when theme.js exports its table in a shape this cannot read, and is a bug on
// this side of the bridge rather than something to punish a host for.
function knowsTheme(mod, id) {
  // isLegacyThemeValue is asked last and on purpose: it is how a host that has
  // been sending a pre-rename id keeps working. theme.js owns the list of what
  // those are, so no theme id is ever written down in this file.
  const asks = [mod?.isLook, mod?.isMode, mod?.isLegacyThemeValue]
    .filter((f) => typeof f === 'function');
  if (asks.length) return asks.some((f) => { try { return !!f(id); } catch { return false; } });
  const ids = new Set();
  for (const val of Object.values(mod || {})) {
    if (!Array.isArray(val)) continue;
    for (const item of val) {
      if (typeof item === 'string') ids.add(item);
      else if (item && typeof item.id === 'string') ids.add(item.id);
    }
  }
  return ids.size ? ids.has(id) : null;
}

async function onMessage(ev) {
  if (!embed.active) return;
  // All three checks matter. The source check pins the conversation to our own
  // parent window: origin alone would accept any OTHER frame at an allowed
  // origin - a sibling iframe, a popup the dashboard spawned - and PLAN.md audit
  // #1. The host loader does the mirror check (embed.js root, ev.source !==
  // frame.contentWindow). The origin check is the security boundary; the shape
  // check stops us reacting to the unrelated postMessage traffic that analytics
  // and framework devtools spray at every frame on the page.
  if (ev.source !== window.parent) return;
  if (ev.origin !== embed.host) return;
  const msg = ev.data;
  if (!msg || typeof msg !== 'object' || typeof msg[PROTO] !== 'string') return;

  switch (msg[PROTO]) {
    case 'auth':
      await applyAuth(msg);
      break;

    case 'signout': {
      // The host drove a sign-out - its person switched accounts, or the
      // dashboard session ended. shell.js's own Sign out takes the local-first
      // caches WITH it (pagecache, readcache, attachment cache) because a
      // shared machine must not hand one person's conversations to the next;
      // this verb used to drop only the credentials, so the conversation stayed
      // painted under the auth-wait screen and every message body stayed in
      // IndexedDB indefinitely. The forced-kick path that closes this gap for
      // revoked tokens can never fire here, because the intentional latch below
      // is exactly what makes its handler stand down.
      embed.waitingForAuth = true;
      send('auth-needed', { reason: 'host-signout' });
      // allSettled, not all: every piece is independent best-effort cleanup,
      // and one rejected member must not let the reload strand the others
      // half-done.
      const wiped = Promise.allSettled([
        import('./lib/pagecache.js').then((m) => m.wipe()),
        import('./lib/readcache.js').then((m) => m.wipe()),
        // Same fixed name as shell.js and main.js delete; must match STORAGE
        // in sw.js.
        window.caches ? caches.delete('dek-storage-v1') : Promise.resolve(),
      ]);
      markIntentionalSignOut();
      await sb.auth.signOut().catch(() => {});
      await wiped;
      // Nobody signed in means nothing of theirs is on screen, and reloading
      // would only fight the host mid-handshake; the panel is already on (or
      // heading for) the auth-wait frame. With an identity, follow the shell
      // menu: clean reload, session() finds nobody at boot, auth-wait shows.
      if (!store.me) break;
      location.hash = '';
      location.reload();
      break;
    }

    case 'navigate':
      // Hash routing is the app's own, so the host does not need to know it: it
      // names a channel or a message and this turns that into the route.
      //
      // THERE IS NO FREE-TEXT ROUTE, and there must never be one. This branch
      // used to accept msg.route and write it straight to location.hash, and
      // main.js redeems `#/join/<token>` and `#/join-org/<token>` on a hash
      // change with no confirmation and no user gesture. So one host - a real
      // allowlisted one, with an XSS in it, which is the whole point of an
      // allowlist being a trust boundary rather than a guarantee - could enrol
      // the person into an organisation they have never heard of, silently. Only
      // ids the app resolves itself get through.
      //
      // The specific case is tested FIRST. Written the other way round, the
      // `msg.channel` branch swallowed every message that also carried
      // msg.message, so deep-linking to a message opened its channel at the
      // bottom instead and the second branch was unreachable.
      if (msg.channel && msg.message) {
        location.hash = `#/m/${encodeURIComponent(msg.channel)}/${encodeURIComponent(msg.message)}`;
      } else if (msg.channel) {
        location.hash = '#/c/' + encodeURIComponent(msg.channel);
      }
      break;

    case 'theme':
      // Host input, so it is checked like every other field on this bridge. It
      // used to go straight into setTheme(), which writes the value onto
      // <html data-theme> unexamined: a typo, or an id from a host integrated
      // back when there were three of them, lands an attribute value nothing in
      // the stylesheet matches. The panel then paints the fallback palette and
      // there is nothing on screen, in the console or on the wire to say why -
      // the host believes it set a theme and the person believes the app is
      // broken.
      //
      // Refusal is reported back rather than swallowed, because the host is the
      // only party that can fix a bad id, and it is the party that will never
      // find out otherwise.
      if (msg.theme) {
        import('./theme.js').then((m) => {
          const known = knowsTheme(m, msg.theme);
          if (known === false) {
            send('error', { where: 'theme', message: 'unknown theme: ' + String(msg.theme) });
            return;
          }
          // Refuse only on a real no. A "cannot tell" still applies the value,
          // because dropping every setTheme() a host makes would be a far worse
          // failure than passing an unchecked id to a setter that ignores what
          // it does not recognise - so warn where a developer will see it and
          // behave as this branch always did.
          if (known === null) console.warn('[Dek] no readable theme list in theme.js; applying', msg.theme, 'unchecked');
          m.setTheme(msg.theme);
        }).catch(() => { /* theme.js did not load; the person keeps their own theme */ });
      }
      break;

    case 'tokens':
      // Per-host overrides. Cosmetic for the colour tokens, load-bearing for the
      // ones EMBED.md documents as such: --kb, the keyboard inset an iframe
      // cannot measure for itself, and the --safe-* insets. Only custom
      // properties are accepted, so the worst a host can do is make its own
      // panel ugly.
      //
      // These land in documentElement.style, an inline declaration, which
      // outranks every [data-theme] and [data-scheme] rule in the cascade. A
      // token pushed here therefore wins, and goes on winning after the person
      // switches theme, since no stylesheet can outrank it. That is the intended
      // contract and not an oversight - a host asking for its own brand accent
      // means it in every theme - but it is also why a host that pushes a
      // hardcoded --c-bg or --c-text has quietly taken the light/dark switch
      // away from the person sitting in front of the panel. Push what you own.
      if (msg.tokens && typeof msg.tokens === 'object') {
        for (const [k, v] of Object.entries(msg.tokens)) {
          if (/^--[a-z0-9-]+$/i.test(k) && typeof v === 'string' && v.length < 120) {
            document.documentElement.style.setProperty(k, v);
          }
        }
      }
      break;

    case 'ping':
      send('pong', { at: Date.now() });
      break;

    case 'visible':
      // A CSS-collapsed panel can never heal itself: inside an iframe
      // document.visibilityState reflects the TOP-LEVEL browser tab, so the
      // host hiding and re-showing the panel fires nothing the app observes,
      // and sb.js measures roughly 35s where the socket still reports joined
      // while carrying no frames. The host knows - it did the hiding - so it
      // pushes this on show: forced socket rebuild, then an unread refresh so
      // the badge is right before the first frame paints.
      try { retryAllNow({ force: true }); } catch { /* socket never started */ }
      bus.emit('unread:reload');
      // Geometry-blind hiding (opacity:0, a host panel stacked on top) fires no
      // IntersectionObserver inside the frame - the host did it, so it says so,
      // and the message log's live region unmutes here.
      bus.emit('embed:visible');
      break;

    case 'hidden':
      // Was accepted for protocol symmetry only; now it mutes the message log's
      // live region (uxfix gate) so a collapsed panel stops reading arriving
      // messages aloud over the host app the person is actually working in.
      bus.emit('embed:hidden');
      break;

    default:
      break;
  }
}

// ------------------------------------------------------------------ outbound
// The things a host actually wants back: a badge number for its own launcher,
// the task count that justifies a second one, enough of a signal to know the
// panel is alive and who is in it, and the panel's width so a host with a
// resizable splitter can snap its layout to the app's breakpoints.
function wireReports() {
  const unread = () => {
    let total = 0;
    let mentions = 0;
    for (const b of store.spaceBadges?.values() || []) {
      total += b.unread_total || 0;
      mentions += b.mention_total || 0;
    }
    send('unread', { total, mentions });
  };
  const where = () => send('navigated', {
    space: store.ws?.id || null,
    spaceName: store.ws?.name || null,
    channel: store.current?.id || null,
    channelName: store.current?.name || null,
  });
  bus.on('spaces:badges', unread);
  bus.on('unread', unread);
  bus.on('workspace', where);
  bus.on('channel:open', where);
  // tasks.js publishes this on every refreshCount; overdue rides along when the
  // emitting side computed it. unassigned is deliberately absent - the mine-filtered
  // read behind the event cannot see other people's tasks without a second query.
  bus.on('tasks:count', (p) => send('tasks', { open: p?.open || 0, overdue: p?.overdue ?? null }));
}

// Panel width out. ResizeObserver fires per frame during a splitter drag, so
// posts are trailing-debounced: the host gets where the drag ENDED, which is the
// only width it can snap to anyway. Fires once on observe, so the initial size
// is reported shortly after boot with no extra code.
function wireSize() {
  const app = document.getElementById('app');
  if (!app || typeof ResizeObserver === 'undefined') return;
  let last = null;
  const post = debounce((w) => send('size', { inlineSize: w }), 150);
  new ResizeObserver((entries) => {
    const w = entries[0] ? Math.round(entries[0].contentRect.width) : null;
    if (typeof w === 'number' && w !== last) { last = w; post(w); }
  }).observe(app);
}

// ------------------------------------------------------------------ pinning
// "The dashboard is team-specific, so the server should be that team's."
//
// The host names a Space by id, or by name when it does not know the id - which
// is the ordinary case for a dashboard that was set up before anyone thought
// about which uuid it would get. Matching by name is deliberately forgiving,
// because "tech", "Tech" and "Tech Team" are all the same intent, and a panel
// that silently lands in the wrong room is worse than one that says it could not
// find the room.
export function pinnedSpaceOf(spaces) {
  if (!embed.space) return null;
  const want = String(embed.space).toLowerCase().trim();
  return spaces.find((s) => s.id === embed.space)
    || spaces.find((s) => (s.name || '').toLowerCase().trim() === want)
    || spaces.find((s) => (s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === want.replace(/[^a-z0-9]/g, ''))
    || null;
}

// ------------------------------------------------------------------ init
// Called before anything paints, so the body class is on the element for the
// first frame and the panel never flashes the standalone layout.
export function initEmbed() {
  const q = new URLSearchParams(location.search);

  // FRAMED, BUT NOT AS A SANCTIONED EMBED.
  //
  // Anybody can put the plain app URL in an iframe. A person who already has a
  // session then gets the entire signed-in app painted inside a page they have
  // never heard of, with every control live: that is clickjacking, and the
  // damage is whatever an invisible overlay can talk them into pressing - leave
  // a Space, delete a channel, approve a request.
  //
  // The real fix is a response header, `Content-Security-Policy:
  // frame-ancestors ...`, which stops the frame being drawn at all. GitHub Pages
  // cannot send headers, and frame-ancestors is IGNORED in a <meta> tag, so on
  // Pages there is no header answer at all. This is the script-level fallback:
  // refuse to render, and offer the one thing that is actually useful, which is
  // the same app in a tab of its own.
  //
  // It is a weaker defence than the header - a frame can be sandboxed to break
  // the escape link - but refusing to paint is not something sandboxing undoes,
  // and refusing is the part that matters. When the app moves somewhere that can
  // send headers, this stays: two independent checks, neither trusting the other.
  const framed = (() => {
    try { return window.top !== window.self; } catch { return true; }
  })();
  const sanctioned = q.get('embed') === '1' && !!allowedOrigin(q.get('host'));
  if (framed && !sanctioned) {
    embed.refused = true;
    const say = () => {
      document.documentElement.classList.add('embed-refused');
      // base.css already paints every <a> in var(--c-accent), so on the ordinary
      // path this changes nothing and only restates the house link colour. It is
      // written inline because this is a refusal path: it has to stay legible in
      // the run where the stylesheets did not arrive, and a bare <a> then falls
      // back to the browser's own blue, which follows no theme and lands around
      // 2:1 on a dark ground. The literal fallback carries that case for the same
      // reason it does on the fatal screen in main.js, and the token in front of
      // it keeps the link on the palette whenever the palette exists.
      document.body.innerHTML = '<div style="font:14px/1.6 system-ui;padding:24px;max-width:44ch">'
        + '<b>Dek will not run inside this page.</b><br>'
        + 'It is being shown in a frame on a site that is not set up to embed it. '
        + '<a style="color:var(--c-accent, #1b5fcc)" href="' + location.origin + location.pathname + '" target="_blank" rel="noopener">'
        + 'Open Dek in its own tab</a>.</div>';
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', say);
    else say();
    console.warn('[Dek] refusing to render: framed by a page that is not a configured embed');
    return embed;
  }

  if (q.get('embed') !== '1') return embed;

  const asked = q.get('host');
  const host = allowedOrigin(asked);
  if (!host) {
    // Loud on purpose, and terminal. A silent fallback to the standalone app
    // inside somebody's dashboard is how a misconfigured embed ships and nobody
    // notices for weeks - and a sign-in card served to a page we do not trust is
    // a password prompt in an attacker's frame.
    //
    // embed.refused stops main() rather than this file tearing the document down
    // underneath it. Replacing document.body here and letting the boot carry on
    // is what the first version did, and main() then died on the first
    // getElementById that no longer resolved: the screen said "Dek failed to
    // start: Cannot set properties of null", which tells the person nothing and
    // hides the actual cause.
    embed.refused = true;
    const say = () => {
      document.documentElement.classList.add('embed-refused');
      document.body.innerHTML = '<div style="font:14px/1.6 system-ui;padding:24px;max-width:44ch">'
        + '<b>Dek cannot be embedded here.</b><br>'
        + 'This page did not name a host origin that Dek recognises'
        + (asked ? ', and <code>' + String(asked).replace(/[<>&"]/g, '') + '</code> is not on the allowlist' : '')
        + '. Add it to EMBED_ORIGINS in js/config.js.</div>';
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', say);
    else say();
    console.warn('[Dek] embed refused: host origin not allowed:', asked);
    return embed;
  }

  embed.active = true;
  embed.host = host;
  embed.space = q.get('space') || null;
  embed.channel = q.get('channel') || null;
  embed.chrome = q.get('chrome') === 'full' ? 'full' : 'minimal';
  embed.theme = q.get('theme') || null;
  embed.waitingForAuth = true;

  document.documentElement.classList.add('embed');
  if (embed.chrome === 'minimal') document.documentElement.classList.add('embed-minimal');

  window.addEventListener('message', onMessage);
  wireReports();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireSize);
  else wireSize();

  // Told after the listener is up, so a host that replies instantly is heard.
  // Sent on DOMContentLoaded rather than load: the host wants to hand over
  // credentials as early as possible, and waiting for every image is dead time
  // the person spends looking at an empty panel.
  const ready = () => send('ready', {
    version: VERSION,
    space: embed.space,
    needsAuth: embed.waitingForAuth,
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  return embed;
}
