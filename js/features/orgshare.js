// Sharing an organisation, in one sheet.
//
// What this replaces: a form that asked three questions (role, max uses, expiry)
// BEFORE it would give you anything, then dropped a URL in a read-only input and
// left. Three decisions and a clipboard, to do the single most common thing
// anybody does with an organisation. It was also admin-only, so the twenty-two
// people in a sales area could not bring in the twenty-third.
//
// What people actually do, in the order they do it:
//
//   1. Hold the phone up so the room can scan it. This is the real one. These
//      are warehouse and sales staff standing in a group at the end of a shift;
//      nobody is typing a URL, and half of them will not check email today. So
//      the QR is the first thing in the sheet, at a size that survives being
//      photographed from two metres, and it is drawn locally (js/lib/qr.js) so
//      it still works on a floor with no signal.
//   2. Forward it on WhatsApp. That is what this product is replacing, which
//      makes it exactly the channel the invite has to leave through - the joke
//      being that the fastest way off WhatsApp runs through WhatsApp.
//   3. Copy it.
//
// Everything else - who they join as, how many may use it, when it dies - is a
// decision with a correct default (member, unlimited, never) and is folded away
// behind "Link settings". The sheet opens with a working link already minted,
// because a share sheet with nothing to share is a form.
//
// The token is only ever stored as a digest server-side, so a link cannot be
// re-displayed later from the database. It is cached in sessionStorage against
// its invite id so that reopening the sheet in the same sitting shows the SAME
// link rather than minting a pile of them; a new tab quite correctly gets a new
// link.
import { api, tryRpc } from '../api.js';
import { store } from '../store.js';
import { el, esc } from '../util.js';
import { toast, modal } from '../ui.js';
import { icon } from '../icons.js';
import { qrSvg } from '../lib/qr.js';

const CACHE = 'dek.orgshare.';

const cached = (orgId) => {
  try { return JSON.parse(sessionStorage.getItem(CACHE + orgId) || 'null'); } catch { return null; }
};
const remember = (orgId, v) => {
  try { sessionStorage.setItem(CACHE + orgId, JSON.stringify(v)); } catch { /* private mode */ }
};
const forget = (orgId) => {
  try { sessionStorage.removeItem(CACHE + orgId); } catch { /* private mode */ }
};

const linkFor = (token) => location.origin + location.pathname + '#/join-org/' + token;

const listInvites = async (orgId) => {
  const [rows] = await tryRpc('list_org_invites', { p_org: orgId });
  return Array.isArray(rows) ? rows : [];
};

const isLive = (row) => !row.revoked_at
  && (!row.expires_at || new Date(row.expires_at) > new Date())
  && (row.max_uses == null || row.uses < row.max_uses);

// Mint, then find the row we just made so the link can be shown AND revoked.
// create_org_invite returns the token alone - by design, since the id is
// worthless to somebody joining - so the id is recovered from the listing.
async function mint(orgId, opts = {}) {
  const token = await api.rpc('create_org_invite', {
    p_org: orgId,
    p_role: opts.role || 'member',
    p_max_uses: opts.uses ? +opts.uses : null,
    p_expires_at: opts.days ? new Date(Date.now() + 864e5 * opts.days).toISOString() : null,
  });
  let id = null;
  try {
    const rows = await listInvites(orgId);
    id = rows.find((r) => r.mine && isLive(r))?.id || null;
  } catch { /* the listing is a convenience; the link already works */ }
  const rec = { token, id, role: opts.role || 'member' };
  remember(orgId, rec);
  return rec;
}

const shareText = (org, link) => `Join ${org} on Dek: ${link}`;

function when(row) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return 'expired';
  if (row.max_uses != null && row.uses >= row.max_uses) return 'used up';
  const used = `${row.uses} ${row.uses === 1 ? 'person' : 'people'}`;
  const cap = row.max_uses != null ? ` of ${row.max_uses}` : '';
  const dies = row.expires_at
    ? ` - until ${new Date(row.expires_at).toLocaleDateString()}`
    : '';
  return `${used}${cap} joined${dies}`;
}

/**
 * The sheet. `orgId` is all it needs; everything else it works out.
 */
export async function openShareSheet(orgId) {
  const org = (store.orgs || []).find((o) => o.org_id === orgId);
  const name = org?.name || 'this organisation';
  const admin = org?.org_role === 'admin';

  const box = el('div', 'oshare');
  box.innerHTML = '<div class="oshare-load">Making a link…</div>';
  const m = modal({ title: 'Invite people to ' + name, body: box });

  // Reuse this sitting's link when it is still good; otherwise mint one now so
  // the sheet is never a form.
  let rec = cached(orgId);
  try {
    if (rec?.id) {
      const rows = await listInvites(orgId);
      const still = rows.find((r) => r.id === rec.id);
      if (!still || !isLive(still)) rec = null;
    } else if (rec && !rec.id) {
      rec = null; // pre-id cache entry, cannot be verified or revoked
    }
    if (!rec) rec = await mint(orgId);
  } catch (e) {
    box.innerHTML = `<div class="oshare-err">${esc(shareError(e))}</div>`;
    return;
  }

  const paint = async () => {
    const link = linkFor(rec.token);
    const canNativeShare = typeof navigator !== 'undefined' && !!navigator.share;

    // Does this link actually lead anywhere? redeem_org_invite drops an arriving
    // person into every OPEN server, so an organisation with none of those has a
    // link that makes people members of nothing they can see. Every org created
    // before 0109 is in exactly that state, because its founding server took the
    // 'invite' column default. Worth one round trip: handing out a link that
    // quietly does nothing is the worst outcome this sheet has.
    let dead = null;
    try {
      const [spaces] = await tryRpc('list_org_spaces', { p_org: orgId });
      const live = (Array.isArray(spaces) ? spaces : []).filter((s) => !s.archived_at);
      if (live.length && !live.some((s) => s.join_policy === 'open')) dead = live[0];
    } catch { /* if we cannot tell, say nothing rather than cry wolf */ }

    box.innerHTML = `
      ${dead ? `<div class="oshare-warn">
        <b>People who open this will not see any server.</b>
        <span>Every server in ${esc(name)} is invite-only, so they will join the
        organisation and land in an empty app.</span>
        ${admin
          ? `<button class="sm" type="button" data-a="open">Let them into ${esc(dead.name)}</button>`
          : '<span>Ask an admin to open one.</span>'}
      </div>` : ''}

      <div class="oshare-qrwrap">
        <div class="oshare-qr">${qrSvg(link, { scale: 6, quiet: 3 })}</div>
        <div class="oshare-scan">${icon('qr')}<span>Point a camera at this</span></div>
      </div>

      <div class="oshare-linkrow">
        <input class="oshare-url" readonly value="${esc(link)}" aria-label="Invite link" />
        <button class="oshare-copy" type="button">${icon('copy')}<span>Copy</span></button>
      </div>

      <div class="oshare-send">
        <button class="oshare-chip oshare-wa" type="button" data-a="wa">
          ${icon('whatsapp')}<span>WhatsApp</span></button>
        <button class="oshare-chip" type="button" data-a="mail">
          ${icon('mail')}<span>Email</span></button>
        ${canNativeShare ? `<button class="oshare-chip" type="button" data-a="share">
          ${icon('share')}<span>Share</span></button>` : ''}
        <button class="oshare-chip" type="button" data-a="save">
          ${icon('download')}<span>Save QR</span></button>
      </div>

      <p class="oshare-note">Anyone who opens this joins <b>${esc(name)}</b>${
        rec.role === 'admin' ? ' <b>as an admin</b>' : ''
      } and lands in every open server in it.</p>

      <details class="oshare-fold">
        <summary>${icon('settings')}<span>Link settings</span></summary>
        <div class="oshare-form">
          <label>They join as
            <select data-f="role">
              <option value="member"${rec.role !== 'admin' ? ' selected' : ''}>Member</option>
              ${admin ? `<option value="admin"${rec.role === 'admin' ? ' selected' : ''}>Admin</option>` : ''}
            </select>
          </label>
          <label>Limit to
            <input type="number" min="1" data-f="uses" placeholder="no limit" />
          </label>
          <label>Expires in
            <input type="number" min="1" data-f="days" placeholder="never" />
          </label>
          <button class="sm" type="button" data-a="remint">Make a new link</button>
          <p class="muted oshare-small">The link above keeps working until you revoke it below.</p>
        </div>
      </details>

      <details class="oshare-fold oshare-existing">
        <summary>${icon('link')}<span>Links you have made</span></summary>
        <div class="oshare-list"><div class="muted oshare-small">loading…</div></div>
      </details>`;

    const $ = (s) => box.querySelector(s);

    // Copy, with the confirmation ON the button - a toast for something this
    // small reads as an error to people who are not looking for it.
    $('.oshare-copy').onclick = async () => {
      const btn = $('.oshare-copy');
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        // Clipboard API refuses without a secure context or a user gesture it
        // recognises; selecting the field at least leaves one keystroke to go.
        $('.oshare-url').select();
        toast('Press Ctrl+C to copy', 'info');
        return;
      }
      btn.classList.add('is-done');
      btn.innerHTML = `${icon('check')}<span>Copied</span>`;
      setTimeout(() => {
        btn.classList.remove('is-done');
        btn.innerHTML = `${icon('copy')}<span>Copy</span>`;
      }, 1600);
    };
    $('.oshare-url').onclick = (e) => e.target.select();

    const act = (n, fn) => { const b = box.querySelector(`[data-a="${n}"]`); if (b) b.onclick = fn; };

    act('open', async () => {
      try {
        await api.setJoinPolicy(dead.id, 'open');
        await paint();
        toast(`${dead.name} is open. People who join land there.`, 'success');
      } catch (e) { toast(shareError(e), 'error'); }
    });

    act('wa', () => window.open(
      'https://wa.me/?text=' + encodeURIComponent(shareText(name, link)), '_blank', 'noopener'));

    act('mail', () => {
      const subject = `Join ${name} on Dek`;
      const body = `${shareText(name, link)}\n\n`
        + `Open the link on your phone and follow the two steps. `
        + `If your camera is easier, ask me to show you the code.`;
      window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    });

    act('share', async () => {
      try {
        await navigator.share({ title: `Join ${name} on Dek`, text: shareText(name, link), url: link });
      } catch { /* the sheet was dismissed; not an error */ }
    });

    // Saving the QR is what puts it on a noticeboard, which is how the people
    // who were not in the room that day still get in.
    act('save', () => {
      const svg = qrSvg(link, { scale: 12, quiet: 4 });
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `join-${(name || 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.svg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });

    act('remint', async () => {
      const role = $('[data-f="role"]')?.value || 'member';
      const uses = $('[data-f="uses"]')?.value || null;
      const days = $('[data-f="days"]')?.value || null;
      try {
        rec = await mint(orgId, { role, uses, days });
        await paint();
        toast('New link ready', 'success');
      } catch (e) { toast(shareError(e), 'error'); }
    });

    // The listing is only fetched when the fold is opened - it is the rarest
    // thing in the sheet and it costs a round trip.
    const fold = $('.oshare-existing');
    let loaded = false;
    const fill = async () => {
      const host = $('.oshare-list');
      if (!host) return;
      let rows = [];
      try { rows = await listInvites(orgId); }
      catch { host.innerHTML = '<div class="muted oshare-small">Could not load them.</div>'; return; }
      if (!rows.length) {
        host.innerHTML = '<div class="muted oshare-small">No links yet.</div>';
        return;
      }
      host.innerHTML = rows.map((r) => `
        <div class="oshare-row${isLive(r) ? '' : ' is-dead'}" data-id="${r.id}">
          <div class="oshare-rowmain">
            <b>${r.grant_role === 'admin' ? 'Admin link' : 'Member link'}</b>
            <span class="muted oshare-small">${esc(when(r))}${
              r.mine ? '' : ` - by ${esc(r.created_by_name)}`}</span>
          </div>
          ${isLive(r) ? '<button class="sm ghost" data-revoke="1">Revoke</button>' : ''}
        </div>`).join('');
      host.querySelectorAll('.oshare-row').forEach((row) => {
        row.querySelector('[data-revoke]')?.addEventListener('click', async () => {
          try {
            await api.rpc('revoke_org_invite', { p_invite: row.dataset.id });
            // If the link on screen is the one just killed, the sheet must not
            // go on offering it.
            if (row.dataset.id === rec.id) {
              forget(orgId);
              rec = await mint(orgId, { role: rec.role });
              await paint();
              toast('Revoked. Here is a fresh link.', 'success');
              return;
            }
            await fill();
            toast('Revoked', 'success');
          } catch (e) { toast(shareError(e), 'error'); }
        });
      });
    };
    fold.addEventListener('toggle', () => { if (fold.open && !loaded) { loaded = true; fill(); } });
  };

  await paint();
}

export function shareError(e) {
  const msg = String(e?.message || '');
  if (/org_deleted/.test(msg)) return 'This organisation is being deleted, so it takes no new people.';
  if (/Only an admin can invite/.test(msg)) return 'Only an admin can hand out admin links.';
  if (/Join the organisation/.test(msg)) return 'You are not in this organisation.';
  if (/only revoke a link you made/.test(msg)) return 'You can only revoke a link you made.';
  if (/forbidden/.test(msg)) return 'You do not have permission to do that here.';
  return msg || 'That did not work.';
}

export function register() {
  // Nothing to mount: the sheet is opened from the org tile's menu, the servers
  // directory and the rail's + chooser, all of which import it directly. The
  // export exists because the registry calls it on every feature.
}
