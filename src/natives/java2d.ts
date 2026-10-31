// java.desktop's Java2D natives: BufferedImage surfaces and the software
// graphics primitives that libawt registers (GraphicsPrimitiveMgr
// .registerNativeLoops). Surface types without loops here use the JDK's
// pure Java general loops, as HotSpot does for types it has no loops for.

import { INITIALIZED } from "../runtime.ts";
import type { JArray, JMethod, JObject } from "../runtime.ts";
import type { JVM } from "../jvm.ts";
import { PendingThrow } from "../thread.ts";
import type { JThread, NativeGen } from "../thread.ts";
import type { Natives } from "./util.ts";
import { spanIterOf } from "./java2d-shape.ts";
import {
  Surf, alphaMaskBlit, alphaMaskFill, convertBlit, convertScale, fmts, isoCopy, isoScale, swapBlit, swapScale,
  srcMaskFill, srcOverMaskBlit, srcOverMaskFill,
} from "./java2d-loops.ts";
import type { BlitFn, MaskBlitFn, MaskFillFn, ScaleFn } from "./java2d-loops.ts";
import { registerUshortGray } from "./java2d-gray16.ts";
import { registerIndexed, registerPacked } from "./java2d-types.ts";
import type { BlitBgFn } from "./java2d-types.ts";
import { isoXorBlit, pixelFromArgb, plainPen, penOf, xorBlit, xorPen } from "./java2d-pen.ts";
import type { Pen } from "./java2d-pen.ts";
import {
  GP, LOOPS, add, clipBounds, compOf, intersect, intersectXYWH, lockBounds, prims, primOf, regionRects, satInt, sgInt, surfOf,
} from "./java2d-surface.ts";
import type { Bounds } from "./java2d-surface.ts";
import { natives as glyphs } from "./java2d-glyphs.ts";
import { natives as transform } from "./java2d-transform.ts";

// Types the loops here cover, and the registrations HotSpot has for them.
const TYPES = ["IntArgb", "IntArgbPre", "IntRgb", "IntBgr", "ThreeByteBgr", "FourByteAbgr", "FourByteAbgrPre", "ByteGray", "Ushort565Rgb", "Ushort555Rgb"];
const FAMILIES = ["AnyByte", "AnyShort", "Any3Byte", "AnyInt", "Any4Byte"];
const SWAPS = ["IntArgb>IntBgr", "IntRgb>IntBgr", "IntBgr>IntRgb"];
const HELPERLESS = ["Ushort565Rgb", "Ushort555Rgb"];
const ICM = "java/awt/image/IndexColorModel";
const XOR_COMPOSITE = "sun/java2d/loops/XORComposite";
const XOR_SOLID = ["FillRect", "FillSpans", "DrawLine", "DrawRect", "DrawPolygons", "DrawPath", "FillPath"];
const ISO_XOR = ["ByteGray", "IntBgr", "IntRgb", "ThreeByteBgr", "Ushort565Rgb", "Ushort555Rgb"];
const SOLID = ["FillRect", "FillSpans", "DrawLine", "DrawRect", "DrawPolygons", "FillPath", "DrawPath", "FillParallelogram", "DrawParallelogram"];

// conversions among the types: "src>dst" or "src>dst=impl" (impl "copy" is a raw copy)
const CONVERTS = ("ByteGray>IntArgb IntArgb>ByteGray IntRgb>ByteGray=IntArgb>ByteGray ThreeByteBgr>ByteGray FourByteAbgr>IntArgb IntArgb>FourByteAbgr " +
  "IntRgb>FourByteAbgr ThreeByteBgr>FourByteAbgr ByteGray>FourByteAbgr FourByteAbgrPre>IntArgb IntArgb>FourByteAbgrPre IntRgb>FourByteAbgrPre " +
  "ThreeByteBgr>FourByteAbgrPre ByteGray>FourByteAbgrPre IntArgbPre>IntArgb IntArgb>IntArgbPre IntRgb>IntArgbPre ThreeByteBgr>IntArgbPre " +
  "ByteGray>IntArgbPre IntBgr>IntArgb IntArgb>IntBgr ThreeByteBgr>IntBgr IntRgb>IntBgr=IntArgb>IntBgr IntBgr>IntRgb=IntArgb>IntBgr " +
  "ByteGray>IntBgr=ByteGray>IntRgb IntRgb>IntArgb IntArgb>IntRgb=copy ThreeByteBgr>IntRgb ByteGray>IntRgb ThreeByteBgr>IntArgb " +
  "IntArgb>ThreeByteBgr IntRgb>ThreeByteBgr=IntArgb>ThreeByteBgr ByteGray>ThreeByteBgr Ushort555Rgb>IntArgb IntArgb>Ushort555Rgb " +
  "IntRgb>Ushort555Rgb=IntArgb>Ushort555Rgb ThreeByteBgr>Ushort555Rgb ByteGray>Ushort555Rgb Ushort565Rgb>IntArgb IntArgb>Ushort565Rgb " +
  "IntRgb>Ushort565Rgb=IntArgb>Ushort565Rgb ThreeByteBgr>Ushort565Rgb ByteGray>Ushort565Rgb").split(" ");

// mask blit sources per rule: every destination has these, plus two odd pairs
const MASKBLIT_OVER = ["IntArgb", "IntArgbPre"];
const MASKBLIT_ALPHA = ["IntArgb", "IntArgbPre", "IntRgb"];

function register() {
  for (const fam of FAMILIES) {
    for (const cls of SOLID) add(cls, "AnyColor", "SrcNoEa", fam, () => plainPen);
    for (const cls of XOR_SOLID) add(cls, "AnyColor", "Xor", fam, xorPen);
  }
  for (const t of TYPES) {
    const f = fmts[t];
    add("Blit", "IntArgb", "Xor", t, xorBlit(t));
    if (ISO_XOR.includes(t)) add("Blit", t, "Xor", t, isoXorBlit);
    add("Blit", t, "SrcNoEa", t, isoCopy(f.ps));
    add("ScaledBlit", t, "SrcNoEa", t, isoScale(f.ps));
    add("MaskFill", "AnyColor", "Src", t, srcMaskFill(f));
    add("MaskFill", "AnyColor", "SrcOver", t, srcOverMaskFill(f));
    add("MaskFill", "AnyColor", "AnyAlpha", t, alphaMaskFill(f));
    for (const s of MASKBLIT_OVER) add("MaskBlit", s, "SrcOver", t, srcOverMaskBlit(fmts[s], f));
    for (const s of MASKBLIT_ALPHA) add("MaskBlit", s, "AnyAlpha", t, alphaMaskBlit(fmts[s], f));
    if (!HELPERLESS.includes(t)) add("TransformHelper", t, "SrcNoEa", "IntArgbPre");
  }
  add("MaskBlit", "FourByteAbgrPre", "SrcOver", "IntArgbPre", srcOverMaskBlit(fmts.FourByteAbgrPre, fmts.IntArgbPre));
  add("MaskBlit", "FourByteAbgrPre", "AnyAlpha", "IntArgbPre", alphaMaskBlit(fmts.FourByteAbgrPre, fmts.IntArgbPre));
  add("MaskBlit", "IntBgr", "AnyAlpha", "IntBgr", alphaMaskBlit(fmts.IntBgr, fmts.IntBgr));
  registerIndexed(add);
  registerPacked(add);
  registerUshortGray(add);
  for (const c of CONVERTS) {
    const [pair, impl] = c.split("=");
    const [s, d] = pair.split(">");
    let b: BlitFn, sc: ScaleFn;
    if (impl === "copy") {
      b = isoCopy(4);
      sc = isoScale(4);
    } else if (SWAPS.includes(pair)) {
      b = swapBlit();
      sc = swapScale();
    } else {
      const [is, id] = impl ? impl.split(">") : [s, d];
      b = convertBlit(fmts[is], fmts[id]);
      sc = convertScale(fmts[is], fmts[id]);
    }
    add("Blit", s, "SrcNoEa", d, b);
    add("ScaledBlit", s, "SrcNoEa", d, sc);
  }
}
register();

// ---- solid loops ----------------------------------------------------------

export function drawRun(s: Surf, x: number, y: number, pixel: number, steps: number, error: number, majorMask: number, errMajor: number, minorMask: number, errMinor: number, pen: Pen = plainPen) {
  pen.run(s, x, y, pixel, steps, error, majorMask, errMajor, minorMask, errMinor);
}

const OUT_TOP = 1, OUT_BOTTOM = 2, OUT_LEFT = 4, OUT_RIGHT = 8;

function outcode(x: number, y: number, b: Bounds) {
  return (y < b.y1 ? OUT_TOP : y > b.y2 - 1 ? OUT_BOTTOM : 0) | (x < b.x1 ? OUT_LEFT : x > b.x2 - 1 ? OUT_RIGHT : 0);
}

// LineUtils_ProcessLine: clips a line to bounds and draws it
export function processLine(s: Surf, b: Bounds, pixel: number, x1: number, y1: number, x2: number, y2: number, shorten: number, pen: Pen = plainPen) {
  if (y1 === y2) {
    if (y1 >= b.y1 && y1 < b.y2) {
      let a = x1 < x2 ? x1 : (x2 + shorten) | 0, e = x1 < x2 ? (x2 - shorten) | 0 : x1;
      e = (e + 1) | 0;
      if (e < a) e = (e - 1) | 0;
      if (a < b.x1) a = b.x1;
      if (e > b.x2) e = b.x2;
      if (a < e) pen.run(s, a, y1, pixel, e - a, 0, 1, 0, 0, 0);
    }
  } else if (x1 === x2) {
    if (x1 >= b.x1 && x1 < b.x2) {
      let a = y1 < y2 ? y1 : (y2 + shorten) | 0, e = y1 < y2 ? (y2 - shorten) | 0 : y1;
      e = (e + 1) | 0;
      if (e < a) e = (e - 1) | 0;
      if (a < b.y1) a = b.y1;
      if (e > b.y2) e = b.y2;
      if (a < e) pen.run(s, x1, a, pixel, e - a, 0, 4, 0, 0, 0);
    }
  } else {
    bresenham(s, b, pixel, x1, y1, x2, y2, shorten, pen);
  }
}

const BIG_MAX = (1 << 29) - 1, BIG_MIN = -(1 << 29);
const overflowsSmall = (v: number) => v !== (v << 17) >> 17;
const overflowsBig = (v: number) => v !== (v << 2) >> 2;

// trunc((2 * a * b + c) / d) as C's jlong math computes it
function stepsOf(a: number, b: number, c: number, d: number): number {
  const n = 2 * a * b + c;
  if (Math.abs(n) < 2 ** 52) return Math.trunc(n / d);
  return Number(BigInt.asIntN(64, (2n * BigInt(a) * BigInt(b) + BigInt(c)) / BigInt(d)));
}

// LineUtils_SetupBresenham, then the loop. Coordinates beyond 15 bits use
// 64-bit step math, and beyond 30 bits are pre-clipped with doubles first.
export function bresenham(s: Surf, b: Bounds, pixel: number, ox1: number, oy1: number, ox2: number, oy2: number, shorten: number, pen: Pen = plainPen) {
  if (overflowsSmall(ox1) || overflowsSmall(oy1) || overflowsSmall(ox2) || overflowsSmall(oy2)) {
    if (overflowsBig(ox1) || overflowsBig(oy1) || overflowsBig(ox2) || overflowsBig(oy2)) {
      const dx = ox2 - ox1, dy = oy2 - oy1;
      let x1d = ox1, y1d = oy1, x2d = ox2, y2d = oy2;
      if (ox1 < BIG_MIN) {
        y1d = oy1 + ((BIG_MIN - ox1) * dy) / dx;
        x1d = BIG_MIN;
      } else if (ox1 > BIG_MAX) {
        y1d = oy1 - ((ox1 - BIG_MAX) * dy) / dx;
        x1d = BIG_MAX;
      }
      if (y1d < BIG_MIN) {
        x1d = ox1 + (((BIG_MIN - oy1) | 0) * dx) / dy;
        y1d = BIG_MIN;
      } else if (y1d > BIG_MAX) {
        x1d = ox1 - (((oy1 - BIG_MAX) | 0) * dx) / dy;
        y1d = BIG_MAX;
      }
      if (ox2 < BIG_MIN) {
        y2d = oy2 + ((BIG_MIN - ox2) * dy) / dx;
        x2d = BIG_MIN;
      } else if (ox2 > BIG_MAX) {
        y2d = oy2 - ((ox2 - BIG_MAX) * dy) / dx;
        x2d = BIG_MAX;
      }
      if (y2d < BIG_MIN) {
        x2d = ox2 + (((BIG_MIN - oy2) | 0) * dx) / dy;
        y2d = BIG_MIN;
      } else if (y2d > BIG_MAX) {
        x2d = ox2 - (((oy2 - BIG_MAX) | 0) * dx) / dy;
        y2d = BIG_MAX;
      }
      ox1 = satInt(x1d);
      oy1 = satInt(y1d);
      ox2 = satInt(x2d);
      oy2 = satInt(y2d);
    }
  }
  let X1 = ox1, Y1 = oy1, X2 = ox2, Y2 = oy2;
  const dx = (X2 - X1) | 0, dy = (Y2 - Y1) | 0;
  let ax = Math.abs(dx), ay = Math.abs(dy);
  const cxmin = b.x1, cymin = b.y1, cxmax = b.x2 - 1, cymax = b.y2 - 1;
  const xmajor = ax >= ay;
  let o1 = outcode(X1, Y1, b), o2 = outcode(X2, Y2, b);
  const jint = (v: number) => v | 0;
  while ((o1 | o2) !== 0) {
    if ((o1 & o2) !== 0) return;
    if (o1 !== 0) {
      if (o1 & (OUT_TOP | OUT_BOTTOM)) {
        Y1 = o1 & OUT_TOP ? cymin : cymax;
        const xs = stepsOf(Math.abs(Y1 - oy1), ax, xmajor ? ay - ax - 1 + ay : ay, 2 * ay);
        X1 = jint(ox1 + jint(dx < 0 ? -xs : xs));
      } else if (o1 & (OUT_LEFT | OUT_RIGHT)) {
        X1 = o1 & OUT_LEFT ? cxmin : cxmax;
        const ys = stepsOf(Math.abs(X1 - ox1), ay, !xmajor ? ax - ay - 1 + ax : ax, 2 * ax);
        Y1 = jint(oy1 + jint(dy < 0 ? -ys : ys));
      }
      o1 = outcode(X1, Y1, b);
    } else {
      if (o2 & (OUT_TOP | OUT_BOTTOM)) {
        Y2 = o2 & OUT_TOP ? cymin : cymax;
        const xs = stepsOf(Math.abs(Y2 - oy2), ax, xmajor ? ay - ax + ay : ay - 1, 2 * ay);
        X2 = jint(ox2 + jint(dx > 0 ? -xs : xs));
      } else if (o2 & (OUT_LEFT | OUT_RIGHT)) {
        X2 = o2 & OUT_LEFT ? cxmin : cxmax;
        const ys = stepsOf(Math.abs(X2 - ox2), ay, xmajor ? ax - 1 : ax - ay + ax, 2 * ax);
        Y2 = jint(oy2 + jint(dy > 0 ? -ys : ys));
      }
      o2 = outcode(X2, Y2, b);
    }
  }
  let errMajor: number, errMinor: number, majorMask: number, minorMask: number, steps: number;
  if (xmajor) {
    errMajor = ay * 2;
    errMinor = ax * 2;
    majorMask = dx < 0 ? 2 : 1;
    minorMask = dy < 0 ? 8 : 4;
    ax = -ax;
    steps = X2 - X1;
    if (X2 !== ox2) shorten = 0;
  } else {
    errMajor = ax * 2;
    errMinor = ay * 2;
    majorMask = dy < 0 ? 8 : 4;
    minorMask = dx < 0 ? 2 : 1;
    ay = -ay;
    steps = Y2 - Y1;
    if (Y2 !== oy2) shorten = 0;
  }
  steps = Math.abs(steps) + 1 - shorten;
  if (steps === 0) return;
  let error = -Math.trunc(errMinor / 2);
  if (Y1 !== oy1) error = (error + Math.imul(Math.abs(Y1 - oy1), ax) * 2) | 0;
  if (X1 !== ox1) error = (error + Math.imul(Math.abs(X1 - ox1), ay) * 2) | 0;
  error = (error + errMajor) | 0;
  errMinor -= errMajor;
  pen.run(s, X1, Y1, pixel, steps, error, majorMask, errMajor, minorMask, errMinor);
}

function refineLine(b: Bounds, x1: number, y1: number, x2: number, y2: number) {
  const refine = (a: number, c: number): [number, number] => {
    const min = Math.min(a, c);
    let max = (Math.max(a, c) + 1) | 0;
    if (max <= min) max = (max - 1) | 0;
    return [min, max];
  };
  let [min, max] = refine(x1, x2);
  intersect(b, min, -0x80000000, max, 0x7fffffff);
  [min, max] = refine(y1, y2);
  intersect(b, -0x80000000, min, 0x7fffffff, max);
}

// ---- natives --------------------------------------------------------------

const solid: Natives = {
  "sun/java2d/loops/FillRect.FillRect"(t, [self, sg2d, sd, x, y, w, h]) {
    const vm = t.vm;
    if (w <= 0 || h <= 0) return;
    const s = surfOf(t, sd);
    if (!s) return;
    const b = clipBounds(vm, vm.getField(sg2d, "sun/java2d/SunGraphics2D", "clipRegion"));
    intersectXYWH(b, x, y, w, h);
    if (b.y2 <= b.y1 || b.x2 <= b.x1) return;
    if (!lockBounds(b, s)) return;
    penOf(vm, self, sg2d).fill(s, b.x1, b.y1, b.x2, b.y2, sgInt(vm, sg2d, "pixel"));
  },

  "sun/java2d/loops/FillSpans.FillSpans"(t, [self, sg2d, sd, pixel, _it, si]) {
    const s = surfOf(t, sd);
    const it = spanIterOf(si);
    if (!it) throw new PendingThrow("java/lang/NullPointerException", "native iterator not supplied");
    if (!s) return;
    const box = new Int32Array(4);
    it.getPathBox(box);
    const b: Bounds = { x1: box[0], y1: box[1], x2: box[2], y2: box[3] };
    lockBounds(b, s);
    it.intersectClipBox(b.x1, b.y1, b.x2, b.y2);
    const pen = penOf(t.vm, self, sg2d);
    while (it.nextSpan(box)) pen.fill(s, box[0], box[1], box[2], box[3], pixel);
  },

  "sun/java2d/loops/DrawLine.DrawLine"(t, [self, sg2d, sd, x1, y1, x2, y2]) {
    const vm = t.vm;
    const s = surfOf(t, sd);
    if (!s) return;
    const b = clipBounds(vm, vm.getField(sg2d, "sun/java2d/SunGraphics2D", "clipRegion"));
    refineLine(b, x1, y1, x2, y2);
    if (!lockBounds(b, s)) return;
    processLine(s, b, sgInt(vm, sg2d, "pixel"), x1, y1, x2, y2, 0, penOf(vm, self, sg2d));
  },

  "sun/java2d/loops/DrawPolygons.DrawPolygons"(t, [self, sg2d, sd, xs, ys, ns, numPolys, transX, transY, close]) {
    const vm = t.vm;
    if (xs === null || ys === null) throw new PendingThrow("java/lang/NullPointerException", "coordinate array");
    if (ns === null) throw new PendingThrow("java/lang/NullPointerException", "polygon length array");
    const n = ns.a as Int32Array, x = xs.a as Int32Array, y = ys.a as Int32Array;
    if (n.length < numPolys) throw new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", "polygon length array size");
    const s = surfOf(t, sd);
    if (!s) return;
    const b = clipBounds(vm, vm.getField(sg2d, "sun/java2d/SunGraphics2D", "clipRegion"));
    let needed = 0;
    for (let i = 0; i < numPolys; i++) if (n[i] > 0) needed += n[i];
    if (y.length < needed || x.length < needed) throw new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", "coordinate array length");
    if (!lockBounds(b, s)) return;
    const pixel = sgInt(vm, sg2d, "pixel"), pen = penOf(vm, self, sg2d);
    let k = 0;
    for (let i = 0; i < numPolys; i++) {
      let pts = n[i];
      if (pts > 1) {
        let empty = true;
        const x0 = (transX + x[k]) | 0, y0 = (transY + y[k++]) | 0;
        let x1 = x0, y1 = y0;
        while (--pts > 0) {
          const x2 = (transX + x[k]) | 0, y2 = (transY + y[k++]) | 0;
          empty = empty && x1 === x2 && y1 === y2;
          processLine(s, b, pixel, x1, y1, x2, y2, pts > 1 || close ? 1 : 0, pen);
          x1 = x2;
          y1 = y2;
        }
        if (close && (empty || x1 !== x0 || y1 !== y0)) processLine(s, b, pixel, x1, y1, x0, y0, empty ? 0 : 1, pen);
      } else if (pts === 1) k++;
    }
  },

  "sun/java2d/loops/DrawRect.DrawRect"(t, [self, sg2d, sd, x, y, w, h]) {
    const vm = t.vm;
    if (w < 0 || h < 0) return;
    const s = surfOf(t, sd);
    if (!s) return;
    const lox = x, loy = y;
    const hix = (x + w + 1) | 0, hiy = (y + h + 1) | 0;
    const b = clipBounds(vm, vm.getField(sg2d, "sun/java2d/SunGraphics2D", "clipRegion"));
    intersect(b, lox, loy, hix, hiy);
    if (!lockBounds(b, s)) return;
    const pixel = sgInt(vm, sg2d, "pixel"), pen = penOf(vm, self, sg2d);
    const loyin = loy === b.y1 ? 1 : 0, hiyin = hiy === b.y2 ? 1 : 0;
    const xsize = b.x2 - b.x1, ysize = b.y2 - b.y1 - loyin - hiyin;
    if (loyin) pen.run(s, b.x1, b.y1, pixel, xsize, 0, 1, 0, 0, 0);
    if (lox === b.x1 && ysize > 0) pen.run(s, b.x1, b.y1 + loyin, pixel, ysize, 0, 4, 0, 0, 0);
    if (hix === b.x2 && ysize > 0 && lox !== hix - 1) pen.run(s, b.x2 - 1, b.y1 + loyin, pixel, ysize, 0, 4, 0, 0, 0);
    if (hiyin && loy !== hiy - 1) pen.run(s, b.x1, b.y2 - 1, pixel, xsize, 0, 1, 0, 0, 0);
  },
};

function* init(t: JThread, name: string) {
  const c = t.vm.loadBootOrFail(name);
  if (c.state !== INITIALIZED) yield* t.vm.initGen(t, c);
  return c;
}

function* registerNativeLoops(t: JThread): NativeGen {
  const vm = t.vm;
  const stc = yield* init(t, LOOPS + "SurfaceType");
  const ctc = yield* init(t, LOOPS + "CompositeType");
  const mgr = vm.loadBootOrFail(LOOPS + "GraphicsPrimitiveMgr");
  const st = (n: string) => vm.getStatic(stc, n) as JObject;
  const ct = (n: string) => vm.getStatic(ctc, n) as JObject;
  const out: JObject[] = [];
  for (let i = 1; i < prims.length; i++) {
    const p = prims[i];
    const c = yield* init(t, LOOPS + p.cls);
    const o = vm.newObject(c);
    const ctor = c.methodMap.get(`<init>(JL${LOOPS}SurfaceType;L${LOOPS}CompositeType;L${LOOPS}SurfaceType;)V`);
    yield t.call(ctor!, o, BigInt(i), st(p.src), ct(p.comp), st(p.dst));
    out.push(o);
  }
  const reg: JMethod = mgr.methodMap.get(`register([L${GP};)V`)!;
  yield t.call(reg, vm.newObjectArray(GP, out));
}

// ---- BufImgSurfaceData ----------------------------------------------------

const surfaceNatives: Natives = {
  "sun/awt/image/BufImgSurfaceData.initRaster"(t, [self, array, offset, bitoffset, width, height, pixStr, scanStr, icm]) {
    const a = (array as JArray).a;
    const vm = t.vm;
    const lut = icm === null ? null : ((vm.getField(icm, ICM, "rgb") as JArray).a as Int32Array);
    const lutSize = icm === null ? 0 : (vm.getField(icm, ICM, "map_size") as number);
    // the depth is the raster's sample size, which picked the surface type
    const sType = vm.getField(self, "sun/java2d/SurfaceData", "surfaceType");
    const stc = vm.loadBootOrFail(LOOPS + "SurfaceType");
    const bpp = [1, 2, 4].find((b) => sType === vm.getStatic(stc, `ByteBinary${b}Bit`)) ?? 0;
    const ppb = 8 / bpp;
    const s = bpp ? new Surf(a, offset * ppb + ((bitoffset / bpp) | 0), 1, scanStr * ppb, width, height) : new Surf(a, offset, pixStr, scanStr, width, height);
    s.bpp = bpp;
    s.bo = bpp ? (bitoffset / bpp) | 0 : 0;
    s.lut = lut;
    s.lutSize = lutSize;
    s.icm = icm;
    self.x = s;
  },
  "sun/java2d/SurfaceData.isOpaqueGray"(t, [icm]) {
    return icm === null ? 0 : t.vm.getField(icm, "java/awt/image/IndexColorModel", "allgrayopaque");
  },
  // HotSpot's initIDs reads static fields of SunHints, which initializes it
  "sun/java2d/loops/GraphicsPrimitiveMgr.initIDs": function* (t): NativeGen {
    yield* init(t, "sun/awt/SunHints");
  },
  "sun/java2d/loops/GraphicsPrimitiveMgr.registerNativeLoops": function* (t): NativeGen {
    yield* registerNativeLoops(t);
  },
};

// ---- blits ----------------------------------------------------------------

const unsafeAdd = (a: number, b: number) => (a >= 0 && b >= 0 && a > 2147483647 - b) || (a < 0 && b < 0 && a < -2147483648 - b);
const unsafeSub = (a: number, b: number) => (b >= 0 && a < 0 && a < -2147483648 + b) || (b < 0 && a >= 0 && a > 2147483647 + b);

function blitSetup(t: JThread, self: JObject, srcData: JObject, dstData: JObject, clip: JObject | null,
  srcx: number, srcy: number, dstx: number, dsty: number, width: number, height: number) {
  const vm = t.vm;
  const src = surfOf(t, srcData), dst = src && surfOf(t, dstData);
  if (!src || !dst || width <= 0 || height <= 0) return null;
  if (unsafeAdd(srcx, width) || unsafeAdd(srcy, height) || unsafeAdd(dstx, width) || unsafeAdd(dsty, height)) return null;
  if (unsafeSub(srcx, dstx) || unsafeSub(srcy, dsty)) return null;
  const cb = clipBounds(vm, clip);
  const sb: Bounds = { x1: srcx, y1: srcy, x2: srcx + width, y2: srcy + height };
  const db: Bounds = { x1: dstx, y1: dsty, x2: dstx + width, y2: dsty + height };
  const dx = srcx - dstx, dy = srcy - dsty;
  intersect(db, cb.x1, cb.y1, cb.x2, cb.y2);
  intersect(sb, 0, 0, src.w, src.h);
  intersect(db, 0, 0, dst.w, dst.h);
  // IntersectBlitBounds, with jint sums
  intersect(sb, (db.x1 + dx) | 0, (db.y1 + dy) | 0, (db.x2 + dx) | 0, (db.y2 + dy) | 0);
  intersect(db, (sb.x1 - dx) | 0, (sb.y1 - dy) | 0, (sb.x2 - dx) | 0, (sb.y2 - dy) | 0);
  intersect(cb, db.x1, db.y1, db.x2, db.y2);
  return { src, dst, rects: regionRects(t, clip, cb), dx, dy, dby: db.y1, p: primOf(vm, self) };
}

const blits: Natives = {
  "sun/java2d/loops/Blit.Blit"(t, [self, srcData, dstData, comp, clip, srcx, srcy, dstx, dsty, width, height]) {
    const k = blitSetup(t, self, srcData, dstData, clip, srcx, srcy, dstx, dsty, width, height);
    if (!k) return;
    const fn = k.p.fn as BlitFn;
    const ps = fmtPs(k.p.src), pd = fmtPs(k.p.dst);
    const xor = k.p.comp === "Xor" ? xorOf(t.vm, comp) : { xor: 0, mask: 0 };
    for (const r of k.rects) {
      fn(k.dst, k.dst.off + r.y1 * k.dst.scan + r.x1 * pd, k.src, k.src.off + (k.dy + r.y1) * k.src.scan + (k.dx + r.x1) * ps, r.x2 - r.x1, r.y2 - r.y1,
        { sx: k.dx + r.x1, dx: r.x1, dy: k.dby, ...xor });
    }
  },

  "sun/java2d/loops/BlitBg.BlitBg"(t, [self, srcData, dstData, comp, clip, bgColor, srcx, srcy, dstx, dsty, width, height]) {
    const k = blitSetup(t, self, srcData, dstData, clip, srcx, srcy, dstx, dsty, width, height);
    if (!k) return;
    const fn = k.p.fn as BlitBgFn;
    const ps = fmtPs(k.p.src), pd = fmtPs(k.p.dst);
    const bg = pixelFromArgb[k.p.dst](bgColor, k.dst);
    for (const r of k.rects) {
      fn(k.dst, k.dst.off + r.y1 * k.dst.scan + r.x1 * pd, k.src, k.src.off + (k.dy + r.y1) * k.src.scan + (k.dx + r.x1) * ps, r.x2 - r.x1, r.y2 - r.y1, bg,
        { sx: k.dx + r.x1, dx: r.x1, dy: k.dby, xor: 0, mask: 0 });
    }
  },

  "sun/java2d/loops/MaskBlit.MaskBlit"(t, [self, srcData, dstData, comp, clip, srcx, srcy, dstx, dsty, width, height, mask, maskoff, maskscan]) {
    const k = blitSetup(t, self, srcData, dstData, clip, srcx, srcy, dstx, dsty, width, height);
    if (!k) return;
    const fn = k.p.fn as MaskBlitFn;
    const m = maskBytes(mask);
    const { rule, extra, ea } = compOf(t.vm, comp);
    const ps = fmtPs(k.p.src), pd = fmtPs(k.p.dst);
    for (const r of k.rects) {
      // the offset accumulates over the clip's rectangles, as in MaskBlit.c
      maskoff += (r.y1 - dsty) * maskscan + (r.x1 - dstx);
      fn(k.dst, k.dst.off + r.y1 * k.dst.scan + r.x1 * pd, k.src, k.src.off + (k.dy + r.y1) * k.src.scan + (k.dx + r.x1) * ps, m,
        maskoff, maskscan, r.x2 - r.x1, r.y2 - r.y1, rule, extra, { sx: k.dx + r.x1, dx: r.x1, dy: k.dby, xor: 0, mask: 0, ea });
    }
  },

  "sun/java2d/loops/MaskFill.MaskFill"(t, [self, sg2d, sd, comp, x, y, w, h, mask, maskoff, maskscan]) {
    const vm = t.vm;
    const s = surfOf(t, sd);
    if (!s) return;
    const b: Bounds = { x1: x, y1: y, x2: (x + w) | 0, y2: (y + h) | 0 };
    if (!lockBounds(b, s)) return;
    const fn = primOf(vm, self).fn as MaskFillFn;
    const m = maskBytes(mask);
    const dst = fmtPs(primOf(vm, self).dst);
    fn(s, s.off + b.y1 * s.scan + b.x1 * dst, m, maskoff + (b.y1 - y) * maskscan + (b.x1 - x), maskscan, b.x2 - b.x1, b.y2 - b.y1,
      sgInt(vm, sg2d, "eargb"), compOf(vm, comp).rule, { sx: 0, dx: b.x1, dy: b.y1, xor: 0, mask: 0 });
  },
};


function xorOf(vm: JVM, comp: JObject | null) {
  if (!comp) return { xor: 0, mask: 0 };
  return { xor: vm.getField(comp, XOR_COMPOSITE, "xorPixel") as number, mask: vm.getField(comp, XOR_COMPOSITE, "alphaMask") as number };
}

const tileStart = (id: number, io: number, ts: number) => io + ((id - io) & ~(ts - 1));
const srcLoc = (id: number, fo: number, sf: number) => Math.ceil((id + 0.5 - fo) * sf - 0.5);

function pow2TileSize(shift: number, sxinc: number, syinc: number): number {
  if (sxinc > syinc) sxinc = syinc;
  if (sxinc === 0) return 1;
  while (1 << shift > sxinc) shift--;
  shift = shift >= 16 ? shift - 8 : shift >> 1;
  return 1 << shift;
}

// The smallest destination coordinate whose source location reaches srctarget
function refine(intorigin: number, dblorigin: number, tilesize: number, scale: number, srctarget: number, srcinc: number): number {
  let dstloc = satInt(Math.ceil(dblorigin + srctarget / scale - 0.5));
  let wasneg = false, waspos = false;
  for (;;) {
    const ts = tileStart(dstloc, intorigin, tilesize);
    let loc = srcLoc(ts, dblorigin, scale);
    if (dstloc > ts) loc += srcinc * (dstloc - ts);
    if (loc >= srctarget) {
      if (wasneg) break;
      dstloc--;
      waspos = true;
    } else {
      dstloc++;
      if (waspos) break;
      wasneg = true;
    }
  }
  return dstloc;
}

function scaledBlit(t: JThread, [self, srcData, dstData, comp, clip, sx1, sy1, sx2, sy2, ddx1, ddy1, ddx2, ddy2]: any[]) {
  const vm = t.vm;
  const p = primOf(vm, self);
  const src = surfOf(t, srcData), dst = src && surfOf(t, dstData);
  if (!src || !dst) return;
  let sxinc = (sx2 - sx1) | (sy2 - sy1), shift = 0;
  if (sxinc > 0) while (((sxinc <<= 1) | 0) > 0) shift++;
  const yunder = ddy2 - ddy1 < 1, xunder = ddx2 - ddx1 < 1;
  const scaley = (((sy2 - sy1) | 0) / (ddy2 - ddy1)) * (1 << shift);
  const syinc = yunder ? (sy2 - sy1) << shift : satInt(scaley);
  const scalex = (((sx2 - sx1) | 0) / (ddx2 - ddx1)) * (1 << shift);
  sxinc = xunder ? (sx2 - sx1) << shift : satInt(scalex);
  const tilesize = pow2TileSize(shift, sxinc, syinc);
  const sb: Bounds = { x1: sx1, y1: sy1, x2: sx2, y2: sy2 };
  intersect(sb, 0, 0, src.w, src.h);
  if (sb.x2 <= sb.x1 || sb.y2 <= sb.y1) return;
  const idx1 = satInt(Math.ceil(ddx1 - 0.5)), idy1 = satInt(Math.ceil(ddy1 - 0.5));
  const db: Bounds = { x1: 0, y1: 0, x2: 0, y2: 0 };
  if (xunder) {
    const x = sx1 + srcLoc(idx1, ddx1, scalex) / (1 << shift);
    db.x1 = db.x2 = idx1;
    if (x >= sb.x1 && x < sb.x2) db.x2++;
  } else {
    db.x1 = sb.x1 <= sx1 ? idx1 : refine(idx1, ddx1, tilesize, scalex, (sb.x1 - sx1) << shift, sxinc);
    db.x2 = refine(idx1, ddx1, tilesize, scalex, (sb.x2 - sx1) << shift, sxinc);
  }
  if (yunder) {
    const y = sy1 + srcLoc(idy1, ddy1, scaley) / (1 << shift);
    db.y1 = db.y2 = idy1;
    if (y >= sb.y1 && y < sb.y2) db.y2++;
  } else {
    db.y1 = sb.y1 <= sy1 ? idy1 : refine(idy1, ddy1, tilesize, scaley, (sb.y1 - sy1) << shift, syinc);
    db.y2 = refine(idy1, ddy1, tilesize, scaley, (sb.y2 - sy1) << shift, syinc);
  }
  const cb = clipBounds(vm, clip);
  intersect(db, cb.x1, cb.y1, cb.x2, cb.y2);
  intersect(db, 0, 0, dst.w, dst.h);
  if (db.x2 <= db.x1 || db.y2 <= db.y1) return;
  intersect(cb, db.x1, db.y1, db.x2, db.y2);
  const fn = p.fn as ScaleFn;
  const ps = fmtPs(p.src), pd = fmtPs(p.dst);
  const ctx = { sx: 0, dx: db.x1, dy: db.y1, xor: 0, mask: 0 };
  const base = src.off + sy1 * src.scan + sx1 * ps;
  const run = (x1: number, y1: number, x2: number, y2: number, sxloc: number, syloc: number) =>
    fn(dst, dst.off + y1 * dst.scan + x1 * pd, src, base, x2 - x1, y2 - y1, sxloc, syloc, sxinc, syinc, shift, ctx);
  const oneTile = tilesize >= ddx2 - ddx1 && tilesize >= ddy2 - ddy1;
  for (const span of regionRects(t, clip, cb)) {
    if (oneTile) {
      let tsx = satInt(srcLoc(idx1, ddx1, scalex)), tsy = satInt(srcLoc(idy1, ddy1, scaley));
      if (span.y1 > idy1) tsy += syinc * (span.y1 - idy1);
      if (span.x1 > idx1) tsx += sxinc * (span.x1 - idx1);
      run(span.x1, span.y1, span.x2, span.y2, tsx, tsy);
      continue;
    }
    for (let tiley = tileStart(span.y1, idy1, tilesize); tiley < span.y2; tiley += tilesize) {
      const y1 = Math.max(tiley, span.y1), y2 = Math.min(tiley + tilesize, span.y2);
      let syloc = satInt(srcLoc(tiley, ddy1, scaley));
      if (y1 > tiley) syloc += syinc * (y1 - tiley);
      for (let tilex = tileStart(span.x1, idx1, tilesize); tilex < span.x2; tilex += tilesize) {
        const x1 = Math.max(tilex, span.x1), x2 = Math.min(tilex + tilesize, span.x2);
        let sxloc = satInt(srcLoc(tilex, ddx1, scalex));
        if (x1 > tilex) sxloc += sxinc * (x1 - tilex);
        run(x1, y1, x2, y2, sxloc, syloc);
      }
    }
  }
}

function maskBytes(mask: JArray | null): Uint8Array | null {
  if (mask === null) return null;
  const a = mask.a as Int8Array;
  return new Uint8Array(a.buffer, a.byteOffset, a.length);
}

function fmtPs(type: string): number {
  const f = fmts[type];
  return f.packed ? 0 : f.ps;
}

export const natives: Natives = { ...transform, ...glyphs, ...surfaceNatives, ...solid, ...blits, "sun/java2d/loops/ScaledBlit.Scale": scaledBlit };
