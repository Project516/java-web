// Indexed (ByteIndexed) and bit-packed (ByteBinary1Bit, 2Bit, 4Bit)
// surfaces: palettes, the inverse color table and ordered dither of
// the indexed store, and the loops libawt registers for these types.

import { PendingThrow } from "../thread.ts";
import { alphaMaskBlit, alphaMaskFill, convertBlit, convertScale, ditherOf, fmts, isoCopy, isoScale } from "./java2d-loops.ts";
import type { BlitFn, Ctx, Fmt, MaskBlitFn, MaskFillFn, ScaleFn, Surf } from "./java2d-loops.ts";
import { pixelFromArgb, xorBlit } from "./java2d-pen.ts";
import type { Pen, PenFactory } from "./java2d-pen.ts";

// ---- inverse color table and dither ----------------------------------------

interface Cube {
  used: Uint8Array;
  lut: Uint8Array;
  rgb: Uint16Array;
  indices: Uint8Array;
  active: number;
}

function insertNew(st: Cube, rgb: number, index: number) {
  if (!st.used[rgb]) {
    st.used[rgb] = 1;
    st.lut[rgb] = index;
    st.rgb[st.active] = rgb;
    st.indices[st.active] = index;
    st.active++;
  }
}

function activate(rgb: number, mask: number, delta: number, st: Cube, index: number) {
  if ((rgb & mask) + delta <= mask) insertNew(st, rgb + delta, index);
  if ((rgb & mask) >= delta) insertNew(st, rgb - delta, index);
}

// breadth-first from the palette's own colors through the 32x32x32 cube
function recurseLevel(prior: Cube) {
  const cur: Cube = { used: prior.used, lut: prior.lut, rgb: new Uint16Array(6 * prior.active), indices: new Uint8Array(6 * prior.active), active: 0 };
  for (let i = prior.active - 1; i >= 0; i--) {
    const rgb = prior.rgb[i], index = prior.indices[i];
    activate(rgb, 0x7c00, 0x0400, cur, index);
    activate(rgb, 0x03e0, 0x0020, cur, index);
    activate(rgb, 0x001f, 0x0001, cur, index);
  }
  if (cur.active) recurseLevel(cur);
}

function initCubemap(cmap: Int32Array, len: number): Uint8Array {
  const st: Cube = { used: new Uint8Array(32768), lut: new Uint8Array(32768), rgb: new Uint16Array(len), indices: new Uint8Array(len), active: 0 };
  const key = (p: number) => ((p & 0x00f80000) >> 9) | ((p & 0x0000f800) >> 6) | ((p & 0xf8) >> 3);
  const mid = (len >> 1) + (len & 1);
  for (let i = 0; i < mid; i++) {
    insertNew(st, key(cmap[i]), i & 255);
    insertNew(st, key(cmap[len - i - 1]), (len - i - 1) & 255);
  }
  recurseLevel(st);
  return st.lut;
}

// true when the palette has the corner colors of the cube to within 5
function representsPrimaries(cmap: Int32Array, cube: Uint8Array): boolean {
  const delta = 5;
  for (let i = 0; i < 32; i += 31) {
    for (let j = 0; j < 32; j += 31) {
      for (let k = 0; k < 32; k += 31) {
        const color = cmap[cube[i + 32 * (j + 32 * k)]];
        const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
        if (i === 0 ? b > delta : b < 255 - delta) return false;
        if (j === 0 ? g > delta : g < 255 - delta) return false;
        if (k === 0 ? r > delta : r < 255 - delta) return false;
      }
    }
  }
  return true;
}

function signedDither(minerr: number, maxerr: number): Int8Array {
  const o = new Int8Array(64);
  for (let k = 1; k < 8; k *= 2) {
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        o[(i << 3) + j] = o[(i << 3) + j] * 4;
        o[((i + k) << 3) + j + k] = o[(i << 3) + j] + 1;
        o[(i << 3) + j + k] = o[(i << 3) + j] + 2;
        o[((i + k) << 3) + j] = o[(i << 3) + j] + 3;
      }
    }
  }
  for (let k = 0; k < 64; k++) o[k] = Math.trunc((o[k] * (maxerr - minerr)) / 64) + minerr;
  return o;
}

const ERR = (() => {
  const q = Math.trunc(256 / Math.pow(256, 1 / 3));
  const r = signedDither(-q >> 1, q >> 1), g = signedDither(-q >> 1, q >> 1), b = signedDither(-q >> 1, q >> 1);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 4; j++) {
      let k = g[(i << 3) + j];
      g[(i << 3) + j] = g[(i << 3) + 7 - j];
      g[(i << 3) + 7 - j] = k;
      k = b[(j << 3) + i];
      b[(j << 3) + i] = b[((7 - j) << 3) + i];
      b[((7 - j) << 3) + i] = k;
    }
  }
  return { r, g, b };
})();

function colorData(s: Surf) {
  if (s.cdata) return s.cdata;
  if (!s.lut) throw new PendingThrow("java/lang/NullPointerException", "Attempt to lock missing colormap");
  const inv = initCubemap(s.lut, s.lutSize);
  return (s.cdata = { inv, primaries: representsPrimaries(s.lut, inv) });
}

const invColor = (argb: number, s: Surf) => colorData(s).inv[(((argb >> 19) & 31) << 10) + (((argb >> 11) & 31) << 5) + ((argb >> 3) & 31)];

// ---- formats ----------------------------------------------------------------

const lutAt = (s: Surf, i: number) => s.lut![i] | 0;

const biStore = (s: Surf, o: number, v: number, d = 0) => {
  let r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  const cd = colorData(s);
  if (!((r === 0 || r === 255) && (g === 0 || g === 255) && (b === 0 || b === 255) && cd.primaries)) {
    r += ERR.r[d];
    g += ERR.g[d];
    b += ERR.b[d];
  }
  if ((r | g | b) >> 8 !== 0) {
    if (r >> 8 !== 0) r = ~(r >> 31) & 255;
    if (g >> 8 !== 0) g = ~(g >> 31) & 255;
    if (b >> 8 !== 0) b = ~(b >> 31) & 255;
  }
  s.u8![o] = cd.inv[((r >> 3) << 10) + ((g >> 3) << 5) + (b >> 3)];
};

function bbFmt(bpp: number): Fmt {
  const sh = bpp === 1 ? 3 : bpp === 2 ? 2 : 1, mask = (1 << bpp) - 1, max = 8 - bpp, ppb = 8 / bpp;
  return {
    ps: 1,
    packed: true,
    opaque: false,
    pre: false,
    gray: false,
    rd: (s, o) => lutAt(s, (s.u8![o >> sh] >> (max - (o & (ppb - 1)) * bpp)) & mask),
    wr: (s, o, v) => {
      const bits = max - (o & (ppb - 1)) * bpp, i = o >> sh;
      s.u8![i] = (s.u8![i] & ~(mask << bits)) | (invColor(v, s) << bits);
    },
  };
}

fmts.ByteIndexed = { ps: 1, opaque: false, pre: false, gray: false, rd: (s, o) => lutAt(s, s.u8![o]), wr: biStore };
// transparent entries (alpha under 128) are 0, the rest are used as they are
fmts.ByteIndexedBm = { ...fmts.ByteIndexed, rdPre: (s, o) => { const a = lutAt(s, s.u8![o]); return a & (a >> 24); } };
fmts.ByteBinary1Bit = bbFmt(1);
fmts.ByteBinary2Bit = bbFmt(2);
fmts.ByteBinary4Bit = bbFmt(4);

pixelFromArgb.ByteIndexed = invColor;
pixelFromArgb.ByteBinary1Bit = invColor;
pixelFromArgb.ByteBinary2Bit = invColor;
pixelFromArgb.ByteBinary4Bit = invColor;

// ---- bit-packed pens --------------------------------------------------------

function bbPen(bpp: number, xor: boolean, xorpixel: number): Pen {
  const sh = bpp === 1 ? 3 : bpp === 2 ? 2 : 1, mask = (1 << bpp) - 1, max = 8 - bpp, ppb = 8 / bpp;
  const store = (s: Surf, slot: number, pixel: number) => {
    const bits = max - (slot & (ppb - 1)) * bpp, i = slot >> sh;
    s.u8![i] = xor ? s.u8![i] ^ (((pixel ^ xorpixel) & mask) << bits) : (s.u8![i] & ~(mask << bits)) | (pixel << bits);
  };
  return {
    fill(s, x1, y1, x2, y2, pixel) {
      for (let y = y1; y < y2; y++) {
        for (let x = x1, slot = s.off + y * s.scan + x1; x < x2; x++, slot++) store(s, slot, pixel);
      }
    },
    // DrawLine for packed types walks one position that holds both column and
    // row (a row is scan * ppb positions). The byte and bit come from a C
    // division and remainder of it, so a line going up drops most pixels.
    run(s, x, y, pixel, steps, error, majorMask, errMajor, minorMask, errMinor) {
      const bump = (m: number) => (m & 1 ? 1 : m & 2 ? -1 : m & 4 ? s.scan : m & 8 ? -s.scan : 0);
      const major = bump(majorMask), minor = bump(minorMask) + major;
      const row = (s.off - s.bo + y * s.scan) / ppb;
      do {
        const adj = x + s.bo, rem = adj % ppb, bits = max - rem * bpp;
        if (bits < 8) {
          const i = row + Math.trunc(adj / ppb);
          s.u8![i] = xor ? s.u8![i] ^ (((pixel ^ xorpixel) & mask) << bits) : (s.u8![i] & ~(mask << bits)) | (pixel << bits);
        }
        if (errMajor === 0 || error < 0) {
          x += major;
          error = (error + errMajor) | 0;
        } else {
          x += minor;
          error = (error - errMinor) | 0;
        }
      } while (--steps > 0);
    },
    put(s, x, y, pixel) {
      store(s, s.off + y * s.scan + x, pixel);
    },
  };
}

const bbPens = (bpp: number): { plain: PenFactory; xor: PenFactory } => {
  const plain = bbPen(bpp, false, 0);
  return { plain: () => plain, xor: (xorpixel) => bbPen(bpp, true, xorpixel) };
};

// IntArgb to bit-packed, skipping source pixels with alpha under 128
function bbXorBlit(bpp: number): BlitFn {
  const mask = (1 << bpp) - 1, max = 8 - bpp, ppb = 8 / bpp, sh = bpp === 1 ? 3 : bpp === 2 ? 2 : 1;
  return (d, dOff, sr, sOff, w, h, c) => {
    for (let y = 0; y < h; y++) {
      let od = dOff + y * d.scan, os = sOff + y * sr.scan;
      for (let x = 0; x < w; x++, od++, os += 4) {
        const src = sr.i32![os >> 2];
        if (src >= 0) continue;
        const bits = max - (od & (ppb - 1)) * bpp;
        d.u8![od >> sh] ^= (((invColor(src, d) ^ c!.xor) & mask) << bits);
      }
    }
  };
}

// ---- conversions from ByteIndexed -------------------------------------------

// the destination pixel of a palette entry for the transparent-skipping loops: IntBgr stays clean there
const xparPixel = (df: string, argb: number, d: Surf) => (df === "IntBgr" ? ((argb & 255) << 16) | (argb & 0xff00) | ((argb >> 16) & 255) : pixelFromArgb[df](argb, d));

// stores a palette entry in a destination; a ByteIndexed one dithers
function putArgb(df: string, xpar: boolean, d: Surf, o: number, argb: number, dither: number) {
  if (df === "ByteIndexed") biStore(d, o, argb, dither);
  else storeRaw(d, o, xpar ? xparPixel(df, argb, d) : pixelFromArgb[df](argb, d));
}

function lutBlit(df: string, xpar: boolean): BlitFn {
  const ps = fmts[df].ps;
  return (d, dOff, sr, sOff, w, h, c) => {
    for (let y = 0; y < h; y++) {
      let od = dOff + y * d.scan, os = sOff + y * sr.scan;
      for (let x = 0; x < w; x++, od += ps, os++) {
        const argb = lutAt(sr, sr.u8![os]);
        if (!xpar || argb < 0) putArgb(df, xpar, d, od, argb, ditherOf(c, x, y));
      }
    }
  };
}

function lutScale(df: string, xpar: boolean): ScaleFn {
  const ps = fmts[df].ps;
  return (d, dOff, sr, sOff, w, h, sx, sy, sxinc, syinc, shift, c) => {
    for (let y = 0; y < h; y++, sy += syinc) {
      const rowS = sOff + (sy >> shift) * sr.scan;
      let od = dOff + y * d.scan, tx = sx;
      for (let x = 0; x < w; x++, od += ps, tx += sxinc) {
        const argb = lutAt(sr, sr.u8![rowS + (tx >> shift)]);
        if (!xpar || argb < 0) putArgb(df, xpar, d, od, argb, ditherOf(c, x, y));
      }
    }
  };
}

// BlitBg: transparent entries become the background pixel
export type BlitBgFn = (d: Surf, dOff: number, sr: Surf, sOff: number, w: number, h: number, bg: number, c?: Ctx) => void;
function lutBlitBg(df: string): BlitBgFn {
  const ps = fmts[df].ps;
  return (d, dOff, sr, sOff, w, h, bg, c) => {
    for (let y = 0; y < h; y++) {
      let od = dOff + y * d.scan, os = sOff + y * sr.scan;
      for (let x = 0; x < w; x++, od += ps, os++) {
        const argb = lutAt(sr, sr.u8![os]);
        if (argb < 0) putArgb(df, false, d, od, argb, ditherOf(c, x, y));
        else storeRaw(d, od, bg);
      }
    }
  };
}

function storeRaw(s: Surf, o: number, pixel: number) {
  if (s.i32) s.i32[o >> 2] = pixel;
  else if (s.u16) s.u16[o >> 1] = pixel;
  else {
    const u = s.u8!;
    u[o] = pixel;
    if (s.ps > 1) {
      u[o + 1] = pixel >> 8;
      u[o + 2] = pixel >> 16;
      if (s.ps > 3) u[o + 3] = pixel >> 24;
    }
  }
}

// the first sr.lutSize palette entries are the same in both
function sameLut(sr: Surf, d: Surf) {
  if (sr.lut === d.lut) return true;
  if (sr.lutSize > d.lutSize) return false;
  for (let i = 0; i < sr.lutSize; i++) if (sr.lut![i] !== d.lut![i]) return false;
  return true;
}

const biBlit: BlitFn = (() => {
  const conv = convertBlit(fmts.ByteIndexed, fmts.ByteIndexed), copy = isoCopy(1);
  return (d, dOff, sr, sOff, w, h, c) => (sameLut(sr, d) ? copy(d, dOff, sr, sOff, w, h, c) : conv(d, dOff, sr, sOff, w, h, c));
})();

const biScale: ScaleFn = (() => {
  const conv = convertScale(fmts.ByteIndexed, fmts.ByteIndexed), copy = isoScale(1);
  return (d, dOff, sr, sOff, w, h, sx, sy, sxinc, syinc, shift, c) =>
    (sameLut(sr, d) ? copy(d, dOff, sr, sOff, w, h, sx, sy, sxinc, syinc, shift, c) : conv(d, dOff, sr, sOff, w, h, sx, sy, sxinc, syinc, shift, c));
})();

// ---- registration -----------------------------------------------------------

type Add = (cls: string, src: string, comp: string, dst: string, fn?: any) => void;

const DESTS = ["IntArgb", "IntArgbPre", "IntRgb", "IntBgr", "ThreeByteBgr", "FourByteAbgr", "FourByteAbgrPre", "ByteGray", "Ushort565Rgb", "Ushort555Rgb", "UshortGray"];

export function registerIndexed(add: Add) {
  const bi = fmts.ByteIndexed;
  const into = (src: string, impl = src) => {
    add("Blit", src, "SrcNoEa", "ByteIndexed", convertBlit(fmts[impl], bi));
    add("ScaledBlit", src, "SrcNoEa", "ByteIndexed", convertScale(fmts[impl], bi));
  };
  into("IntArgb");
  into("IntRgb", "IntArgb");
  into("ThreeByteBgr");
  into("ByteGray");
  add("Blit", "ByteIndexed", "SrcNoEa", "ByteIndexed", biBlit);
  add("ScaledBlit", "ByteIndexed", "SrcNoEa", "ByteIndexed", biScale);
  add("Blit", "ByteIndexedBm", "SrcOverNoEa", "ByteIndexed", lutBlit("ByteIndexed", true));
  add("ScaledBlit", "ByteIndexedBm", "SrcOverNoEa", "ByteIndexed", lutScale("ByteIndexed", true));
  add("BlitBg", "ByteIndexedBm", "SrcNoEa", "ByteIndexed", lutBlitBg("ByteIndexed"));
  add("Blit", "IntArgb", "Xor", "ByteIndexed", xorBlit("ByteIndexed"));
  add("MaskFill", "AnyColor", "AnyAlpha", "ByteIndexed", alphaMaskFill(bi));
  for (const s of ["IntArgb", "IntArgbPre", "IntRgb"]) add("MaskBlit", s, "AnyAlpha", "ByteIndexed", alphaMaskBlit(fmts[s], bi));
  for (const d of DESTS) {
    add("Blit", "ByteIndexed", "SrcNoEa", d, lutBlit(d, false));
    add("ScaledBlit", "ByteIndexed", "SrcNoEa", d, lutScale(d, false));
    add("Blit", "ByteIndexedBm", "SrcOverNoEa", d, lutBlit(d, true));
    add("ScaledBlit", "ByteIndexedBm", "SrcOverNoEa", d, lutScale(d, true));
    add("BlitBg", "ByteIndexedBm", "SrcNoEa", d, lutBlitBg(d));
  }
  add("TransformHelper", "ByteIndexed", "SrcNoEa", "IntArgbPre");
  add("TransformHelper", "ByteIndexedBm", "SrcNoEa", "IntArgbPre");
}

// Packed surfaces have no pixel stride, so the natives hand the loops a row and
// the loops add the column from the context.
const packedBlit = (fn: BlitFn, src: boolean, dst: boolean): BlitFn => (d, dOff, sr, sOff, w, h, c) =>
  fn(d, dst ? dOff + c!.dx : dOff, sr, src ? sOff + c!.sx : sOff, w, h, c);
const packedMaskBlit = (fn: MaskBlitFn, src: boolean, dst: boolean): MaskBlitFn => (d, dOff, sr, sOff, mask, mo, ms, w, h, rule, extra, c) =>
  fn(d, dst ? dOff + c!.dx : dOff, sr, src ? sOff + c!.sx : sOff, mask, mo, ms, w, h, rule, extra, c);
const packedFill = (fn: MaskFillFn): MaskFillFn => (s, o0, mask, mo, ms, w, h, fg, rule, c) => fn(s, o0 + c!.dx, mask, mo, ms, w, h, fg, rule, c);

export function registerPacked(add: Add) {
  for (const bpp of [1, 2, 4]) {
    const t = "ByteBinary" + bpp + "Bit", f = fmts[t], pens = bbPens(bpp);
    for (const cls of ["FillRect", "FillSpans", "DrawLine", "DrawRect", "DrawPolygons", "DrawPath", "FillPath"]) {
      add(cls, "AnyColor", "SrcNoEa", t, pens.plain);
      add(cls, "AnyColor", "Xor", t, pens.xor);
    }
    add("Blit", t, "SrcNoEa", t, packedBlit(convertBlit(f, f), true, true));
    add("Blit", t, "SrcNoEa", "IntArgb", packedBlit(convertBlit(f, fmts.IntArgb), true, false));
    add("Blit", "IntArgb", "SrcNoEa", t, packedBlit(convertBlit(fmts.IntArgb, f), false, true));
    add("Blit", "IntArgb", "Xor", t, packedBlit(bbXorBlit(bpp), false, true));
    add("MaskBlit", t, "AnyAlpha", "IntArgb", packedMaskBlit(alphaMaskBlit(f, fmts.IntArgb), true, false));
    add("MaskBlit", "IntArgb", "AnyAlpha", t, packedMaskBlit(alphaMaskBlit(fmts.IntArgb, f), false, true));
    add("MaskFill", "AnyColor", "AnyAlpha", t, packedFill(alphaMaskFill(f)));
  }
}
