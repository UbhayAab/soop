// The Apps console: what an organisation admin sees, and the only place an app
// token is ever created.
//
// WHY THIS LOOKS THE WAY IT DOES: the bots and webhooks screen this replaces had
// every capability and zero users. Four tables, four RPCs, a working console -
// and zero rows in all of them, forever. The reasons were findable: the curl
// example on screen pointed at a URL that 404s, and a message posted by a bot
// rendered as the word "someone" because the client tested a column that does
// not exist. Nobody debugs past two dead ends to reach a feature they are only
// curious about.
//
// So this screen is built around the three questions an app author actually
// asks, in order: what is my token, does it work, and what may it touch. The
// documentation is on the page rather than behind a link, it carries the real
// endpoint and the reader's own channel names, and the first thing it tells them
// to run is the call that answers "is my token right" in one line.
import { api } from '../api.js';
import { esc, relTime, hueOf, initials } from '../util.js';

import { modal, formModal, confirmModal, toast } from '../ui.js';
import { SUPABASE_URL } from '../config.js';

const FN_URL = SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/dek-app';

// The eight bits, in the order an admin reads them rather than numeric order.
// Each label is what the permission lets the app DO, phrased so that ticking it
// is a decision and not a guess. The three that are enforced today say so; the
// rest are honest about being reserved so nobody ticks one and wonders why
// nothing changed.
const SCOPES = [
  { bit: 1,   label: 'Post messages',             hint: 'Send messages into the channels below.' },
  { bit: 8,   label: 'Create tasks',              hint: 'Assign work to a person, with a due date.' },
  { bit: 16,  label: 'Attach files',              hint: 'Include an attachment on a message it posts.' },
  { bit: 2,   label: 'Read messages',             hint: 'Reserved. Not enforced yet.', soon: true },
  { bit: 4,   label: 'Add reactions',             hint: 'Reserved. Not enforced yet.', soon: true },
  { bit: 32,  label: 'Read the member directory', hint: 'Reserved. Not enforced yet.', soon: true },
  { bit: 64,  label: 'Edit canvases',             hint: 'Reserved. Not enforced yet.', soon: true },
  { bit: 128, label: 'Create forms',              hint: 'Reserved. Not enforced yet.', soon: true },
];

const scopeNames = (bits) => SCOPES.filter((s) => (bits & s.bit) === s.bit).map((s) => s.label);

// ------------------------------------------------------------------- list

export async function drawApps(host, org) {
  const apps = await api.rpc('list_apps', { p_org: org.org_id });

  host.innerHTML = `
    <div class="ap-rowhead">
      <h2 class="ap-h2">Apps <span class="muted">${apps.length || ''}</span></h2>
      <button class="sm" id="apNewApp">＋ New app</button>
    </div>
    <p class="muted apps-lede">An app posts into your channels from somewhere else: a scheduled
      script, a machine on the floor, another system. It gets its own name and picture, and a
      token that you can see the last use of and kill at any time.</p>
    <div class="ap-table">${apps.map((a) => `
      <div class="ap-server-row${a.disabled_at ? ' off' : ''}" data-app="${esc(a.id)}">
        <span class="ap-av" style="--h:${hueOf(a.id)}">${esc(initials(a.name))}</span>
        <div class="ap-person-main">
          <b>${esc(a.name)}</b>
          ${a.disabled_at ? '<span class="ap-chip warn">turned off</span>' : ''}
          <div class="muted ap-person-sub">${
            a.description ? esc(a.description) + ' · ' : ''
          }${a.installs} Space${a.installs === 1 ? '' : 's'} · ${
            a.last_used_at ? 'last used ' + esc(relTime(a.last_used_at)) : 'never used'
          }</div>
        </div>
        <div class="ap-acts"><button class="sm ghost" data-a="open">Open</button></div>
      </div>`).join('') || `<div class="empty">No apps yet. An app is how something outside Dek
        posts into it.</div>`}</div>`;

  host.querySelector('#apNewApp').onclick = async () => {
    const out = await formModal({
      title: 'New app',
      note: 'The name and picture are what people will see on every message it posts.',
      fields: [
        { name: 'name', label: 'Name', required: true, placeholder: 'Dispatch Bot' },
        { name: 'description', label: 'What it does', placeholder: 'Posts the Bhiwandi loading numbers at 06:15' },
      ],
      submitLabel: 'Create',
    });
    if (!out) return;
    try {
      const made = await api.rpc('create_app', {
        p_org: org.org_id, p_name: out.name, p_description: out.description || null,
      });
      toast('App created', 'success');
      await drawApps(host, org);
      openApp(host, org, made.id);
    } catch (e) { toast(e.message, 'error'); }
  };

  host.querySelectorAll('[data-app]').forEach((row) => {
    row.querySelector('[data-a="open"]').onclick = () => openApp(host, org, row.dataset.app);
  });
}

// ----------------------------------------------------------------- detail

async function openApp(host, org, appId) {
  const app = await api.rpc('get_app', { p_app: appId });
  const spaces = await api.listOrgServers(org.org_id);
  const live = app.installs.filter((i) => !i.uninstalled_at);

  host.innerHTML = `
    <button class="sm ghost apps-back" id="apAppsBack">← All apps</button>
    <div class="ap-rowhead">
      <h2 class="ap-h2">${esc(app.name)}
        ${app.disabled_at ? '<span class="ap-chip warn">turned off</span>' : ''}</h2>
      ${app.disabled_at ? '' : '<button class="sm danger" id="apDisable">Turn off everywhere</button>'}
    </div>
    ${app.description ? `<p class="muted">${esc(app.description)}</p>` : ''}

    <h2 class="ap-h2">Where it is installed</h2>
    <div class="ap-table" id="apInstalls">${live.map((i) => renderInstall(i)).join('')
      || '<div class="empty">Not installed anywhere yet. Install it in a Space to give it a token.</div>'}</div>
    <button class="sm" id="apInstall">＋ Install in a Space</button>

    ${live.length ? docsBlock(app, live[0]) : ''}`;

  host.querySelector('#apAppsBack').onclick = () => drawApps(host, org);

  host.querySelector('#apDisable')?.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: `Turn off ${app.name}?`,
      body: `Every token this app has stops working immediately, in every Space. Its past messages
             stay where they are. You can install it again later, but you will need a new token.`,
      confirmLabel: 'Turn it off', danger: true,
    });
    if (!ok) return;
    try {
      await api.rpc('disable_app', { p_app: appId });
      toast('Turned off', 'success');
      openApp(host, org, appId);
    } catch (e) { toast(e.message, 'error'); }
  });

  host.querySelector('#apInstall').onclick = () => installDialog(host, org, app, spaces, null);

  for (const inst of live) {
    const box = host.querySelector(`[data-install="${inst.id}"]`);
    if (!box) continue;
    box.querySelector('[data-a="edit"]').onclick = () => installDialog(host, org, app, spaces, inst);
    box.querySelector('[data-a="uninstall"]').onclick = async () => {
      const ok = await confirmModal({
        title: `Remove ${app.name} from ${inst.workspace_name}?`,
        body: 'Its tokens for this Space stop working immediately.',
        confirmLabel: 'Remove', danger: true,
      });
      if (!ok) return;
      try {
        await api.rpc('uninstall_app', { p_install: inst.id });
        toast('Removed', 'success');
        openApp(host, org, appId);
      } catch (e) { toast(e.message, 'error'); }
    };
    box.querySelector('[data-a="newtoken"]').onclick = async () => {
      const out = await formModal({
        title: 'New token',
        note: 'Give it the name of the machine it will live on. That is what makes it possible to kill the right one later.',
        fields: [{ name: 'label', label: 'Where will this token live?', placeholder: 'Bhiwandi dispatch PC' }],
        submitLabel: 'Create token',
      });
      if (!out) return;
      try {
        const t = await api.rpc('create_app_token', { p_install: inst.id, p_label: out.label || null });
        revealToken(t.token, 'This is the only time this token is shown.');
        openApp(host, org, appId);
      } catch (e) { toast(e.message, 'error'); }
    };
    box.querySelectorAll('[data-tok]').forEach((n) => {
      const id = n.dataset.tok;
      n.querySelector('[data-a="rotate"]')?.addEventListener('click', async () => {
        const ok = await confirmModal({
          title: 'Rotate this token?',
          body: `You get a new token now. The old one keeps working for 48 hours, so you have time to
                 walk to the machine and change it. After that it stops.`,
          confirmLabel: 'Rotate',
        });
        if (!ok) return;
        try {
          const t = await api.rpc('rotate_app_token', { p_token: id });
          revealToken(t.token, 'The old token keeps working for 48 hours. Replace it before then.');
          openApp(host, org, appId);
        } catch (e) { toast(e.message, 'error'); }
      });
      n.querySelector('[data-a="revoke"]')?.addEventListener('click', async () => {
        const ok = await confirmModal({
          title: 'Kill this token now?',
          body: 'Whatever is using it stops working immediately. There is no grace period.',
          confirmLabel: 'Kill it', danger: true,
        });
        if (!ok) return;
        try {
          await api.rpc('revoke_app_token', { p_token: id });
          toast('Token killed', 'success');
          openApp(host, org, appId);
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  host.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => {
      navigator.clipboard?.writeText(b.dataset.copy);
      toast('Copied', 'success');
    };
  });
}

function renderInstall(i) {
  const names = scopeNames(i.scopes);
  const live = i.tokens.filter((t) => !t.revoked_at);
  return `
  <div class="apps-install" data-install="${esc(i.id)}">
    <div class="ap-rowhead">
      <b>${esc(i.workspace_name)}</b>
      <div class="ap-acts">
        <button class="sm ghost" data-a="edit">Change</button>
        <button class="sm danger" data-a="uninstall">Remove</button>
      </div>
    </div>
    <div class="apps-meta">
      <div><span class="apps-k">Can</span>
        ${names.length ? names.map((n) => `<span class="ap-chip">${esc(n)}</span>`).join('')
          : '<span class="muted">nothing yet</span>'}</div>
      <div><span class="apps-k">In</span>
        ${i.channel_scope === 'all'
          ? '<span class="ap-chip warn">every channel</span>'
          : (i.channels.length
              ? i.channels.map((c) => `<span class="ap-chip">#${esc(c.name)}</span>`).join('')
              : '<span class="muted">no channels chosen</span>')}</div>
    </div>

    <div class="apps-tokens">${live.map((t) => {
      const expiring = t.expires_at && new Date(t.expires_at) > new Date();
      return `
      <div class="apps-token" data-tok="${esc(t.id)}">
        <div class="apps-token-main">
          <code>dek_at_…${esc(t.hint)}</code>
          ${t.label ? `<span class="apps-label">${esc(t.label)}</span>` : ''}
          ${expiring ? `<span class="ap-chip warn">stops ${esc(relTime(t.expires_at))}</span>` : ''}
          <div class="muted apps-token-sub">${
            t.last_used_at ? 'last used ' + esc(relTime(t.last_used_at))
                           : 'never used - nothing has called Dek with this yet'}</div>
        </div>
        <div class="ap-acts">
          <button class="sm ghost" data-a="rotate">Rotate</button>
          <button class="sm danger" data-a="revoke">Kill</button>
        </div>
      </div>`;
    }).join('') || '<div class="empty">No token yet. Create one to make this app able to do anything.</div>'}
    </div>
    <button class="sm" data-a="newtoken">＋ Create token</button>
  </div>`;
}

// -------------------------------------------------------------- install UI

async function installDialog(host, org, app, spaces, existing) {
  const wsId = existing?.workspace_id || spaces.find((s) => !s.archived_at)?.id;
  if (!wsId) { toast('Make a Space first', 'error'); return; }

  let channels = [];
  try {
    channels = await api.rpc('admin_list_channels', { p_workspace: wsId });
  } catch { channels = []; }

  const chosen = new Set((existing?.channels || []).map((c) => c.id));
  const scopes = existing?.scopes ?? 1;

  const box = document.createElement('div');
  box.className = 'apps-install-form';
  box.innerHTML = `
    ${existing ? `<p class="muted">Changing what <b>${esc(app.name)}</b> may do in
        <b>${esc(existing.workspace_name)}</b>.</p>`
      : `<label class="apps-field"><span>Which Space?</span>
        <select id="afWs">${spaces.filter((s) => !s.archived_at).map((s) =>
          `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>`}

    <h3 class="apps-h3">What may it do?</h3>
    <div class="apps-scopes">${SCOPES.map((s) => `
      <label class="apps-scope${s.soon ? ' soon' : ''}">
        <input type="checkbox" data-bit="${s.bit}" ${(scopes & s.bit) === s.bit ? 'checked' : ''}
               ${s.soon ? 'disabled' : ''}>
        <span><b>${esc(s.label)}</b><em>${esc(s.hint)}</em></span>
      </label>`).join('')}</div>

    <h3 class="apps-h3">Which channels?</h3>
    <label class="apps-scope">
      <input type="radio" name="afScope" value="listed" ${existing?.channel_scope !== 'all' ? 'checked' : ''}>
      <span><b>Only the ones I pick</b><em>Anything else answers "no such channel", so the app cannot
        discover your private channels by guessing names.</em></span>
    </label>
    <label class="apps-scope">
      <input type="radio" name="afScope" value="all" ${existing?.channel_scope === 'all' ? 'checked' : ''}>
      <span><b>Every channel in the Space</b><em>Including private ones, and any made later.</em></span>
    </label>
    <div class="apps-chans" id="afChans">${channels.map((c) => `
      <label class="apps-chan"><input type="checkbox" value="${esc(c.id)}"
        ${chosen.has(c.id) ? 'checked' : ''}> #${esc(c.name)}</label>`).join('')
      || '<p class="muted">No channels to pick from.</p>'}</div>`;

  const syncChans = () => {
    const all = box.querySelector('[name="afScope"][value="all"]').checked;
    box.querySelector('#afChans').style.display = all ? 'none' : '';
  };
  box.querySelectorAll('[name="afScope"]').forEach((r) => r.addEventListener('change', syncChans));
  syncChans();

  modal({
    title: existing ? 'Change access' : `Install ${app.name}`,
    body: box,
    wide: true,
    actions: [{
      label: existing ? 'Save' : 'Install',
      onClick: async (close) => {
        const bits = [...box.querySelectorAll('[data-bit]:checked')]
          .reduce((n, el2) => n | Number(el2.dataset.bit), 0);
        const scope = box.querySelector('[name="afScope"]:checked').value;
        const chans = [...box.querySelectorAll('#afChans input:checked')].map((c) => c.value);
        const target = existing?.workspace_id || box.querySelector('#afWs').value;
        try {
          if (existing) {
            await api.rpc('update_install', {
              p_install: existing.id, p_scopes: bits, p_channel_scope: scope, p_channels: chans,
            });
          } else {
            await api.rpc('install_app', {
              p_app: app.id, p_workspace: target, p_scopes: bits,
              p_channel_scope: scope, p_channels: chans,
            });
          }
          toast(existing ? 'Saved' : 'Installed', 'success');
          close();
          openApp(host, org, app.id);
        } catch (e) { toast(e.message, 'error'); }
      },
    }],
  });
}

// --------------------------------------------------------------- the token

// Shown once, big, with a copy button, and saying plainly that it will not be
// shown again. Anything less and it gets pasted into a chat message to be
// "saved for later", which is how a token ends up somewhere it cannot be found.
function revealToken(token, note) {
  const box = document.createElement('div');
  box.innerHTML = `
    <p>${esc(note)} Copy it now and put it on the machine that will use it.</p>
    <div class="apps-token-reveal"><code>${esc(token)}</code></div>
    <button class="wide" id="afCopy">Copy token</button>
    <p class="muted">If you lose it, come back and rotate: you get a new one and the old
      keeps working for 48 hours.</p>`;
  const m = modal({ title: 'Your app token', body: box, wide: true });
  box.querySelector('#afCopy').onclick = () => {
    navigator.clipboard?.writeText(token);
    toast('Copied', 'success');
  };
  return m;
}

// ------------------------------------------------------------------- docs

// On the page, not behind a link, and carrying this reader's own channel name.
// The webhook screen this replaces printed a URL that returns 404, which is the
// most expensive kind of documentation there is.
function docsBlock(app, inst) {
  const ch = inst.channel_scope === 'all' ? 'general' : (inst.channels[0]?.name || 'general');
  const py = `import requests

r = requests.post(
    "${FN_URL}/messages",
    headers={"Authorization": "Bearer " + TOKEN},
    json={"channel": "${ch}", "text": "Loaded 14 trucks, 892 cases."},
)
print(r.json())`;
  const curl = `curl -X POST ${FN_URL}/whoami -H "Authorization: Bearer $TOKEN"`;

  return `
  <h2 class="ap-h2">How to use it</h2>
  <p class="muted">Start with this. It answers "is my token right" and lists every channel
    ${esc(app.name)} is allowed to post in.</p>
  <div class="apps-code"><pre>${esc(curl)}</pre>
    <button class="sm ghost" data-copy="${esc(curl)}">Copy</button></div>

  <p class="muted">Then post something. There is no SDK, no project key and no channel ID to look
    up: the channel is named the way people name it.</p>
  <div class="apps-code"><pre>${esc(py)}</pre>
    <button class="sm ghost" data-copy="${esc(py)}">Copy</button></div>

  <p class="muted">Assigning work is the same shape, at
    <code>${esc(FN_URL)}/tasks</code>, with <code>title</code> and an
    <code>assignee</code> given as a username or an email address.</p>`;
}

export const APPS_CSS = `
.apps-lede{max-width:62ch;margin:0 0 var(--s-4)}
.apps-back{margin-bottom:var(--s-3)}
.apps-install{border:var(--bw) solid var(--c-border);border-radius:var(--r-md);
  padding:var(--s-4);margin-bottom:var(--s-3)}
.apps-meta{display:grid;gap:var(--s-2);margin:var(--s-3) 0}
.apps-meta>div{display:flex;flex-wrap:wrap;gap:var(--s-2);align-items:center}
.apps-k{font-size:var(--t-xs);text-transform:uppercase;letter-spacing:var(--t-track-caps);
  color:var(--c-text-3);min-width:3em}
.apps-tokens{display:grid;gap:var(--s-2);margin:var(--s-3) 0}
.apps-token{display:flex;gap:var(--s-3);align-items:center;justify-content:space-between;
  border:var(--bw) solid var(--c-border);border-radius:var(--r-sm);padding:var(--s-2) var(--s-3)}
.apps-token-main{min-width:0}
.apps-token-main code{font-size:var(--t-sm)}
.apps-label{margin-left:var(--s-2);font-size:var(--t-sm);color:var(--c-text-2)}
.apps-token-sub{font-size:var(--t-xs);margin-top:2px}
.apps-token-reveal{background:var(--c-bg-2);border:var(--bw) solid var(--c-border);
  border-radius:var(--r-sm);padding:var(--s-3);margin:var(--s-3) 0;word-break:break-all}
.apps-token-reveal code{font-size:var(--t-sm)}
.apps-h3{font-size:var(--t-md);font-weight:var(--t-bold);margin:var(--s-4) 0 var(--s-2)}
.apps-scopes{display:grid;gap:var(--s-1)}
.apps-scope{display:flex;gap:var(--s-3);align-items:flex-start;padding:var(--s-2);
  border-radius:var(--r-sm);cursor:pointer}
.apps-scope:hover{background:var(--c-bg-2)}
.apps-scope.soon{opacity:.5;cursor:default}
.apps-scope input{margin-top:3px;flex:none}
.apps-scope span{display:block;min-width:0}
.apps-scope em{display:block;font-style:normal;font-size:var(--t-sm);color:var(--c-text-3);margin-top:2px}
.apps-field{display:block;margin-bottom:var(--s-3)}
.apps-field span{display:block;font-size:var(--t-sm);color:var(--c-text-2);margin-bottom:var(--s-1)}
.apps-field select{width:100%}
.apps-chans{display:flex;flex-wrap:wrap;gap:var(--s-2);margin-top:var(--s-2)}
.apps-chan{display:inline-flex;gap:var(--s-1);align-items:center;font-size:var(--t-sm);
  border:var(--bw) solid var(--c-border);border-radius:var(--r-pill);padding:2px var(--s-2)}
.apps-code{position:relative;margin:0 0 var(--s-4)}
.apps-code pre{background:var(--c-bg-2);border:var(--bw) solid var(--c-border);
  border-radius:var(--r-sm);padding:var(--s-3);overflow-x:auto;font-size:var(--t-sm);margin:0}
.apps-code button{position:absolute;top:var(--s-2);right:var(--s-2)}
@media (max-width:700px){
  .apps-token{flex-direction:column;align-items:stretch;gap:var(--s-2)}
  .apps-code button{position:static;margin-top:var(--s-2)}
}`;
