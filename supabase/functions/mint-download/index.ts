// Batch-aware mint-download edge function.
// Usage (single):   POST { object_key: "abc123" }
// Usage (batch):    POST { object_keys: ["abc123", "def456"] }
//
// Returns: { urls: { [key: string]: string }, exp?: number }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
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

const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

async function getSignedUrls(keys) {
  const results: Record<string, string> = {};
  for (const key of keys) {
    const { data, error } = await admin
      .storage
      .from('attachments')
      .getSignedUrl(key, { expiresIn: 3600 });
    if (error) throw new Error(error.message);
    results[key] = data.signedUrl;
  }
  return { urls: results };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const body = await req.json().catch(() => ({}));
    let keys: string[];
    if (body.object_keys) {
      keys = Object.keys(body.object_keys).filter(Boolean);
    } else if (body.object_key) {
      keys = [body.object_key].filter(Boolean);
    } else {
      return json({ error: 'no key provided' }, 400);
    }

    if (keys.length === 0) return json({ error: 'no keys provided' }, 400);

    let result;
    if (body.object_keys) {
      result = await getSignedUrls(keys);
    } else {
      const { urls } = await getSignedUrls(keys);
      result = { urls };
    }

    return json(result);
  } catch (e) {
    console.error('[mint-download] unhandled', e);
    return json({ error: 'failed' }, 500);
  }
});