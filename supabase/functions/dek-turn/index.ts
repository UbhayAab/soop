// TURN credentials for voice rooms, minted per request.
//
// The mesh in js/core/voice.js works on permissive networks and dies silently
// behind carrier-grade NAT and corporate firewalls - which is most Indian
// mobile data. A TURN relay fixes that; Cloudflare Realtime includes 1,000 GB
// of relay traffic a month on the free tier, more than this product's whole
// audience will use for audio.
//
// Cloudflare's model: the account holds one long-lived TURN token secret. A
// short-lived credential is HMAC-SHA1(secret, username) where the username
// encodes an expiry timestamp. Browsers accept it as a standard iceServers
// entry. The secret therefore lives HERE, in the function's environment, and
// never reaches a browser.
//
// Authentication: any signed-in Soop user. The Authorization header carries a
// Supabase access token (the client already sends the publishable key); we
// verify it against GoTrue before handing out relay credentials, so this is not
// a free relay for the open internet.
//
// Deploy:
//   supabase functions deploy dek-turn
//   supabase secrets set TURN_TOKEN_ID=<id> TURN_TOKEN_SECRET=<secret>
// Until both are set the function answers 503 and the client stays STUN-only,
// which is the historical behaviour rather than a new failure.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const TURN_TOKEN_ID = Deno.env.get('TURN_TOKEN_ID');
const TURN_TOKEN_SECRET = Deno.env.get('TURN_TOKEN_SECRET');

const TTL_SECONDS = 3600 * 6;

const enc = new TextEncoder();

function b64(buf: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function hmacSha1(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

async function verifyUser(authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        Authorization: authHeader,
        apikey: ANON_KEY,
      },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (!TURN_TOKEN_ID || !TURN_TOKEN_SECRET) {
    return new Response(JSON.stringify({ error: 'turn_not_configured' }), {
      status: 503,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // A real Supabase session is required. The publishable key alone must NOT
  // count: it ships in every bundle, so accepting it turns this into an open
  // relay for anyone who can read JavaScript.
  const auth = req.headers.get('Authorization');
  const ok = !!(await verifyUser(auth));
  if (!ok) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const nonce = crypto.randomUUID().slice(0, 8);
  const username = `${expiry}:${nonce}`;
  const credential = await hmacSha1(TURN_TOKEN_SECRET, username);

  return new Response(JSON.stringify({
    iceServers: [
      {
        urls: [
          'turn:standard.turn.cloudflare.com:3470?transport=udp',
          'turn:standard.turn.cloudflare.com:3478?transport=udp',
          'turn:standard.turn.cloudflare.com:3478?transport=tcp',
          'turns:standard.turn.cloudflare.com:5349?transport=tcp',
        ],
        username,
        credential,
      },
    ],
    ttl: TTL_SECONDS,
  }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
