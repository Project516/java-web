// What the Java2D native loops share: surfaces, clip regions, the registry of
// native primitives, and pixel stores.

import type { JArray, JObject } from "../runtime.ts";
import { PendingThrow } from "../thread.ts";
import type { JThread } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import { Surf, extraAlpha8 } from "./java2d-loops.ts";

export const LOOPS = "sun/java2d/loops/";
export const GP = LOOPS + "GraphicsPrimitive";

export interface Bounds { x1: number; y1: number; x2: number; y2: number }

// A native primitive: its Java class, the types it is registered under, and
// the loop that runs it. The index is the Java object's pNativePrim.
export interface Prim {
  cls: string;
  src: string;
  comp: string;
  dst: string;
  fn: any;
}

// index 0 stays empty: a Java-implemented primitive has pNativePrim 0
export const prims: Prim[] = [{ cls: "", src: "", comp: "", dst: "", fn: null }];

export function add(cls: string, src: string, comp: string, dst: string, fn: any = null) {
  prims.push({ cls, src, comp, dst, fn });
}

// ---- surfaces -------------------------------------------------------------

export function surfOf(t: JThread, sd: JObject | null): Surf | null {
  if (sd === null) throw new PendingThrow("java/lang/NullPointerException", "surfaceData");
  const s = sd.x as Surf | undefined;
  if (s) return s;
  if (sd.cls.name === "sun/java2d/NullSurfaceData") return null;
  if (!t.vm.getField(sd, "sun/java2d/SurfaceData", "valid")) throw new PendingThrow("sun/java2d/InvalidPipeException", "invalid data");
  throw new PendingThrow("java/lang/NullPointerException", "native ops missing");
}

export function primOf(vm: JVM, self: JObject): Prim {
  const p = prims[Number(vm.getField(self, GP, "pNativePrim"))];
  if (!p || !p.cls) throw new PendingThrow("java/lang/InternalError", "Non-native Primitive invoked natively");
  return p;
}

// a C cast of a double to jint, as the ARM and x86-64 libawt builds do it for in-range values; out of range saturates
export const satInt = (d: number) => (d >= 2147483647 ? 2147483647 : d <= -2147483648 ? -2147483648 : d !== d ? 0 : Math.trunc(d));

export function clipBounds(vm: JVM, region: JObject | null): Bounds {
  if (region === null) return { x1: -0x80000000, y1: -0x80000000, x2: 0x7fffffff, y2: 0x7fffffff };
  const g = (n: string) => vm.getField(region, "sun/java2d/pipe/Region", n) as number;
  return { x1: g("lox"), y1: g("loy"), x2: g("hix"), y2: g("hiy") };
}

export function intersect(b: Bounds, x1: number, y1: number, x2: number, y2: number) {
  if (b.x1 < x1) b.x1 = x1;
  if (b.y1 < y1) b.y1 = y1;
  if (b.x2 > x2) b.x2 = x2;
  if (b.y2 > y2) b.y2 = y2;
}

// SurfaceData_IntersectBoundsXYWH. The C overflow fallback is dead code in
// HotSpot's build (signed overflow is UB), so a wrapped far edge gives an empty box.
export function intersectXYWH(b: Bounds, x: number, y: number, w: number, h: number) {
  intersect(b, x, y, w <= 0 ? x : (x + w) | 0, h <= 0 ? y : (y + h) | 0);
}

// The rectangles of a Region within bounds, in band order (Region_NextIteration)
export function* regionRects(t: JThread, region: JObject | null, bounds: Bounds): Generator<Bounds> {
  if (bounds.x1 >= bounds.x2 || bounds.y1 >= bounds.y2) return;
  const vm = t.vm;
  const end = region ? (vm.getField(region, "sun/java2d/pipe/Region", "endIndex") as number) : 0;
  if (end === 0) {
    yield { ...bounds };
    return;
  }
  const bands = (vm.getField(region!, "sun/java2d/pipe/Region", "bands") as JArray).a as Int32Array;
  let i = 0;
  while (i < end) {
    let y1 = bands[i++];
    if (y1 >= bounds.y2) return;
    if (y1 < bounds.y1) y1 = bounds.y1;
    let y2 = bands[i++];
    let n = bands[i++];
    if (y2 > bounds.y2) y2 = bounds.y2;
    if (y2 <= y1) {
      i += n * 2;
      continue;
    }
    while (n-- > 0) {
      let x1 = bands[i++], x2 = bands[i++];
      if (x1 >= bounds.x2) {
        i += n * 2;
        break;
      }
      if (x1 < bounds.x1) x1 = bounds.x1;
      if (x2 > bounds.x2) x2 = bounds.x2;
      if (x2 > x1) yield { x1, y1, x2, y2 };
    }
  }
}

export function compOf(vm: JVM, comp: JObject | null): { rule: number; extra: number; ea: number } {
  if (!comp) return { rule: 0, extra: 0, ea: 0 };
  return {
    ea: vm.getField(comp, "java/awt/AlphaComposite", "extraAlpha") as number,
    rule: vm.getField(comp, "java/awt/AlphaComposite", "rule") as number,
    extra: extraAlpha8(vm.getField(comp, "java/awt/AlphaComposite", "extraAlpha") as number),
  };
}


export function putPixel(s: Surf, o: number, pixel: number) {
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

export function lockBounds(b: Bounds, s: Surf) {
  intersect(b, 0, 0, s.w, s.h);
  return b.x2 > b.x1 && b.y2 > b.y1;
}

export type Sg = (vm: JVM, o: JObject, n: string) => number;
export const sgInt: Sg = (vm, o, n) => vm.getField(o, "sun/java2d/SunGraphics2D", n);

