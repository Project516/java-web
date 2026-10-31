// How the solid loops store a pixel: plain stores and XOR mode stores
// (AnyByte, AnyShort, Any3Byte, AnyInt, Any4Byte loops of libawt).

import type { JObject } from "../runtime.ts";
import type { JVM } from "../jvm.ts";
import { gray, premul } from "./java2d-loops.ts";
import type { BlitFn, Surf } from "./java2d-loops.ts";
import { primOf, putPixel } from "./java2d-surface.ts";

export interface Pen {
  // the rectangle x1..x2 by y1..y2, x2 and y2 exclusive
  fill(s: Surf, x1: number, y1: number, x2: number, y2: number, pixel: number): void;
  // a Bresenham run of `steps` pixels from (x, y); bumps are 1 pixel right, 2 left, 4 scan down, 8 up
  run(s: Surf, x: number, y: number, pixel: number, steps: number, error: number, majorMask: number, errMajor: number, minorMask: number, errMinor: number): void;
  put(s: Surf, x: number, y: number, pixel: number): void;
}

// builds the pen for a draw call from the SunGraphics2D's composite
export type PenFactory = (xorpixel: number, alphamask: number) => Pen;

export function xorPixel(s: Surf, o: number, d: number) {
  if (s.i32) s.i32[o >> 2] ^= d;
  else if (s.u16) s.u16[o >> 1] ^= d;
  else {
    const u = s.u8!;
    u[o] ^= d;
    if (s.ps > 1) {
      u[o + 1] ^= d >> 8;
      u[o + 2] ^= d >> 16;
      if (s.ps > 3) u[o + 3] ^= d >> 24;
    }
  }
}

const bumpOf = (s: Surf, m: number) => (m & 1 ? s.ps : m & 2 ? -s.ps : m & 4 ? s.scan : m & 8 ? -s.scan : 0);

// the DrawLine loop: the pixel offset moves by the bumps, error stays a jint
function walk(s: Surf, x: number, y: number, steps: number, error: number, majorMask: number, errMajor: number, minorMask: number, errMinor: number, store: (o: number) => void) {
  const major = bumpOf(s, majorMask), minor = bumpOf(s, minorMask) + major;
  let o = s.off + y * s.scan + x * s.ps;
  if (errMajor === 0) {
    do {
      store(o);
      o += major;
    } while (--steps > 0);
  } else {
    do {
      store(o);
      if (error < 0) {
        o += major;
        error = (error + errMajor) | 0;
      } else {
        o += minor;
        error = (error - errMinor) | 0;
      }
    } while (--steps > 0);
  }
}

export const plainPen: Pen = {
  fill(s, x1, y1, x2, y2, pixel) {
    for (let y = y1; y < y2; y++) {
      const o = s.off + y * s.scan + x1 * s.ps;
      if (s.i32) s.i32.fill(pixel, o >> 2, (o >> 2) + x2 - x1);
      else if (s.u16) s.u16.fill(pixel, o >> 1, (o >> 1) + x2 - x1);
      else if (s.ps === 1) s.u8!.fill(pixel & 255, o, o + x2 - x1);
      else for (let x = 0, p = o; x < x2 - x1; x++, p += s.ps) putPixel(s, p, pixel);
    }
  },
  run(s, x, y, pixel, steps, error, majorMask, errMajor, minorMask, errMinor) {
    walk(s, x, y, steps, error, majorMask, errMajor, minorMask, errMinor, (o) => putPixel(s, o, pixel));
  },
  put(s, x, y, pixel) {
    putPixel(s, s.off + y * s.scan + x * s.ps, pixel);
  },
};

export function xorPen(xorpixel: number, alphamask: number): Pen {
  const delta = (pixel: number) => (pixel ^ xorpixel) & ~alphamask;
  return {
    fill(s, x1, y1, x2, y2, pixel) {
      const d = delta(pixel);
      for (let y = y1; y < y2; y++) {
        for (let x = x1, o = s.off + y * s.scan + x1 * s.ps; x < x2; x++, o += s.ps) xorPixel(s, o, d);
      }
    },
    run(s, x, y, pixel, steps, error, majorMask, errMajor, minorMask, errMinor) {
      const d = delta(pixel);
      walk(s, x, y, steps, error, majorMask, errMajor, minorMask, errMinor, (o) => xorPixel(s, o, d));
    },
    put(s, x, y, pixel) {
      xorPixel(s, s.off + y * s.scan + x * s.ps, delta(pixel));
    },
  };
}

const SG2D = "sun/java2d/SunGraphics2D", XOR = "sun/java2d/loops/XORComposite";

// the pen a solid primitive draws with, from its registered factory
export function penOf(vm: JVM, self: JObject, sg2d: JObject): Pen {
  const p = primOf(vm, self);
  if (p.comp !== "Xor") return p.fn(0, 0);
  const comp = vm.getField(sg2d, SG2D, "composite") as JObject;
  return p.fn(vm.getField(comp, XOR, "xorPixel"), vm.getField(comp, XOR, "alphaMask"));
}

// ---- XOR blits --------------------------------------------------------------

const swapAbgr = (v: number) => (v << 8) | (v >>> 24);

// the destination pixel for an ARGB color, as each type's PixelFromArgb makes it
export const pixelFromArgb: Record<string, (argb: number, d: Surf) => number> = {
  IntArgb: (v) => v,
  IntArgbPre: premul,
  IntRgb: (v) => v,
  IntBgr: (v) => (v << 16) | (v & 0xff00) | ((v >> 16) & 255),
  ThreeByteBgr: (v) => v,
  FourByteAbgr: swapAbgr,
  FourByteAbgrPre: (v) => swapAbgr(premul(v)),
  ByteGray: (v) => gray((v >> 16) & 255, (v >> 8) & 255, v & 255),
  Ushort565Rgb: (v) => ((v >> 8) & 0xf800) | ((v >> 5) & 0x7e0) | ((v >> 3) & 0x1f),
  Ushort555Rgb: (v) => ((v >> 9) & 0x7c00) | ((v >> 6) & 0x3e0) | ((v >> 3) & 0x1f),
};

// IntArgb to another type: a source pixel with alpha under 128 is skipped
export function xorBlit(type: string): BlitFn {
  const pf = pixelFromArgb[type];
  return (d, dOff, sr, sOff, w, h, c) => {
    for (let y = 0; y < h; y++) {
      let od = dOff + y * d.scan, os = sOff + y * sr.scan;
      for (let x = 0; x < w; x++, od += d.ps, os += 4) {
        const src = sr.i32![os >> 2];
        if (src >= 0) continue;
        xorPixel(d, od, (pf(src, d) ^ c!.xor) & ~c!.mask);
      }
    }
  };
}

function rawPixel(s: Surf, o: number): number {
  if (s.i32) return s.i32[o >> 2];
  if (s.u16) return s.u16[o >> 1];
  const u = s.u8!;
  let v = u[o];
  if (s.ps > 1) v |= (u[o + 1] << 8) | (u[o + 2] << 16);
  if (s.ps > 3) v |= u[o + 3] << 24;
  return v;
}

// the same type to itself: destination ^= source ^ xor pixel
export const isoXorBlit: BlitFn = (d, dOff, sr, sOff, w, h, c) => {
  for (let y = 0; y < h; y++) {
    let od = dOff + y * d.scan, os = sOff + y * sr.scan;
    for (let x = 0; x < w; x++, od += d.ps, os += sr.ps) xorPixel(d, od, rawPixel(sr, os) ^ c!.xor);
  }
};
