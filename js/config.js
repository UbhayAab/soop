// Build-time config. Only client-safe values live here: the project URL and the
// publishable (anon) key. The secret key never reaches the browser.
export const SUPABASE_URL = 'https://ybddogqphinruyunnuwx.supabase.co';
export const PUBLISHABLE = 'sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD';

// The open-demo Space token used to be exported from here. It was a LIVE
// invite credential for a real Space with 1770 members, served to every visitor
// in a file with no auth on it, and nothing in the client ever imported it - the
// behaviour it once enabled was removed in "No more blank screen: an account
// with no team gets a real screen with a join box instead of being dumped into
// the 1770-member demo Space".
//
// Deleting the export is only half of it. The value is in git history and in
// every cached copy of this file that was ever served, so the token itself has
// to be revoked server-side. Rotating it would not help for the same reason.

// Self sign-up: the two ways somebody could get an account without an operator.
// Both are off. An account is provisioned, handed over with a password, and the
// first sign-in forces the person to replace it - there is nothing for a code to
// verify and nothing a guest session is for.
//
// CODE_SIGNIN also controls account CREATION, not just the button: requesting a
// code ran signInWithOtp with shouldCreateUser, so asking for one conjured a
// real account with no password and no Space.
//
// Turning either back on is only half the job. The server enforces both as well
// (disable_signup and external_anonymous_users_enabled), so reopen it with
// `node scripts/auth-config.mjs --open-signup` or the button will be visible and
// still fail.
export const CODE_SIGNIN = false;
export const GUEST_SIGNIN = false;

// ------------------------------------------------------------------ embedding
// Dashboards allowed to run Soop as a panel inside themselves. An embed names
// its own origin in the iframe src and js/embed.js refuses to start unless that
// value appears here, so this list is the whole answer to "who may drive this
// panel and receive its messages".
//
// A leading '*.' matches subdomains of that host on the same scheme and port,
// and nothing else. There is deliberately no bare '*': "any page may embed us"
// is not a state anybody should be able to reach by editing one character.
//
// This is an allowlist, not a secret, which is why it can live in the client.
// It is also only half the defence. A browser will still LOAD the app in a frame
// on any page; what this stops is Soop talking to it or accepting credentials
// from it. Serving `Content-Security-Policy: frame-ancestors <the same list>`
// from wherever this is hosted is what stops the frame being drawn at all, and
// it is the one that also stops clickjacking. GitHub Pages cannot set headers,
// so on Pages this list is the only enforcement there is.
export const EMBED_ORIGINS = [
  // Add your dashboards here, e.g.
  // 'https://dash.yourcompany.com',
  // 'https://*.yourcompany.com',
];

// The demo host page, and ONLY when Soop is itself being served from a
// development machine. Shipped unconditionally these two entries mean that on
// the deployed app any page a person's own computer serves on port 8098 - a
// stray project, an npm start somebody forgot - can drive their panel and be
// handed their credentials. originAllowed also exempts localhost from the https
// requirement, so it would not even need a certificate. The gate is on where
// SOOP is running, not on where the frame claims to be, because the frame is the
// thing being checked.
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (DEV) EMBED_ORIGINS.push('http://localhost:8098', 'http://127.0.0.1:8098');

// Where the browser spends a one-time handoff ticket for a real session. An Edge
// Function, because minting a session needs the service role key and that must
// never come near a browser.
//
// This is the REDEEM half and it is safe to be public: a ticket is single use,
// lives sixty seconds, and is bound to the origin it was issued for. The MINT
// half is the same function at /mint, is called only by a dashboard's backend,
// and is authenticated by an HMAC over the assertion.
//
// Blank until `supabase functions deploy soop-handoff --no-verify-jwt` has been
// run. With no endpoint the handoff path is unavailable and a host has to pass a
// session it minted itself, which works and is worse - see EMBED.md.
export const EMBED_EXCHANGE_URL = SUPABASE_URL + '/functions/v1/soop-handoff';

export const APP_NAME = 'Soop';
export const APP_VENDOR = 'Redtree';
export const VERSION = '0.3.0';

// Permission bitfield, mirrored from the database (private.has_perm).
export const PERM = {
  SEND: 1n,
  MANAGE_MESSAGES: 2n,
  MANAGE_CHANNELS: 4n,
  MANAGE_ROLES: 8n,
  KICK: 16n,
  BAN: 32n,
  MANAGE_WORKSPACE: 64n,
  CREATE_INVITE: 128n,
  MENTION_EVERYONE: 256n,
  MODERATE: 512n,
  MANAGE_THREADS: 1024n,
  ADMINISTRATOR: 1n << 40n,
};

// Quick-react bar: the six shown on message hover without opening the picker.
export const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

// 50 MB, because that is the hard ceiling on the Supabase free plan: "For Free
// projects, the limit can't exceed 50 MB." This said 100 MB, so somebody picking
// a 90 MB video got the whole optimistic experience - the file read into memory,
// hashed with sha256, dimensions probed - and then a server refusal at the end,
// with the client having promised in its own error message that 100 MB was fine.
//
// Raise it here AND in the bucket's own limit if the project ever moves off the
// free plan; the two have to agree or one of them is lying to somebody.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MESSAGE_PAGE = 50;
