// Software loops of java.desktop's libawt (src/java.desktop/share/native/libawt/
// java2d/loops) for the common image surface types. Each loop does what the C
// macros do, with the same integer rounding, so pixels match HotSpot's.

import type { ArrayData } from "../runtime.ts";

// A surface's pixels: the array behind a BufferedImage and its layout in bytes.
export class Surf {
  u8: Uint8Array | null = null;
  i32: Int32Array | null = null;
  u16: Uint16Array | null = null;
  // indexed and bit-packed surfaces: the palette (ARGB words), its size and the
  // IndexColorModel; packed pixels count in slots (off and scan too, ps is 1)
  lut: Int32Array | null = null;
  lutSize = 0;
  icm: unknown = null;
  cdata: { inv: Uint8Array; primaries: boolean } | null = null;
  bpp = 0;
  // packed surfaces: the first pixel's slot within its byte row
  bo = 0;
  readonly off: number;
  readonly ps: number;
  readonly scan: number;
  readonly w: number;
  readonly h: number;
  constructor(a: ArrayData, off: number, ps: number, scan: number, w: number, h: number) {
    this.off = off;
    this.ps = ps;
    this.scan = scan;
    this.w = w;
    this.h = h;
    if (a instanceof Int32Array) this.i32 = a;
    else if (a instanceof Int16Array) this.u16 = new Uint16Array(a.buffer, a.byteOffset, a.length);
    else if (a instanceof Int8Array) this.u8 = new Uint8Array(a.buffer, a.byteOffset, a.length);
  }

  // the same pixels viewed from another origin
  at(off: number, w: number, h: number): Surf {
    return Object.assign(Object.create(Surf.prototype), this, { off, w, h });
  }
}

const mul8 = new Uint8Array(65536);
const div8 = new Uint8Array(65536);
for (let i = 1; i < 256; i++) {
  const inc = (i << 16) + (i << 8) + i;
  let val = inc + (1 << 23);
  for (let j = 1; j < 256; j++) {
    mul8[(i << 8) | j] = val >>> 24;
    val += inc;
  }
  const dinc = Math.floor((255 * 16777216 + (i >> 1)) / i);
  val = 1 << 23;
  for (let j = 0; j < i; j++) {
    div8[(i << 8) | j] = Math.floor(val / 16777216);
    val += dinc;
  }
  for (let j = i; j < 256; j++) div8[(i << 8) | j] = 255;
}
export const MUL8 = (a: number, b: number) => mul8[(a << 8) | b];
export const DIV8 = (a: number, b: number) => div8[(b << 8) | a];

export const gray = (r: number, g: number, b: number) => (77 * r + 150 * g + 29 * b + 128) >> 8;

// A pixel format. rd reads a pixel as raw ARGB (premultiplied for Pre formats,
// alpha 255 for opaque ones); wr stores raw ARGB.
export interface Fmt {
  ps: number;
  opaque: boolean;
  pre: boolean;
  gray: boolean;
  rd(s: Surf, o: number): number;
  // dither is the 8x8 ordered dither index of the pixel: row * 8 + column
  wr(s: Surf, o: number, v: number, dither?: number): void;
  // packed formats have no pixel stride: loops start from the row and take the column from the Ctx
  packed?: boolean;
  // the pixel as premultiplied ARGB for the transform helper, when rd's is not
  rdPre?(s: Surf, o: number): number;
  // stores the whole word, for a solid fill that keeps the color's alpha byte
  wrWord?(s: Surf, o: number, v: number): void;
}

function fmt(ps: number, opaque: boolean, pre: boolean, rd: Fmt["rd"], wr: Fmt["wr"], isGray = false): Fmt {
  return { ps, opaque, pre, gray: isGray, rd, wr };
}

const r16 = (v: number, bits: number) => (v << (8 - bits)) | (v >> (2 * bits - 8));

export const fmts: Record<string, Fmt> = {
  IntArgb: fmt(4, false, false, (s, o) => s.i32![o >> 2], (s, o, v) => void (s.i32![o >> 2] = v)),
  IntArgbPre: fmt(4, false, true, (s, o) => s.i32![o >> 2], (s, o, v) => void (s.i32![o >> 2] = v)),
  IntRgb: {
    ...fmt(4, true, false, (s, o) => s.i32![o >> 2] | 0xff000000, (s, o, v) => void (s.i32![o >> 2] = v & 0xffffff)),
    wrWord: (s, o, v) => void (s.i32![o >> 2] = v),
  },
  IntBgr: fmt(4, true, false,
    (s, o) => {
      const p = s.i32![o >> 2];
      return 0xff000000 | ((p & 255) << 16) | (p & 0xff00) | ((p >> 16) & 255);
    },
    (s, o, v) => void (s.i32![o >> 2] = ((v & 255) << 16) | (v & 0xff00) | ((v >> 16) & 255))),
  ThreeByteBgr: fmt(3, true, false,
    (s, o) => 0xff000000 | (s.u8![o + 2] << 16) | (s.u8![o + 1] << 8) | s.u8![o],
    (s, o, v) => {
      s.u8![o] = v;
      s.u8![o + 1] = v >> 8;
      s.u8![o + 2] = v >> 16;
    }),
  FourByteAbgr: fmt(4, false, false, rdAbgr, wrAbgr),
  FourByteAbgrPre: fmt(4, false, true, rdAbgr, wrAbgr),
  ByteGray: fmt(1, true, false, (s, o) => 0xff000000 | (s.u8![o] * 0x010101), (s, o, v) => void (s.u8![o] = gray((v >> 16) & 255, (v >> 8) & 255, v & 255)), true),
  Ushort565Rgb: fmt(2, true, false,
    (s, o) => {
      const p = s.u16![o >> 1];
      return 0xff000000 | (r16((p >> 11) & 31, 5) << 16) | (r16((p >> 5) & 63, 6) << 8) | r16(p & 31, 5);
    },
    (s, o, v) => void (s.u16![o >> 1] = (((v >> 19) & 31) << 11) | (((v >> 10) & 63) << 5) | ((v >> 3) & 31))),
  Ushort555Rgb: fmt(2, true, false,
    (s, o) => {
      const p = s.u16![o >> 1];
      return 0xff000000 | (r16((p >> 10) & 31, 5) << 16) | (r16((p >> 5) & 31, 5) << 8) | r16(p & 31, 5);
    },
    (s, o, v) => void (s.u16![o >> 1] = (((v >> 19) & 31) << 10) | (((v >> 11) & 31) << 5) | ((v >> 3) & 31))),
};

function rdAbgr(s: Surf, o: number) {
  const u = s.u8!;
  return (u[o] << 24) | (u[o + 3] << 16) | (u[o + 2] << 8) | u[o + 1];
}
function wrAbgr(s: Surf, o: number, v: number) {
  const u = s.u8!;
  u[o] = v >>> 24;
  u[o + 1] = v;
  u[o + 2] = v >> 8;
  u[o + 3] = v >> 16;
}

// non-premultiplied ARGB of a pixel, and a store from it
export function rdArgb(f: Fmt, s: Surf, o: number): number {
  const p = f.rd(s, o);
  if (!f.pre) return p;
  const a = p >>> 24;
  if (a === 255 || a === 0) return p;
  return (a << 24) | (DIV8((p >> 16) & 255, a) << 16) | (DIV8((p >> 8) & 255, a) << 8) | DIV8(p & 255, a);
}

export function premul(argb: number): number {
  const a = argb >>> 24;
  if (a === 255) return argb;
  return (a << 24) | (MUL8(a, (argb >> 16) & 255) << 16) | (MUL8(a, (argb >> 8) & 255) << 8) | MUL8(a, argb & 255);
}

export function wrArgb(f: Fmt, s: Surf, o: number, argb: number, dither = 0) {
  f.wr(s, o, f.pre ? premul(argb) : argb, dither);
}

// A pixel as premultiplied ARGB, for the transform helpers
export function rdPre(f: Fmt, s: Surf, o: number): number {
  if (f.rdPre) return f.rdPre(s, o);
  return f.pre ? f.rd(s, o) : premul(f.rd(s, o));
}

// ---- alpha rules ----------------------------------------------------------

// srcOps, dstOps as [and, xor, add] per Porter-Duff rule; apply: ((a & and) ^ xor) + add
const ZERO = [0, 0, 0], ONE = [0, 0, 255], ALPHA = [255, 0, 0], INV = [255, -1, 256];
export const RULES = [[ZERO, ZERO], [ZERO, ZERO], [ONE, ZERO], [ONE, INV], [INV, ONE], [ALPHA, ZERO], [ZERO, ALPHA],
  [INV, ZERO], [ZERO, INV], [ZERO, ONE], [ALPHA, INV], [INV, ALPHA], [INV, INV]];

export function extraAlpha8(ea: number): number {
  return (Math.fround(ea * 255) + 0.5) | 0;
}

// the premultiplied color components of a fill color on a given format
function fillColor(f: Fmt, fg: number) {
  let r = (fg >> 16) & 255, g = (fg >> 8) & 255, b = fg & 255;
  if (f.gray) r = g = b = gray(r, g, b);
  return { a: fg >>> 24, r, g, b };
}

// What a loop gets beyond byte offsets: the first pixel column of the source
// and destination (bit positions of the packed types), the destination row
// the ordered dither starts at, and the XOR mode pixel and alpha mask.
export interface Ctx {
  sx: number;
  dx: number;
  dy: number;
  xor: number;
  mask: number;
  // the composite's extra alpha, for the 16-bit loops
  ea?: number;
}

export const ditherOf = (c: Ctx | undefined, x: number, y: number) => ((((c ? c.dy : 0) + y) & 7) << 3) | (((c ? c.dx : 0) + x) & 7);

export type MaskFillFn = (s: Surf, o0: number, mask: Uint8Array | null, mo: number, ms: number, w: number, h: number, fg: number, rule: number, c?: Ctx) => void;
export type MaskBlitFn = (d: Surf, dOff: number, sr: Surf, sOff: number, mask: Uint8Array | null, mo: number, ms: number, w: number, h: number, rule: number, extra: number, c?: Ctx) => void;

export function srcMaskFill(f: Fmt): MaskFillFn {
  return (s, o0, mask, mo, ms, w, h, fg) => {
    const c = fillColor(f, fg);
    let sa = c.a, sr = c.r, sg = c.g, sb = c.b;
    let fillArgb: number;
    if (sa === 0) {
      sr = sg = sb = 0;
      fillArgb = 0;
    } else {
      fillArgb = (sa << 24) | (c.r << 16) | (c.g << 8) | c.b;
      if (sa !== 255) {
        sr = MUL8(sa, sr);
        sg = MUL8(sa, sg);
        sb = MUL8(sa, sb);
      }
      if (f.pre) fillArgb = (sa << 24) | (sr << 16) | (sg << 8) | sb;
    }
    const raw = sa !== 0 && f.opaque && !f.gray ? fg : fillArgb;
    const store = f.wrWord ?? f.wr;
    for (let y = 0; y < h; y++) {
      let o = o0 + y * s.scan;
      for (let x = 0; x < w; x++, o += f.ps) {
        const pa = mask ? mask[mo + y * ms + x] : 255;
        if (pa === 0) continue;
        if (pa === 255) {
          store(s, o, raw);
          continue;
        }
        const dstF = 255 - pa;
        const p = f.rd(s, o);
        let ra = MUL8(dstF, p >>> 24);
        const df = f.pre ? dstF : ra;
        ra += MUL8(pa, sa);
        let rr = MUL8(df, (p >> 16) & 255) + MUL8(pa, sr);
        let rg = MUL8(df, (p >> 8) & 255) + MUL8(pa, sg);
        let rb = MUL8(df, p & 255) + MUL8(pa, sb);
        if (!f.pre && ra && ra < 255) {
          rr = DIV8(rr, ra);
          rg = DIV8(rg, ra);
          rb = DIV8(rb, ra);
        }
        f.wr(s, o, (ra << 24) | (rr << 16) | (rg << 8) | rb);
      }
    }
  };
}

export function srcOverMaskFill(f: Fmt): MaskFillFn {
  return (s, o0, mask, mo, ms, w, h, fg) => {
    const c = fillColor(f, fg);
    const sa = c.a;
    let sr = c.r, sg = c.g, sb = c.b;
    if (sa !== 255) {
      if (sa === 0) return;
      sr = MUL8(sa, sr);
      sg = MUL8(sa, sg);
      sb = MUL8(sa, sb);
    }
    for (let y = 0; y < h; y++) {
      let o = o0 + y * s.scan;
      for (let x = 0; x < w; x++, o += f.ps) {
        let pa = 255;
        let ra: number, rr: number, rg: number, rb: number;
        if (mask) {
          pa = mask[mo + y * ms + x];
          if (pa === 0) continue;
          if (pa !== 255) {
            ra = MUL8(pa, sa);
            rr = MUL8(pa, sr);
            rg = MUL8(pa, sg);
            rb = MUL8(pa, sb);
          } else {
            ra = sa;
            rr = sr;
            rg = sg;
            rb = sb;
          }
          if (ra !== 255) {
            let dstF = 255 - ra;
            const p = f.rd(s, o);
            const dstA = MUL8(dstF, p >>> 24);
            if (!f.pre) dstF = dstA;
            ra += dstA;
            if (dstF) {
              let tr = (p >> 16) & 255, tg = (p >> 8) & 255, tb = p & 255;
              if (dstF !== 255) {
                tr = MUL8(dstF, tr);
                tg = MUL8(dstF, tg);
                tb = MUL8(dstF, tb);
              }
              rr += tr;
              rg += tg;
              rb += tb;
            }
          }
          if (!f.opaque && !f.pre && ra && ra < 255) {
            rr = DIV8(rr, ra);
            rg = DIV8(rg, ra);
            rb = DIV8(rb, ra);
          }
        } else {
          let dstF = 255 - sa;
          const p = f.rd(s, o);
          ra = MUL8(dstF, p >>> 24);
          if (!f.pre) dstF = ra;
          ra += sa;
          rr = MUL8(dstF, (p >> 16) & 255) + sr;
          rg = MUL8(dstF, (p >> 8) & 255) + sg;
          rb = MUL8(dstF, p & 255) + sb;
          if (!f.opaque && !f.pre && ra && ra < 255) {
            rr = DIV8(rr, ra);
            rg = DIV8(rg, ra);
            rb = DIV8(rb, ra);
          }
        }
        f.wr(s, o, (ra << 24) | (rr << 16) | (rg << 8) | rb);
      }
    }
  };
}

export function alphaMaskFill(f: Fmt): MaskFillFn {
  return (s, o0, mask, mo, ms, w, h, fg, rule, ctx) => {
    const c = fillColor(f, fg);
    const srcA = c.a;
    let sr = c.r, sg = c.g, sb = c.b;
    if (srcA !== 255) {
      sr = MUL8(srcA, sr);
      sg = MUL8(srcA, sg);
      sb = MUL8(srcA, sb);
    }
    const [[sAnd, sXor, sAdd], [dAnd, dXor, dAdd]] = RULES[rule];
    const dstFbase = ((srcA & dAnd) ^ dXor) + dAdd;
    const loadDst = mask !== null || (dAnd | dAdd) !== 0 || sAnd !== 0;
    for (let y = 0; y < h; y++) {
      let o = o0 + y * s.scan;
      for (let x = 0; x < w; x++, o += f.ps) {
        let pathA = 255, dstF = dstFbase;
        if (mask) {
          pathA = mask[mo + y * ms + x];
          if (pathA === 0) continue;
        }
        let dstA = 0, p = 0;
        if (loadDst) {
          p = f.rd(s, o);
          dstA = p >>> 24;
        }
        let srcF = ((dstA & sAnd) ^ sXor) + sAdd;
        if (pathA !== 255) {
          srcF = MUL8(pathA, srcF);
          dstF = 255 - pathA + MUL8(pathA, dstF);
        }
        let ra: number, rr: number, rg: number, rb: number;
        if (srcF) {
          if (srcF === 255) {
            ra = srcA;
            rr = sr;
            rg = sg;
            rb = sb;
          } else {
            ra = MUL8(srcF, srcA);
            rr = MUL8(srcF, sr);
            rg = MUL8(srcF, sg);
            rb = MUL8(srcF, sb);
          }
        } else {
          if (dstF === 255) continue;
          ra = rr = rg = rb = 0;
        }
        if (dstF) {
          dstA = MUL8(dstF, dstA);
          ra += dstA;
          if (f.pre) dstA = dstF;
          if (dstA) {
            let tr = (p >> 16) & 255, tg = (p >> 8) & 255, tb = p & 255;
            if (dstA !== 255) {
              tr = MUL8(dstA, tr);
              tg = MUL8(dstA, tg);
              tb = MUL8(dstA, tb);
            }
            rr += tr;
            rg += tg;
            rb += tb;
          }
        }
        if (!f.pre && ra && ra < 255) {
          rr = DIV8(rr, ra);
          rg = DIV8(rg, ra);
          rb = DIV8(rb, ra);
        }
        f.wr(s, o, (ra << 24) | (rr << 16) | (rg << 8) | rb, ditherOf(ctx, x, y));
      }
    }
  };
}

// source pixel components for the mask blits: gray destinations blend one
// component, the gray of the source
function srcComps(sf: Fmt, df: Fmt, p: number): number {
  if (!df.gray) return p;
  const g = gray((p >> 16) & 255, (p >> 8) & 255, p & 255);
  return (p & 0xff000000) | (g * 0x010101);
}

export function srcOverMaskBlit(sf: Fmt, df: Fmt): MaskBlitFn {
  return (d, dOff, sr, sOff, mask, mo, ms, w, h, _rule, extraA) => {
    for (let y = 0; y < h; y++) {
      let od = dOff + y * d.scan, os = sOff + y * sr.scan;
      for (let x = 0; x < w; x++, od += df.ps, os += sf.ps) {
        let pathA = 255;
        if (mask) {
          pathA = mask[mo + y * ms + x];
          if (pathA === 0) continue;
          pathA = MUL8(pathA, extraA);
        } else pathA = extraA;
        const sp = sf.rd(sr, os);
        let ra = MUL8(pathA, sp >>> 24);
        if (!ra) continue;
        let srcF = sf.pre ? pathA : ra;
        const q = srcComps(sf, df, sp);
        let rr = (q >> 16) & 255, rg = (q >> 8) & 255, rb = q & 255;
        if (ra < 255) {
          const p = df.rd(d, od);
          let dstF = 255 - ra;
          const dstA = MUL8(dstF, p >>> 24);
          if (!df.pre) dstF = dstA;
          ra += dstA;
          rr = MUL8(dstF, (p >> 16) & 255) + MUL8(srcF, rr);
          rg = MUL8(dstF, (p >> 8) & 255) + MUL8(srcF, rg);
          rb = MUL8(dstF, p & 255) + MUL8(srcF, rb);
        } else if (srcF < 255) {
          rr = MUL8(srcF, rr);
          rg = MUL8(srcF, rg);
          rb = MUL8(srcF, rb);
        }
        if (!df.opaque && !df.pre && ra && ra < 255) {
          rr = DIV8(rr, ra);
          rg = DIV8(rg, ra);
          rb = DIV8(rb, ra);
        }
        df.wr(d, od, (ra << 24) | (rr << 16) | (rg << 8) | rb);
      }
    }
  };
}

export function alphaMaskBlit(sf: Fmt, df: Fmt): MaskBlitFn {
  return (d, dOff, sr, sOff, mask, mo, ms, w, h, rule, extraA, c) => {
    const [[sAnd, sXor, sAdd], [dAnd, dXor, dAdd]] = RULES[rule];
    const loadSrc = (sAnd | sAdd) !== 0 || dAnd !== 0;
    const loadDst = mask !== null || (dAnd | dAdd) !== 0 || sAnd !== 0;
    for (let y = 0; y < h; y++) {
      let od = dOff + y * d.scan, os = sOff + y * sr.scan;
      for (let x = 0; x < w; x++, od += df.ps, os += sf.ps) {
        let pathA = 255;
        if (mask) {
          pathA = mask[mo + y * ms + x];
          if (pathA === 0) continue;
        }
        let srcA = 0, dstA = 0, sp = 0, dp = 0;
        if (loadSrc) {
          sp = sf.rd(sr, os);
          srcA = MUL8(extraA, sp >>> 24);
        }
        if (loadDst) {
          dp = df.rd(d, od);
          dstA = dp >>> 24;
        }
        let srcF = ((dstA & sAnd) ^ sXor) + sAdd;
        let dstF = ((srcA & dAnd) ^ dXor) + dAdd;
        if (pathA !== 255) {
          srcF = MUL8(pathA, srcF);
          dstF = 255 - pathA + MUL8(pathA, dstF);
        }
        let ra = 0, rr = 0, rg = 0, rb = 0;
        if (srcF) {
          ra = MUL8(srcF, srcA);
          srcF = sf.pre ? MUL8(srcF, extraA) : ra;
          if (srcF) {
            const q = srcComps(sf, df, sp);
            rr = (q >> 16) & 255;
            rg = (q >> 8) & 255;
            rb = q & 255;
            if (srcF !== 255) {
              rr = MUL8(srcF, rr);
              rg = MUL8(srcF, rg);
              rb = MUL8(srcF, rb);
            }
          } else {
            if (dstF === 255) continue;
          }
        } else {
          if (dstF === 255) continue;
          ra = 0;
        }
        if (dstF) {
          dstA = MUL8(dstF, dstA);
          if (!df.pre) dstF = dstA;
          ra += dstA;
          if (dstF) {
            let tr = (dp >> 16) & 255, tg = (dp >> 8) & 255, tb = dp & 255;
            if (dstF !== 255) {
              tr = MUL8(dstF, tr);
              tg = MUL8(dstF, tg);
              tb = MUL8(dstF, tb);
            }
            rr += tr;
            rg += tg;
            rb += tb;
          }
        }
        if (!df.pre && ra && ra < 255) {
          rr = DIV8(rr, ra);
          rg = DIV8(rg, ra);
          rb = DIV8(rb, ra);
        }
        df.wr(d, od, (ra << 24) | (rr << 16) | (rg << 8) | rb, ditherOf(c, x, y));
      }
    }
  };
}

// ---- blits ----------------------------------------------------------------

export type BlitFn = (d: Surf, dOff: number, sr: Surf, sOff: number, w: number, h: number, c?: Ctx) => void;
export type ScaleFn = (d: Surf, dOff: number, sr: Surf, sOff: number, w: number, h: number, sx: number, sy: number, sxinc: number, syinc: number, shift: number, c?: Ctx) => void;

export function copyBlit(ps: number): BlitFn {
  return (d, dOff, sr, sOff, w, h) => {
    const n = w * ps;
    const same = (d.i32 ?? d.u16 ?? d.u8) === (sr.i32 ?? sr.u16 ?? sr.u8);
    // rows copy in the direction that keeps overlapping source rows intact
    const rev = same && dOff > sOff;
    for (let i = 0; i < h; i++) {
      const y = rev ? h - 1 - i : i;
      const od = dOff + y * d.scan, os = sOff + y * sr.scan;
      if (d.i32) d.i32.copyWithin(od >> 2, os >> 2, (os + n) >> 2);
      else if (d.u16) d.u16.copyWithin(od >> 1, os >> 1, (os + n) >> 1);
      else d.u8!.copyWithin(od, os, os + n);
    }
  };
}

function views(s: Surf, o: number, n: number) {
  return s.i32 ? s.i32.subarray(o >> 2, (o + n) >> 2) : s.u16 ? s.u16.subarray(o >> 1, (o + n) >> 1) : s.u8!.subarray(o, o + n);
}

// Distinct arrays copy through set(); the same array needs copyWithin.
export function isoCopy(ps: number): BlitFn {
  const inPlace = copyBlit(ps);
  return (d, dOff, sr, sOff, w, h) => {
    if ((d.i32 ?? d.u16 ?? d.u8) === (sr.i32 ?? sr.u16 ?? sr.u8)) return inPlace(d, dOff, sr, sOff, w, h);
    const n = w * ps;
    for (let y = 0; y < h; y++) {
      const dv = views(d, dOff + y * d.scan, n);
      dv.set(views(sr, sOff + y * sr.scan, n));
    }
  };
}

export function convertBlit(sf: Fmt, df: Fmt): BlitFn {
  return (d, dOff, sr, sOff, w, h, c) => {
    for (let y = 0; y < h; y++) {
      let od = dOff + y * d.scan, os = sOff + y * sr.scan;
      for (let x = 0; x < w; x++, od += df.ps, os += sf.ps) wrArgb(df, d, od, rdArgb(sf, sr, os), ditherOf(c, x, y));
    }
  };
}

// IntArgb to IntBgr and back swap red and blue on the raw word, which leaves
// the old green in the unused top byte
const swap = (p: number) => (p << 16) | (p & 0xff00) | ((p >> 16) & 255);

export function swapBlit(): BlitFn {
  return (d, dOff, sr, sOff, w, h) => {
    for (let y = 0; y < h; y++) {
      let od = (dOff + y * d.scan) >> 2, os = (sOff + y * sr.scan) >> 2;
      for (let x = 0; x < w; x++) d.i32![od++] = swap(sr.i32![os++]);
    }
  };
}

export function swapScale(): ScaleFn {
  return (d, dOff, sr, sOff, w, h, sx, sy, sxinc, syinc, shift) => {
    for (let y = 0; y < h; y++, sy += syinc) {
      const rowS = sOff + (sy >> shift) * sr.scan;
      let od = (dOff + y * d.scan) >> 2, tx = sx;
      for (let x = 0; x < w; x++, tx += sxinc) d.i32![od++] = swap(sr.i32![(rowS + (tx >> shift) * 4) >> 2]);
    }
  };
}

export function isoScale(ps: number): ScaleFn {
  return (d, dOff, sr, sOff, w, h, sx, sy, sxinc, syinc, shift) => {
    for (let y = 0; y < h; y++, sy += syinc) {
      const rowS = sOff + (sy >> shift) * sr.scan;
      let od = dOff + y * d.scan, tx = sx;
      for (let x = 0; x < w; x++, od += ps, tx += sxinc) {
        const os = rowS + (tx >> shift) * ps;
        if (d.i32) d.i32[od >> 2] = sr.i32![os >> 2];
        else if (d.u16) d.u16[od >> 1] = sr.u16![os >> 1];
        else for (let k = 0; k < ps; k++) d.u8![od + k] = sr.u8![os + k];
      }
    }
  };
}

export function convertScale(sf: Fmt, df: Fmt): ScaleFn {
  return (d, dOff, sr, sOff, w, h, sx, sy, sxinc, syinc, shift, c) => {
    for (let y = 0; y < h; y++, sy += syinc) {
      const rowS = sOff + (sy >> shift) * sr.scan;
      let od = dOff + y * d.scan, tx = sx;
      for (let x = 0; x < w; x++, od += df.ps, tx += sxinc) wrArgb(df, d, od, rdArgb(sf, sr, rowS + (tx >> shift) * sf.ps), ditherOf(c, x, y));
    }
  };
}
