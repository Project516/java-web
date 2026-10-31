// UshortGray: the loops that blend in 16 bits (libawt's 1ShortGray strategy),
// the conversions and registrations of UshortGray.c.

import { RULES, convertBlit, convertScale, fmts, isoCopy, isoScale } from "./java2d-loops.ts";
import type { Ctx, Fmt, MaskBlitFn, MaskFillFn } from "./java2d-loops.ts";
import { isoXorBlit, pixelFromArgb, xorBlit } from "./java2d-pen.ts";

const gray16 = (r: number, g: number, b: number) => ((19672 * r + 38621 * g + 7500 * b) / 256) & 0xffff;
const argbGray16 = (v: number) => gray16((v >> 16) & 255, (v >> 8) & 255, v & 255);

const mul16 = (a: number, b: number) => Math.floor(((a * b) >>> 0) / 65535);
const div16 = (a: number, b: number) => Math.floor(((a * 65535) >>> 0) / b);
const promote = (a: number) => (a << 8) + a;

fmts.UshortGray = {
  ps: 2,
  opaque: true,
  pre: false,
  gray: true,
  rd: (s, o) => {
    const g = s.u16![o >> 1] >> 8;
    return 0xff000000 | (g * 0x010101);
  },
  wr: (s, o, v) => void (s.u16![o >> 1] = argbGray16(v)),
};
pixelFromArgb.UshortGray = argbGray16;

interface Ops { and: number; xor: number; add: number }

// the 16-bit alpha operands of a rule, from the 8-bit ones in RULES
function ops16([and, xor, add8]: number[]): Ops {
  const addval = add8 + xor;
  return { and: promote(and), xor, add: promote(addval) - xor };
}
const apply = (o: Ops, a: number) => (((a & o.and) ^ o.xor) + o.add) | 0;

// the extra alpha as C rounds it for 16-bit math, from the AlphaComposite's float
const extraAlpha16 = (c: Ctx | undefined) => Math.floor(c!.ea! * 65535.0 + 0.5);

export const srcMaskFill16: MaskFillFn = (s, o0, mask, mo, ms, w, h, fg) => {
  let srcA = promote(fg >>> 24);
  let srcG = argbGray16(fg);
  let fill: number;
  if (srcA === 0) {
    srcG = 0;
    fill = 0;
  } else {
    fill = srcG;
    if (srcA !== 0xffff) srcG = mul16(srcA, srcG);
  }
  for (let y = 0; y < h; y++) {
    let o = o0 + y * s.scan;
    for (let x = 0; x < w; x++, o += 2) {
      if (mask) {
        let pathA = mask[mo + y * ms + x];
        if (pathA === 0) continue;
        if (pathA !== 0xff) {
          pathA = promote(pathA);
          let dstF = 0xffff - pathA;
          let resA = mul16(dstF, 0xffff);
          dstF = resA;
          resA += mul16(pathA, srcA);
          let resG = Math.floor((((dstF * s.u16![o >> 1]) + (pathA * srcG)) >>> 0) / 65535);
          if (resA && resA < 0xffff) resG = div16(resG, resA);
          s.u16![o >> 1] = resG;
          continue;
        }
      }
      s.u16![o >> 1] = fill;
    }
  }
};

export const srcOverMaskFill16: MaskFillFn = (s, o0, mask, mo, ms, w, h, fg) => {
  const srcA = promote(fg >>> 24);
  let srcG = argbGray16(fg);
  if (srcA !== 0xffff) {
    if (srcA === 0) return;
    srcG = mul16(srcA, srcG);
  }
  for (let y = 0; y < h; y++) {
    let o = o0 + y * s.scan;
    for (let x = 0; x < w; x++, o += 2) {
      let resA: number, resG: number;
      if (mask) {
        let pathA = mask[mo + y * ms + x];
        if (pathA === 0) continue;
        if (pathA !== 0xff) {
          pathA = promote(pathA);
          resA = mul16(pathA, srcA);
          resG = mul16(pathA, srcG);
        } else {
          resA = srcA;
          resG = srcG;
        }
        if (resA !== 0xffff) {
          let dstF = 0xffff - resA;
          const dstA = mul16(dstF, 0xffff);
          dstF = dstA;
          resA += dstA;
          if (dstF) {
            let t = s.u16![o >> 1];
            if (dstF !== 0xffff) t = mul16(dstF, t);
            resG += t;
          }
        }
      } else {
        let dstF = 0xffff - srcA;
        resA = mul16(dstF, 0xffff);
        dstF = resA;
        resA += srcA;
        resG = mul16(dstF, s.u16![o >> 1]) + srcG;
      }
      s.u16![o >> 1] = resG;
    }
  }
};

export const alphaMaskFill16: MaskFillFn = (s, o0, mask, mo, ms, w, h, fg, rule) => {
  const srcA = promote(fg >>> 24);
  let srcG = argbGray16(fg);
  if (srcA !== 0xffff) srcG = mul16(srcA, srcG);
  const sop = ops16(RULES[rule][0]), dop = ops16(RULES[rule][1]);
  const loadDst = mask !== null || (dop.and | dop.add) !== 0 || sop.and !== 0;
  const dstFbase = apply(dop, srcA);
  for (let y = 0; y < h; y++) {
    let o = o0 + y * s.scan;
    for (let x = 0; x < w; x++, o += 2) {
      let pathA = 0xffff, dstF = dstFbase;
      if (mask) {
        pathA = mask[mo + y * ms + x];
        if (pathA === 0) continue;
        pathA = promote(pathA);
      }
      let dstA = loadDst ? 0xffff : 0;
      let srcF = apply(sop, dstA);
      if (pathA !== 0xffff) {
        srcF = mul16(pathA, srcF);
        dstF = 0xffff - pathA + mul16(pathA, dstF);
      }
      let resA: number, resG: number;
      if (srcF) {
        if (srcF === 0xffff) {
          resA = srcA;
          resG = srcG;
        } else {
          resA = mul16(srcF, srcA);
          resG = mul16(srcF, srcG);
        }
      } else {
        if (dstF === 0xffff) continue;
        resA = 0;
        resG = 0;
      }
      if (dstF) {
        dstA = mul16(dstF, dstA);
        resA += dstA;
        if (dstA) {
          let t = s.u16![o >> 1];
          if (dstA !== 0xffff) t = mul16(dstA, t);
          resG += t;
        }
      }
      if (resA && resA < 0xffff) resG = div16(resG, resA);
      s.u16![o >> 1] = resG;
    }
  }
};

// source alpha as 16 bits, and the source gray, for the mask blits
const srcAlpha = (sf: Fmt, p: number) => (sf.opaque ? 0xffff : promote(p >>> 24));

export function srcOverMaskBlit16(sf: Fmt): MaskBlitFn {
  return (d, dOff, sr, sOff, mask, mo, ms, w, h, _rule, _extra, c) => {
    const extraA = extraAlpha16(c);
    for (let y = 0; y < h; y++) {
      let od = dOff + y * d.scan, os = sOff + y * sr.scan;
      for (let x = 0; x < w; x++, od += 2, os += 4) {
        let pathA = 0xffff;
        if (mask) {
          pathA = mask[mo + y * ms + x];
          if (pathA === 0) continue;
          pathA = mul16(promote(pathA), extraA);
        } else pathA = extraA;
        const sp = sf.rd(sr, os);
        let resA = mul16(pathA, srcAlpha(sf, sp));
        if (!resA) continue;
        let srcF = sf.pre ? pathA : resA;
        let resG = argbGray16(sp);
        if (resA < 0xffff) {
          let dstF = 0xffff - resA;
          const dstA = mul16(dstF, 0xffff);
          dstF = dstA;
          resA += dstA;
          resG = Math.floor((((dstF * d.u16![od >> 1]) + (srcF * resG)) >>> 0) / 65535);
        } else if (srcF < 0xffff) resG = mul16(srcF, resG);
        d.u16![od >> 1] = resG;
      }
    }
  };
}

export function alphaMaskBlit16(sf: Fmt): MaskBlitFn {
  return (d, dOff, sr, sOff, mask, mo, ms, w, h, rule, _extra, c) => {
    const extraA = extraAlpha16(c);
    const sop = ops16(RULES[rule][0]), dop = ops16(RULES[rule][1]);
    const loadSrc = (sop.and | sop.add) !== 0 || dop.and !== 0;
    const loadDst = mask !== null || (dop.and | dop.add) !== 0 || sop.and !== 0;
    for (let y = 0; y < h; y++) {
      let od = dOff + y * d.scan, os = sOff + y * sr.scan;
      for (let x = 0; x < w; x++, od += 2, os += 4) {
        let pathA = 0xffff;
        if (mask) {
          pathA = mask[mo + y * ms + x];
          if (pathA === 0) continue;
          pathA = promote(pathA);
        }
        let srcA = 0, dstA = 0, sp = 0;
        if (loadSrc) {
          sp = sf.rd(sr, os);
          srcA = mul16(extraA, srcAlpha(sf, sp));
        }
        if (loadDst) dstA = 0xffff;
        let srcF = apply(sop, dstA), dstF = apply(dop, srcA);
        if (pathA !== 0xffff) {
          srcF = mul16(pathA, srcF);
          dstF = 0xffff - pathA + mul16(pathA, dstF);
        }
        let resA = 0, resG = 0;
        if (srcF) {
          resA = mul16(srcF, srcA);
          srcF = sf.pre ? mul16(srcF, extraA) : resA;
          if (srcF) {
            resG = argbGray16(sp);
            if (srcF !== 0xffff) resG = mul16(srcF, resG);
          } else if (dstF === 0xffff) continue;
        } else {
          if (dstF === 0xffff) continue;
        }
        if (dstF) {
          dstA = mul16(dstF, dstA);
          dstF = dstA;
          resA += dstA;
          if (dstF) {
            let t = d.u16![od >> 1];
            if (dstF !== 0xffff) t = mul16(dstF, t);
            resG += t;
          }
        }
        if (resA && resA < 0xffff) resG = div16(resG, resA);
        d.u16![od >> 1] = resG;
      }
    }
  };
}

type Add = (cls: string, src: string, comp: string, dst: string, fn?: any) => void;

export function registerUshortGray(add: Add) {
  const f = fmts.UshortGray;
  const into = (src: string, impl = src) => {
    add("Blit", src, "SrcNoEa", "UshortGray", convertBlit(fmts[impl], f));
    add("ScaledBlit", src, "SrcNoEa", "UshortGray", convertScale(fmts[impl], f));
  };
  add("Blit", "UshortGray", "SrcNoEa", "UshortGray", isoCopy(2));
  add("ScaledBlit", "UshortGray", "SrcNoEa", "UshortGray", isoScale(2));
  add("Blit", "UshortGray", "Xor", "UshortGray", isoXorBlit);
  add("Blit", "UshortGray", "SrcNoEa", "IntArgb", convertBlit(f, fmts.IntArgb));
  add("ScaledBlit", "UshortGray", "SrcNoEa", "IntArgb", convertScale(f, fmts.IntArgb));
  add("Blit", "UshortGray", "SrcNoEa", "ByteGray", convertBlit(f, fmts.ByteGray));
  add("ScaledBlit", "UshortGray", "SrcNoEa", "ByteGray", convertScale(f, fmts.ByteGray));
  into("IntArgb");
  into("IntRgb", "IntArgb");
  into("ThreeByteBgr");
  into("ByteGray");
  add("Blit", "IntArgb", "Xor", "UshortGray", xorBlit("UshortGray"));
  add("MaskFill", "AnyColor", "Src", "UshortGray", srcMaskFill16);
  add("MaskFill", "AnyColor", "SrcOver", "UshortGray", srcOverMaskFill16);
  add("MaskFill", "AnyColor", "AnyAlpha", "UshortGray", alphaMaskFill16);
  for (const s of ["IntArgb", "IntArgbPre"]) add("MaskBlit", s, "SrcOver", "UshortGray", srcOverMaskBlit16(fmts[s]));
  for (const s of ["IntArgb", "IntArgbPre", "IntRgb"]) add("MaskBlit", s, "AnyAlpha", "UshortGray", alphaMaskBlit16(fmts[s]));
}
