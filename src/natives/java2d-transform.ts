// sun.java2d.loops.TransformHelper.Transform: samples a source surface through
// an inverse transform into IntArgbPre lines, interpolates them, and hands
// each line to a MaskBlit loop (TransformHelper.c). Source coordinates are
// 32.32 fixed point; per pixel they step as a whole part and a fraction.

import { Surf, fmts, rdPre } from "./java2d-loops.ts";
import type { Fmt, MaskBlitFn } from "./java2d-loops.ts";
import type { Natives } from "./util.ts";
import { PendingThrow } from "../thread.ts";
import type { JArray } from "../runtime.ts";
import { clipBounds, compOf, intersect, primOf, regionRects, surfOf } from "./java2d-surface.ts";
import type { Bounds } from "./java2d-surface.ts";

const LINE_SIZE = 2048;
const ONE = 4294967296;
const HALF = 1n << 31n;
function dblToLong(d: number): bigint {
  d *= ONE;
  if (d !== d) return 0n;
  if (d >= 2 ** 63) return (1n << 63n) - 1n;
  if (d <= -(2 ** 63)) return -(1n << 63n);
  return BigInt(Math.trunc(d));
}
const fract = (l: bigint) => Number(BigInt.asIntN(32, l));
const NN = 1, BL = 2, BC = 3;

// samples written as IntArgbPre ints, `per` of them per destination pixel
type HelperFn = (f: Fmt, s: Surf, out: Int32Array, numpix: number, xlong: bigint, dxlong: bigint, ylong: bigint, dylong: bigint, mode: number) => void;

class Fixed {
  hi: number;
  lo: number;
  readonly dhi: number;
  readonly dlo: number;
  constructor(v: bigint, d: bigint) {
    this.hi = Number(v >> 32n);
    this.lo = Number(v & 0xffffffffn);
    this.dhi = Number(d >> 32n);
    this.dlo = Number(d & 0xffffffffn);
  }
  step() {
    this.lo += this.dlo;
    if (this.lo >= ONE) {
      this.lo -= ONE;
      this.hi++;
    }
    this.hi += this.dhi;
  }
}

const helper: HelperFn = (f, s, out, numpix, xlong, dxlong, ylong, dylong, mode) => {
  const ps = f.ps, scan = s.scan;
  const cx = 0, cy = 0, cw = s.w, ch = s.h;
  if (mode === NN) {
    const x = new Fixed(xlong, dxlong), y = new Fixed(ylong, dylong);
    for (let i = 0; i < numpix; i++) {
      out[i] = rdPre(f, s, s.off + (y.hi | 0) * scan + (x.hi | 0) * ps);
      x.step();
      y.step();
    }
    return;
  }
  const x = new Fixed(xlong - HALF, dxlong), y = new Fixed(ylong - HALF, dylong);
  const px = (row: number, col: number) => rdPre(f, s, s.off + row * scan + col * ps);
  if (mode === BL) {
    for (let i = 0; i < numpix; i++) {
      let xw = x.hi | 0, yw = y.hi | 0;
      let xdelta = (xw + 1 - cw) >>> 31;
      let isneg = xw >> 31;
      xw -= isneg;
      xdelta += isneg;
      let ydelta = (yw + 1 - ch) >> 31;
      isneg = yw >> 31;
      yw -= isneg;
      ydelta -= isneg;
      // ydelta is a row step of 0 or 1 (-1 mask folded into the sign)
      const r0 = yw + cy, r1 = r0 + (ydelta & 1);
      xw += cx;
      out[i * 4] = px(r0, xw);
      out[i * 4 + 1] = px(r0, xw + xdelta);
      out[i * 4 + 2] = px(r1, xw);
      out[i * 4 + 3] = px(r1, xw + xdelta);
      x.step();
      y.step();
    }
    return;
  }
  for (let i = 0; i < numpix; i++) {
    let xw = x.hi | 0, yw = y.hi | 0;
    const xd0 = -xw >> 31;
    let xd1 = (xw + 1 - cw) >>> 31;
    let xd2 = (xw + 2 - cw) >>> 31;
    let isneg = xw >> 31;
    xw -= isneg;
    xd1 += isneg;
    xd2 += xd1;
    const yd0 = (-yw >> 31) & -1;
    let yd1 = ((yw + 1 - ch) >> 31) & 1;
    const yd2 = ((yw + 2 - ch) >> 31) & 1;
    isneg = yw >> 31;
    yw -= isneg;
    yd1 += isneg & -1;
    xw += cx;
    let row = yw + cy + yd0;
    const xs = [xw + xd0, xw, xw + xd1, xw + xd2];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) out[i * 16 + r * 4 + c] = px(row, xs[c]);
      row += r === 0 ? -yd0 : r === 1 ? yd1 : yd2;
    }
    x.step();
    y.step();
  }
};

function bilinear(rgb: Int32Array, numpix: number, xfract: number, dxfract: number, yfract: number, dyfract: number) {
  for (let j = 0; j < numpix; j++) {
    const xf = xfract >>> 24, yf = yfract >>> 24;
    let res = 0;
    for (let sh = 0; sh < 32; sh += 8) {
      const c = (k: number) => (rgb[j * 4 + k] >>> sh) & 255;
      let c1 = c(0), c2 = c(1);
      let cR = (c1 << 8) + (c2 - c1) * xf;
      c1 = c(2);
      c2 = c(3);
      c2 = (c1 << 8) + (c2 - c1) * xf;
      cR = (cR << 8) + (c2 - cR) * yf;
      res |= ((cR + (1 << 15)) >> 16) << sh;
    }
    rgb[j] = res;
    xfract = (xfract + dxfract) | 0;
    yfract = (yfract + dyfract) | 0;
  }
}

const coeff = new Int32Array(513);
let coeffReady = false;
function initBicubic(A: number) {
  let i = 0;
  for (; i < 256; i++) {
    let x = i / 256;
    x = ((A + 2) * x - (A + 3)) * x * x + 1;
    coeff[i] = Math.trunc(x * 256);
  }
  for (; i < 384; i++) {
    let x = i / 256;
    x = ((A * x - 5 * A) * x + 8 * A) * x - 4 * A;
    coeff[i] = Math.trunc(x * 256);
  }
  coeff[384] = ((256 - coeff[128] * 2) / 2) | 0;
  for (i++; i <= 512; i++) coeff[i] = 256 - (coeff[512 - i] + coeff[i - 256] + coeff[768 - i]);
  coeffReady = true;
}

const sat = (v: number, max: number) => {
  v &= ~(v >> 31);
  v -= max;
  v &= v >> 31;
  return v + max;
};

function bicubic(rgb: Int32Array, numpix: number, xfract: number, dxfract: number, yfract: number, dyfract: number) {
  if (!coeffReady) initBicubic(-0.5);
  for (let i = 0; i < numpix; i++) {
    const xf = xfract >>> 24, yf = yfract >>> 24;
    let a = 1 << 15, r = 1 << 15, g = 1 << 15, b = 1 << 15;
    const ys = [yf + 256, yf, 256 - yf, 512 - yf], xs = [xf + 256, xf, 256 - xf, 512 - xf];
    for (let k = 0; k < 16; k++) {
      const factor = coeff[xs[k & 3]] * coeff[ys[k >> 2]];
      const p = rgb[i * 16 + k];
      b += (p & 255) * factor;
      g += ((p >> 8) & 255) * factor;
      r += ((p >> 16) & 255) * factor;
      a += ((p >> 24) & 255) * factor;
    }
    a = sat(a >> 16, 255);
    r = sat(r >> 16, a);
    g = sat(g >> 16, a);
    b = sat(b >> 16, a);
    rgb[i] = (a << 24) | (r << 16) | (g << 8) | b;
    xfract = (xfract + dxfract) | 0;
    yfract = (yfract + dyfract) | 0;
  }
}

const unsafe = (v: number) => !Number.isFinite(v) || Math.abs(v) >= 1 << 30;

export const natives: Natives = {
  "sun/java2d/loops/TransformHelper.Transform"(t, [self, maskblit, srcData, dstData, comp, clip, itx, txtype, sx1, sy1, sx2, sy2, dx1, dy1, dx2, dy2, edgeArray, dxoff, dyoff]) {
    const vm = t.vm;
    const src = surfOf(t, srcData), dst = src && surfOf(t, dstData);
    const sf = fmts[primOf(vm, self).src];
    const mb = primOf(vm, maskblit);
    const blit = mb.fn as MaskBlitFn;
    if (!src || !dst) return;
    const { rule, extra, ea } = compOf(vm, comp);
    const mode = txtype;
    if (mode !== NN && mode !== BL && mode !== BC) return;
    const maxlinepix = mode === NN ? LINE_SIZE : mode === BL ? LINE_SIZE / 4 : LINE_SIZE / 16;
    const sb: Bounds = { x1: sx1, y1: sy1, x2: sx2, y2: sy2 };
    const db: Bounds = { x1: dx1, y1: dy1, x2: dx2, y2: dy2 };
    const cb = clipBounds(vm, clip);
    intersect(db, cb.x1, cb.y1, cb.x2, cb.y2);
    intersect(sb, 0, 0, src.w, src.h);
    intersect(db, 0, 0, dst.w, dst.h);
    intersect(cb, db.x1, db.y1, db.x2, db.y2);
    const g = (n: string) => vm.getField(itx, "java/awt/geom/AffineTransform", n) as number;
    const dxdx = g("m00"), dxdy = g("m01"), tx = g("m02"), dydx = g("m10"), dydy = g("m11"), ty = g("m12");
    const numedges = db.y2 - db.y1;
    let edges: Int32Array;
    if (numedges <= 0) edges = new Int32Array(2);
    else if (edgeArray !== null && (((edgeArray as JArray).a as Int32Array).length >> 1) - 1 >= numedges) edges = (edgeArray as JArray).a as Int32Array;
    else if (edgeArray === null) edges = new Int32Array(2 + numedges * 2);
    else throw new PendingThrow("java/lang/InternalError", "Unable to allocate edge list");
    if (cb.x2 <= cb.x1 || cb.y2 <= cb.y1) {
      edges[0] = edges[1] = 0;
      return;
    }
    const sw = sx2 - sx1, sh = sy2 - sy1;
    const tr = (x: number, y: number): [number, number] => [dxdx * x + dxdy * y + tx, dydx * x + dydy * y + ty];
    const rgb = new Int32Array(LINE_SIZE);
    const srcAt = src.at(src.off + sb.y1 * src.scan + sb.x1 * sf.ps, sb.x2 - sb.x1, sb.y2 - sb.y1);
    const dstPs = fmts[mb.dst].ps;
    // the dither starts at the destination bounds for every run
    const at = { sx: 0, dx: db.x1, dy: db.y1, xor: 0, mask: 0, ea };
    const out = (x: number, y: number, n: number) => blit(dst, dst.off + y * dst.scan + x * dstPs, rgbSurf, 0, null, 0, 0, n, 1, rule, extra, at);
    const rgbSurf = new Surf(rgb, 0, 4, 0, 0, 0);
    const corners: [number, number][] = [[db.x1 + 0.5, db.y1 + 0.5], [db.x2 - 0.5, db.y1 + 0.5], [db.x1 + 0.5, db.y2 - 0.5], [db.x2 - 0.5, db.y2 - 0.5]];
    const first = tr(dxoff + corners[0][0], dyoff + corners[0][1]);
    let overflow = corners.some(([x, y]) => {
      const [a, b] = tr(dxoff + x, dyoff + y);
      return unsafe(a) || unsafe(b);
    });
    const emit = (x1: number, y1: number, n: number, xl: bigint, yl: bigint, dxl: bigint, dyl: bigint) => {
      helper(sf, srcAt, rgb, n, xl, dxl, yl, dyl, mode);
      if (mode === BL) bilinear(rgb, n, fract(xl - HALF), fract(dxl), fract(yl - HALF), fract(dyl));
      else if (mode === BC) bicubic(rgb, n, fract(xl - HALF), fract(dxl), fract(yl - HALF), fract(dyl));
      out(x1, y1, n);
    };
    if (overflow) {
      edges[0] = db.y1;
      edges[1] = db.y2;
      for (let iy = db.y1; iy < db.y2; iy++) {
        edges[(iy - db.y1) * 2 + 2] = db.x2;
        edges[(iy - db.y1) * 2 + 3] = db.x1;
      }
      for (const span of regionRects(t, clip, cb)) {
        for (let y = span.y1; y < span.y2; y++) {
          const i = (y - db.y1) * 2;
          for (let x = span.x1; x < span.x2; x++) {
            const [px, py] = tr(dxoff + x + 0.5, dyoff + y + 0.5);
            if (!(px >= 0 && py >= 0 && px < sw && py < sh)) continue;
            const xl = dblToLong(px), yl = dblToLong(py);
            if (xl >> 32n < BigInt(sw) && yl >> 32n < BigInt(sh)) {
              if (edges[i + 2] > x) edges[i + 2] = x;
              if (edges[i + 3] <= x) edges[i + 3] = x + 1;
              emit(x, y, 1, xl, yl, 0n, 0n);
            }
          }
        }
      }
      return;
    }
    const dxdxl = dblToLong(dxdx), dydxl = dblToLong(dydx), dxdyl = dblToLong(dxdy), dydyl = dblToLong(dydy);
    const xbase = dblToLong(first[0]), ybase = dblToLong(first[1]);
    // calculateEdges
    edges[0] = db.y1;
    edges[1] = db.y2;
    const inRange = (xl: bigint, yl: bigint) => {
      const xw = xl >> 32n, yw = yl >> 32n;
      return xw >= 0n && xw < BigInt(sw) && yw >= 0n && yw < BigInt(sh);
    };
    const drowx = BigInt(db.x2 - db.x1 - 1) * dxdxl, drowy = BigInt(db.x2 - db.x1 - 1) * dydxl;
    let bx = xbase, by = ybase;
    for (let y = db.y1; y < db.y2; y++) {
      let x1 = db.x1, x2 = db.x2;
      let xl = bx, yl = by;
      while (x1 < x2 && !inRange(xl, yl)) {
        x1++;
        xl += dxdxl;
        yl += dydxl;
      }
      xl = bx + drowx;
      yl = by + drowy;
      while (x2 > x1 && !inRange(xl, yl)) {
        x2--;
        xl -= dxdxl;
        yl -= dydxl;
      }
      edges[(y - db.y1) * 2 + 2] = x1;
      edges[(y - db.y1) * 2 + 3] = x2;
      bx += dxdyl;
      by += dydyl;
    }
    for (const span of regionRects(t, clip, cb)) {
      let rowx = xbase + BigInt(span.y1 - db.y1) * dxdyl, rowy = ybase + BigInt(span.y1 - db.y1) * dydyl;
      for (let y = span.y1; y < span.y2; y++) {
        let x1 = edges[(y - db.y1) * 2 + 2], x2 = edges[(y - db.y1) * 2 + 3];
        if (x1 < span.x1) x1 = span.x1;
        if (x2 > span.x2) x2 = span.x2;
        while (x1 < x2) {
          const n = Math.min(x2 - x1, maxlinepix);
          const xl = rowx + BigInt(x1 - db.x1) * dxdxl, yl = rowy + BigInt(x1 - db.x1) * dydxl;
          emit(x1, y, n, xl, yl, dxdxl, dydxl);
          x1 += maxlinepix;
        }
        rowx += dxdyl;
        rowy += dydyl;
      }
    }
  },
};
