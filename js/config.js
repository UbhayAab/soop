// Build-time config. Only client-safe values live here: the project URL and the
// publishable (anon) key. The secret key never reaches the browser.
export const SUPABASE_URL = 'https://ybddogqphinruyunnuwx.supabase.co';
export const PUBLISHABLE = 'sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD';

// Open demo Space. Anyone who lands without an invite link is dropped in here so
// the app is never an empty room. Real Spaces are joined via #/join/<token>.
export const DEMO_TOKEN = 'hearth-demo-open-2026';

// Offer "email me a sign-in code" on the sign-in screen. Off: accounts here are
// provisioned with a password, so there is nothing an emailed code verifies -
// it only sends the person out to a mailbox that may demand its own device
// verification before they can even read it, which is two other companies'
// security checks standing between somebody and a chat app. Turn it back on
// when this project has its own mailer and the code is the way in for new
// people rather than a detour for people who already have an account.
export const CODE_SIGNIN = false;

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

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MESSAGE_PAGE = 50;
