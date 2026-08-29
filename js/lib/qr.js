// A QR encoder, because the join link has to survive being carried across a
// room.
//
// The realistic way somebody joins a Space at a 200-person namkeen company is
// not a pasted URL. It is a supervisor holding a phone up at the end of a shift
// meeting and twenty people pointing their cameras at it. That needs a QR code
// on screen, and it needs to work with no network, because the warehouse floor
// does not have any.
//
// So: no library. The CSP on this deployment allows scripts from exactly four
// CDNs and stylesheets from none, the service worker precaches the whole shell
// for offline use, and a QR generator that needs a round trip is a QR generator
// that fails in the one room it exists for. This is ~260 lines and it is
// checkable - probe-qr.mjs decodes what it draws.
//
// Scope is deliberately narrow: byte mode, error-correction level M, versions
// 1-10. That tops out at 216 data codewords, which is a ~200 character URL. Our
// join link is about 46 characters, so even a custom domain has enormous room.
// Level M recovers from ~15% damage, which is the right trade for a code that
// gets photographed off a screen at an angle.

// ------------------------------------------------------------------ GF(256)
// Reed-Solomon lives in the field defined by x^8 + x^4 + x^3 + x^2 + 1 (0x11d).
// Log/antilog tables turn multiplication into addition, which is what makes the
// generator polynomial cheap to build.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// The generator polynomial for n EC codewords is the product of (x - 2^i).
//
// It is built low-degree-first (index 0 is the constant term, index n is the
// monic leading 1) and then REVERSED, because the division below walks the
// divisor highest-degree-first. Getting that order wrong does not throw and does
// not change the shape of the finished code - it just produces ten plausible
// error-correction bytes that decode to nothing.
function generatorPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();
}

// Polynomial long division; the remainder IS the error correction block.
function ecBlock(data, ecLen) {
  const gen = generatorPoly(ecLen);
  const rem = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < ecLen; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// ------------------------------------------------------------------ tables
// Everything below is level M only, versions 1-10, straight from the spec.
const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
// [count, dataCodewords] groups. Two groups where the spec splits block sizes.
const BLOCKS = [
  [[1, 16]],
  [[1, 28]],
  [[1, 44]],
  [[2, 32]],
  [[2, 43]],
  [[4, 27]],
  [[4, 31]],
  [[2, 38], [2, 39]],
  [[3, 36], [2, 37]],
  [[4, 43], [1, 44]],
];
const ALIGN = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const dataCapacity = (v) => BLOCKS[v - 1].reduce((n, [c, d]) => n + c * d, 0);

// ------------------------------------------------------------------ encode
// Mode indicator 0100, then the character count, then the bytes themselves.
// Count is 8 bits below version 10 and 16 bits at 10 - getting this boundary
// wrong is the classic silent corruption, so the version is chosen first.
function bitStream(bytes, version) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCapacity(version) * 8;
  // Terminator: up to four zero bits, then pad to a byte boundary.
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8) bits.push(0);
  // Then the two alternating pad codewords until the block is full.
  const pads = [0xec, 0x11];
  for (let i = 0; bits.length < capacityBits; i++) push(pads[i % 2], 8);

  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < 8; j++) out[i] = (out[i] << 1) | bits[i * 8 + j];
  }
  return out;
}

// Data and EC codewords are interleaved across blocks, not concatenated - a
// scratch that destroys a contiguous run then damages every block a little
// rather than one block fatally, which is the whole point of the layout.
function interleave(data, version) {
  const ecLen = EC_PER_BLOCK[version - 1];
  const blocks = [];
  let at = 0;
  for (const [count, size] of BLOCKS[version - 1]) {
    for (let i = 0; i < count; i++) {
      const chunk = Array.from(data.slice(at, at + size));
      at += size;
      blocks.push({ data: chunk, ec: ecBlock(chunk, ecLen) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ------------------------------------------------------------------ matrix
const FINDER = [
  [1, 1, 1, 1, 1, 1, 1], [1, 0, 0, 0, 0, 0, 1], [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1], [1, 0, 1, 1, 1, 0, 1], [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];

// Returns the matrix with every function pattern drawn and the format/version
// areas reserved, plus a parallel `fixed` map. The map is not a convenience:
// the mask applies to DATA modules only, and a mask that also flips the finders
// and timing patterns produces a grid that looks like a QR code to a human and
// is unreadable to every scanner on earth.
function skeleton(version) {
  const size = 17 + version * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v; };

  // Three finders, each with its one-module quiet separator.
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) set(br + r, bc + c, FINDER[r][c]);
    for (let i = -1; i < 8; i++) {
      set(br - 1, bc + i, 0); set(br + 7, bc + i, 0);
      set(br + i, bc - 1, 0); set(br + i, bc + 7, 0);
    }
  }
  // Alignment patterns, except where they would sit on a finder.
  const centers = ALIGN[version - 1];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
        }
      }
    }
  }
  // Timing patterns run between the finders and fix the module pitch.
  for (let i = 8; i < size - 8; i++) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0 ? 1 : 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  m[size - 8][8] = 1; // the always-dark module

  // Reserve the format areas so data placement steps over them.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 2;
    if (m[i][8] === null) m[i][8] = 2;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 2;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 2;
  }
  // Version blocks, v7 and up.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = i % 3;
      if (m[r][size - 11 + c] === null) m[r][size - 11 + c] = 2;
      if (m[size - 11 + c][r] === null) m[size - 11 + c][r] = 2;
    }
  }
  // Anything already written is a function pattern or a reserved area; only the
  // nulls left behind will carry data, and only those may be masked.
  const fixed = m.map((row) => row.map((v) => v !== null));
  return { m, fixed };
}

// Upward-then-downward zigzag in two-module columns from the bottom right,
// skipping the vertical timing column entirely.
function placeData(m, codewords) {
  const size = m.length;
  let bit = 0;
  const total = codewords.length * 8;
  let up = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    const rows = up ? [...Array(size).keys()].reverse() : [...Array(size).keys()];
    for (const r of rows) {
      for (const c of [right, right - 1]) {
        if (m[r][c] !== null) continue;
        let v = 0;
        if (bit < total) v = (codewords[bit >> 3] >> (7 - (bit & 7))) & 1;
        m[r][c] = v;
        bit++;
      }
    }
    up = !up;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// The four penalty rules. A decoder does not need these, but a scanner does:
// they push the chosen mask away from patterns that look like a finder.
function penalty(g) {
  const n = g.length;
  let score = 0;
  const run = (line) => {
    let s = 0;
    let len = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) { len++; continue; }
      if (len >= 5) s += 3 + (len - 5);
      len = 1;
    }
    return s;
  };
  for (let i = 0; i < n; i++) {
    score += run(g[i]);
    score += run(g.map((row) => row[i]));
  }
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = g[r][c];
      if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) score += 3;
    }
  }
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const hunt = (line) => {
    let s = 0;
    for (let i = 0; i + 11 <= line.length; i++) {
      const win = line.slice(i, i + 11);
      if (pat1.every((v, j) => v === win[j]) || pat2.every((v, j) => v === win[j])) s += 40;
    }
    return s;
  };
  for (let i = 0; i < n; i++) {
    score += hunt(g[i]);
    score += hunt(g.map((row) => row[i]));
  }
  const dark = g.flat().filter((v) => v === 1).length;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

// BCH(15,5) for format, BCH(18,6) for version. Both are fixed bit twiddles.
function formatBits(mask) {
  let v = (0b00 << 3) | mask; // 00 = level M
  let rem = v;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((v << 10) | rem) ^ 0x5412;
}
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

/**
 * Encode text as a QR matrix.
 * @returns {{size:number, modules:boolean[][], version:number}}
 */
export function qrMatrix(text, { forceMask = null } = {}) {
  const bytes = new TextEncoder().encode(text);
  // Smallest version that fits, counting the 4-bit mode and the count field.
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const headerBytes = Math.ceil((4 + (v < 10 ? 8 : 16)) / 8);
    if (bytes.length + headerBytes <= dataCapacity(v)) { version = v; break; }
  }
  if (!version) throw new Error('qr: text too long for version 10 at level M');

  const codewords = interleave(bitStream(bytes, version), version);
  const { m: base, fixed } = skeleton(version);
  const size = base.length;
  placeData(base, codewords);

  // Try all eight masks, keep the least offensive.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== null && mask !== forceMask) continue;
    const g = base.map((row, r) => row.map((v, c) => {
      if (fixed[r][c]) return v === 2 ? 0 : v;
      return MASKS[mask](r, c) ? v ^ 1 : v;
    }));
    // Format info goes in after masking, unmasked, in both of its copies.
    const fb = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      // Position i takes the word's bit (14 - i): the 15-bit format word is a
      // number whose MOST significant bit is the first one placed. Reading it
      // the other way round yields a grid that is structurally perfect and that
      // no scanner will touch, because the format block is the first thing a
      // decoder reads and the last thing a human can eyeball.
      const bit = (fb >> (14 - i)) & 1;
      if (i < 6) g[8][i] = bit;
      else if (i < 8) g[8][i + 1] = bit;
      else if (i === 8) g[7][8] = bit;
      else g[14 - i][8] = bit;
      if (i < 8) g[size - 1 - i][8] = bit;
      else g[8][size - 15 + i] = bit;
    }
    g[size - 8][8] = 1;
    if (version >= 7) {
      const vb = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (vb >> i) & 1;
        const r = Math.floor(i / 3);
        const c = i % 3;
        g[r][size - 11 + c] = bit;
        g[size - 11 + c][r] = bit;
      }
    }
    const p = penalty(g);
    if (!best || p < best.p) best = { p, g, mask };
  }
  return {
    size,
    version,
    mask: best.mask,
    modules: best.g.map((row) => row.map((v) => v === 1)),
  };
}

/**
 * Render text as a crisp, theme-aware SVG string. One <rect> per dark module is
 * slower to parse than a path but survives every SVG renderer identically, and
 * at ~40x40 modules the difference is not measurable.
 *
 * The quiet zone is not decoration: without four clear modules of margin a
 * scanner cannot find the code at all, which is the single most common way a
 * hand-rolled QR fails in the field.
 */
export function qrSvg(text, { scale = 8, quiet = 4, dark = '#000', light = '#fff' } = {}) {
  const { size, modules } = qrMatrix(text);
  const dim = (size + quiet * 2) * scale;
  let rects = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      rects += `<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" `
       + `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" `
       + `aria-label="QR code">`
       + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
       + `<g fill="${dark}">${rects}</g></svg>`;
}
