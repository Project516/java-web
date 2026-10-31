// A small TrueType reader and glyph rasterizer behind the JDK's font natives:
// cmap, hmtx, glyf outlines, outline transform and emboldening, and a
// coverage rasterizer. No hinting, no layout tables. Loading follows
// FreeType's sfnt and truetype drivers, so it rejects the fonts and glyphs
// FreeType rejects.

const rd16 = (d: DataView, o: number) => d.getUint16(o);
const rd16s = (d: DataView, o: number) => d.getInt16(o);
const rd32 = (d: DataView, o: number) => d.getUint32(o);

const tag = (s: string) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
const HEAD = tag("head"), HHEA = tag("hhea"), MAXP = tag("maxp"), HMTX = tag("hmtx"), VMTX = tag("vmtx");
const GLYF = tag("glyf"), LOCA = tag("loca"), CMAP = tag("cmap"), KERN = tag("kern"), TTCF = tag("ttcf");

// The sfnt versions FreeType's TrueType driver accepts (not OTTO or typ1)
const TT_VERSIONS = new Set([0x00010000, 0x00020000, tag("true"), 0xa56b6264, 0xa56c7374]);

// Points in font units, or in 26.6 pixels after scaling; y is up.
export interface Outline {
  x: number[];
  y: number[];
  on: boolean[];
  ends: number[];
}

type Part = { gid: number; m: number[]; dx: number; dy: number };

// A simple glyph's points, or a composite's parts: a 16.16 matrix (xx, xy, yx,
// yy) and an offset in font units for each component
type Glyph = { simple: Outline } | { parts: Part[] };

// FreeType fails to load the glyph
export class BadGlyph extends Error {}

const BAD = Symbol("bad glyph");

export class TTF {
  readonly upem: number;
  readonly numGlyphs: number;
  readonly ascender: number;
  readonly descender: number;
  readonly height: number;
  readonly maxAdvance: number;
  private readonly dv: DataView;
  private readonly tables = new Map<number, { off: number; len: number }>();
  private readonly longLoca: boolean;
  private readonly locaOff: number;
  private readonly numLocations: number;
  private readonly glyfOff: number;
  private readonly glyfLen: number;
  private readonly hMetrics: number;
  private cmap: { format: number; off: number } | null = null;
  private readonly cache = new Map<number, Glyph | null | typeof BAD>();

  // Throws where FreeType's FT_Open_Face fails
  constructor(data: Uint8Array, faceIndex = 0) {
    const size = data.length;
    const d = (this.dv = new DataView(data.buffer, data.byteOffset, size));
    const bad = (why: string): never => {
      throw new Error(why);
    };
    if (size < 12) bad("short file");
    let base = 0;
    if (rd32(d, 0) === TTCF) {
      const count = rd32(d, 8);
      if (count === 0 || count > size / 32 || faceIndex >= count) bad("bad collection");
      base = rd32(d, 12 + faceIndex * 4);
      if (base + 12 > size) bad("bad collection");
    } else if (faceIndex !== 0) bad("bad face index");
    if (!TT_VERSIONS.has(rd32(d, base))) bad("not TrueType");

    let hasHead = false;
    for (let i = 0, n = rd16(d, base + 4); i < n; i++) {
      const p = base + 12 + i * 16;
      if (p + 16 > size) break;
      const t = rd32(d, p), off = rd32(d, p + 8);
      let len = rd32(d, p + 12);
      if (off > size) continue;
      if (len > size - off) {
        if (t !== HMTX && t !== VMTX) continue;
        len = (size - off) & ~3;
      } else if (t === HEAD) {
        hasHead = true;
        if (len < 0x36) bad("head too small");
      }
      if (!this.tables.has(t)) this.tables.set(t, { off, len });
    }
    const head = this.tables.get(HEAD), hhea = this.tables.get(HHEA), maxp = this.tables.get(MAXP);
    const hmtx = this.tables.get(HMTX), glyf = this.tables.get(GLYF), loca = this.tables.get(LOCA);
    if (!hasHead || !head) bad("no head");
    this.upem = rd16(d, head!.off + 18);
    if (this.upem < 16 || this.upem > 16384) bad("bad unitsPerEm");
    this.longLoca = rd16s(d, head!.off + 50) !== 0;
    let numGlyphs = maxp && maxp.off + 6 <= size ? rd16(d, maxp.off + 4) : 0;
    if (!hhea || hhea.off + 36 > size || !hmtx || !glyf || !loca) bad("missing table");
    const h = hhea!.off;
    this.ascender = rd16s(d, h + 4);
    this.descender = rd16s(d, h + 6);
    this.height = this.ascender - this.descender + rd16s(d, h + 8);
    this.maxAdvance = rd16(d, h + 10);
    this.hMetrics = rd16(d, h + 34);
    this.glyfOff = glyf!.off;
    this.glyfLen = glyf!.len;

    // loca may disagree with maxp; FreeType extends it into free space or shrinks the glyph count
    const shift = this.longLoca ? 2 : 1;
    let locaLen = Math.min(loca!.len, 0x10000 * 2 ** shift);
    let numLocations = Math.floor(locaLen / 2 ** shift);
    if (numLocations < numGlyphs + 1) {
      const newLen = (numGlyphs + 1) * 2 ** shift;
      let dist = 0x7fffffff, found = false;
      for (const t of this.tables.values()) {
        const diff = t.off - loca!.off;
        if (diff > 0 && diff < dist) {
          dist = diff;
          found = true;
        }
      }
      if (!found) dist = size - loca!.off;
      if (newLen <= dist) {
        numLocations = numGlyphs + 1;
        locaLen = newLen;
      } else numGlyphs = numLocations ? numLocations - 1 : 0;
    }
    this.numGlyphs = numGlyphs;
    this.numLocations = numLocations;
    this.locaOff = loca!.off;
    try {
      this.pickCmap(this.tables.get(CMAP)?.off ?? 0);
    } catch {
      this.cmap = null;
    }
  }

  // Prefers full Unicode (3,10 or 0,4+), then BMP (3,1 or 0,*)
  private pickCmap(base: number) {
    if (!base) return;
    const d = this.dv;
    let best = -1, bestOff = 0;
    for (let i = 0, n = rd16(d, base + 2); i < n; i++) {
      const pid = rd16(d, base + 4 + i * 8), eid = rd16(d, base + 6 + i * 8), off = base + rd32(d, base + 8 + i * 8);
      const fmt = rd16(d, off);
      if (fmt !== 4 && fmt !== 12) continue;
      const score = (pid === 3 && eid === 10) || (pid === 0 && eid >= 4) ? 3 : (pid === 3 && eid === 1) || pid === 0 ? 2 : -1;
      if (score > best) {
        best = score;
        bestOff = off;
      }
    }
    if (best >= 0) this.cmap = { format: rd16(d, bestOff), off: bestOff };
  }

  glyphIndex(cp: number): number {
    try {
      return this.lookup(cp);
    } catch {
      return 0;
    }
  }

  private lookup(cp: number): number {
    const c = this.cmap;
    if (!c) return 0;
    const d = this.dv, o = c.off;
    if (c.format === 12) {
      let lo = 0, hi = rd32(d, o + 12) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, g = o + 16 + mid * 12;
        if (cp < rd32(d, g)) hi = mid - 1;
        else if (cp > rd32(d, g + 4)) lo = mid + 1;
        else return rd32(d, g + 8) + cp - rd32(d, g);
      }
      return 0;
    }
    if (cp > 0xffff) return 0;
    const segX2 = rd16(d, o + 6), ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    let lo = 0, hi = segX2 / 2 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp > rd16(d, ends + mid * 2)) lo = mid + 1;
      else if (cp < rd16(d, starts + mid * 2)) hi = mid - 1;
      else {
        const ro = rd16(d, ranges + mid * 2);
        if (ro === 0) return (cp + rd16(d, deltas + mid * 2)) & 0xffff;
        const g = rd16(d, ranges + mid * 2 + ro + (cp - rd16(d, starts + mid * 2)) * 2);
        return g === 0 ? 0 : (g + rd16(d, deltas + mid * 2)) & 0xffff;
      }
    }
    return 0;
  }

  // Advance in font units, zero where hmtx does not hold the glyph
  advance(gid: number): number {
    const t = this.tables.get(HMTX), k = this.hMetrics;
    if (!t || k === 0) return 0;
    const pos = gid < k ? gid * 4 : (k - 1) * 4;
    return pos + (gid < k ? 4 : 2) > t.len ? 0 : rd16(this.dv, t.off + pos);
  }

  // The glyph's offset in glyf and its byte length (tt_face_get_location)
  private location(gid: number): [number, number] {
    const d = this.dv, wide = this.longLoca, n = this.numLocations;
    let pos1 = 0, pos2 = 0;
    if (gid < n) {
      const w = wide ? 4 : 2, p = this.locaOff + gid * w;
      const get = (o: number) => (wide ? rd32(d, o) : rd16(d, o));
      pos1 = pos2 = get(p);
      if (gid + 1 < n) pos2 = get(p + w);
      if (!wide) {
        pos1 *= 2;
        pos2 *= 2;
      }
    }
    if (pos1 > this.glyfLen) return [0, 0];
    if (pos2 > this.glyfLen) {
      if (gid !== n - 2) return [0, 0];
      pos2 = this.glyfLen;
    }
    return [pos1, pos2 >= pos1 ? pos2 - pos1 : this.glyfLen - pos1];
  }

  private glyph(gid: number): Glyph | null {
    let g = this.cache.get(gid);
    if (g === undefined) {
      try {
        g = gid >= 0 && gid < this.numGlyphs ? this.parse(gid) : BAD;
      } catch {
        g = BAD;
      }
      if (this.cache.size > 1024) this.cache.clear();
      this.cache.set(gid, g);
    }
    if (g === BAD) throw new BadGlyph();
    return g;
  }

  private parse(gid: number): Glyph | null {
    const [off, len] = this.location(gid);
    if (len === 0) return null;
    const p = this.glyfOff + off, limit = p + len;
    if (p + 10 > limit) throw new BadGlyph();
    const nc = rd16s(this.dv, p);
    if (nc === 0) return null;
    if (nc < 0) return { parts: this.composite(p + 10, limit) };
    return { simple: this.simple(p + 10, limit, nc) };
  }

  private simple(p: number, limit: number, nc: number): Outline {
    const d = this.dv, u = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    const bad = (): never => {
      throw new BadGlyph();
    };
    if (nc >= 0xfff || p + 2 * nc + 2 > limit) bad();
    const ends: number[] = [];
    for (let i = 0, last = -1; i < nc; i++, p += 2) {
      const e = rd16(d, p);
      if (e <= last) bad();
      ends.push((last = e));
    }
    const n = ends[nc - 1] + 1;
    const nIns = rd16(d, p);
    p += 2;
    if (p + nIns > limit) bad();
    p += nIns;
    const flags: number[] = [];
    while (flags.length < n) {
      if (p + 1 > limit) bad();
      const f = u[p++];
      flags.push(f);
      if (f & 8) {
        if (p + 1 > limit) bad();
        let count = u[p++];
        if (flags.length + count > n) bad();
        while (count-- > 0) flags.push(f);
      }
    }
    const coord = (short: number, sign: number, same: number) => {
      const out: number[] = [];
      let v = 0;
      for (const f of flags) {
        if (f & short) {
          if (p + 1 > limit) bad();
          v += f & sign ? u[p++] : -u[p++];
        } else if (!(f & same)) {
          if (p + 2 > limit) bad();
          v += rd16s(d, p);
          p += 2;
        }
        out.push(v);
      }
      return out;
    };
    const x = coord(2, 16, 16), y = coord(4, 32, 32);
    return { x, y, on: flags.map((f) => (f & 1) !== 0), ends };
  }

  private composite(p: number, limit: number): Part[] {
    const d = this.dv, parts: Part[] = [];
    for (;;) {
      if (p + 4 > limit) throw new BadGlyph();
      const flags = rd16(d, p), gid = rd16(d, p + 2);
      p += 4;
      if (gid >= this.numGlyphs) throw new BadGlyph();
      const words = flags & 1;
      const scale = flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0;
      if (p + 2 + words * 2 + scale > limit) throw new BadGlyph();
      let dx = 0, dy = 0;
      if (flags & 2) {
        dx = words ? rd16s(d, p) : d.getInt8(p);
        dy = words ? rd16s(d, p + 2) : d.getInt8(p + 1);
      }
      p += 2 + words * 2;
      const f = (o: number) => d.getInt16(o) * 4;
      let m = [0x10000, 0, 0, 0x10000];
      if (flags & 8) m = [f(p), 0, 0, f(p)];
      else if (flags & 0x40) m = [f(p), 0, 0, f(p + 2)];
      else if (flags & 0x80) m = [f(p), f(p + 4), f(p + 2), f(p + 6)];
      p += scale;
      parts.push({ gid, m, dx, dy });
      if (!(flags & 0x20)) return parts;
    }
  }

  // The glyph's points in 26.6 pixels at a 16.16 scale, null if it is empty.
  // Components are scaled first and moved by their scaled offset afterwards,
  // as FreeType does. Throws BadGlyph where FreeType fails to load the glyph.
  scaled(gid: number, scale: number, path: number[] = []): Outline | null {
    if (path.length > 100) throw new BadGlyph();
    const g = this.glyph(gid);
    if (!g) return null;
    if ("simple" in g) {
      const o = g.simple;
      return { x: o.x.map((v) => mulFix(v, scale)), y: o.y.map((v) => mulFix(v, scale)), on: o.on, ends: o.ends };
    }
    if (path.includes(gid)) throw new BadGlyph();
    path.push(gid);
    const out: Outline = { x: [], y: [], on: [], ends: [] };
    for (const part of g.parts) {
      const sub = this.scaled(part.gid, scale, path);
      if (!sub) continue;
      const base = out.x.length, [xx, xy, yx, yy] = part.m;
      const dx = mulFix(part.dx, scale), dy = mulFix(part.dy, scale);
      for (let i = 0; i < sub.x.length; i++) {
        out.x.push(mulFix(sub.x[i], xx) + mulFix(sub.y[i], xy) + dx);
        out.y.push(mulFix(sub.x[i], yx) + mulFix(sub.y[i], yy) + dy);
        out.on.push(sub.on[i]);
      }
      for (const end of sub.ends) out.ends.push(end + base);
    }
    path.pop();
    return out.x.length ? out : null;
  }

  // Pair kerning from the legacy kern table (horizontal, format 0), in font units
  kern(left: number, right: number): number {
    try {
      return this.pairKern(left, right);
    } catch {
      return 0;
    }
  }

  private pairKern(left: number, right: number): number {
    const d = this.dv, kern = this.tables.get(KERN)?.off ?? 0;
    if (!kern) return 0;
    let p = kern + 4;
    for (let t = rd16(d, kern + 2); t > 0; t--) {
      const len = rd16(d, p + 2), coverage = rd16(d, p + 4);
      if (coverage === 1) {
        const n = rd16(d, p + 6), key = left * 65536 + right;
        let lo = 0, hi = n - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1, e = p + 14 + mid * 6, k = rd16(d, e) * 65536 + rd16(d, e + 2);
          if (key < k) hi = mid - 1;
          else if (key > k) lo = mid + 1;
          else return rd16s(d, e + 4);
        }
      }
      p += len;
    }
    return 0;
  }
}

// FT_MulFix: a * b / 65536 rounded half away from zero
export function mulFix(a: number, b: number): number {
  const p = Math.abs(a) * Math.abs(b), r = Math.floor((p + 0x8000) / 0x10000);
  return a < 0 !== b < 0 ? -r : r;
}

// FT_Outline_Transform: a 16.16 matrix (xx, xy, yx, yy; y is up like
// FreeType's), each product rounded
export function transformOutline(o: Outline, m: [number, number, number, number]): Outline {
  const n = o.x.length, x = new Array<number>(n), y = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    x[i] = mulFix(o.x[i], m[0]) + mulFix(o.y[i], m[1]);
    y[i] = mulFix(o.x[i], m[2]) + mulFix(o.y[i], m[3]);
  }
  return { x, y, on: o.on, ends: o.ends };
}

// FT_MulDiv: a * b / c rounded half away from zero
export function mulDiv(a: number, b: number, c: number): number {
  const neg = a < 0 !== b < 0 !== c < 0, ac = Math.abs(c);
  const r = ac > 0 ? Math.floor((Math.abs(a) * Math.abs(b) + Math.floor(ac / 2)) / ac) : 0x7fffffff;
  return neg ? -r : r;
}

// FT_DivFix: a / b as 16.16, rounded half away from zero
export const divFix = (a: number, b: number) => mulDiv(a, 65536, b);

const msb = (v: number) => 31 - Math.clz32(v);

// FT_Vector_NormLen: scales v to a 16.16 unit vector in place and returns the
// original length, by FreeType's 32-bit fixed point Newton iteration
function normLen(v: { x: number; y: number }): number {
  const xs = v.x | 0, ys = v.y | 0;
  const sx = xs < 0 ? -1 : 1, sy = ys < 0 ? -1 : 1;
  let x = Math.abs(xs) >>> 0, y = Math.abs(ys) >>> 0;
  if (x === 0) {
    if (y > 0) v.y = sy * 0x10000;
    return y;
  }
  if (y === 0) {
    if (x > 0) v.x = sx * 0x10000;
    return x;
  }
  let l = x > y ? x + (y >>> 1) : y + (x >>> 1);
  let shift = 31 - msb(l);
  shift -= 15 + (l >= 0xaaaaaaaa >>> shift ? 1 : 0);
  if (shift > 0) {
    x = (x << shift) >>> 0;
    y = (y << shift) >>> 0;
    l = x > y ? x + (y >>> 1) : y + (x >>> 1);
  } else {
    x >>>= -shift;
    y >>>= -shift;
    l >>>= -shift;
  }
  let b = (0x10000 - l) | 0, z: number, u: number, w: number;
  const xi = x | 0, yi = y | 0;
  do {
    u = (xi + (Math.imul(xi, b) >> 16)) >>> 0;
    w = (yi + (Math.imul(yi, b) >> 16)) >>> 0;
    z = Math.trunc(-((Math.imul(u, u) + Math.imul(w, w)) | 0) / 0x200);
    z = Math.trunc(Math.imul(z, (0x10000 + b) >> 8) / 0x10000);
    b = (b + z) | 0;
  } while (z > 0);
  v.x = sx < 0 ? -u : u;
  v.y = sy < 0 ? -w : w;
  l = (0x10000 + Math.trunc(((Math.imul(u, x) + Math.imul(w, y)) | 0) / 0x10000)) >>> 0;
  return shift > 0 ? ((l + (1 << (shift - 1))) >>> shift) : (l << -shift) >>> 0;
}

// FT_Outline_Get_CBox over all points: [xMin, yMin, xMax, yMax]
export function controlBox(o: Outline): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < o.x.length; i++) {
    if (o.x[i] < x0) x0 = o.x[i];
    if (o.x[i] > x1) x1 = o.x[i];
    if (o.y[i] < y0) y0 = o.y[i];
    if (o.y[i] > y1) y1 = o.y[i];
  }
  return [x0, y0, x1, y1];
}

// FT_Outline_Get_Orientation: 1 for TrueType (clockwise), -1 for PostScript, 0 when unknown
function orientation(o: Outline): number {
  if (o.x.length === 0) return 1;
  const [x0, y0, x1, y1] = controlBox(o);
  if (x0 === x1 || y0 === y1) return 0;
  if (x0 < -0x1000000 || y0 < -0x1000000 || x1 > 0x1000000 || y1 > 0x1000000) return 0;
  const xshift = Math.max(msb(Math.abs(x1) | Math.abs(x0)) - 14, 0), yshift = Math.max(msb(y1 - y0) - 14, 0);
  let area = 0;
  for (let c = 0, first = 0; c < o.ends.length; first = o.ends[c++] + 1) {
    const last = o.ends[c];
    let px = o.x[last] >> xshift, py = o.y[last] >> yshift;
    for (let n = first; n <= last; n++) {
      const cx = o.x[n] >> xshift, cy = o.y[n] >> yshift;
      area += (cy - py) * (cx + px);
      px = cx;
      py = cy;
    }
  }
  return area > 0 ? -1 : area < 0 ? 1 : 0;
}

// FT_Outline_EmboldenXY with equal strength in x and y (26.6 units). Unit
// vectors are 16.16 and the arithmetic is FreeType's fixed point.
export function embolden(o: Outline, strength: number) {
  const s = Math.trunc(strength / 2);
  if (s === 0) return;
  const orient = orientation(o);
  if (orient === 0) return;
  const truetype = orient > 0;
  let first = 0;
  for (const last of o.ends) {
    let inV = { x: 0, y: 0 }, lIn = 0, anchor = { x: 0, y: 0 }, lAnchor = 0;
    let i = last, j = first, k = -1;
    while (j !== i && i !== k) {
      let out: { x: number; y: number }, lOut: number;
      if (j !== k) {
        out = { x: o.x[j] - o.x[i], y: o.y[j] - o.y[i] };
        lOut = normLen(out);
        if (lOut === 0) {
          j = j < last ? j + 1 : first;
          continue;
        }
      } else {
        out = anchor;
        lOut = lAnchor;
      }
      if (lIn !== 0) {
        if (k < 0) {
          k = i;
          anchor = inV;
          lAnchor = lIn;
        }
        let d = mulFix(inV.x, out.x) + mulFix(inV.y, out.y), shx = 0, shy = 0;
        if (d > -0xf000) {
          d += 0x10000;
          shx = inV.y + out.y;
          shy = inV.x + out.x;
          if (truetype) shx = -shx;
          else shy = -shy;
          let q = mulFix(out.x, inV.y) - mulFix(out.y, inV.x);
          if (truetype) q = -q;
          const l = Math.min(lIn, lOut);
          const small = mulFix(s, q) <= mulFix(l, d);
          shx = small ? mulDiv(shx, s, d) : mulDiv(shx, l, q);
          shy = small ? mulDiv(shy, s, d) : mulDiv(shy, l, q);
        }
        for (; i !== j; i = i < last ? i + 1 : first) {
          o.x[i] += s + shx;
          o.y[i] += s + shy;
        }
      } else i = j;
      inV = out;
      lIn = lOut;
      j = j < last ? j + 1 : first;
    }
    first = last + 1;
  }
}

// ---- path decomposition ----------------------------------------------------

export const SEG_MOVETO = 0, SEG_LINETO = 1, SEG_QUADTO = 2, SEG_CLOSE = 4;

interface PathSink {
  move(x: number, y: number): void;
  line(x: number, y: number): void;
  quad(cx: number, cy: number, x: number, y: number): void;
  close(): void;
}

// FT_Outline_Decompose for TrueType (quadratic) contours
export function decompose(o: Outline, s: PathSink) {
  let first = 0;
  for (const last of o.ends) {
    const { x, y, on } = o;
    let sx: number, sy: number, begin = first, end = last;
    if (!on[first]) {
      if (on[last]) {
        sx = x[last];
        sy = y[last];
        end = last - 1;
      } else {
        sx = Math.trunc((x[first] + x[last]) / 2);
        sy = Math.trunc((y[first] + y[last]) / 2);
      }
    } else {
      sx = x[first];
      sy = y[first];
      begin = first + 1;
    }
    s.move(sx, sy);
    let cx = 0, cy = 0, haveCtl = false;
    for (let i = begin; i <= end; i++) {
      if (on[i]) {
        if (haveCtl) s.quad(cx, cy, x[i], y[i]);
        else s.line(x[i], y[i]);
        haveCtl = false;
      } else {
        if (haveCtl) s.quad(cx, cy, Math.trunc((cx + x[i]) / 2), Math.trunc((cy + y[i]) / 2));
        cx = x[i];
        cy = y[i];
        haveCtl = true;
      }
    }
    if (haveCtl) s.quad(cx, cy, sx, sy);
    else s.line(sx, sy);
    s.close();
    first = last + 1;
  }
}

// FT_Outline_Get_BBox: [xMin, yMin, xMax, yMax] with the exact extrema of the
// curves, found as ftbbox.c does
export function outlineBBox(o: Outline): [number, number, number, number] {
  if (o.x.length === 0 || o.ends.length === 0) return [0, 0, 0, 0];
  const big = 0x7fffffff;
  const cb = [big, big, -big, -big], bb = [big, big, -big, -big];
  const grow = (b: number[], x: number, y: number) => {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  };
  for (let i = 0; i < o.x.length; i++) {
    grow(cb, o.x[i], o.y[i]);
    if (o.on[i]) grow(bb, o.x[i], o.y[i]);
  }
  if (cb[0] >= bb[0] && cb[1] >= bb[1] && cb[2] <= bb[2] && cb[3] <= bb[3]) return [bb[0], bb[1], bb[2], bb[3]];
  // only called with a control point outside the box of the on points
  const conic = (y1: number, y2: number, y3: number, i: number) => {
    y1 -= y2;
    y3 -= y2;
    y2 += mulDiv(y1, y3, y1 + y3);
    if (y2 < bb[i]) bb[i] = y2;
    if (y2 > bb[i + 2]) bb[i + 2] = y2;
  };
  let lx = 0, ly = 0;
  decompose(o, {
    move(x, y) {
      grow(bb, x, y);
      lx = x;
      ly = y;
    },
    line(x, y) {
      lx = x;
      ly = y;
    },
    quad(cx, cy, x, y) {
      grow(bb, x, y);
      if (cx < bb[0] || cx > bb[2]) conic(lx, cx, x, 0);
      if (cy < bb[1] || cy > bb[3]) conic(ly, cy, y, 1);
      lx = x;
      ly = y;
    },
    close() {},
  });
  return [bb[0], bb[1], bb[2], bb[3]];
}

// ---- rasterizer ------------------------------------------------------------

export interface Bitmap {
  left: number;
  top: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

// Exact-area coverage of a nonzero-winding outline in 26.6 units, one byte per
// pixel; mono thresholds the coverage at one half. A bitmap past `limit` in
// either direction comes back without pixels.
export function rasterize(o: Outline, mono: boolean, limit: number): Bitmap | null {
  const n = o.x.length;
  if (n === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (o.x[i] < x0) x0 = o.x[i];
    if (o.x[i] > x1) x1 = o.x[i];
    if (o.y[i] < y0) y0 = o.y[i];
    if (o.y[i] > y1) y1 = o.y[i];
  }
  const left = x0 >> 6, top = (y1 + 63) >> 6;
  const width = ((x1 + 63) >> 6) - left, height = top - (y0 >> 6);
  if (width <= 0 || height <= 0) return null;
  if (width > limit || height > limit) return { left, top, width, height, pixels: new Uint8Array(0) };
  const stride = width + 2;
  const acc = new Float32Array(stride * height + 2);
  // pixel space: x right from `left`, y down from `top`
  const px = (v: number) => v / 64 - left, py = (v: number) => top - v / 64;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const line = (ax: number, ay: number, bx: number, by: number) => addLine(acc, stride, height, ax, ay, bx, by);
  decompose(o, {
    move(x, y) {
      cx = sx = px(x);
      cy = sy = py(y);
    },
    line(x, y) {
      const nx = px(x), ny = py(y);
      line(cx, cy, nx, ny);
      cx = nx;
      cy = ny;
    },
    quad(qx, qy, x, y) {
      const ctlx = px(qx), ctly = py(qy), nx = px(x), ny = py(y);
      const dd = Math.hypot(cx - 2 * ctlx + nx, cy - 2 * ctly + ny);
      const steps = Math.min(32, Math.max(1, Math.ceil(Math.sqrt(dd / 0.2))));
      let lx = cx, ly = cy;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        const tx = u * u * cx + 2 * u * t * ctlx + t * t * nx, ty = u * u * cy + 2 * u * t * ctly + t * t * ny;
        line(lx, ly, tx, ty);
        lx = tx;
        ly = ty;
      }
      cx = nx;
      cy = ny;
    },
    close() {
      line(cx, cy, sx, sy);
    },
  });
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += acc[y * stride + x];
      const c = Math.min(Math.abs(sum), 1);
      pixels[y * width + x] = mono ? (c >= 0.5 ? 255 : 0) : Math.round(c * 255);
    }
  }
  return { left, top, width, height, pixels };
}

// Signed area and cover of one edge into the accumulation buffer
function addLine(a: Float32Array, stride: number, h: number, ax: number, ay: number, bx: number, by: number) {
  if (ay === by) return;
  let dir = 1;
  if (ay > by) {
    dir = -1;
    [ax, ay, bx, by] = [bx, by, ax, ay];
  }
  const dxdy = (bx - ax) / (by - ay);
  let x = ax;
  let y = Math.floor(ay);
  if (ay < 0) {
    x -= ay * dxdy;
    y = 0;
  }
  const yEnd = Math.min(h, Math.ceil(by));
  for (; y < yEnd; y++) {
    const row = y * stride;
    const dy = Math.min(y + 1, by) - Math.max(y, ay);
    const xn = x + dxdy * dy;
    const d = dy * dir;
    const lo = x < xn ? x : xn, hi = x < xn ? xn : x;
    const lof = Math.floor(lo), hic = Math.ceil(hi);
    if (hic <= lof + 1) {
      const xm = 0.5 * (x + xn) - lof;
      a[row + lof] += d - d * xm;
      a[row + lof + 1] += d * xm;
    } else {
      const s = 1 / (hi - lo);
      const x0f = lo - lof, a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
      const x1f = hi - hic + 1, am = 0.5 * s * x1f * x1f;
      a[row + lof] += d * a0;
      if (hic === lof + 2) a[row + lof + 1] += d * (1 - a0 - am);
      else {
        const a1 = s * (1.5 - x0f);
        a[row + lof + 1] += d * (a1 - a0);
        for (let xi = lof + 2; xi < hic - 1; xi++) a[row + xi] += d * s;
        const a2 = a1 + (hic - lof - 3) * s;
        a[row + hic - 1] += d * (1 - a2 - am);
      }
      a[row + hic] += d * am;
    }
    x = xn;
  }
}
