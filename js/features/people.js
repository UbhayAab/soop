// The People tab of the admin console: add colleagues, see who is stuck, and
// give somebody a new password.
//
// Every one of these was a terminal command run by one person. Onboarding two
// organisations that way meant every new starter and every forgotten password
// was a message to whoever owned the scripts, and nobody else could act at all.
// This is those scripts as a screen, for the person who actually runs the team.
//
// The service role never reaches the browser, so all three go through the
// admin-users Edge Function, which re-checks org admin against the caller's own
// JWT rather than trusting anything sent from here.
import { store } from '../store.js';
import { el, esc } from '../util.js';
import { api } from '../api.js';
import { sb } from '../sb.js';
import { SUPABASE_URL } from '../config.js';

const FN = SUPABASE_URL + '/functions/v1/admin-users';

async function callAdmin(payload) {
  const { data } = await sb.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('You are signed out. Reload and sign in again.');
  const res = await fetch(FN, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const e = new Error(body.error || `That did not work (${res.status})`);
    e.status = res.status;
    e.code = body.error;
    throw e;
  }
  return body;
}

// Which organisation this admin is acting on. The console is opened from inside
// a Space, so the Space's org is the answer - and if they do not administer it,
// nothing here is shown at all.
function currentOrg() {
  const orgId = store.ws?.org_id;
  if (!orgId) return null;
  const o = (store.orgs || []).find((x) => x.org_id === orgId);
  return o?.org_role === 'admin' ? o : null;
}

export function canManagePeople() { return !!currentOrg(); }

// ------------------------------------------------------------------ add
function addPeopleForm(host, ctx, ui, org) {
  const wrap = el('div', 'admin-form');
  const servers = (store.spaces || []).filter((s) => s.org_id === org.org_id);
  wrap.innerHTML = `
    <p class="muted">Paste email addresses - one per line, or straight out of a
      spreadsheet column. Names and phone numbers alongside them are ignored.</p>
    <label class="field"><span class="field-label">Email addresses</span>
      <textarea id="addEmails" rows="7" placeholder="asha@gmail.com&#10;ravi@gmail.com&#10;Meena Rao, 98765 43210, meena@gmail.com"></textarea></label>
    <div class="admin-row2">
      <label class="field"><span class="field-label">Put them in</span>
        <select id="addSpace">
          ${servers.map((s) => `<option value="${esc(s.id)}"${s.id === store.ws?.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
          <option value="">No server yet - they use a join link</option>
        </select></label>
      <label class="field"><span class="field-label">Their title (optional)</span>
        <input id="addTitle" maxlength="60" placeholder="Interview Intern" /></label>
    </div>
    <label class="field field-check"><span class="field-label">Let them moderate that server</span>
      <input id="addMod" type="checkbox" /></label>
    <button id="addGo" class="wide">Add them</button>
    <div id="addOut"></div>`;
  host.appendChild(wrap);

  const out = wrap.querySelector('#addOut');
  wrap.querySelector('#addGo').onclick = async () => {
    const raw = wrap.querySelector('#addEmails').value;
    if (!raw.trim()) { ui.toast('Paste some email addresses first', 'error'); return; }
    const btn = wrap.querySelector('#addGo');
    btn.disabled = true;
    btn.textContent = 'Adding…';
    out.innerHTML = '';
    try {
      const r = await callAdmin({
        action: 'add',
        org: org.org_id,
        emails: raw,
        workspace: wrap.querySelector('#addSpace').value || null,
        title: wrap.querySelector('#addTitle').value,
        role: wrap.querySelector('#addMod').checked ? 'moderator' : 'member',
      });
      renderAddResult(out, r, ui);
      wrap.querySelector('#addEmails').value = '';
      ctx.cache.delete('people');
      ctx.cache.delete('members');
    } catch (e) {
      out.innerHTML = `<div class="autherr">${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add them';
    }
  };
}

// The passwords are shown ONCE. Nothing can read them back afterwards, so the
// screen has to say that plainly rather than letting an admin close it assuming
// they can come back for the list.
function renderAddResult(out, r, ui) {
  out.innerHTML = '';
  const { created = [], existing = [], failed = [], rejected = [] } = r;

  if (created.length) {
    const box = el('div', 'addresult');
    box.innerHTML = `<h4 class="sec">${created.length} account${created.length > 1 ? 's' : ''} created</h4>
      <p class="muted">Send each person their own line. <b>This is the only time these
      passwords are shown</b> - nothing can read them back, they can only be replaced.
      Each one works once, then they choose their own.</p>`;
    const list = el('div', 'addcreds');
    list.innerHTML = created.map((c) =>
      `<div class="addcred"><code>${esc(c.email)}</code><code class="addcred-pw">${esc(c.password)}</code></div>`).join('');
    box.appendChild(list);
    const copy = el('button', 'wide', 'Copy all as a list');
    copy.onclick = async () => {
      const text = created.map((c) => `${c.email}  ${c.password}`).join('\n');
      await navigator.clipboard?.writeText(text).catch(() => {});
      ui.toast('Copied. Send it over something private and delete it after.');
    };
    box.appendChild(copy);
    out.appendChild(box);
  }

  if (existing.length) {
    out.appendChild(el('div', 'admin-note',
      `${existing.length} already had an account and were added to the server without touching their password: `
      + esc(existing.join(', '))));
  }
  if (rejected.length) {
    out.appendChild(el('div', 'admin-note',
      `Skipped, they do not look like addresses: ${esc(rejected.join(', '))}`));
  }
  if (failed.length) {
    out.appendChild(el('div', 'autherr',
      failed.map((f) => `${esc(f.email)}: ${esc(f.reason)}`).join('<br />')));
  }
  if (!created.length && !existing.length && !failed.length) {
    out.appendChild(el('div', 'admin-note', 'Nothing to do - every address was already in.'));
  }
}

// ------------------------------------------------------------------ status
// Three groups, because they need three different actions and treating them as
// one list is how "resend it" and "reset them" get mixed up. Resetting somebody
// who has never signed in destroys the password they are holding.
const GROUPS = [
  {
    key: 'never_signed_in',
    title: 'Have never signed in',
    hint: 'They still hold the password you gave them. Send it again - do NOT reset them, that makes the one they have stop working.',
  },
  {
    key: 'signed_in_no_password',
    title: 'Signed in, have not chosen a password yet',
    hint: 'They got in and stopped at the password screen. They can just finish it.',
  },
  {
    key: 'done',
    title: 'Finished',
    hint: 'Signed in and chose their own password. Nothing to do.',
  },
];

async function drawPeople(host, ctx, ui) {
  const org = currentOrg();
  host.innerHTML = '';
  if (!org) {
    host.appendChild(el('div', 'empty',
      'Only an admin of this organisation can add or reset people. Ask whoever set it up.'));
    return;
  }

  host.appendChild(el('h4', 'sec', 'Add people to ' + (org.name || 'this organisation')));
  addPeopleForm(host, ctx, ui, org);

  host.appendChild(el('h4', 'sec', 'Who has got in'));
  const board = el('div');
  host.appendChild(board);
  board.innerHTML = '<div class="loading-space"><span class="spin"></span>Checking…</div>';

  let people;
  try {
    // Cached per open panel so switching tabs does not re-list every account in
    // the organisation; any action that changes the answer deletes the key.
    if (!ctx.cache.has('people')) {
      ctx.cache.set('people', callAdmin({ action: 'status', org: org.org_id }));
    }
    ({ people } = await ctx.cache.get('people'));
  } catch (e) {
    ctx.cache.delete('people');
    board.innerHTML = `<div class="autherr">${esc(e.message)}</div>`;
    return;
  }

  board.innerHTML = '';
  const counts = el('div', 'admin-stats');
  for (const g of GROUPS) {
    const n = people.filter((p) => p.state === g.key).length;
    counts.appendChild(el('div', 'admin-stat', `<b>${n}</b><span class="muted">${esc(g.title)}</span>`));
  }
  board.appendChild(counts);

  for (const g of GROUPS) {
    const list = people.filter((p) => p.state === g.key);
    if (!list.length) continue;
    board.appendChild(el('h4', 'sec', `${g.title} - ${list.length}`));
    board.appendChild(el('p', 'muted', esc(g.hint)));
    const rows = el('div');
    for (const p of list) {
      const row = el('div', 'admin-line');
      row.innerHTML = `<div><b>${esc(p.name || p.email || 'somebody')}</b>
        <div class="muted">${esc(p.email || '')}</div></div>`;
      const btn = el('button', 'sm ghost', 'New password');
      btn.onclick = () => resetOne(p, btn, ctx, ui, org);
      row.appendChild(btn);
      rows.appendChild(row);
    }
    board.appendChild(rows);
  }
}

// ------------------------------------------------------------------ reset
async function resetOne(person, btn, ctx, ui, org, force = false) {
  if (!force) {
    const ok = await ui.confirmModal({
      title: 'New password for ' + (person.name || person.email),
      body: 'They get a fresh password that works once, and the app makes them choose '
          + 'their own the moment they use it. Whatever they have now stops working.',
      confirmLabel: 'Give them a new password',
      danger: true,
    });
    if (!ok) return;
  }
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = '…';
  try {
    const r = await callAdmin({ action: 'reset', org: org.org_id, user: person.user_id, force });
    showPassword(person, r.password, ui);
    ctx.cache.delete('people');
  } catch (e) {
    if (e.code === 'already_chosen') {
      // The guard that stops an admin quietly wiping a password somebody chose.
      const ok = await ui.confirmModal({
        title: (person.name || 'They') + ' already chose their own password',
        body: 'Replacing it throws theirs away and they will have to pick a new one. '
            + 'Only do this if they have told you they are locked out.',
        confirmLabel: 'Replace it anyway',
        danger: true,
      });
      btn.disabled = false;
      btn.textContent = was;
      if (ok) await resetOne(person, btn, ctx, ui, org, true);
      return;
    }
    ui.toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

function showPassword(person, password, ui) {
  const box = el('div');
  box.innerHTML = `
    <p>Send this to <b>${esc(person.name || person.email)}</b> over something private.
      <b>It is shown once</b> - nothing can read it back afterwards.</p>
    <div class="addcred"><code>${esc(person.email || '')}</code><code class="addcred-pw">${esc(password)}</code></div>
    <p class="muted">It works once. The moment they sign in, the app makes them choose
      their own, and this one stops working.</p>`;
  ui.modal({
    title: 'New password',
    body: box,
    actions: [{
      label: 'Copy',
      onClick: async () => {
        await navigator.clipboard?.writeText(`${person.email}  ${password}`).catch(() => {});
        ui.toast('Copied');
      },
    }],
  });
}

export { drawPeople };
