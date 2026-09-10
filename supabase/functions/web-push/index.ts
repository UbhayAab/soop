// Web Push sender. The last missing half of notifications: the client
// subscribes, stores subscriptions, shows incoming pushes (sw.js) - but
// NOTHING ever sent a push. A mention buzzed only if the tab was open, which
// is the opposite of what a notification is.
//
// Who calls this: a scheduled job or DB hook via pg_net, authenticated with the
// service-role key. It is NOT callable by browsers (that check is explicit
// below) because a user must never be able to push arbitrary payloads to other
// users.
//
// Body: { user_ids: ["uuid", ...], title, body, url, tag? }
// Sends to every stored subscription of those users; prunes subscriptions that
// answer 404/410 (uninstalled app, expired endpoint) instead of retrying them
// forever.
//
// Secrets (supabase secrets set):
//   VAPID_PUBLIC_KEY  BEsEiFEZ... (also lives in index.html meta tag)
//   VAPID_PRIVATE_KEY pg_jfvGI...
//   VAPID_SUBJECT     mailto:you@yourdomain.com
//   PUSH_DRAIN_SECRET the shared secret app.drain_notifications sends
//
// WHY THERE ARE TWO ACCEPTED CREDENTIALS. The scheduled drain in Postgres has to
// authenticate to this function, and the only credential it had was whatever
// somebody could put in a SQL function body. It was sending the PUBLISHABLE key,
// which this function correctly refused - 403, every fifteen seconds, since the
// day it was deployed: 1438 refusals in the six hours before this was found, and
// a queue of notifications that had never once been delivered. The fix is not to
// put the service-role key in SQL; that is a full-access credential and it would
// then live in a function body and in Vault for the sake of triggering a push.
// PUSH_DRAIN_SECRET can do exactly one thing - ask this function to send the
// payload it was given - and the drain reads it out of Vault.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUB = Deno.env.get('VAPID_PUBLIC_KEY');
const PRIV = Deno.env.get('VAPID_PRIVATE_KEY');
const SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:ops@example.com';
const DRAIN_SECRET = Deno.env.get('PUSH_DRAIN_SECRET') || '';

// Constant-time compare of two same-length ASCII strings.
function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// WHICH KEY ACTUALLY BYPASSES RLS.
//
// push_subscriptions has RLS with `user_id = auth.uid()`, so a client that is
// not really privileged reads ZERO rows and this function answers a cheerful
// {"sent":0} having sent nothing. That is what it did: the project has moved to
// the sb_secret_* key format, and the legacy SUPABASE_SERVICE_ROLE_KEY JWT this
// was built with no longer bypasses RLS. Measured directly against PostgREST:
// the sb_secret_ key returns the row, and this function returned sent:0 for the
// same user in the same second.
//
// SUPABASE_SECRET_KEYS is injected by the platform and may be a JSON array, a
// comma-separated list, or one value. Take the first sb_secret_ in it and fall
// back to the legacy key, so a project that has NOT migrated still works.
function pickSecretKey(): string {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS') || '';
  let candidates: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    candidates = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    candidates = raw.split(',');
  }
  const found = candidates.map((c) => c.trim()).find((c) => c.startsWith('sb_secret_'));
  return found || SERVICE_ROLE;
}
const ADMIN_KEY = pickSecretKey();

const admin = createClient(SUPABASE_URL, ADMIN_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (!PUB || !PRIV) {
    return new Response(JSON.stringify({ error: 'vapid_not_configured' }), {
      status: 503, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Service role, or the drain secret. The anon/publishable key must be rejected
  // here or any signed-in user could spam any other user's phone.
  //
  // timingSafeEqual on the drain key rather than ===: it is a fixed secret
  // compared on every call, which is the shape a timing oracle likes.
  const auth = req.headers.get('Authorization') || '';
  const drainKey = req.headers.get('x-drain-key') || '';
  const okDrain = !!DRAIN_SECRET && drainKey.length === DRAIN_SECRET.length
    && crypto.subtle && timingSafeEqualStr(drainKey, DRAIN_SECRET);
  if (!auth.includes(SERVICE_ROLE) && !okDrain) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  let body: { user_ids?: string[]; title?: string; body?: string; url?: string; tag?: string };
  try { body = await req.json(); } catch { body = {}; }
  const ids = (body.user_ids || []).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (!ids.length || !body.title) {
    return new Response(JSON.stringify({ error: 'need user_ids and title' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  webpush.setVapidDetails(SUBJECT, PUB, PRIV);

  // Read in batches of 500; the free tier's default row cap is 1000 and this
  // table grows one row per device per user.
  const { data: subs, error } = await admin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, user_id')
    .in('user_id', ids)
    .limit(1000);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const payload = JSON.stringify({
    title: body.title,
    body: body.body || '',
    url: body.url || './',
    tag: body.tag,
  });

  let sent = 0;
  const dead: string[] = [];
  // Every failure that is not a dead endpoint was swallowed here, so a push
  // service refusing the VAPID details for every subscription looked exactly
  // like "nobody has notifications on": {"sent":0}, no error, nothing in a log.
  // Collected and returned, because this endpoint is reachable only by the
  // drain secret or the service role - the people fixing it.
  const errors: { status: number; body: string }[] = [];
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 3600 },
      );
      sent++;
    } catch (e) {
      const status = e?.statusCode || 0;
      const why = String(e?.body || '');
      // 404/410: the endpoint is gone. VapidPkHashMismatch: this subscription
      // was minted against a different application server key and can never be
      // signed for again - it is just as dead, and keeping it means retrying it
      // forever. Pruning lets the client notice it has no subscription and make
      // a valid one.
      if (status === 404 || status === 410 || /VapidPkHashMismatch/i.test(why)) {
        dead.push(s.endpoint);
      }
      else if (errors.length < 3) {
        errors.push({ status, body: String(e?.body || e?.message || e).slice(0, 300) });
      }
    }
  }));

  // Prune dead endpoints so the table does not fill with ghosts.
  for (const endpoint of dead) {
    await admin.from('push_subscriptions').delete().eq('endpoint', endpoint);
  }

  // `found` separates "nobody has turned notifications on" from "this function
  // cannot read the table" - the two produce the same sent:0 and have
  // completely different fixes, which cost this deployment a while to work out.
  return new Response(JSON.stringify({
    sent, pruned: dead.length, found: (subs || []).length,
    key: ADMIN_KEY.startsWith('sb_secret_') ? 'secret' : 'legacy',
    subject: SUBJECT,
    errors: errors.length ? errors : undefined,
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
});
