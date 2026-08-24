// Credential passthrough: how somebody already signed into a dashboard ends up
// signed into the Soop panel on it, without typing anything.
//
// THREE PARTIES, AND THE SPLIT IS THE WHOLE DESIGN.
//
//   1. The dashboard's BACKEND holds a shared secret and knows who is signed in.
//      It calls POST /soop-handoff/mint with an HMAC-signed assertion and gets
//      back a ticket: single use, sixty seconds, bound to one origin.
//   2. The dashboard's PAGE receives only the ticket. It hands it to the iframe.
//   3. The BROWSER inside the iframe calls POST /soop-handoff/redeem and gets a
//      real Supabase session.
//
// The obvious shorter version - backend calls one endpoint, gets tokens, passes
// them down - also works and is supported by the client (`session:` instead of
// `handoff:`). It is worse: a refresh token that has been through a page's
// JavaScript is a refresh token that has been through whatever else is on that
// page. A stolen ticket is worth one use inside a minute; a stolen refresh token
// is worth the account until somebody notices.
//
// THINGS THAT WILL BITE, WRITTEN DOWN BECAUSE EACH ONE IS SILENT:
//
// - The tenant is read from the row whose secret verified the signature, NEVER
//   from the payload. Take it from the payload and one leaked secret mints users
//   in every other organisation too.
// - `role` is hard-coded. GoTrue's admin API does `if params.Role != "" { role =
//   params.Role }` and the JS client does not even type the field, so it is
//   reachable by anything that builds the REST call by hand - which is exactly
//   what this file does. Forwarding a host-supplied role of 'service_role' mints
//   a user whose every future JWT bypasses all RLS, permanently, and it does not
//   appear anywhere in the API keys page.
// - Signature comparison is constant-time. A fast `===` on an HMAC is a timing
//   oracle, and this endpoint is public and unauthenticated by definition.
// - Timestamps are checked both ways. Only checking "not too old" leaves a
//   clock-skewed host able to mint assertions valid for hours.
//
// Deploy:  supabase functions deploy soop-handoff --no-verify-jwt
//   --no-verify-jwt is REQUIRED and is not a weakening: the whole point is that
//   the caller does not have a Supabase JWT yet. The HMAC is the authentication.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const TICKET_TTL_SECONDS = 60;
const ASSERTION_MAX_AGE_SECONDS = 120;
const ASSERTION_MAX_SKEW_SECONDS = 60;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const enc = new TextEncoder();

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(s: string) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// Length-independent, value-independent comparison. Both strings are hex of a
// fixed-size digest so the length check leaks nothing.
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// CORS: the redeem call comes from the app's own origin inside the iframe, and
// the mint call comes from a server with no origin at all. Reflecting the
// requesting origin would be wrong here, so it is fixed to the app.
const APP_ORIGIN = Deno.env.get('SOOP_APP_ORIGIN') ?? '*';
const cors = {
  'Access-Control-Allow-Origin': APP_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });

// Errors to the caller are deliberately vague. Errors to the log are not: which
// of "unknown key", "bad signature" and "expired" it was, is exactly what an
// attacker probing this endpoint wants to know and exactly what the operator
// needs.
const fail = (logLine: string, status = 401) => {
  console.warn('[soop-handoff] ' + logLine);
  return json({ error: 'refused' }, status);
};

// ------------------------------------------------------------------- mint
// Called by the dashboard's BACKEND.
//
//   const body = JSON.stringify({ key, sub, email, name, ts: Date.now(), origin });
//   const sig  = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
//   fetch(URL + '/mint', { method:'POST', headers:{'content-type':'application/json'},
//                          body: JSON.stringify({ payload: body, signature: sig }) })
//
// `payload` is sent as the exact STRING that was signed, not as an object. Signing
// an object means signing whatever JSON.stringify produced on that machine, and
// key order is not guaranteed to survive a round trip through a different
// runtime. Signing the bytes and verifying the bytes removes the whole class.
async function mint(req: Request) {
  const body = await req.json().catch(() => null);
  const payloadStr: string = body?.payload;
  const signature: string = body?.signature;
  if (typeof payloadStr !== 'string' || typeof signature !== 'string') {
    return fail('mint: payload and signature must both be strings', 400);
  }

  let claim: Record<string, unknown>;
  try { claim = JSON.parse(payloadStr); } catch { return fail('mint: payload is not JSON', 400); }

  const key = String(claim.key ?? '');
  if (!key) return fail('mint: no key in payload', 400);

  const { data: host, error } = await admin
    .from('embed_hosts')
    .select('key, org_id, secret_sha256, allowed_origins, disabled_at')
    .eq('key', key)
    .maybeSingle();
  if (error) return fail('mint: registry read failed: ' + error.message, 500);
  if (!host || host.disabled_at) return fail(`mint: unknown or disabled key "${key}"`);

  // The secret itself is not stored, so it cannot be used to recompute the HMAC
  // here. What IS stored is its hash, so the caller proves knowledge by signing
  // with the secret and we verify with... the secret. Which means the function
  // needs it. It comes from an env var named after the key, so each dashboard's
  // secret is a separate secret in the platform rather than one file listing all
  // of them: EMBED_SECRET_TECH_DASHBOARD for key "tech-dashboard".
  const envName = 'EMBED_SECRET_' + key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const secret = Deno.env.get(envName);
  if (!secret) return fail(`mint: no ${envName} configured`, 500);
  if (!safeEqual(await sha256(secret), host.secret_sha256)) {
    return fail(`mint: ${envName} does not match the hash registered for "${key}"`, 500);
  }

  if (!safeEqual(await hmac(secret, payloadStr), signature.toLowerCase())) {
    return fail(`mint: bad signature for "${key}"`);
  }

  // Replay window, checked in BOTH directions.
  const ts = Number(claim.ts);
  if (!Number.isFinite(ts)) return fail('mint: no ts', 400);
  const ageSeconds = (Date.now() - ts) / 1000;
  if (ageSeconds > ASSERTION_MAX_AGE_SECONDS) return fail('mint: assertion too old');
  if (ageSeconds < -ASSERTION_MAX_SKEW_SECONDS) return fail('mint: assertion is from the future');

  const origin = String(claim.origin ?? '');
  const origins: string[] = host.allowed_origins ?? [];
  if (origins.length && !origins.includes(origin)) {
    return fail(`mint: origin "${origin}" not registered for "${key}"`);
  }

  // Who this is. `sub` is the dashboard's own stable id for the person and is
  // what identity is keyed on; email is carried for display only.
  const sub = String(claim.sub ?? '');
  const email = String(claim.email ?? '').toLowerCase();
  if (!sub) return fail('mint: no sub', 400);

  // The address the Soop account is keyed on. Namespacing by host key means one
  // dashboard cannot assert an identity that belongs to another, even if it
  // knows the email: host B claiming ceo@customer.com gets
  // ceo=customer.com@tech-dashboard.embed.soop.invalid, which is nobody. The
  // real address goes on the profile, where it is a label and not a credential.
  //
  // .invalid is reserved by RFC 2606 and can never be delivered to, which is the
  // point: nothing here should ever be able to receive a password reset.
  const localPart = (email || sub).replace(/[^a-zA-Z0-9._-]/g, '=');
  const shadowEmail = `${localPart}@${key}.embed.soop.invalid`;

  const userId = await findOrCreateUser(shadowEmail, {
    embed_key: key,
    embed_sub: sub,
    display_email: email || null,
    display_name: String(claim.name ?? '') || null,
  });
  if (!userId) return fail('mint: could not resolve a user', 500);

  // The server exists and this person is in it, before the browser asks for
  // anything. Idempotent and cheap on the common path.
  const { error: provErr } = await admin.rpc('ensure_embed_space', {
    p_key: key, p_user: userId,
  });
  if (provErr) return fail('mint: provisioning failed: ' + provErr.message, 500);

  const ticket = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const { error: tErr } = await admin.from('embed_tickets').insert({
    token_sha256: await sha256(ticket),
    host_key: key,
    user_id: userId,
    origin,
    expires_at: new Date(Date.now() + TICKET_TTL_SECONDS * 1000).toISOString(),
  });
  if (tErr) return fail('mint: could not store ticket: ' + tErr.message, 500);

  admin.rpc('embed_sweep_tickets').then(() => {}, () => {});
  return json({ handoff: ticket, expires_in: TICKET_TTL_SECONDS });
}

// Find by the shadow address, create if absent. Kept separate because the
// listUsers paging behaviour is the part most likely to need changing.
async function findOrCreateUser(email: string, meta: Record<string, unknown>) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: meta,
    // NOT taken from the caller. See the header comment.
    // role is intentionally omitted so GoTrue applies its default.
  });
  if (created?.user?.id) return created.user.id;

  // Already exists is the ordinary case after the first visit, and it is
  // reported as an error rather than as a lookup, so it has to be detected by
  // its message.
  if (error && !/already (been )?registered|already exists|duplicate/i.test(error.message)) {
    console.warn('[soop-handoff] createUser failed: ' + error.message);
    return null;
  }
  // Page through until the address turns up. Cheap in practice because the
  // dashboard population is small, and correct regardless of ordering.
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const hit = data?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (!data?.users?.length || data.users.length < 200) break;
  }
  return null;
}

// ------------------------------------------------------------------ redeem
// Called by the BROWSER inside the iframe, with the ticket the page was given.
async function redeem(req: Request) {
  const body = await req.json().catch(() => null);
  const token: string = body?.token;
  const origin: string = body?.origin ?? '';
  if (typeof token !== 'string' || token.length < 32) return fail('redeem: no ticket', 400);

  const hash = await sha256(token);

  // Claim it with a conditional UPDATE rather than select-then-update: two tabs
  // opening at once would both read an unused ticket and both spend it, and
  // "single use" that is only single-use when nobody is in a hurry is not a
  // property, it is a coincidence. `used_at is null` in the filter makes the
  // database the arbiter and RETURNING tells us whether we won.
  const { data: rows, error } = await admin
    .from('embed_tickets')
    .update({ used_at: new Date().toISOString() })
    .eq('token_sha256', hash)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('user_id, origin, host_key');
  if (error) return fail('redeem: ticket claim failed: ' + error.message, 500);
  const t = rows?.[0];
  if (!t) return fail('redeem: ticket unknown, already spent, or expired');

  if (t.origin && origin && t.origin !== origin) {
    return fail(`redeem: ticket was issued for ${t.origin}, presented from ${origin}`);
  }

  // Minting the session. generateLink does NOT send an email - it returns the
  // token that the email would have contained - and verifyOtp turns that into a
  // real session. This is the documented server-side path, and it is the only
  // one that produces a session with a refresh token the client can go on using.
  const { data: user } = await admin.auth.admin.getUserById(t.user_id);
  if (!user?.user?.email) return fail('redeem: user has no address', 500);

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: user.user.email,
  });
  if (linkErr || !link?.properties?.hashed_token) {
    return fail('redeem: generateLink failed: ' + (linkErr?.message ?? 'no hashed_token'), 500);
  }

  // A throwaway client, because verifyOtp on the shared admin client would leave
  // the service-role client holding a user session.
  const anon = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sess, error: vErr } = await anon.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'email',
  });
  if (vErr || !sess?.session) {
    return fail('redeem: verifyOtp failed: ' + (vErr?.message ?? 'no session'), 500);
  }

  return json({
    access_token: sess.session.access_token,
    refresh_token: sess.session.refresh_token,
    expires_in: sess.session.expires_in,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const path = new URL(req.url).pathname;
  try {
    if (path.endsWith('/mint')) return await mint(req);
    // The bare path is redeem, because that is the one a browser calls and the
    // client posts to EMBED_EXCHANGE_URL with no suffix.
    return await redeem(req);
  } catch (e) {
    console.error('[soop-handoff] unhandled', e);
    return json({ error: 'refused' }, 500);
  }
});
