// DrawGlyphList and DrawGlyphListAA: blit the glyph images of a GlyphList
// (libfontmanager's DrawGlyphList.c and libawt's glyph loop macros). The
// glyph images are the GlyphInfo structs of sun.font.StrikeCache. LCD glyph
// lists have no loop here, so the JDK falls back to grayscale antialiasing.

import type { JArray, JObject } from "../runtime.ts";
import type { JThread } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import type { Natives } from "./util.ts";
import { DIV8, MUL8, fmts, gray } from "./java2d-loops.ts";
import type { Fmt, Surf } from "./java2d-loops.ts";
import { add, clipBounds, lockBounds, primOf, putPixel, sgInt, surfOf } from "./java2d-surface.ts";

const GL = "sun/font/GlyphList";
const FAMILIES = ["AnyByte", "AnyShort", "Any3Byte", "AnyInt", "Any4Byte"];
const TYPES = ["IntArgb", "IntArgbPre", "IntRgb", "IntBgr", "ThreeByteBgr", "FourByteAbgr", "FourByteAbgrPre", "ByteGray", "Ushort565Rgb", "Ushort555Rgb"];

interface Glyph {
  pixels: number;
  rowBytes: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

type GlyphFn = (s: Surf, mem: Uint8Array, glyphs: Glyph[], pixel: number, argb: number, x1: number, y1: number, x2: number, y2: number) => void;

// Calls draw(o, g, row, col) for each glyph pixel inside the clip; g is the
// glyph's pixel offset of that pixel
function forPixels(s: Surf, glyphs: Glyph[], x1: number, y1: number, x2: number, y2: number, draw: (o: number, src: number) => void) {
  for (const g of glyphs) {
    if (!g.pixels) continue;
    let left = g.x, top = g.y, src = g.pixels;
    let right = left + g.width, bottom = top + g.height;
    if (left < x1) {
      src += x1 - left;
      left = x1;
    }
    if (top < y1) {
      src += (y1 - top) * g.rowBytes;
      top = y1;
    }
    if (right > x2) right = x2;
    if (bottom > y2) bottom = y2;
    for (let y = top; y < bottom; y++, src += g.rowBytes) {
      let o = s.off + y * s.scan + left * s.ps;
      for (let x = 0; x < right - left; x++, o += s.ps) draw(o, src + x);
    }
  }
}

const solid: GlyphFn = (s, mem, glyphs, pixel, _argb, x1, y1, x2, y2) =>
  forPixels(s, glyphs, x1, y1, x2, y2, (o, p) => {
    if (mem[p]) putPixel(s, o, pixel);
  });

// Opaque destinations blend the color's channels straight in
function opaqueAA(f: Fmt): GlyphFn {
  return (s, mem, glyphs, pixel, argb, x1, y1, x2, y2) => {
    const sr = (argb >> 16) & 255, sg = (argb >> 8) & 255, sb = argb & 255;
    forPixels(s, glyphs, x1, y1, x2, y2, (o, p) => {
      const mix = mem[p];
      if (!mix) return;
      if (mix === 255) return putPixel(s, o, pixel);
      const inv = 255 - mix, d = f.rd(s, o);
      f.wr(s, o, 0xff000000 | ((MUL8(inv, (d >> 16) & 255) + MUL8(mix, sr)) << 16) | ((MUL8(inv, (d >> 8) & 255) + MUL8(mix, sg)) << 8) | (MUL8(inv, d & 255) + MUL8(mix, sb)));
    });
  };
}

function grayAA(s: Surf, mem: Uint8Array, glyphs: Glyph[], pixel: number, argb: number, x1: number, y1: number, x2: number, y2: number) {
  const sg = gray((argb >> 16) & 255, (argb >> 8) & 255, argb & 255);
  forPixels(s, glyphs, x1, y1, x2, y2, (o, p) => {
    const mix = mem[p];
    if (!mix) return;
    if (mix === 255) return putPixel(s, o, pixel);
    s.u8![o] = MUL8(255 - mix, s.u8![o]) + MUL8(mix, sg);
  });
}

// Destinations with alpha blend with source-over, so a translucent color and a
// translucent background both come out right
function alphaAA(f: Fmt): GlyphFn {
  return (s, mem, glyphs, pixel, argb, x1, y1, x2, y2) => {
    const srcA = argb >>> 24, sr = (argb >> 16) & 255, sg = (argb >> 8) & 255, sb = argb & 255;
    forPixels(s, glyphs, x1, y1, x2, y2, (o, p) => {
      const mix = mem[p];
      if (!mix) return;
      let resA = mix === 255 ? srcA : MUL8(mix, srcA);
      if (resA === 255) return putPixel(s, o, pixel);
      const dstF = 255 - resA, d = f.rd(s, o);
      let dstA = d >>> 24;
      let rr = MUL8(resA, sr), rg = MUL8(resA, sg), rb = MUL8(resA, sb);
      if (dstA) {
        dstA = MUL8(dstF, dstA);
        resA += dstA;
        const blend = f.pre ? dstF : dstA;
        let tr = (d >> 16) & 255, tg = (d >> 8) & 255, tb = d & 255;
        if (blend !== 255) {
          tr = MUL8(blend, tr);
          tg = MUL8(blend, tg);
          tb = MUL8(blend, tb);
        }
        rr += tr;
        rg += tg;
        rb += tb;
      }
      if (!f.pre && resA && resA < 255) {
        rr = DIV8(rr, resA);
        rg = DIV8(rg, resA);
        rb = DIV8(rb, resA);
      }
      f.wr(s, o, (resA << 24) | (rr << 16) | (rg << 8) | rb);
    });
  };
}

for (const fam of FAMILIES) add("DrawGlyphList", "AnyColor", "SrcNoEa", fam, solid);
for (const t of TYPES) {
  const f = fmts[t];
  add("DrawGlyphListAA", "AnyColor", "SrcNoEa", t, f.gray ? grayAA : f.opaque ? opaqueAA(f) : alphaAA(f));
}

// ---- natives ---------------------------------------------------------------

const fr = Math.fround;
const floor = (v: number) => Math.floor(v) | 0;

// setupBlitVector: the glyph images and where they land, advancing the list's
// position when it has none per glyph
function blitVector(vm: JVM, list: JObject, from: number, to: number): Glyph[] {
  const dv = vm.mem.dv;
  let x = vm.getField(list, GL, "gposx") as number, y = vm.getField(list, GL, "gposy") as number;
  const images = (vm.getField(list, GL, "images") as JArray).a as BigInt64Array;
  const usePos = vm.getField(list, GL, "usePositions") as number;
  const pos = usePos ? ((vm.getField(list, GL, "positions") as JArray).a as Float32Array) : null;
  const out: Glyph[] = [];
  for (let g = from; g < to; g++) {
    const a = Number(images[g]);
    const topLeftX = dv.getFloat32(a + 16, true), topLeftY = dv.getFloat32(a + 20, true);
    const px = pos ? fr(x + pos[g * 2]) : x, py = pos ? fr(y + pos[g * 2 + 1]) : y;
    out.push({
      pixels: Number(dv.getBigUint64(a + 32, true)),
      width: dv.getUint16(a + 8, true),
      height: dv.getUint16(a + 10, true),
      rowBytes: dv.getUint16(a + 12, true),
      x: floor(fr(px + topLeftX)),
      y: floor(fr(py + topLeftY)),
    });
    if (!pos) {
      x = fr(x + dv.getFloat32(a, true));
      y = fr(y + dv.getFloat32(a + 4, true));
    }
  }
  if (!pos) {
    vm.setField(list, GL, "gposx", x);
    vm.setField(list, GL, "gposy", y);
  }
  return out;
}

function drawGlyphList(t: JThread, self: JObject, sg2d: JObject, sd: JObject, list: JObject, from: number, to: number) {
  const vm = t.vm, glyphs = blitVector(vm, list, from, to);
  const s = surfOf(t, sd);
  if (!s) return;
  const b = clipBounds(vm, vm.getField(sg2d, "sun/java2d/SunGraphics2D", "clipRegion"));
  if (b.y2 <= b.y1 || b.x2 <= b.x1 || !lockBounds(b, s)) return;
  (primOf(vm, self).fn as GlyphFn)(s, vm.mem.u8, glyphs, sgInt(vm, sg2d, "pixel"), sgInt(vm, sg2d, "eargb"), b.x1, b.y1, b.x2, b.y2);
}

export const natives: Natives = {
  "sun/java2d/loops/DrawGlyphList.DrawGlyphList"(t, [self, sg2d, sd, list, from, to]) {
    drawGlyphList(t, self, sg2d, sd, list, from, to);
  },
  "sun/java2d/loops/DrawGlyphListAA.DrawGlyphListAA"(t, [self, sg2d, sd, list, from, to]) {
    drawGlyphList(t, self, sg2d, sd, list, from, to);
  },
};
