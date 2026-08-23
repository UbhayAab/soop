// The UI kit and the extension registry. Feature modules never touch the shell
// markup directly - they register through here, so features can be added in
// parallel without colliding.
import { $, el, esc } from './util.js';
import { bus } from './store.js';

// ------------------------------------------------------------------ toasts
let toastHost;
export function toast(msg, kind = 'info', ms = 3200) {
  if (!toastHost) {
    toastHost = el('div', 'toasts');
    document.body.appendChild(toastHost);
  }
  const t = el('div', 'toast toast-' + kind, esc(msg));
  toastHost.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
  return t;
}

// ------------------------------------------------------------------ modals
// modal({title, body, actions:[{label,kind,onClick(close)}], wide}) -> {root, body, close}
export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const back = el('div', 'modal-back');
  const box = el('div', 'modal' + (wide ? ' modal-wide' : ''));
  const head = el('div', 'modal-head', `<strong>${esc(title || '')}</strong>`);
  const x = el('button', 'icon', '✕');
  head.appendChild(x);
  const bodyEl = el('div', 'modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const foot = el('div', 'modal-foot');
  box.append(head, bodyEl, foot);
  back.appendChild(box);

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  x.onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };

  for (const a of actions) {
    const b = el('button', a.kind === 'ghost' ? 'ghost' : a.kind === 'danger' ? 'danger' : '', esc(a.label));
    b.onclick = () => a.onClick?.(close, bodyEl);
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();

  document.body.appendChild(back);
  setTimeout(() => box.querySelector('input,textarea,select,button')?.focus(), 30);
  return { root: back, box, body: bodyEl, foot, close };
}

export function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<p>${esc(body || '')}</p>`,
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: (c) => { done = true; c(); resolve(false); } },
        { label: confirmLabel, kind: danger ? 'danger' : '', onClick: (c) => { done = true; c(); resolve(true); } },
      ],
    });
    m.box.querySelector('.modal-foot button:last-child')?.focus();
  });
}

// For the handful of actions that destroy other people's work. A confirm button
// is muscle memory by the third time somebody sees it; typing the name back is
// not, and it is the only guard that reliably stops the wrong row being deleted.
// `phrase` is what has to be typed - always the actual name of the thing.
export function typeToConfirm({ title, body, phrase, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    let done = false;
    const box = el('div');
    box.innerHTML = `<p>${esc(body || '')}</p>
      <label class="field"><span class="field-label">Type <b>${esc(phrase)}</b> to confirm</span>
        <input id="ttcInput" autocomplete="off" spellcheck="false" placeholder="${esc(phrase)}" /></label>`;
    const m = modal({
      title,
      body: box,
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: (c) => { done = true; c(); resolve(false); } },
        { label: confirmLabel, kind: 'danger', onClick: (c) => { done = true; c(); resolve(true); } },
      ],
    });
    const go = m.box.querySelector('.modal-foot button:last-child');
    const input = box.querySelector('#ttcInput');
    // Disabled until it matches, so the dangerous button is never the easy one.
    go.disabled = true;
    const check = () => { go.disabled = input.value.trim() !== phrase; };
    input.addEventListener('input', check);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !go.disabled) { e.preventDefault(); go.click(); }
    });
    setTimeout(() => input.focus(), 40);
  });
}

// A real replacement for window.prompt: fields = [{name,label,type,value,placeholder,options,rows,required}]
export function formModal({ title, fields = [], submitLabel = 'Save', wide = false, note }) {
  return new Promise((resolve) => {
    let done = false;
    const form = el('form', 'form');
    for (const f of fields) {
      const wrap = el('label', 'field');
      wrap.appendChild(el('span', 'field-label', esc(f.label || f.name)));
      let input;
      if (f.type === 'textarea') {
        input = el('textarea');
        input.rows = f.rows || 4;
      } else if (f.type === 'select') {
        input = el('select');
        for (const o of f.options || []) {
          const opt = el('option', null, esc(o.label ?? o));
          opt.value = o.value ?? o;
          input.appendChild(opt);
        }
      } else if (f.type === 'checkbox') {
        input = el('input');
        input.type = 'checkbox';
        input.checked = !!f.value;
        wrap.classList.add('field-check');
      } else {
        input = el('input');
        input.type = f.type || 'text';
      }
      if (f.type !== 'checkbox' && f.value != null) input.value = f.value;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.required) input.required = true;
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      input.name = f.name;
      wrap.appendChild(input);
      if (f.hint) wrap.appendChild(el('span', 'field-hint', esc(f.hint)));
      form.appendChild(wrap);
    }
    if (note) form.appendChild(el('p', 'muted', esc(note)));

    const m = modal({
      title, body: form, wide,
      onClose: () => { if (!done) resolve(null); },
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: (c) => { done = true; c(); resolve(null); } },
        {
          label: submitLabel,
          onClick: (c) => {
            const out = {};
            for (const f of fields) {
              const i = form.elements[f.name];
              out[f.name] = f.type === 'checkbox' ? i.checked : i.value;
            }
            const missing = fields.find((f) => f.required && !String(out[f.name] || '').trim());
            if (missing) { toast(`${missing.label || missing.name} is required`, 'error'); return; }
            done = true; c(); resolve(out);
          },
        },
      ],
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      m.foot.querySelector('button:last-child').click();
    };
  });
}

// ------------------------------------------------------------------ side panel
const panels = new Map();
let activePanel = null;

// registerPanel({id, title, icon, render(bodyEl, ctx), footer(footEl), onClose})
export function registerPanel(def) { panels.set(def.id, def); }

export async function openPanel(id, ctx = {}) {
  const def = panels.get(id);
  if (!def) return console.warn('no panel', id);
  activePanel = id;
  const aside = $('panel');
  aside.classList.remove('hidden');
  document.body.classList.add('panel-open');
  // Android Back must close the sheet, not the app. A pushed entry per open,
  // consumed by the popstate handler in main.js. Programmatic closes (the X)
  // leave a harmless extra entry whose popstate finds nothing to do.
  if (!history.state?.dekPanel) history.pushState({ dekPanel: id }, '');
  $('panelTitle').textContent = typeof def.title === 'function' ? def.title(ctx) : def.title;
  const body = $('panelContent');
  body.innerHTML = '<div class="muted pad">loading…</div>';
  const foot = $('panelFooter');
  foot.innerHTML = '';
  foot.classList.add('hidden');
  try {
    await def.render(body, ctx);
    if (def.footer) { foot.classList.remove('hidden'); await def.footer(foot, ctx); }
  } catch (e) {
    body.innerHTML = `<div class="muted pad">${esc(e.message || 'failed to load')}</div>`;
  }
}

export function closePanel() {
  const id = activePanel;
  activePanel = null;
  $('panel').classList.add('hidden');
  document.body.classList.remove('panel-open');
  $('panelContent').innerHTML = '';
  $('panelFooter').innerHTML = '';
  $('panelFooter').classList.add('hidden');
  if (id) panels.get(id)?.onClose?.();
  bus.emit('panel:close', { id });
}

export const currentPanel = () => activePanel;
export const refreshPanel = (ctx) => (activePanel ? openPanel(activePanel, ctx || {}) : null);

// ------------------------------------------------------------------ header buttons
const headerButtons = [];
export function addHeaderButton(def) {
  headerButtons.push({ order: 50, ...def });
  renderHeaderButtons();
}
// Visible, in registration order, after the show() filter. The shell decides how
// many of these fit on the channel bar and puts the rest behind one overflow
// menu - a feature never has to know which side of that line it landed on.
export function getHeaderButtons() {
  return [...headerButtons].sort((a, z) => a.order - z.order)
    .filter((b) => !b.show || b.show());
}

// Only the first `inlineCap` render as buttons. Thirteen identical glyphs in a
// row is a wall, not a toolbar.
export let inlineCap = 4;
export function setInlineCap(n) { inlineCap = n; renderHeaderButtons(); }

export function renderHeaderButtons() {
  const host = $('headerActions');
  if (!host) return;
  host.innerHTML = '';
  for (const b of getHeaderButtons().slice(0, inlineCap)) {
    const n = el('button', 'icon' + (b.cls ? ' ' + b.cls : ''), b.label);
    n.title = b.title || '';
    // Icon-only buttons contain an SVG with no text, so without this a screen
    // reader announces nothing at all.
    n.setAttribute('aria-label', b.title || b.id);
    n.id = 'hb-' + b.id;
    n.onclick = (e) => b.onClick(e);
    host.appendChild(n);
  }
}

// ------------------------------------------------------------------ nav sections
const navSections = [];
// addNavSection({id, order, render(hostEl)}) - rendered under the channel list
export function addNavSection(def) { navSections.push({ order: 50, ...def }); }
// Serialised, and built detached.
//
// This used to clear #navExtra and then append one wrapper per section, awaiting
// each section's render in between. Both halves are a problem. Clearing first
// means a second call that arrives during the first one's await wipes what the
// first has already put on screen, and the first then carries on appending into
// a host somebody else has since rebuilt. Measured with three features listening
// to overlapping events (workspace, channels, voice:state - all of which fire
// together when a Space opens): seven rows rendered twenty-one times.
//
// So: one run at a time, and if calls arrive while it is going, do exactly one
// more pass at the end rather than one per caller. The tree is assembled in a
// fragment and swapped in a single assignment, so the sidebar never shows a
// half-built list.
let navRun = null;
let navAgain = false;
export async function renderNavSections() {
  if (navRun) { navAgain = true; return navRun; }
  navRun = (async () => {
    try {
      do {
        navAgain = false;
        const host = $('navExtra');
        if (!host) return;
        const frag = document.createDocumentFragment();
        for (const s of [...navSections].sort((a, z) => a.order - z.order)) {
          if (s.show && !s.show()) continue;
          const wrap = el('div', 'navsec');
          frag.appendChild(wrap);
          try { await s.render(wrap); } catch (e) { console.warn('navsec', s.id, e); }
        }
        host.replaceChildren(frag);
      } while (navAgain);
    } finally { navRun = null; }
  })();
  return navRun;
}

// ------------------------------------------------------------------ message actions
const messageActions = [];
// addMessageAction({id, label, title, order, show(msg), onClick(msg, ev, el)})
export function addMessageAction(def) { messageActions.push({ order: 50, ...def }); }
export const getMessageActions = (msg) =>
  [...messageActions].sort((a, z) => a.order - z.order).filter((a) => !a.show || a.show(msg));

// ------------------------------------------------------------------ composer buttons
const composerButtons = [];
export function addComposerButton(def) { composerButtons.push({ order: 50, ...def }); }
export function renderComposerButtons() {
  const host = $('composerTools');
  if (!host) return;
  host.innerHTML = '';
  for (const b of [...composerButtons].sort((a, z) => a.order - z.order)) {
    if (b.show && !b.show()) continue;
    const n = el('button', 'icon', b.label);
    n.title = b.title || '';
    n.type = 'button';
    n.onclick = (e) => b.onClick(e);
    host.appendChild(n);
  }
}

// ------------------------------------------------------------------ slash commands
const slashCommands = new Map();
// addSlashCommand({name, description, args, run(argText)})
// Warns on a collision, and lowercases, because runSlash() looks up lowercased
// and a def registered with any capital letter could never be found.
//
// The warning is the point. This is a Map, features load through Promise.all, so
// a name registered twice resolves to whichever module happened to finish last -
// nondeterministically, between reloads. /me was registered by profilepage.js
// ("open your profile") and shortcuts.js ("send an action in italics"), and
// /roles by onboarding.js and roles.js, so the help sheet listed a description
// that did not necessarily match what pressing it did.
export function addSlashCommand(def) {
  const key = def.name.replace(/^\//, '').toLowerCase();
  if (slashCommands.has(key)) {
    console.warn(`[Dek] slash command /${key} registered twice; the later one wins, `
      + 'and which one that is depends on network timing. Rename one.');
  }
  slashCommands.set(key, def);
}
export const listSlash = () => [...slashCommands.values()];
export function findSlash(name) { return slashCommands.get((name || '').replace(/^\//, '')); }

// Returns true if the text was handled as a slash command.
export async function runSlash(text) {
  const m = (text || '').match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return false;
  const cmd = slashCommands.get(m[1].toLowerCase());
  if (!cmd) return false;
  try { await cmd.run(m[2].trim()); } catch (e) { toast(e.message || 'command failed', 'error'); }
  return true;
}

// ------------------------------------------------------------------ quick switcher sources
const switcherSources = [];
// addSwitcherSource({id, search(q) -> [{label, hint, icon, run()}]})
export function addSwitcherSource(def) { switcherSources.push(def); }
export const getSwitcherSources = () => switcherSources;

// ------------------------------------------------------------------ context menu
export function contextMenu(ev, items) {
  document.querySelector('.ctxmenu')?.remove();
  const menu = el('div', 'ctxmenu');
  for (const it of items) {
    if (it === '-') { menu.appendChild(el('div', 'ctx-sep')); continue; }
    if (it.show === false) continue;
    const b = el('div', 'ctx-item' + (it.danger ? ' danger' : ''), esc(it.label));
    b.onclick = () => { menu.remove(); it.onClick?.(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const x = Math.min(ev.clientX, window.innerWidth - r.width - 8);
  const y = Math.min(ev.clientY, window.innerHeight - r.height - 8);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  const away = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', away); }
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
  return menu;
}

// ------------------------------------------------------------------ popover
export function popover(anchorEl, contentEl, opts = {}) {
  document.querySelector('.popover')?.remove();
  const p = el('div', 'popover' + (opts.cls ? ' ' + opts.cls : ''));
  p.appendChild(contentEl);
  document.body.appendChild(p);
  // A caller that anchored off a header button which ended up in the overflow
  // menu hands us null. Throwing here was worse than useless: the popover had
  // already been appended, so it stayed in the DOM as a fixed element with no top
  // or left, parked off the bottom of the page. Cheap insurance for every feature
  // that anchors off a header button, not just the one that was found doing it.
  const anchor = anchorEl && anchorEl.getBoundingClientRect ? anchorEl : document.body;
  const a = anchor.getBoundingClientRect();
  const r = p.getBoundingClientRect();
  let top = opts.below ? a.bottom + 6 : a.top - r.height - 6;
  if (top < 8) top = a.bottom + 6;
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
  let left = Math.min(a.left, window.innerWidth - r.width - 8);
  p.style.top = top + 'px';
  p.style.left = Math.max(8, left) + 'px';
  const away = (e) => {
    if (!p.contains(e.target) && !anchor.contains(e.target)) {
      p.remove();
      document.removeEventListener('mousedown', away);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
  return { el: p, close: () => p.remove() };
}

export function closePopovers() {
  document.querySelector('.popover')?.remove();
  document.querySelector('.ctxmenu')?.remove();
}

// ------------------------------------------------------------------ misc
export function spinner(text = 'loading…') { return el('div', 'muted pad', esc(text)); }
export function emptyState(text) { return el('div', 'empty', esc(text)); }

export const ui = {
  toast, modal, confirmModal, typeToConfirm, formModal, getHeaderButtons, setInlineCap,
  registerPanel, openPanel, closePanel, refreshPanel, currentPanel,
  addHeaderButton, renderHeaderButtons, addNavSection, renderNavSections,
  addMessageAction, getMessageActions, addComposerButton, renderComposerButtons,
  addSlashCommand, listSlash, findSlash, runSlash,
  addSwitcherSource, getSwitcherSources,
  contextMenu, popover, closePopovers, spinner, emptyState,
};

export default ui;
