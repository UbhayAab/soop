// Dek service worker.
//
// Rules that matter:
//  - Never cache Supabase (auth, realtime, RPC). A stale message list or
//    a stale token is worse than no app at all. Storage BODIES are the one
//    exception - see the storage branch in the fetch handler below.
//  - Never auto-activate a new bundle mid-conversation: the page asks first, then
//    posts SKIP_WAITING.
//  - The esm.sh dependencies are cached so the app opens offline instead of
//    hanging on a module import.
// Bumped for the delivery, scroll and layout fixes; most recently so the
// feature modules join the precache (below). The module URLs carry no
// version of their own, so this string is the only cache-bust lever the app has:
// activate() deletes every cache key that does not start with VERSION, which is
// what drops the precached v7 copies of these files. Code is network-first
// (below), but the precached copy is still what wins the 3.5s race on a slow
// phone, so without this bump the 41 installed clients would keep serving the old
// bundle whenever the network was slow - which is the shape of 03f8074.
// v39: DM reactions read and write their own table, the DMs panel starts a
// conversation from a search at the top of it, an Owner/Admin/Moderator badge
// beside every name, direct calls.
const VERSION = 'dek-v49';
const SHELL = VERSION + '-shell';
const VENDOR = VERSION + '-vendor';

// Attachment bodies. Fixed name on purpose: it has to survive VERSION bumps
// (activate() deletes every cache that is not current) and the sign-out wipes
// in js/shell.js, js/core/auth.js and js/main.js delete this exact string -
// keep those call sites in sync with it. The LRU bookkeeping lives in the
// same cache as one tiny JSON entry keyed dek-storage-lru, so eviction state
// survives worker restarts.
const STORAGE = 'dek-storage-v1';
const STORAGE_LIMIT = 150 * 1024 * 1024;   // ~150 MB or a 64 GB phone fills up
const STORAGE_MAX_ENTRIES = 500;           // belt for bodies without content-length

const SHELL_FILES = [
  './',
  './index.html',
  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/layout.css',
  './css/messages.css',
  './css/panels.css',
  './css/features.css',
  './css/reading.css',
  './css/shell.css',
  // Injected by features/uxfix.js rather than linked from index.html, so it is
  // not discoverable by crawling the document - but it carries the touch-target
  // floor, the long-press menu layout and the contrast corrections. Without it
  // in the shell an offline cold start renders those wrong.
  './css/polish.css',
  // Embedded mode subtracts chrome the other stylesheets add, and it also locks
  // the document scroll. Missing offline it is not fatal, but the panel scrolls
  // its own header away, which looks exactly like the app being broken.
  './css/embed.css',
  // The reskin layer loads last and re-skins everything above it; linked from
  // index.html but easy to overlook because nothing imports it. Missing offline
  // the app falls back to the pre-reskin look, which is a silent half-break.
  './css/reskin.css',
  './js/shell.js',
  './js/theme.js',
  './js/icons.js',
  './manifest.webmanifest',
  './js/main.js',
  // NOT optional. main.js imports this statically, so if the module is missing
  // the whole graph fails to evaluate and an offline cold start is a blank page
  // - for the STANDALONE app, which never uses embedded mode at all. A feature
  // module failing offline is a degraded app because features/index.js catches
  // it; a static import failing is a dead one.
  './js/embed.js',
  './js/config.js',
  './js/util.js',
  './js/sb.js',
  './js/store.js',
  './js/api.js',
  './js/ui.js',
  './js/pwa.js',
  './js/features/index.js',
  // The outbox has to be reachable with no network - it is the module that
  // replays what the person wrote while they had none.
  './js/features/offline.js',
  // uxfix owns the long-press menu repair, the failed-load card, the members and
  // search panels and the keyboard wiring. Offline it is the difference between
  // a phone that says "could not load, try again" and one that shows a raw
  // exception where the conversation was, so it belongs in the shell too.
  './js/features/uxfix.js',
  // Every registered feature module. features/index.js imports these dynamically
  // and swallows fetch failures by design, so a feature missing from this cache
  // does not break anything online - but offline it silently vanishes: no DM
  // list, no tasks, no tab bar. KEEP IN SYNC with FEATURES in
  // js/features/index.js; a stale entry here costs nothing (install skips 404s),
  // a missing one costs the feature on every offline cold start.
  ...['dmlist', 'activity', 'polls', 'events', 'canvases', 'topics', 'forum', 'later',
    'status', 'profile', 'profilepage', 'admin', 'orgadmin', 'orgshare', 'moderation',
    'integrations', 'messageExtras', 'onboarding', 'roles', 'snippets',
    'bookmarks', 'notifications', 'shortcuts', 'ackloop', 'forms', 'tasks',
    'quicktask', 'taskprogress', 'orientation', 'activityReport', 'coordnav',
    'voicerooms', 'adminnav', 'screenshare', 'errorreport', 'voicenotes',
    'calls',
  ].map((n) => `./js/features/${n}.js`),
  // tabbar.js is a dynamic import in main.js with a silent catch; uncached it
  // means an installed phone opens with no navigation at all.
  './js/tabbar.js',
  './js/lib/outbox.js',
  './js/lib/readcache.js',
  // Static dependencies of tasks/quicktask/taskprogress above - if the feature
  // file is cached but its import is not, the dynamic import still throws and
  // the feature still vanishes.
  './js/lib/asks.js',
  './js/lib/forecast.js',
  // The QR encoder orgshare.js statically imports. It has to be in the shell:
  // the whole reason it is hand-rolled rather than fetched is that the room
  // where somebody holds a phone up to be scanned is a warehouse floor with no
  // signal, and an uncached module there is a blank square.
  './js/lib/qr.js',
  // Same shape: adminnav.js statically imports this support module.
  './js/features/people.js',
  // The last page of each channel is painted from here BEFORE the network is
  // touched, so it has to be in the shell or an offline cold start has nothing
  // to draw.
  './js/lib/pagecache.js',
  './js/core/auth.js',
  './js/core/workspace.js',
  './js/core/channels.js',
  './js/core/messages.js',
  './js/core/threads.js',
  './js/core/composer.js',
  './js/core/media.js',
  './js/core/emoji.js',
  './js/core/dms.js',
  './js/core/voice.js',
  // Direct calls, and the peer-connection layer both they and the rooms sit on.
  // call.js is a static import of features/calls.js and voice.js imports rtc.js,
  // so either one missing offline is a module graph that fails to evaluate.
  './js/core/rtc.js',
  './js/core/call.js',
  './js/core/presence.js',
  './js/core/actions.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // Do not sit in "waiting" behind the previous worker. Combined with
  // clients.claim() below, a deploy takes effect on the next load instead of the
  // load after that.
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // addAll fails the whole install if any single file 404s; add individually.
    await Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => {})));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION) && k !== STORAGE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

const isSupabase = (url) =>
  url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.in');
const isVendor = (url) =>
  url.hostname === 'esm.sh' || url.hostname.endsWith('.esm.sh') || url.hostname === 'cdn.jsdelivr.net';

function lruKey() {
  return new URL('dek-storage-lru', self.registration.scope).href;
}

async function readLru(cache) {
  try {
    const m = await cache.match(lruKey());
    if (m) return await m.json();
  } catch { /* missing or torn bookkeeping starts a fresh list */ }
  return [];
}

// How long a stored object is trusted without asking the server. These paths
// carry a per-upload uuid so their bytes do not change; this is the belt, not
// the braces, and it costs one 304 rather than one body.
const REVALIDATE_AFTER = 7 * 24 * 60 * 60 * 1000;

// Response headers are immutable, so re-dating a cached copy means rebuilding
// it. Cheap, and it is the only way to know how old a cache entry is: the Cache
// API stores no metadata of its own and Supabase storage sends no Cache-Control
// at all (confirmed against a real signed object - only ETag and Last-Modified).
function stamp(res) {
  const h = new Headers(res.headers);
  h.set('x-dek-cached-at', String(Date.now()));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function lruPut(cache, key, res) {
  try {
    await cache.put(new Request(key), res);
    const size = Number(res.headers.get('content-length')) || 0;
    const list = (await readLru(cache)).filter((x) => x.k !== key);
    list.push({ k: key, s: size });
    let total = list.reduce((a, x) => a + x.s, 0);
    while (list.length > 1 && (total > STORAGE_LIMIT || list.length > STORAGE_MAX_ENTRIES)) {
      const old = list.shift();
      total -= old.s;
      await cache.delete(old.k);
    }
    await cache.put(new Request(lruKey()), new Response(JSON.stringify(list)));
  } catch { /* eviction must never break the response it decorates */ }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Attachments and avatars: the ONE Supabase exception, and the most expensive
  // thing on this deployment.
  //
  // Signed URLs rotate their query string on every mint, so caching by full URL
  // is useless - every viewer and every re-view gets a different key. Key by
  // origin+path with the search stripped and you own the key.
  //
  // THE BUG THIS FIXES. An <img src> to another origin is a no-cors request, so
  // a signed storage URL always came back OPAQUE: status 0, ok false, type
  // 'opaque'. An opaque body has no readable length, so lruPut skipped it - and
  // the comment here said so, accurately, for months. The consequence was never
  // written down: this 150MB cache held NOTHING that an <img> had ever asked
  // for, so every avatar and every photo was downloaded again on every cold
  // start, forever. Measured before the fix with scripts/probe-mediareuse.mjs:
  // second load, fresh token, same worker - 2 network hits and an empty cache.
  //
  // The fix is to stop accepting an opaque response. The service worker asks for
  // the same bytes with an explicit CORS request, which Supabase storage allows
  // (`Access-Control-Allow-Origin: *`, confirmed against a real signed object),
  // and a readable response can be handed straight back to a no-cors <img> - the
  // browser is happy to paint bytes the worker was allowed to read.
  //
  // CACHE FIRST, not stale-while-revalidate. SWR would still spend the download
  // every time, just off the critical path, and egress on the free plan is the
  // thing being paid for here. These objects are immutable in practice: the path
  // carries a per-upload uuid (`ws/<workspace>/<uuid>.jpg`), so new bytes always
  // arrive at a new path and changing an avatar writes a new key. A hit is
  // therefore served without touching the network at all. REVALIDATE_AFTER is
  // the belt: past it, one conditional request with If-None-Match, which costs a
  // 304 and about two hundred bytes rather than the whole body.
  if (isSupabase(url) && url.pathname.includes('/storage/v1/object/')) {
    e.respondWith((async () => {
      const key = url.origin + url.pathname;
      const cache = await caches.open(STORAGE);
      const hit = await cache.match(key);

      const fetchAndStore = async (extraHeaders) => {
        try {
          // mode:'cors' is the whole fix. credentials:'omit' because the token
          // is in the query string and a cookie would only invite a Vary.
          const res = await fetch(url.href, {
            mode: 'cors',
            credentials: 'omit',
            headers: extraHeaders || undefined,
          });
          if (res.status === 304 && hit) {
            // Unchanged. Re-date the cached copy so the next revalidation is
            // another REVALIDATE_AFTER away rather than every single load.
            await lruPut(cache, key, stamp(hit.clone()));
            return hit;
          }
          if (res.ok) {
            await lruPut(cache, key, stamp(res.clone()));
            return res;
          }
          return null;
        } catch {
          return null;
        }
      };

      if (hit) {
        const at = Number(hit.headers.get('x-dek-cached-at')) || 0;
        if (Date.now() - at < REVALIDATE_AFTER) return hit;
        // Old enough to be worth one conditional request. Serve the cached copy
        // now either way; correcting a freak overwrite can happen in the
        // background and does not need to hold up a photo.
        const etag = hit.headers.get('etag');
        e.waitUntil(fetchAndStore(etag ? { 'If-None-Match': etag } : null));
        return hit;
      }

      const fresh = await fetchAndStore(null);
      if (fresh) return fresh;
      // The CORS fetch failed - a host that does not allow it, or offline. Fall
      // back to the request as the browser made it. That still paints (an
      // opaque response is fine for an <img>) and still cannot be stored, which
      // is the old behaviour and the right floor rather than a broken image.
      try { return await fetch(req); } catch { return Response.error(); }
    })());
    return;
  }

  // Live data always goes to the network. No exceptions.
  if (isSupabase(url)) return;

  // Navigations: network first so a deploy is picked up, cache as the fallback.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Vendored ES modules: cache first, they are versioned by URL.
  if (isVendor(url)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(VENDOR)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // Own assets.
  //
  // This used to be stale-while-revalidate, which serves the CACHED copy and
  // only refreshes it in the background. That meant every deploy took two loads
  // to reach anyone: the first showed yesterday's code, the second showed
  // today's. From the outside that is indistinguishable from the app being
  // broken and then "fixed by refreshing", and it is exactly what people
  // reported. Code and styles are small and this app is useless offline anyway,
  // so correctness beats the few milliseconds: go to the network first and fall
  // back to the cache only when there is no network.
  if (url.origin === self.location.origin) {
    const isCode = /\.(js|mjs|css|webmanifest)$/i.test(url.pathname);

    if (isCode) {
      e.respondWith((async () => {
        const cache = await caches.open(SHELL);
        try {
          // A short timeout keeps a dead-slow connection from hanging the app on
          // its own cached assets; whichever answers first wins.
          const net = await Promise.race([
            fetch(req, { cache: 'no-cache' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500)),
          ]);
          if (net && net.ok) { cache.put(req, net.clone()); return net; }
          throw new Error('bad response');
        } catch {
          return (await cache.match(req)) || fetch(req).catch(() => Response.error());
        }
      })());
      return;
    }

    // Images, fonts and icons are content-addressed enough to serve from cache.
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});

// Web Push: the payload is minted by the web-push edge function.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data?.json() || {}; } catch { d = { body: e.data?.text() || '' }; }
  const title = d.title || 'Dek';
  // Collapse per conversation when the sender did not choose a tag, so five
  // messages in one channel replace one another instead of stacking five deep.
  const conv = (d.url || '').match(/#\/m\/([^/]+)/);
  const tag = d.tag || (conv ? 'dek-msg-' + conv[1] : 'dek');
  const show = self.registration.showNotification(title, {
    body: d.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag,
    data: d,
    renotify: true,
  });
  // The badging dot. An exact count is unknowable here without trusting the
  // payload; one is enough to say "something is waiting" on the launcher icon.
  const badge = (typeof self.navigator.setAppBadge === 'function')
    ? self.navigator.setAppBadge(1).catch(() => {})
    : Promise.resolve();
  e.waitUntil(Promise.all([show, badge]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (typeof self.navigator.clearAppBadge === 'function') {
    self.navigator.clearAppBadge().catch(() => {});
  }
  const target = e.notification.data?.url || './';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.location.origin)) { await c.focus(); c.navigate?.(target); return; }
    }
    await self.clients.openWindow(target);
  })());
});
