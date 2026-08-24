-- 0106 - OTP codes for self-serve sign-in, delivered through the JCF-Mailer.
--
-- Why not Supabase's built-in OTP mail: it is rate-limited to a handful of
-- messages per hour project-wide, which is a signup funnel that dies on launch
-- day. The organisation already runs a mailer (JCF-Mailer on SES, jarurat.care)
-- with a transactional API and a template editor. Codes go through that.
--
-- The edge function (mail-otp) is the ONLY reader/writer: it runs with the
-- service role, which bypasses RLS, so these policies deny everyone else.
-- Codes are stored as SHA-256(code + email) - a database leak must not leak
-- usable codes.

create table if not exists private.otp_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz
);
create index if not exists otp_codes_email_idx on private.otp_codes (email, created_at desc);

alter table private.otp_codes enable row level security;
-- No policies: deny by default. Service role ignores RLS and is the only path.

-- Expired/used rows are noise. The function prunes on each send, so no cron
-- dependency for correctness.
