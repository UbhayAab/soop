// Your own profile: name, title, pronouns, and your password.
//
// None of this was editable. Names came from whatever was typed into a
// provisioning spreadsheet - "Shariva" is spelled off her email address,
// "Aditya" has no surname, one account is called "harshithakpm7755" - and the
// person it belongs to had no way to correct it. The password could be set
// exactly once, during the forced first-run, and never again.
//
// Which fields are editable is an ORGANISATION's decision, not this file's: some
// want the name locked to what HR holds, others want people to write their own.
// The rules come from the server (my_identity_rules) and a locked field is shown
// as locked rather than being offered and then refused on save.
import { store, bus } from '../store.js';
import { api } from '../api.js';
import { sb } from '../sb.js';
import { el, esc } from '../util.js';
import { uploadFile } from '../core/media.js';
import { avatarHtml } from '../core/messages.js';

const RULE_NOTE = {
  admins: 'Your organisation has this set by an admin. Ask them to change it.',
  locked: 'Your organisation has locked this field.',
};

// A face circle wants a square source; a 3MB camera photo as a 56px avatar is
// bandwidth nobody should pay. Center-crop to 256px JPEG client-side, keep the
// original only if that somehow fails or comes out bigger.
async function downscaleAvatar(file) {
  try {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    if (blob && blob.size < file.size) {
      return new File([blob], (file.name || 'avatar').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    }
  } catch { /* no createImageBitmap on this engine: send the original */ }
  return file;
}

export async function openProfileEditor(ui) {
  let rules = { name: 'anyone', title: 'anyone', pronouns: 'anyone', avatar: 'anyone' };
  try { rules = await api.myIdentityRules(); } catch { /* default to editable */ }

  const me = store.myProfile || store.profiles.get(store.me) || {};
  const box = el('div', 'profile-edit');
  const field = (id, label, value, rule, placeholder) => `
    <label class="field">
      <span class="field-label">${esc(label)}</span>
      <input id="${id}" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}"
        maxlength="60" ${rule === 'anyone' ? '' : 'disabled'} />
      ${rule === 'anyone' ? '' : `<span class="field-hint">${esc(RULE_NOTE[rule])}</span>`}
    </label>`;

  box.innerHTML = `
    <div class="pf-avatar-row">
      <span id="pfAvatarPreview">${avatarHtml(store.me, 56)}</span>
      <div class="pf-avatar-actions">
        ${rules.avatar === 'anyone'
          ? `<button class="sm ghost" id="pfAvatarBtn" type="button">${me.avatar_key ? 'Change photo' : 'Add photo'}</button>`
          : `<span class="field-hint">${esc(RULE_NOTE[rules.avatar] || '')}</span>`}
      </div>
    </div>
    ${field('pfName', 'Your name', me.display_name, rules.name, 'How you want to be listed')}
    ${field('pfTitle', 'Your title', me.title, rules.title, 'Interview Intern')}
    ${field('pfPronouns', 'Pronouns', me.pronouns, rules.pronouns, 'she/her, he/him, they/them')}
    <p class="muted fineprint">Your title is a description, not a permission. Changing it
      does not change what you can do.</p>`;

  // The upload path sends the WHOLE current profile: set_profile's contract for
  // unspecified fields (keep vs clear) lives in SQL this repo does not hold,
  // and betting faces on an unverified null was how the Later-queue lie
  // happened. Full payload, zero ambiguity.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  box.appendChild(fileInput);
  box.querySelector('#pfAvatarBtn')?.addEventListener('click', () => fileInput.click());
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const btn = box.querySelector('#pfAvatarBtn');
    const oldLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      const small = await downscaleAvatar(f);
      const up = await uploadFile(small);
      await api.setProfile({
        display_name: me.display_name ?? null,
        title: me.title ?? null,
        pronouns: me.pronouns ?? null,
        avatar_key: up.object_key,
        status_text: me.status_text ?? null,
        status_emoji: me.status_emoji ?? null,
        timezone: store.myProfile?.timezone || me.timezone || undefined,
      });
      store.myProfile = { ...(store.myProfile || {}), avatar_key: up.object_key, id: store.me };
      store.profiles.set(store.me, { ...(store.profiles.get(store.me) || {}), avatar_key: up.object_key });
      const prev = box.querySelector('#pfAvatarPreview');
      if (prev) prev.innerHTML = avatarHtml(store.me, 56);
      const { hydrateAvatars } = await import('../core/messages.js');
      hydrateAvatars(prev).catch(() => {});
      btn.textContent = 'Change photo';
      btn.disabled = false;
      ui.toast('Photo saved', 'success');
      bus.emit('profiles');
      bus.emit('status:changed');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = oldLabel;
      ui.toast(e.message || 'Could not upload that photo', 'error');
    }
  };

  const anyEditable = ['name', 'title', 'pronouns'].some((k) => rules[k] === 'anyone');
  const actions = [];
  if (anyEditable) {
    actions.push({
      label: 'Save',
      onClick: async (close, body) => {
        const val = (id) => {
          const n = body.querySelector('#' + id);
          return n && !n.disabled ? n.value.trim() : null;
        };
        try {
          await api.setMyIdentity({
            display_name: val('pfName'),
            title: val('pfTitle'),
            pronouns: val('pfPronouns'),
          });
          // Keep what is on screen honest without waiting for a reload.
          const patch = {
            display_name: val('pfName') || me.display_name,
            title: val('pfTitle'),
            pronouns: val('pfPronouns'),
          };
          store.myProfile = { ...(store.myProfile || {}), ...patch, id: store.me };
          store.profiles.set(store.me, { ...(store.profiles.get(store.me) || {}), ...patch });
          bus.emit('profiles');
          bus.emit('status:changed');
          ui.toast('Saved', 'success');
          close();
        } catch (e) {
          ui.toast(/field_locked/.test(e.message || '')
            ? 'Your organisation does not allow that field to be changed.'
            : (e.message || 'Could not save that'), 'error');
        }
      },
    });
  }
  ui.modal({ title: 'Your profile', body: box, actions });
}

// ------------------------------------------------------------------ password
// Changing your own password was possible exactly once, on the forced first-run
// screen, and never again. Somebody who thought their password had been seen had
// no way to replace it without asking an admin to reset them.
export async function openPasswordChange(ui) {
  const box = el('div');
  box.innerHTML = `
    <p class="muted">Choose a new password. You stay signed in on this device.</p>
    <label class="field"><span class="field-label">Current password</span>
      <input id="pcOld" type="password" autocomplete="current-password" /></label>
    <label class="field"><span class="field-label">New password</span>
      <input id="pcNew" type="password" autocomplete="new-password" placeholder="At least 8 characters" /></label>
    <label class="field"><span class="field-label">Type it again</span>
      <input id="pcNew2" type="password" autocomplete="new-password" /></label>
    <div id="pcErr" class="autherr hidden"></div>`;

  ui.modal({
    title: 'Change your password',
    body: box,
    actions: [{
      label: 'Change it',
      onClick: async (close, body) => {
        const err = body.querySelector('#pcErr');
        const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
        // Trimmed for the same reason the sign-in screen trims: a password
        // pasted from a chat app arrives with a trailing space and would be
        // stored with it, locking the person out of an account they just set.
        const old = body.querySelector('#pcOld').value.trim();
        const a = body.querySelector('#pcNew').value.trim();
        const b = body.querySelector('#pcNew2').value.trim();
        if (a.length < 8) return fail('Use at least 8 characters');
        if (a !== b) return fail('Those two do not match');
        if (!old) return fail('Enter your current password');

        // Prove they are the account holder, not somebody at an unlocked phone.
        // updateUser alone would let anyone who finds a signed-in device take it.
        const email = store.myProfile?.email || (await sb.auth.getUser()).data?.user?.email;
        if (!email) return fail('Could not confirm who you are. Sign out and back in.');
        const { error: reauth } = await sb.auth.signInWithPassword({ email, password: old });
        if (reauth) return fail('That current password is not right.');

        const { error } = await sb.auth.updateUser({ password: a });
        if (error) return fail(error.message || 'Could not change it');
        ui.toast('Password changed', 'success');
        close();
      },
    }],
  });
}

export function register(app) {
  const { ui } = app;
  bus.on('identity:open', () => openProfileEditor(ui));
  bus.on('password:open', () => openPasswordChange(ui));
}
