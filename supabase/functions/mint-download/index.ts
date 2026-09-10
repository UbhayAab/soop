// Signed download URLs for stored objects.
//
// Usage (single):   POST { object_key: "ws/<workspace>/<uuid>.jpg" }
// Usage (batch):    POST { object_keys: ["ws/...", "ws/..."] }
// Returns:          { urls: { [key]: string }, exp: number }
//
// THREE THINGS WERE WRONG AND EVERY IMAGE IN THE APP WAS BROKEN.
//
// 1. THE DEPLOYED FUNCTION DID NOT UNDERSTAND A BATCH. It answered
//    {"error":"missing_object_key"} to the plural shape - a string that does not
//    appear in this file, because the version running in production was built in
//    July and the batch-aware rewrite in the repo was never deployed. js/core/
//    media.js hydrateMedia() mints through mediaUrls(), which sends
//    {object_keys: [...]}, so EVERY inline image, video and voice note failed to
//    get a URL and painted the "Image unavailable" box. Only avatars worked,
//    because hydrateAvatars() goes through the singular mediaUrl().
//
// 2. THE REPO VERSION WOULD NOT HAVE FIXED IT EITHER. It read the batch with
//    `Object.keys(body.object_keys)` - and object_keys is an ARRAY, so that
//    returns the INDICES. It would have asked storage to sign objects called
//    "0" and "1".
//
// 3. AND IT HAD NO ACCESS CHECK AT ALL. It signed whatever it was handed with
//    the service role. The July build being replaced does check - it answers
//    'forbidden' - so shipping the repo version would have quietly turned "every
//    image is broken" into "any signed-in person can read any attachment in any
//    workspace". The check is restored below and is the reason this file is
//    longer than the one it replaces.
//
// The authorisation rule: an object key carries its workspace in its own path,
// `ws/<workspace-uuid>/<per-upload-uuidv7>.<ext>`. Verified against the live
// database - all 14 attachments and both avatars match that shape - so the
// question "may this person have this object" is exactly "is this person a
// member of that workspace", which is one indexed read per distinct workspace
// rather than one per key. A key that is not in that shape is refused rather
// than guessed at.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';

// WHICH KEY ACTUALLY BYPASSES RLS. This project has moved to the sb_secret_*
// format and the legacy SUPABASE_SERVICE_ROLE_KEY JWT no longer bypasses RLS -
// the same fault that made web-push read zero push subscriptions and report a
// cheerful success. A storage sign with an unprivileged key fails, so this is
// not optional here.
function pickSecretKey(): string {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS') || '';
  let candidates: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    candidates = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    candidates = raw.split(',');
  }
  return candidates.map((c) => c.trim()).find((c) => c.startsWith('sb_secret_')) || SERVICE_ROLE;
}
const ADMIN_KEY = pickSecretKey();

const admin = createClient(SUPABASE_URL, ADMIN_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  // media.js sends Authorization + apikey on both call sites; a preflight
  // answer that does not allow them fails the request outright, and a cached
  // failed preflight would stick for Max-Age seconds.
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

const TTL = 3600;
const MAX_KEYS = 60;                        // one screen of attachments, generously
const KEY_RE = /^ws\/([0-9a-f-]{36})\/[A-Za-z0-9._-]+$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    // Who is asking. The caller's own token, not the service role - this is the
    // whole basis of the check below.
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'unauthenticated' }, 401);
    const asCaller = createClient(SUPABASE_URL, ANON || ADMIN_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: who, error: whoErr } = await asCaller.auth.getUser();
    const uid = who?.user?.id;
    if (whoErr || !uid) return json({ error: 'unauthenticated' }, 401);

    const body = await req.json().catch(() => ({}));
    // An ARRAY is an array. Object.keys() on one returns "0","1",... which is
    // how the previous rewrite would have asked storage for an object called 0.
    let keys: string[] = [];
    if (Array.isArray(body.object_keys)) keys = body.object_keys;
    else if (body.object_keys && typeof body.object_keys === 'object') keys = Object.values(body.object_keys) as string[];
    else if (body.object_key) keys = [body.object_key];
    keys = [...new Set(keys.filter((k) => typeof k === 'string' && k))];

    if (!keys.length) return json({ error: 'no key provided' }, 400);
    if (keys.length > MAX_KEYS) return json({ error: 'too_many_keys' }, 400);

    // The workspace each key belongs to, straight out of the key. A key that
    // does not name one is refused: guessing would be the whole access check.
    const wsOf = new Map<string, string>();
    for (const k of keys) {
      const m = KEY_RE.exec(k);
      if (m) wsOf.set(k, m[1]);
    }
    const workspaces = [...new Set(wsOf.values())];
    if (!workspaces.length) return json({ urls: {}, exp: Date.now() + TTL * 1000 });

    // One read for every workspace in the batch, not one per key.
    const { data: mem, error: memErr } = await admin
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', uid)
      .in('workspace_id', workspaces);
    if (memErr) {
      console.error('[mint-download] membership read failed', memErr.message);
      return json({ error: 'failed' }, 500);
    }
    const allowed = new Set((mem || []).map((r) => r.workspace_id));

    const urls: Record<string, string> = {};
    let refused = 0;
    for (const k of keys) {
      const ws = wsOf.get(k);
      if (!ws || !allowed.has(ws)) { refused++; continue; }
      const { data, error } = await admin.storage.from('attachments')
        .createSignedUrl(k, TTL);
      // One missing object must not fail the other forty-nine: a deleted
      // attachment is a broken thumbnail, not a broken conversation.
      if (error || !data?.signedUrl) continue;
      urls[k] = data.signedUrl;
    }

    // The client caches by this expiry, so it has to be real rather than a
    // guess made on the other side of the wire.
    return json({ urls, exp: Date.now() + TTL * 1000, refused: refused || undefined });
  } catch (e) {
    console.error('[mint-download] unhandled', e);
    return json({ error: 'failed' }, 500);
  }
});
