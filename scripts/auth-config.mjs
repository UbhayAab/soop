// Server-side signup toggle for self-onboarding.
//
// Usage:
//   node scripts/auth-config.mjs --open-signup
//   node scripts/auth-config.mjs --closed-signup
//
// Two layers must agree or one of them lies:
//   1. GoTrue server config (disable_signup, external_anonymous_users_enabled)
//   2. The client flags in js/config.js (CODE_SIGNIN / GUEST_SIGNIN)
// This script handles layer 1. Layer 1 has NO stable public REST surface:
// GoTrue's own admin API does not expose these fields, so the supported paths
// are the Supabase Management API (needs a personal access token) or the
// dashboard. Both are wired here; without credentials the script prints the
// exact manual steps instead of pretending.
//
// Env needed for the automatic path:
//   SUPABASE_ACCESS_TOKEN  personal token: supabase.com/dashboard/account/tokens
//   SUPABASE_PROJECT_REF   the abcdefgh.supabase.co part

const argv = process.argv.slice(2);
const open = argv.includes('--open-signup');
const closed = argv.includes('--closed-signup');

if (!open && !closed) {
  console.error('Pass --open-signup or --closed-signup');
  process.exit(1);
}
if (open && closed) {
  console.error('Pass only one of --open-signup / --closed-signup');
  process.exit(1);
}

const disableSignup = !open;              // open => allow signups
const anonUsers = !open ? 'false' : null; // anonymous stays off in BOTH modes by design

const ref = process.env.SUPABASE_PROJECT_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;

if (!ref || !token) {
  console.log(`
No SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN in env - doing this by hand:

  1. Dashboard -> Project Settings -> Authentication
  2. Turn "Allow new users to sign up" ${open ? 'ON' : 'OFF'}
  3. Leave "Anonymous sign-ins" OFF either way
  4. Save. Then check js/config.js CODE_SIGNIN = ${open}.

Set both env vars to let this script do it via the Management API next time.`);
  process.exit(0);
}

const url = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const body = { disable_signup: disableSignup };
if (anonUsers) body.external_anonymous_users_enabled = anonUsers;

try {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`Management API said ${r.status}: ${text.slice(0, 400)}`);
    console.error('Falling back to the manual steps printed above this line.');
    process.exit(2);
  }
  console.log(`OK: disable_signup=${disableSignup}${anonUsers ? `, external_anonymous_users_enabled=${anonUsers}` : ''}`);
  console.log(`Now set js/config.js CODE_SIGNIN = ${open}.`);
} catch (e) {
  console.error('Network failure talking to api.supabase.com:', e.message);
  process.exit(3);
}
