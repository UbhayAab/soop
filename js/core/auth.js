// Auth: email one-time-code as the real path, guest as the zero-friction path.
// The OTP screen is a state machine (idle -> sent -> verifying) with a resend
// cooldown, because a code screen that silently does nothing is the fastest way
// to lose someone at the door.
import { sb, session, markIntentionalSignOut } from '../sb.js';
import { CODE_SIGNIN, GUEST_SIGNIN, NOTICE_AT_SIGNUP } from '../config.js';
import { api, tryRpc } from '../api.js';
import { store } from '../store.js';
import { $, el, esc } from '../util.js';
import { toast } from '../ui.js';

const RESEND_SECONDS = 45;
let resendTimer = null;

const show = (id) => { $(id).classList.remove('hidden'); };
const hide = (id) => { $(id).classList.add('hidden'); };

function authError(msg, causes) {
  const e = $('authErr');
  e.textContent = msg || '';
  if (msg && causes?.length) {
    const ul = el('ul');
    for (const c of causes) ul.appendChild(el('li', '', esc(c)));
    e.appendChild(ul);
  }
  e.classList.toggle('hidden', !msg);
}

// Whether the person actually typed into the password box, as opposed to the
// browser filling it. Autofill selects a value without a keystroke or a paste,
// so "no key was ever pressed in this field" is a good enough read on it - and
// it is the case that needs a different answer when sign-in fails.
let pwWasTyped = false;

function busy(btn, on, label) {
  btn.disabled = on;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = on ? '…' : (label || btn.dataset.label);
}

// Supabase decides between a sign-in LINK and a numeric CODE purely from the
// email template, and template editing is locked until a custom SMTP provider is
// configured. So on the default mailer people receive a link, not a code, and a
// screen that only offers a code box looks broken. Support both: the link signs
// them in on return (detectSessionInUrl), and the code box stays for when the
// template is switched to {{ .Token }}.
export function readAuthCallback() {
  const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const q = new URLSearchParams(location.search || '');
  const err = h.get('error_description') || h.get('error') || q.get('error_description');
  const hasToken = !!(h.get('access_token') || q.get('code'));
  if (err) {
    // Clear it so a refresh does not resurrect a dead error.
    history.replaceState(null, '', location.pathname + location.search);
    return { error: decodeURIComponent(err.replace(/\+/g, ' ')) };
  }
  return { hasToken };
}

export function initAuth(onSignedIn) {
  // Someone clicked an expired or already-used sign-in link. Without this they
  // land on a blank sign-in screen with no idea why nothing happened.
  // Show DPDP s.6(1) notice at signup.
  const notice = $('dpdpNotice');
  if (notice) {
    notice.textContent = NOTICE_AT_SIGNUP;
    notice.classList.remove('hidden');
  }
  const cb = readAuthCallback();
  if (cb.error) {
    authError(/expired|invalid/i.test(cb.error)
      ? 'That sign-in link has expired or was already used. Request a new one below.'
      : cb.error);
  }

  // A forced sign-out (revoked token, another tab leaving) stashes this before
  // reloading, so the card can say why it appeared instead of the person finding
  // chat gone with no explanation.
  try {
    if (sessionStorage.getItem('dekKicked')) {
      sessionStorage.removeItem('dekKicked');
      authError('Your session ended on this device. Sign in again to continue.');
    }
  } catch { /* storage unavailable */ }

  // ---- guest ----
  $('guestBtn').onclick = async () => {
    const name = $('displayName').value.trim() || 'Guest ' + Math.floor(1000 + Math.random() * 9000);
    const btn = $('guestBtn');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.signInAnonymously();
      if (error) throw error;
      await api.setProfile({ display_name: name });
      await onSignedIn();
    } catch (e) {
      authError(e.message || 'Could not start a guest session');
      busy(btn, false);
    }
  };
  // Both ship hidden; these two lines are what put them back, so the flags in
  // config.js are the only thing to change on the client.
  $('guestBtn').classList.toggle('hidden', !GUEST_SIGNIN);
  $('displayName').closest('.field').classList.toggle('hidden', !(GUEST_SIGNIN || CODE_SIGNIN));

  // ---- password sign-in ----
  // The interim path while the organisations finish their own mailer: accounts
  // are provisioned in bulk with a temporary password, and the first sign-in
  // forces a real one.
  const passwordSignIn = async () => {
    const email = $('email').value.trim();
    const typed = $('password').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) return authError('Enter a valid email address');
    if (!typed) return authError('Enter your password');
    const btn = $('pwSignIn');
    busy(btn, true);
    authError('');
    try {
      // A password is whatever bytes were chosen, so it is never silently
      // rewritten - but a temporary password handed out over WhatsApp is copied,
      // and a long-press copy on Android takes the trailing space with it.
      // gotrue rejects that as a wrong password with no way to tell the
      // difference. So: try exactly what was entered, and only if that is
      // refused, try it again without the surrounding whitespace.
      let { error } = await sb.auth.signInWithPassword({ email, password: typed });
      const trimmed = typed.trim();
      if (error && /invalid login/i.test(error.message || '') && trimmed && trimmed !== typed) {
        ({ error } = await sb.auth.signInWithPassword({ email, password: trimmed }));
      }
      if (error) throw error;
      if (await needsPasswordSetup()) { showSetPassword(email); return; }
      await onSignedIn();
    } catch (e) {
      if (/invalid login/i.test(e.message || '')) {
        // "Check with whoever set up your account" was the whole message, and it
        // is the one thing that does not help: it is not the operator's mistake
        // in either of the two cases that actually happen. Name them instead.
        const causes = [];
        if (!pwWasTyped) {
          causes.push('Your browser filled the password in for you, and it may still be holding the '
            + 'temporary one from your first sign-in. Clear the box and type the password you chose.');
        }
        causes.push('Your account may be under a different email address - most people were added '
          + 'with a personal address, not a work one. Try the other one.');
        causes.push('If neither works, ask the person who set this up to reset you. Nobody can see '
          + 'your password, so it can only be replaced, never looked up.');
        authError('That email and password do not match.', causes);
      } else {
        authError(e.message);
      }
      busy(btn, false);
    }
  };
  $('emailStep').addEventListener('submit', (e) => { e.preventDefault(); passwordSignIn(); });
  // keydown, not input: autofill writes a value without either, and telling the
  // two apart is what lets the failure message name the right cause.
  $('password').addEventListener('keydown', () => { pwWasTyped = true; });
  $('password').addEventListener('paste', () => { pwWasTyped = true; });

  // ---- forced password change ----
  const savePassword = async () => {
    // Trimmed on the way IN, which is the half that matters. A stray space
    // pasted here is stored as part of the password forever, and the person then
    // types the password they think they chose and is told it is wrong - with no
    // way for anyone to work out why, because nobody can read the password back.
    const a = $('newPw').value.trim();
    const b = $('newPw2').value.trim();
    if (a.length < 8) return authError('Use at least 8 characters');
    if (a !== b) return authError('Those two passwords do not match');
    const btn = $('pwSave');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) throw error;
      // Only drop the latch once GoTrue has actually accepted the new password.
      await api.completePasswordSetup();
      // The password manager saved the temporary password on the way in. Leave
      // the new one where it can find it and let the form's submit be what it
      // reads, rather than being asked to guess from a SPA that never navigates.
      await onSignedIn();
    } catch (e) {
      authError(e.message || 'Could not set that password');
      busy(btn, false);
    }
  };
  $('setPwStep').addEventListener('submit', (e) => { e.preventDefault(); savePassword(); });
  $('newPw').addEventListener('input', () => paintStrength($('newPw').value));

  // ---- request a code ----
  const sendCode = async () => {
    const email = $('email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return authError('Enter a valid email address');
    const btn = $('otpSend');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: {
          // Conjure an account only when CODE_SIGNIN is on. The code request button
          // is hidden when CODE_SIGNIN is false, so when it is visible the user is
          // explicitly choosing to create an account.
          shouldCreateUser: CODE_SIGNIN,
          // The link has to come back to THIS page, including when the mail app
          // opens it in a fresh tab.
          emailRedirectTo: location.origin + location.pathname,
        },
      });
      if (error) throw error;
      $('otpTarget').textContent = email;
      show('otpStep');
      hide('emailStep');
      $('code').focus();
      startCooldown();
    } catch (e) {
      const msg = /rate|limit|seconds/i.test(e.message || '')
        ? 'Too many codes requested. Wait a minute and try again, or continue as a guest.'
        : e.message;
      authError(msg);
    } finally { busy(btn, false); }
  };
  // Enter in the email box submits the sign-in form now, which is the path
  // almost everyone here is on. Requesting a code is an explicit button press.
  $('otpSend').onclick = sendCode;
  // The button ships hidden; this is what puts it back, so the flag is the only
  // thing to change when the mailer exists.
  $('otpSend').classList.toggle('hidden', !CODE_SIGNIN);

  // ---- verify ----
  const verify = async () => {
    const email = $('email').value.trim();
    const token = $('code').value.replace(/\s/g, '');
    if (token.length < 6) return authError('Enter the 6-digit code from your email');
    const btn = $('otpVerifyBtn');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
      if (error) throw error;
      const name = $('displayName').value.trim();
      if (name) await api.setProfile({ display_name: name });
      await onSignedIn();
    } catch (e) {
      authError(/expired|invalid/i.test(e.message || '')
        ? 'That code is wrong or expired. Request a new one.'
        : e.message);
      busy(btn, false);
    }
  };
  $('otpVerifyBtn').onclick = verify;
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
  $('code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 8);
    if (e.target.value.length === 6) verify();
  });

  $('otpBack').onclick = () => {
    hide('otpStep');
    show('emailStep');
    authError('');
    stopCooldown();
  };
  $('otpResend').onclick = () => { if (!$('otpResend').disabled) sendCode(); };

  // ---- sign out ----
  // Sign out lives in the user menu now (js/shell.js). The old top-level button
  // is gone, so bind only if some surface still offers one.
  const so = $('signout');
  if (so) {
    so.onclick = async () => {
      // Same as the user menu: the cached conversations come off the device.
      await Promise.all([
        import('../lib/pagecache.js').then((m) => m.wipe()),
        import('../lib/readcache.js').then((m) => m.wipe()),
        // Attachment cache off the device too. 'dek-storage-v1' must match
        // STORAGE in sw.js.
        window.caches ? caches.delete('dek-storage-v1') : Promise.resolve(),
      ]).catch(() => { /* signing out must not be blocked by storage */ });
      markIntentionalSignOut();
      await sb.auth.signOut();
      location.hash = '';
      location.reload();
    };
  }
}

function startCooldown() {
  let n = RESEND_SECONDS;
  const b = $('otpResend');
  b.disabled = true;
  const tick = () => {
    b.textContent = n > 0 ? `Resend in ${n}s` : 'Resend code';
    b.disabled = n > 0;
    if (n-- > 0) resendTimer = setTimeout(tick, 1000);
  };
  stopCooldown();
  tick();
}
function stopCooldown() { if (resendTimer) { clearTimeout(resendTimer); resendTimer = null; } }

// Whether this session is still on a provisioned temporary password. Failing
// open would be wrong in the other direction: if the check itself errors we do
// NOT trap someone on the reset screen, we let them in and they keep the latch
// until the next sign-in.
export async function needsPasswordSetup() {
  const [flag] = await tryRpc('must_set_password', {});
  return flag === true;
}

export function showSetPassword(email) {
  hide('emailStep');
  hide('otpStep');
  show('setPwStep');
  $('pwWho').textContent = email ? `, ${email}` : '';
  // The password manager needs a username on this form or it has nothing to file
  // the new password against - see the comment on #pwUser in index.html.
  $('pwUser').value = email || '';
  authError('');
  setTimeout(() => $('newPw').focus(), 40);
}

// A calm strength hint rather than a scolding validator: length is what actually
// matters, with a nudge for variety.
function paintStrength(v) {
  const meter = $('pwMeter');
  if (!meter) return;
  let score = 0;
  if (v.length >= 8) score++;
  if (v.length >= 12) score++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
  if (/\d/.test(v) || /[^\w\s]/.test(v)) score++;
  meter.dataset.score = String(score);
  meter.querySelector('i').style.width = `${(score / 4) * 100}%`;
}

export async function currentUser() {
  const s = await session();
  return s?.user || null;
}

export function showAuth() {
  $('auth').classList.remove('hidden');
  $('chat').classList.add('hidden');
}
export function showChat() {
  $('auth').classList.add('hidden');
  $('chat').classList.remove('hidden');
}
