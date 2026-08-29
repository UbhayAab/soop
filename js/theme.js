// Look and mode: two axes, because they were never one.
//
// This file used to offer "dark", "light" and "colorful" from a single control,
// which quietly conflated two different questions. Dark and light are a MODE -
// how bright the room is. Colorful was a LOOK - the Slack aubergine chrome. Ask
// them together and you can never answer "I want the aubergine, but at night",
// and you can never add a second look without doubling the list.
//
// So now:
//   <html data-theme="saffron">   the LOOK. Five of them, each a designed
//                                 visual language with its own type, radius,
//                                 border weight and palette.
//   <html data-mode="system">     what the person CHOSE: light, dark or system.
//   <html data-scheme="dark">     what that RESOLVES to right now. Always
//                                 concrete, never "system".
//
// data-scheme is the one that matters to CSS. Before it existed, rules that
// needed "am I on a dark ground" enumerated theme ids - `[data-theme="dark"],
// :root:not([data-theme])` - and every such selector silently stopped applying
// the moment a sixth id existed. Nothing in this codebase may enumerate look ids
// in a selector again; key on [data-scheme] instead.
import { $, el, esc } from './util.js';
import { popover, toast } from './ui.js';

const LOOK_KEY = 'dak.look';
const MODE_KEY = 'dak.mode';
const LEGACY_KEYS = ['dak.theme', 'hearth.theme'];

// The five looks. `swatch` is [nav ground, work surface, accent] and is what the
// picker draws - people choose a theme by looking at it, not by reading its name.
// `fonts` is a Google Fonts query, loaded lazily by applyLook: a warehouse phone
// on a bad connection should not download five typefaces to use one.
// The names are the designed ones. The hints are NOT: each look arrived with a
// line like "three bone papers, a single vermilion numeral", which is how a
// designer describes a thing and not how a dispatch supervisor at a namkeen
// factory decides which one to tap. The names carry the character; the hint
// underneath has one job, which is to tell somebody what they are about to get.
export const LOOKS = [
  {
    id: 'saffron',
    name: 'Saffron',
    hint: 'Purple sidebar, white chat. Closest to before.',
    swatch: ['#341237', '#FFFFFF', '#E8A02A'],
    fonts: 'family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Instrument+Sans:wght@400;500;600;700&family=Noto+Sans+Devanagari:wght@400;500;700',
  },
  {
    id: 'enterprise',
    name: 'Dispatch Ledger',
    hint: 'Navy and white, dense, made for long shifts',
    swatch: ['#0C2340', '#FFFFFF', '#14539E'],
    fonts: 'family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@600&family=IBM+Plex+Sans:wght@400;500;600;700',
  },
  {
    id: 'precision',
    name: 'Graphite Caliper',
    hint: 'Very dark and compact. Easiest at night.',
    swatch: ['#08090B', '#111317', '#E0301F'],
    fonts: 'family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700',
  },
  {
    id: 'editorial',
    name: 'Bone and Rule',
    hint: 'Warm paper, thin lines, almost no colour',
    swatch: ['#F5F3EC', '#FBFAF6', '#14120E'],
    fonts: 'family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..900;1,6..96,400..700&family=Instrument+Sans:wdth,wght@75..100,400..700',
  },
  {
    id: 'swiss',
    name: 'Signal Grid',
    hint: 'Black and white with one orange. Very plain.',
    swatch: ['#F3F2EE', '#FFFFFF', '#EB3B00'],
    fonts: 'family=Archivo:wght@400;500;600;700&family=Noto+Sans+Devanagari:wght@400;600',
  },
];

export const MODES = [
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
  { id: 'system', name: 'Match device' },
];

// Saffron by default: it is the closest to what the app looked like before, so
// nobody's first launch after the update is a shock, and it is the one that
// reads as a product rather than as a statement.
export const DEFAULT_LOOK = 'saffron';
export const DEFAULT_MODE = 'system';

export const isLook = (id) => LOOKS.some((l) => l.id === id);
export const isMode = (id) => MODES.some((m) => m.id === id);
// Values that are no longer ids here but that somebody outside this codebase may
// still be sending. A dashboard has been passing {theme:'colorful'} over the
// embed bridge for months; renaming the look inside our own repo is not a reason
// to start answering that host with an error. js/embed.js discovers this
// predicate by name, so the knowledge stays here rather than being a theme id
// hardcoded in the bridge - which is the one thing this refactor forbids.
export const isLegacyThemeValue = (id) => id === 'colorful';
export const lookById = (id) => LOOKS.find((l) => l.id === id) || LOOKS.find((l) => l.id === DEFAULT_LOOK);

const media = window.matchMedia('(prefers-color-scheme: dark)');

// Old stored values were a single string. Map each onto the two axes rather than
// dropping people back to the default, because a theme silently resetting is the
// kind of small betrayal nobody reports and everybody notices.
//   colorful -> saffron. It WAS the aubergine look; this is that look, done properly.
//   dark / light -> the default look, with the mode they had asked for.
function migrateLegacy() {
  let legacy = null;
  for (const k of LEGACY_KEYS) {
    try { legacy = legacy || localStorage.getItem(k); } catch { /* private mode */ }
  }
  if (!legacy) return null;
  if (legacy === 'colorful') return { look: 'saffron', mode: 'light' };
  if (legacy === 'dark' || legacy === 'light') return { look: DEFAULT_LOOK, mode: legacy };
  if (legacy === 'system') return { look: DEFAULT_LOOK, mode: 'system' };
  return null;
}

export function storedLook() {
  try {
    const v = localStorage.getItem(LOOK_KEY);
    if (isLook(v)) return v;
    const m = migrateLegacy();
    if (m) { try { localStorage.setItem(LOOK_KEY, m.look); } catch { /* ignore */ } return m.look; }
  } catch { /* private mode */ }
  return DEFAULT_LOOK;
}

export function storedMode() {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (isMode(v)) return v;
    const m = migrateLegacy();
    if (m) { try { localStorage.setItem(MODE_KEY, m.mode); } catch { /* ignore */ } return m.mode; }
  } catch { /* private mode */ }
  return DEFAULT_MODE;
}

// What is actually painted right now. Never returns 'system'.
export const resolvedScheme = (mode = storedMode()) =>
  (mode === 'system' ? (media.matches ? 'dark' : 'light') : mode);

// Lazily pull a look's typefaces. Only the active look's fonts are ever fetched,
// and the tag is reused so switching back and forth does not stack link elements.
function loadFonts(look) {
  const q = lookById(look).fonts;
  let tag = document.getElementById('lookFonts');
  if (!q) { if (tag) tag.remove(); return; }
  const href = `https://fonts.googleapis.com/css2?${q}&display=swap`;
  if (!tag) {
    tag = document.createElement('link');
    tag.id = 'lookFonts';
    tag.rel = 'stylesheet';
    document.head.appendChild(tag);
  }
  if (tag.href !== href) tag.href = href;
}

export function applyTheme(look = storedLook(), mode = storedMode()) {
  const l = isLook(look) ? look : DEFAULT_LOOK;
  const m = isMode(mode) ? mode : DEFAULT_MODE;
  const scheme = resolvedScheme(m);
  const root = document.documentElement;
  root.setAttribute('data-theme', l);
  root.setAttribute('data-mode', m);
  root.setAttribute('data-scheme', scheme);
  loadFonts(l);

  // Keep the mobile browser chrome in step with the app, otherwise a light theme
  // sits under a black status bar and looks broken on a phone.
  const bg = getComputedStyle(root).getPropertyValue('--c-nav-bg').trim() || '#14161a';
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = bg;
}

export function setLook(look) {
  if (!isLook(look)) return;
  try { localStorage.setItem(LOOK_KEY, look); } catch { /* private mode */ }
  applyTheme(look, storedMode());
  document.dispatchEvent(new CustomEvent('themechange', { detail: { look, mode: storedMode() } }));
}

export function setMode(mode) {
  if (!isMode(mode)) return;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
  applyTheme(storedLook(), mode);
  document.dispatchEvent(new CustomEvent('themechange', { detail: { look: storedLook(), mode } }));
}

export function initTheme() {
  applyTheme();
  // Only react to the OS while the person is actually following it.
  const onSystem = () => { if (storedMode() === 'system') applyTheme(); };
  if (media.addEventListener) media.addEventListener('change', onSystem);
  else media.addListener(onSystem);
}

// ------------------------------------------------------------------ the picker
// A grid of looks, each drawn as a miniature of the app rather than as three
// coloured dots. The dots told you a theme had a purple in it somewhere; the
// miniature tells you what the sidebar will feel like next to the conversation,
// which is the thing people are actually choosing between.
function lookCard(l, activeLook) {
  const [nav, surface, accent] = l.swatch;
  return `
    <button class="look-card${l.id === activeLook ? ' is-active' : ''}" data-look="${esc(l.id)}"
            type="button" role="radio" aria-checked="${l.id === activeLook}">
      <span class="look-mini" aria-hidden="true">
        <span class="lm-rail" style="background:${esc(nav)}"></span>
        <span class="lm-side" style="background:${esc(nav)}">
          <i style="background:${esc(accent)}"></i><i></i><i></i>
        </span>
        <span class="lm-main" style="background:${esc(surface)}">
          <b></b><b></b><b class="lm-short"></b>
        </span>
      </span>
      <span class="look-name">${esc(l.name)}</span>
      <span class="look-hint">${esc(l.hint)}</span>
      <span class="look-tick" aria-hidden="true">✓</span>
    </button>`;
}

export function themePickerBody() {
  const box = el('div', 'theme-picker');
  const paint = () => {
    const look = storedLook();
    const mode = storedMode();
    box.innerHTML = `
      <div class="tp-head">Look</div>
      <div class="look-grid" role="radiogroup" aria-label="Look">
        ${LOOKS.map((l) => lookCard(l, look)).join('')}
      </div>
      <div class="tp-head">Brightness</div>
      <div class="mode-row" role="radiogroup" aria-label="Brightness">
        ${MODES.map((m) => `
          <button class="mode-btn${m.id === mode ? ' is-active' : ''}" data-mode="${esc(m.id)}"
                  type="button" role="radio" aria-checked="${m.id === mode}">${esc(m.name)}</button>`).join('')}
      </div>`;
    box.querySelectorAll('[data-look]').forEach((b) => {
      b.onclick = () => { setLook(b.dataset.look); paint(); };
    });
    box.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => { setMode(b.dataset.mode); paint(); };
    });
  };
  paint();
  return box;
}

export function openThemePicker(anchor) {
  return popover(anchor, themePickerBody(), { below: true, cls: 'popover-theme' });
}

// Cycle looks, for comparing them quickly. Driven off the LOOKS array rather
// than a hardcoded list, so adding a sixth look does not leave this behind.
export function cycleTheme() {
  const ids = LOOKS.map((l) => l.id);
  const i = ids.indexOf(storedLook());
  const next = ids[(i + 1) % ids.length];
  setLook(next);
  toast(`${lookById(next).name}`);
}

// Kept so older call sites and the embed bridge keep working. setTheme accepts
// either axis and routes it, because a host page saying {theme:'dark'} means a
// mode and a host saying {theme:'swiss'} means a look.
export function setTheme(value) {
  if (isLook(value)) return setLook(value);
  if (isMode(value)) return setMode(value);
  const m = value === 'colorful' ? 'saffron' : null;
  if (m) return setLook(m);
}
export const THEMES = LOOKS;
export const storedTheme = storedLook;
export const effectiveTheme = () => storedLook();
