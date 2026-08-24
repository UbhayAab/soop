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
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUB = Deno.env.get('VAPID_PUBLIC_KEY');
const PRIV = Deno.env.get('VAPID_PRIVATE_KEY');
const SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:ops@example.com';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
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

  // Service role only. The anon/publishable key must be rejected here or any
  // signed-in user could spam any other user's phone.
  const auth = req.headers.get('Authorization') || '';
  if (!auth.includes(SERVICE_ROLE)) {
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
      if (status === 404 || status === 410) dead.push(s.endpoint);
    }
  }));

  // Prune dead endpoints so the table does not fill with ghosts.
  for (const endpoint of dead) {
    await admin.from('push_subscriptions').delete().eq('endpoint', endpoint);
  }

  return new Response(JSON.stringify({ sent, pruned: dead.length }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
