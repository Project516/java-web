// Java2D FillPath, DrawPath, FillParallelogram and DrawParallelogram, ported
// from libawt (ProcessPath.c, FillParallelogram.c, DrawParallelogram.c).
// The float, int and long arithmetic follows the C so pixels match HotSpot.

import { PendingThrow } from "../thread.ts";
import type { JArray, JObject } from "../runtime.ts";
import type { Natives } from "./util.ts";
import type { Surf } from "./java2d-loops.ts";
import { clipBounds, intersect, lockBounds, putPixel, sgInt, surfOf } from "./java2d-surface.ts";
import type { Bounds } from "./java2d-surface.ts";
import { processLine } from "./java2d.ts";
import { penOf } from "./java2d-pen.ts";
import type { Pen } from "./java2d-pen.ts";

const f = Math.fround;

// C double and float to int casts on aarch64 saturate; NaN gives 0
function toInt(x: number): number {
  return x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : x !== x ? 0 : Math.trunc(x) | 0;
}

const LONG_MAX = (1n << 63n) - 1n, LONG_MIN = -(1n << 63n);

function toLong(d: number): bigint {
  d *= 4294967296;
  if (d !== d) return 0n;
  if (d >= 9223372036854775807) return LONG_MAX;
  if (d <= -9223372036854775808) return LONG_MIN;
  return BigInt(Math.trunc(d));
}

const wrap = (x: bigint) => BigInt.asIntN(64, x);
const idiv = (a: number, b: number) => Math.trunc(a / b) | 0;

// ---- ProcessPath ----------------------------------------------------------

const MDP_PREC = 10, MDP_MULT = 1 << MDP_PREC, MDP_HALF_MULT = MDP_MULT >> 1, MDP_W_MASK = -MDP_MULT;
const UPPER_BND = f(3.4028234663852886e38 / 4), LOWER_BND = -UPPER_BND;
const UPPER_OUT_BND = 1 << (30 - MDP_PREC), LOWER_OUT_BND = -UPPER_OUT_BND;
const EPSF = 1 / MDP_MULT;
const CALC_BND = 1 << (30 - MDP_PREC);

const MAX_CUB_SIZE = 256, MAX_QUAD_SIZE = 1024;
const DF_CUB_STEPS = 3, DF_QUAD_STEPS = 2, FWD_PREC = 7;
const DF_CUB_SHIFT = FWD_PREC + DF_CUB_STEPS * 3 - MDP_PREC;
const DF_QUAD_SHIFT = FWD_PREC + DF_QUAD_STEPS * 2 - MDP_PREC;
const DF_CUB_COUNT = 1 << DF_CUB_STEPS, DF_QUAD_COUNT = 1 << DF_QUAD_STEPS;
const DF_CUB_DEC_BND = 1 << (DF_CUB_STEPS * 3 + FWD_PREC + 2);
const DF_CUB_INC_BND = 1 << (DF_CUB_STEPS * 3 + FWD_PREC - 1);
const DF_QUAD_DEC_BND = 1 << (DF_QUAD_STEPS * 2 + FWD_PREC + 2);
const CUB_A_MULT = 1 << FWD_PREC, CUB_B_MULT = 1 << (DF_CUB_STEPS + FWD_PREC + 1), CUB_C_MULT = 1 << (DF_CUB_STEPS * 2 + FWD_PREC);
const QUAD_A_MULT = 1 << FWD_PREC, QUAD_B_MULT = 1 << (DF_QUAD_STEPS + FWD_PREC);

const CRES_MIN_CLIPPED = 0, CRES_MAX_CLIPPED = 1, CRES_NOT_CLIPPED = 2, CRES_INVISIBLE = 3;
const isClipped = (res: number) => res === CRES_MIN_CLIPPED || res === CRES_MAX_CLIPPED;

// TESTANDCLIP: the clipped a1 and b1 come back in ca and cb
let ca = 0, cb = 0;

function testAndClip(min: number, max: number, a1: number, b1: number, a2: number, b2: number, flt: boolean): number {
  ca = a1;
  cb = b1;
  if (a1 >= min && a1 <= max) return CRES_NOT_CLIPPED;
  let res: number, t: number;
  if (a1 < min) {
    if (a2 < min) return CRES_INVISIBLE;
    res = CRES_MIN_CLIPPED;
    t = min;
  } else {
    if (a2 > max) return CRES_INVISIBLE;
    res = CRES_MAX_CLIPPED;
    t = max;
  }
  if (flt) {
    cb = f(b1 + ((t - a1) * f(b2 - b1)) / f(a2 - a1));
    ca = f(t);
  } else {
    cb = toInt(b1 + ((t - a1) * ((b2 - b1) | 0)) / ((a2 - a1) | 0));
    ca = toInt(t);
  }
  return res;
}

// CLIPCLAMP: clipped a1 and b1 in ca and cb, a2 in ca2, a3 and b3 in ca3 and cb3
let ca2 = 0, ca3 = 0, cb3 = 0;

function clipClamp(min: number, max: number, a1: number, b1: number, a2: number, b2: number, flt: boolean): number {
  ca3 = a1;
  cb3 = b1;
  ca2 = a2;
  let res = testAndClip(min, max, a1, b1, a2, b2, flt);
  if (res === CRES_MIN_CLIPPED || res === CRES_MAX_CLIPPED) {
    ca3 = ca;
  } else if (res === CRES_INVISIBLE) {
    if (a1 > max) return CRES_INVISIBLE;
    ca = flt ? f(min) : toInt(min);
    ca2 = ca;
    res = CRES_NOT_CLIPPED;
  }
  return res;
}

interface Pt {
  x: number;
  y: number;
  last: boolean;
  prev: Pt | null;
  next: Pt | null;
  nextByY: Pt | null;
  edge: Edge | null;
}

interface Edge {
  x: number;
  dx: number;
  dir: number;
  prev: Edge | null;
  next: Edge | null;
}

// The DrawHandler and ProcessHandler of the C, with the fill data
class Handler {
  s: Surf;
  b: Bounds;
  pixel: number;
  fill: boolean;
  pure: boolean;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  xMinf = 0;
  yMinf = 0;
  xMaxf = 0;
  yMaxf = 0;
  pts: Pt[] = [];
  plgYMin = 0;
  plgYMax = 0;
  pen: Pen;
  constructor(s: Surf, b: Bounds, pixel: number, fill: boolean, pure: boolean, pen: Pen) {
    this.pen = pen;
    this.s = s;
    this.b = b;
    this.pixel = pixel;
    this.fill = fill;
    this.pure = pure;
    this.xMin = b.x1;
    this.yMin = b.y1;
    this.xMax = b.x2;
    this.yMax = b.y2;
  }

  drawPixel(x: number, y: number) {
    this.pen.put(this.s, x, y, this.pixel);
  }

  drawLine(x0: number, y0: number, x1: number, y1: number) {
    processLine(this.s, this.b, this.pixel, x0, y0, x1, y1, 0, this.pen);
  }

  drawScanline(x0: number, x1: number, y0: number) {
    this.pen.run(this.s, x0, y0, this.pixel, x1 - x0 + 1, 0, 1, 0, 0, 0);
  }

  processFixedLine(x1: number, y1: number, x2: number, y2: number, pi: Int32Array, checkBounds: boolean, endSubPath: boolean) {
    if (this.fill) this.storeFixedLine(x1, y1, x2, y2, pi, checkBounds, endSubPath);
    else this.fixedLine(x1, y1, x2, y2, pi, checkBounds);
  }

  endSubPath() {
    if (this.fill && this.pts.length) this.pts[this.pts.length - 1].last = true;
  }

  // PROCESS_LINE
  private processLineFixed(fx0: number, fy0: number, fx1: number, fy1: number, checkBounds: boolean, pi: Int32Array) {
    let X0 = fx0 >> MDP_PREC, Y0 = fy0 >> MDP_PREC, X1 = fx1 >> MDP_PREC, Y1 = fy1 >> MDP_PREC;
    if (checkBounds) {
      const xMinf = f(this.xMinf + 0.5), yMinf = f(this.yMinf + 0.5), xMaxf = f(this.xMaxf + 0.5), yMaxf = f(this.yMaxf + 0.5);
      if (testAndClip(yMinf, yMaxf, Y0, X0, Y1, X1, false) === CRES_INVISIBLE) return;
      Y0 = ca;
      X0 = cb;
      if (testAndClip(yMinf, yMaxf, Y1, X1, Y0, X0, false) === CRES_INVISIBLE) return;
      Y1 = ca;
      X1 = cb;
      if (testAndClip(xMinf, xMaxf, X0, Y0, X1, Y1, false) === CRES_INVISIBLE) return;
      X0 = ca;
      Y0 = cb;
      if (testAndClip(xMinf, xMaxf, X1, Y1, X0, Y0, false) === CRES_INVISIBLE) return;
      X1 = ca;
      Y1 = cb;
    }
    if (((X0 ^ X1) | (Y0 ^ Y1)) === 0) {
      if (pi[0] === 0) {
        pi[0] = 1;
        pi[1] = X0;
        pi[2] = Y0;
        pi[3] = X0;
        pi[4] = Y0;
        this.drawPixel(X0, Y0);
      } else if ((X0 !== pi[3] || Y0 !== pi[4]) && (X0 !== pi[1] || Y0 !== pi[2])) {
        this.drawPixel(X0, Y0);
        pi[3] = X0;
        pi[4] = Y0;
      }
      return;
    }
    if (pi[0] && ((pi[1] === X0 && pi[2] === Y0) || (pi[3] === X0 && pi[4] === Y0))) this.drawPixel(X0, Y0);
    this.drawLine(X0, Y0, X1, Y1);
    if (pi[0] === 0) {
      pi[0] = 1;
      pi[1] = X0;
      pi[2] = Y0;
      pi[3] = X0;
      pi[4] = Y0;
    }
    if ((pi[1] === X1 && pi[2] === Y1) || (pi[3] === X1 && pi[4] === Y1)) this.drawPixel(X1, Y1);
    pi[3] = X1;
    pi[4] = Y1;
  }

  // PROCESS_POINT
  private processPoint(fx: number, fy: number, checkBounds: boolean, pi: Int32Array) {
    const X = fx >> MDP_PREC, Y = fy >> MDP_PREC;
    if (checkBounds && (this.yMin > Y || this.yMax <= Y || this.xMin > X || this.xMax <= X)) return;
    if (pi[0] === 0) {
      pi[0] = 1;
      pi[1] = X;
      pi[2] = Y;
      pi[3] = X;
      pi[4] = Y;
      this.drawPixel(X, Y);
    } else if ((X !== pi[3] || Y !== pi[4]) && (X !== pi[1] || Y !== pi[2])) {
      this.drawPixel(X, Y);
      pi[3] = X;
      pi[4] = Y;
    }
  }

  // ProcessFixedLine: a line with subpixel endpoints
  private fixedLine(x1: number, y1: number, x2: number, y2: number, pi: Int32Array, checkBounds: boolean) {
    const c = (x1 ^ x2) | (y1 ^ y2);
    let rx1: number, ry1: number, rx2: number, ry2: number;
    if ((c & MDP_W_MASK) === 0) {
      if (c === 0) this.processPoint((x1 + MDP_HALF_MULT) | 0, (y1 + MDP_HALF_MULT) | 0, checkBounds, pi);
      return;
    }
    if (x1 === x2 || y1 === y2) {
      rx1 = (x1 + MDP_HALF_MULT) | 0;
      rx2 = (x2 + MDP_HALF_MULT) | 0;
      ry1 = (y1 + MDP_HALF_MULT) | 0;
      ry2 = (y2 + MDP_HALF_MULT) | 0;
    } else {
      const dx = (x2 - x1) | 0, dy = (y2 - y1) | 0;
      const fx1 = x1 & MDP_W_MASK, fy1 = y1 & MDP_W_MASK, fx2 = x2 & MDP_W_MASK, fy2 = y2 & MDP_W_MASK;
      if (fx1 === x1 || fy1 === y1) {
        rx1 = (x1 + MDP_HALF_MULT) | 0;
        ry1 = (y1 + MDP_HALF_MULT) | 0;
      } else {
        const bx1 = x1 < x2 ? (fx1 + MDP_MULT) | 0 : fx1;
        const by1 = y1 < y2 ? (fy1 + MDP_MULT) | 0 : fy1;
        let cross = (y1 + idiv(Math.imul((bx1 - x1) | 0, dy), dx)) | 0;
        if (cross >= fy1 && cross <= fy1 + MDP_MULT) {
          rx1 = bx1;
          ry1 = (cross + MDP_HALF_MULT) | 0;
        } else {
          cross = (x1 + idiv(Math.imul((by1 - y1) | 0, dx), dy)) | 0;
          rx1 = (cross + MDP_HALF_MULT) | 0;
          ry1 = by1;
        }
      }
      if (fx2 === x2 || fy2 === y2) {
        rx2 = (x2 + MDP_HALF_MULT) | 0;
        ry2 = (y2 + MDP_HALF_MULT) | 0;
      } else {
        const bx2 = x1 > x2 ? (fx2 + MDP_MULT) | 0 : fx2;
        const by2 = y1 > y2 ? (fy2 + MDP_MULT) | 0 : fy2;
        let cross = (y2 + idiv(Math.imul((bx2 - x2) | 0, dy), dx)) | 0;
        if (cross >= fy2 && cross <= fy2 + MDP_MULT) {
          rx2 = bx2;
          ry2 = (cross + MDP_HALF_MULT) | 0;
        } else {
          cross = (x2 + idiv(Math.imul((by2 - y2) | 0, dx), dy)) | 0;
          rx2 = (cross + MDP_HALF_MULT) | 0;
          ry2 = by2;
        }
      }
    }
    this.processLineFixed(rx1, ry1, rx2, ry2, checkBounds, pi);
  }

  // StoreFixedLine: clips and clamps a flattened segment into the fill points
  private storeFixedLine(x1: number, y1: number, x2: number, y2: number, pi: Int32Array, checkBounds: boolean, endSubPath: boolean) {
    if (checkBounds) {
      const outXMin = toInt(f(this.xMinf * MDP_MULT)), outXMax = toInt(f(this.xMaxf * MDP_MULT));
      const outYMin = toInt(f(this.yMinf * MDP_MULT)), outYMax = toInt(f(this.yMaxf * MDP_MULT));
      if (testAndClip(outYMin, outYMax, y1, x1, y2, x2, false) === CRES_INVISIBLE) return;
      y1 = ca;
      x1 = cb;
      let res = testAndClip(outYMin, outYMax, y2, x2, y1, x1, false);
      if (res === CRES_INVISIBLE) return;
      y2 = ca;
      x2 = cb;
      let lastClipped = isClipped(res);

      res = clipClamp(outXMin, outXMax, x1, y1, x2, y2, false);
      if (res === CRES_INVISIBLE) return;
      x1 = ca;
      y1 = cb;
      x2 = ca2;
      let x3 = ca3, y3 = cb3;
      if (res === CRES_MIN_CLIPPED) this.storeFixedLine(x3, y3, x1, y1, pi, false, lastClipped);

      res = clipClamp(outXMin, outXMax, x2, y2, x1, y1, false);
      x2 = ca;
      y2 = cb;
      x1 = ca2;
      x3 = ca3;
      y3 = cb3;
      lastClipped = lastClipped || res === CRES_MAX_CLIPPED;
      this.storeFixedLine(x1, y1, x2, y2, pi, false, lastClipped);
      if (res === CRES_MIN_CLIPPED) this.storeFixedLine(x2, y2, x3, y3, pi, false, lastClipped);
      return;
    }
    const pts = this.pts;
    if (pts.length === 0 || pts[pts.length - 1].last) this.addPoint(x1, y1);
    this.addPoint(x2, y2);
    if (endSubPath) pts[pts.length - 1].last = true;
  }

  private addPoint(x: number, y: number) {
    const pts = this.pts;
    if (pts.length) {
      if (this.plgYMin > y) this.plgYMin = y;
      if (this.plgYMax < y) this.plgYMax = y;
    } else {
      this.plgYMin = y;
      this.plgYMax = y;
    }
    pts.push({ x, y, last: false, prev: null, next: null, nextByY: null, edge: null });
  }

  // ProcessLine of the C
  processLine(x1: number, y1: number, x2: number, y2: number, pi: Int32Array) {
    const { xMinf: xMin, yMinf: yMin, xMaxf: xMax, yMaxf: yMax } = this;
    let res = testAndClip(yMin, yMax, y1, x1, y2, x2, true);
    if (res === CRES_INVISIBLE) return;
    y1 = ca;
    x1 = cb;
    let clipped = isClipped(res);
    res = testAndClip(yMin, yMax, y2, x2, y1, x1, true);
    if (res === CRES_INVISIBLE) return;
    y2 = ca;
    x2 = cb;
    let lastClipped = isClipped(res);
    clipped = clipped || lastClipped;

    if (!this.fill) {
      res = testAndClip(xMin, xMax, x1, y1, x2, y2, true);
      if (res === CRES_INVISIBLE) return;
      x1 = ca;
      y1 = cb;
      clipped = clipped || isClipped(res);
      res = testAndClip(xMin, xMax, x2, y2, x1, y1, true);
      if (res === CRES_INVISIBLE) return;
      x2 = ca;
      y2 = cb;
      lastClipped = lastClipped || isClipped(res);
      clipped = clipped || lastClipped;
      const X1 = toInt(f(x1 * MDP_MULT)), Y1 = toInt(f(y1 * MDP_MULT)), X2 = toInt(f(x2 * MDP_MULT)), Y2 = toInt(f(y2 * MDP_MULT));
      this.processFixedLine(X1, Y1, X2, Y2, pi, clipped, lastClipped);
      return;
    }

    res = clipClamp(xMin, xMax, x1, y1, x2, y2, true);
    if (res === CRES_INVISIBLE) return;
    x1 = ca;
    y1 = cb;
    x2 = ca2;
    let x3 = ca3, y3 = cb3;
    const X1 = toInt(f(x1 * MDP_MULT)), Y1 = toInt(f(y1 * MDP_MULT));
    if (res === CRES_MIN_CLIPPED) {
      const X3 = toInt(f(x3 * MDP_MULT)), Y3 = toInt(f(y3 * MDP_MULT));
      this.processFixedLine(X3, Y3, X1, Y1, pi, false, lastClipped);
    }

    res = clipClamp(xMin, xMax, x2, y2, x1, y1, true);
    x2 = ca;
    y2 = cb;
    x3 = ca3;
    y3 = cb3;
    lastClipped = lastClipped || res === CRES_MAX_CLIPPED;
    const X2 = toInt(f(x2 * MDP_MULT)), Y2 = toInt(f(y2 * MDP_MULT));
    this.processFixedLine(X1, Y1, X2, Y2, pi, false, lastClipped);
    if (res === CRES_MIN_CLIPPED) {
      const X3 = toInt(f(x3 * MDP_MULT)), Y3 = toInt(f(y3 * MDP_MULT));
      this.processFixedLine(X2, Y2, X3, Y3, pi, false, lastClipped);
    }
  }

  // The visibility and size tests of ProcessMonotonicQuad and Cubic (n is 6 or 8)
  private curveBounds(c: Float32Array, n: number): { skip: boolean; split: boolean; check: boolean } {
    let xMin = c[0], xMax = c[0], yMin = c[1], yMax = c[1];
    for (let i = 2; i < n; i += 2) {
      if (c[i] < xMin) xMin = c[i];
      if (c[i] > xMax) xMax = c[i];
      if (c[i + 1] < yMin) yMin = c[i + 1];
      if (c[i + 1] > yMax) yMax = c[i + 1];
    }
    const max = n === 6 ? MAX_QUAD_SIZE : MAX_CUB_SIZE;
    if (!this.fill) {
      if (this.xMaxf < xMin || this.xMinf > xMax || this.yMaxf < yMin || this.yMinf > yMax) return { skip: true, split: false, check: false };
    } else {
      if (this.yMaxf < yMin || this.yMinf > yMax || this.xMaxf < xMin) return { skip: true, split: false, check: false };
      if (this.xMinf > xMax) {
        for (let i = 0; i < n; i += 2) c[i] = this.xMinf;
      }
    }
    const split = f(xMax - xMin) > max || f(yMax - yMin) > max;
    // the quad test is >= and <=, the cubic test is > and <
    const check = n === 6
      ? this.xMinf >= xMin || this.xMaxf <= xMax || this.yMinf >= yMin || this.yMaxf <= yMax
      : this.xMinf > xMin || this.xMaxf < xMax || this.yMinf > yMin || this.yMaxf < yMax;
    return { skip: false, split, check };
  }

  private drawMonotonicQuad(c: Float32Array, checkBounds: boolean, pi: Int32Array) {
    const x0 = toInt(f(c[0] * MDP_MULT)), y0 = toInt(f(c[1] * MDP_MULT));
    const xe = toInt(f(c[4] * MDP_MULT)), ye = toInt(f(c[5] * MDP_MULT));
    let px = (x0 & ~MDP_W_MASK) << DF_QUAD_SHIFT, py = (y0 & ~MDP_W_MASK) << DF_QUAD_SHIFT;
    let count = DF_QUAD_COUNT, shift = DF_QUAD_SHIFT;
    const ax = toInt(f(f(f(c[0] - f(2 * c[2])) + c[4]) * QUAD_A_MULT));
    const ay = toInt(f(f(f(c[1] - f(2 * c[3])) + c[5]) * QUAD_A_MULT));
    const bx = toInt(f(f(f(-2 * c[0]) + f(2 * c[2])) * QUAD_B_MULT));
    const by = toInt(f(f(f(-2 * c[1]) + f(2 * c[3])) * QUAD_B_MULT));
    const ddpx = (2 * ax) | 0, ddpy = (2 * ay) | 0;
    let dpx = (ax + bx) | 0, dpy = (ay + by) | 0;
    let x1: number, y1: number, x2 = x0, y2 = y0;
    const abs32 = (x: number) => ((x ^ (x >> 31)) - (x >> 31)) | 0;
    let maxDD = Math.max(abs32(ddpx), abs32(ddpy));
    const x0w = x0 & MDP_W_MASK, y0w = y0 & MDP_W_MASK;
    const dx = (xe - x0) | 0, dy = (ye - y0) | 0;
    while (maxDD > DF_QUAD_DEC_BND) {
      dpx = ((dpx << 1) - ax) | 0;
      dpy = ((dpy << 1) - ay) | 0;
      count <<= 1;
      maxDD >>= 2;
      px <<= 2;
      py <<= 2;
      shift += 2;
    }
    while (count-- > 1) {
      px = (px + dpx) | 0;
      py = (py + dpy) | 0;
      dpx = (dpx + ddpx) | 0;
      dpy = (dpy + ddpy) | 0;
      x1 = x2;
      y1 = y2;
      x2 = (x0w + (px >> shift)) | 0;
      y2 = (y0w + (py >> shift)) | 0;
      if ((((xe - x2) | 0) ^ dx) < 0) x2 = xe;
      if ((((ye - y2) | 0) ^ dy) < 0) y2 = ye;
      this.processFixedLine(x1, y1, x2, y2, pi, checkBounds, false);
    }
    this.processFixedLine(x2, y2, xe, ye, pi, checkBounds, false);
  }

  private processMonotonicQuad(c: Float32Array, pi: Int32Array) {
    const r = this.curveBounds(c, 6);
    if (r.skip) return;
    if (r.split) {
      const c1 = new Float32Array(6);
      c1[4] = c[4];
      c1[5] = c[5];
      c1[2] = f(c[2] + c[4]) / 2;
      c1[3] = f(c[3] + c[5]) / 2;
      c[2] = f(c[0] + c[2]) / 2;
      c[3] = f(c[1] + c[3]) / 2;
      c[4] = c1[0] = f(c[2] + c1[2]) / 2;
      c[5] = c1[1] = f(c[3] + c1[3]) / 2;
      this.processMonotonicQuad(c, pi);
      this.processMonotonicQuad(c1, pi);
    } else {
      this.drawMonotonicQuad(c, r.check, pi);
    }
  }

  private firstPartOfQuad(c: Float32Array, pi: Int32Array, t: number) {
    const c1 = new Float32Array(6);
    c1[0] = c[0];
    c1[1] = c[1];
    c1[2] = f(c[0] + f(t * f(c[2] - c[0])));
    c1[3] = f(c[1] + f(t * f(c[3] - c[1])));
    c[2] = f(c[2] + f(t * f(c[4] - c[2])));
    c[3] = f(c[3] + f(t * f(c[5] - c[3])));
    c[0] = c1[4] = f(c1[2] + f(t * f(c[2] - c1[2])));
    c[1] = c1[5] = f(c1[3] + f(t * f(c[3] - c1[3])));
    this.processMonotonicQuad(c1, pi);
  }

  processQuad(c: Float32Array, pi: Int32Array) {
    const params = [0, 0];
    let cnt = 0, param: number;
    if ((c[0] > c[2] || c[2] > c[4]) && (c[0] < c[2] || c[2] < c[4])) {
      const ax = f(f(c[0] - f(2 * c[2])) + c[4]);
      if (ax !== 0) {
        const bx = f(c[0] - c[2]);
        param = bx / ax;
        if (param < 1 && param > 0) params[cnt++] = param;
      }
    }
    if ((c[1] > c[3] || c[3] > c[5]) && (c[1] < c[3] || c[3] < c[5])) {
      const ay = f(f(c[1] - f(2 * c[3])) + c[5]);
      if (ay !== 0) {
        const by = f(c[1] - c[3]);
        param = by / ay;
        if (param < 1 && param > 0) {
          if (cnt > 0) {
            if (params[0] > param) {
              params[cnt++] = params[0];
              params[0] = param;
            } else if (params[0] < param) {
              params[cnt++] = param;
            }
          } else {
            params[cnt++] = param;
          }
        }
      }
    }
    if (cnt >= 1) {
      this.firstPartOfQuad(c, pi, f(params[0]));
      if (cnt === 2) {
        param = params[1] - params[0];
        if (param > 0) this.firstPartOfQuad(c, pi, f(param / (1 - params[0])));
      }
    }
    this.processMonotonicQuad(c, pi);
  }

  private drawMonotonicCubic(c: Float32Array, checkBounds: boolean, pi: Int32Array) {
    const x0 = toInt(f(c[0] * MDP_MULT)), y0 = toInt(f(c[1] * MDP_MULT));
    const xe = toInt(f(c[6] * MDP_MULT)), ye = toInt(f(c[7] * MDP_MULT));
    let px = (x0 & ~MDP_W_MASK) << DF_CUB_SHIFT, py = (y0 & ~MDP_W_MASK) << DF_CUB_SHIFT;
    let incStepBnd1 = DF_CUB_INC_BND, incStepBnd2 = DF_CUB_INC_BND << 1;
    let decStepBnd1 = DF_CUB_DEC_BND, decStepBnd2 = DF_CUB_DEC_BND << 1;
    let count = DF_CUB_COUNT, shift = DF_CUB_SHIFT;
    const cubA = (a: number, b: number, c2: number, d: number) => f(f(f(-a + f(3 * b)) - f(3 * c2)) + d);
    const ax = toInt(f(cubA(c[0], c[2], c[4], c[6]) * CUB_A_MULT));
    const ay = toInt(f(cubA(c[1], c[3], c[5], c[7]) * CUB_A_MULT));
    const cubB = (a: number, b: number, c2: number) => f(f(f(3 * a) - f(6 * b)) + f(3 * c2));
    const bx = toInt(f(cubB(c[0], c[2], c[4]) * CUB_B_MULT));
    const by = toInt(f(cubB(c[1], c[3], c[5]) * CUB_B_MULT));
    const cx = toInt(f(f(f(-3 * c[0]) + f(3 * c[2])) * CUB_C_MULT));
    const cy = toInt(f(f(f(-3 * c[1]) + f(3 * c[3])) * CUB_C_MULT));
    const dddpx = Math.imul(6, ax), dddpy = Math.imul(6, ay);
    let ddpx = (dddpx + bx) | 0, ddpy = (dddpy + by) | 0;
    let dpx = (ax + (bx >> 1) + cx) | 0, dpy = (ay + (by >> 1) + cy) | 0;
    let x1: number, y1: number, x2 = x0, y2 = y0;
    const x0w = x0 & MDP_W_MASK, y0w = y0 & MDP_W_MASK;
    const dx = (xe - x0) | 0, dy = (ye - y0) | 0;
    while (count > 0) {
      while (
        ((ddpx + decStepBnd1) | 0) >>> 0 > decStepBnd2 >>> 0 ||
        ((ddpy + decStepBnd1) | 0) >>> 0 > decStepBnd2 >>> 0
      ) {
        ddpx = ((ddpx << 1) - dddpx) | 0;
        ddpy = ((ddpy << 1) - dddpy) | 0;
        dpx = ((dpx << 2) - (ddpx >> 1)) | 0;
        dpy = ((dpy << 2) - (ddpy >> 1)) | 0;
        count <<= 1;
        decStepBnd1 <<= 3;
        decStepBnd2 <<= 3;
        incStepBnd1 <<= 3;
        incStepBnd2 <<= 3;
        px <<= 3;
        py <<= 3;
        shift += 3;
      }
      while (
        ((count & 1) ^ 1) &&
        shift > DF_CUB_SHIFT &&
        ((dpx + incStepBnd1) | 0) >>> 0 <= incStepBnd2 >>> 0 &&
        ((dpy + incStepBnd1) | 0) >>> 0 <= incStepBnd2 >>> 0
      ) {
        dpx = ((dpx >> 2) + (ddpx >> 3)) | 0;
        dpy = ((dpy >> 2) + (ddpy >> 3)) | 0;
        ddpx = (ddpx + dddpx) >> 1;
        ddpy = (ddpy + dddpy) >> 1;
        count >>= 1;
        decStepBnd1 >>= 3;
        decStepBnd2 >>= 3;
        incStepBnd1 >>= 3;
        incStepBnd2 >>= 3;
        px >>= 3;
        py >>= 3;
        shift -= 3;
      }
      count--;
      if (count) {
        px = (px + dpx) | 0;
        py = (py + dpy) | 0;
        dpx = (dpx + ddpx) | 0;
        dpy = (dpy + ddpy) | 0;
        ddpx = (ddpx + dddpx) | 0;
        ddpy = (ddpy + dddpy) | 0;
        x1 = x2;
        y1 = y2;
        x2 = (x0w + (px >> shift)) | 0;
        y2 = (y0w + (py >> shift)) | 0;
        if ((((xe - x2) | 0) ^ dx) < 0) x2 = xe;
        if ((((ye - y2) | 0) ^ dy) < 0) y2 = ye;
        this.processFixedLine(x1, y1, x2, y2, pi, checkBounds, false);
      } else {
        this.processFixedLine(x2, y2, xe, ye, pi, checkBounds, false);
      }
    }
  }

  private processMonotonicCubic(c: Float32Array, pi: Int32Array) {
    const r = this.curveBounds(c, 8);
    if (r.skip) return;
    if (r.split) {
      const c1 = new Float32Array(8);
      c1[6] = c[6];
      c1[7] = c[7];
      c1[4] = f(c[4] + c[6]) / 2;
      c1[5] = f(c[5] + c[7]) / 2;
      const tx = f(f(c[2] + c[4]) / 2), ty = f(f(c[3] + c[5]) / 2);
      c1[2] = f(tx + c1[4]) / 2;
      c1[3] = f(ty + c1[5]) / 2;
      c[2] = f(c[0] + c[2]) / 2;
      c[3] = f(c[1] + c[3]) / 2;
      c[4] = f(c[2] + tx) / 2;
      c[5] = f(c[3] + ty) / 2;
      c[6] = c1[0] = f(c[4] + c1[2]) / 2;
      c[7] = c1[1] = f(c[5] + c1[3]) / 2;
      this.processMonotonicCubic(c, pi);
      this.processMonotonicCubic(c1, pi);
    } else {
      this.drawMonotonicCubic(c, r.check, pi);
    }
  }

  private firstPartOfCubic(c: Float32Array, pi: Int32Array, t: number) {
    const c1 = new Float32Array(8);
    c1[0] = c[0];
    c1[1] = c[1];
    const tx = f(c[2] + f(t * f(c[4] - c[2]))), ty = f(c[3] + f(t * f(c[5] - c[3])));
    c1[2] = f(c[0] + f(t * f(c[2] - c[0])));
    c1[3] = f(c[1] + f(t * f(c[3] - c[1])));
    c1[4] = f(c1[2] + f(t * f(tx - c1[2])));
    c1[5] = f(c1[3] + f(t * f(ty - c1[3])));
    c[4] = f(c[4] + f(t * f(c[6] - c[4])));
    c[5] = f(c[5] + f(t * f(c[7] - c[5])));
    c[2] = f(tx + f(t * f(c[4] - tx)));
    c[3] = f(ty + f(t * f(c[5] - ty)));
    c[0] = c1[6] = f(c1[4] + f(t * f(c[2] - c1[4])));
    c[1] = c1[7] = f(c1[5] + f(t * f(c[3] - c1[5])));
    this.processMonotonicCubic(c1, pi);
  }

  processCubic(c: Float32Array, pi: Int32Array) {
    const params: number[] = [];
    // SOLVEQUADINRANGE
    const solve = (A: number, B: number, C: number) => {
      let param: number;
      if (A !== 0) {
        let d = B * B - 4 * A * C;
        if (d < 0) return;
        d = Math.sqrt(d);
        if (B < 0) d = -d;
        const q = (B + d) / -2;
        param = q / A;
        if (param < 1 && param > 0) params.push(param);
        if (d === 0 || q === 0) return;
        param = C / q;
        if (param < 1 && param > 0) params.push(param);
      } else {
        if (B === 0) return;
        param = -C / B;
        if (param < 1 && param > 0) params.push(param);
      }
    };
    if ((c[0] > c[2] || c[2] > c[4] || c[4] > c[6]) && (c[0] < c[2] || c[2] < c[4] || c[4] < c[6])) {
      solve(f(f(f(-c[0] + f(3 * c[2])) - f(3 * c[4])) + c[6]), f(2 * f(f(c[0] - f(2 * c[2])) + c[4])), f(-c[0] + c[2]));
    }
    if ((c[1] > c[3] || c[3] > c[5] || c[5] > c[7]) && (c[1] < c[3] || c[3] < c[5] || c[5] < c[7])) {
      solve(f(f(f(-c[1] + f(3 * c[3])) - f(3 * c[5])) + c[7]), f(2 * f(f(c[1] - f(2 * c[3])) + c[5])), f(-c[1] + c[3]));
    }
    const cnt = params.length;
    if (cnt > 0) {
      for (let i = 1; i < cnt; i++) {
        const value = params[i];
        let j: number;
        for (j = i - 1; j >= 0 && params[j] > value; j--) params[j + 1] = params[j];
        params[j + 1] = value;
      }
      this.firstPartOfCubic(c, pi, f(params[0]));
      for (let i = 1; i < cnt; i++) {
        const param = params[i] - params[i - 1];
        if (param > 0) this.firstPartOfCubic(c, pi, f(param / (1 - params[i - 1])));
      }
    }
    this.processMonotonicCubic(c, pi);
  }

  // FillPolygon: scan converts the stored points
  fillPolygon(evenOdd: boolean) {
    const pt = this.pts;
    const n = pt.length;
    const yMin = this.plgYMin, yMax = this.plgYMax;
    const hashSize = ((yMax - yMin) >> MDP_PREC) + 4;
    const hashOffset = (yMin - 1) & MDP_W_MASK;
    const rightBnd = this.xMax - 1;
    const counterMask = evenOdd ? 1 : -1;
    if (n <= 1) return;

    const yHash: (Pt | null)[] = new Array(hashSize).fill(null);
    pt[0].prev = null;
    const hashOf = (p: Pt) => (p.y - hashOffset - 1) >> MDP_PREC;
    for (let i = 0; i < n - 1; i++) {
      const cur = pt[i], nextpt = pt[i + 1];
      const k = hashOf(cur);
      cur.nextByY = yHash[k];
      yHash[k] = cur;
      cur.next = nextpt;
      nextpt.prev = cur;
      cur.edge = null;
    }
    const ept = pt[n - 1];
    const ek = hashOf(ept);
    ept.nextByY = yHash[ek];
    yHash[ek] = ept;
    ept.next = null;
    ept.edge = null;

    const act: { head: Edge | null } = { head: null };
    const deleteActive = (e: Edge) => {
      const prevp = e.prev, nextp = e.next;
      if (prevp) prevp.next = nextp;
      else act.head = nextp;
      if (nextp) nextp.prev = prevp;
    };
    const insertActive = (p: Pt, cy: number) => {
      const np = p.next!;
      if (p.y === np.y) return;
      const ne: Edge = { x: 0, dx: 0, dir: 0, prev: null, next: null };
      const dX = (np.x - p.x) | 0, dY = (np.y - p.y) | 0;
      let dy: number;
      if (p.y < np.y) {
        ne.dir = -1;
        ne.x = p.x;
        dy = (cy - p.y) | 0;
      } else {
        ne.dir = 1;
        ne.x = np.x;
        dy = (cy - np.y) | 0;
      }
      if (((dX ^ (dX >> 31)) - (dX >> 31)) > CALC_BND) {
        ne.dx = toInt((dX * MDP_MULT) / dY);
        ne.x = (ne.x + toInt((dX * dy) / dY)) | 0;
      } else {
        ne.dx = idiv(dX << MDP_PREC, dY);
        ne.x = (ne.x + idiv(Math.imul(dX, dy), dY)) | 0;
      }
      ne.next = act.head;
      if (act.head) act.head.prev = ne;
      act.head = ne;
      p.edge = ne;
    };

    for (let y = (hashOffset + MDP_MULT) | 0, k = 0; y <= yMax && k < hashSize; y = (y + MDP_MULT) | 0, k++) {
      for (let p = yHash[k]; p; p = p.nextByY) {
        if (p.prev && !p.prev.last) {
          if (p.prev.edge && p.prev.y <= y) {
            deleteActive(p.prev.edge);
            p.prev.edge = null;
          } else if (p.prev.y > y) {
            insertActive(p.prev, y);
          }
        }
        if (!p.last && p.next) {
          if (p.edge && p.next.y <= y) {
            deleteActive(p.edge);
            p.edge = null;
          } else if (p.next.y > y) {
            insertActive(p, y);
          }
        }
      }
      if (!act.head) continue;

      // LBUBBLE_SORT
      let s: Edge | null = null;
      let wasSwap = true;
      while (s !== act.head!.next && wasSwap) {
        let p: Edge = act.head!, r: Edge = p;
        let q: Edge | null = p.next;
        wasSwap = false;
        while (p !== s) {
          if (p.x >= q!.x) {
            wasSwap = true;
            const temp: Edge | null = q!.next;
            q!.next = p;
            p.next = temp;
            if (p === act.head) act.head = q;
            else r.next = q;
            r = q!;
          } else {
            r = p;
            p = p.next!;
          }
          q = p.next;
          if (q === s) s = p;
        }
      }

      let prevEdge: Edge | null = null;
      for (let e = act.head; e; e = e.next) {
        e.prev = prevEdge;
        prevEdge = e;
      }

      let xl = this.xMin, xr: number;
      let counter = 0, drawing = false;
      for (let e: Edge | null = act.head; e; e = e.next) {
        counter += e.dir;
        if (counter & counterMask && !drawing) {
          xl = (e.x + MDP_MULT - 1) >> MDP_PREC;
          drawing = true;
        }
        if (!(counter & counterMask) && drawing) {
          xr = (e.x - 1) >> MDP_PREC;
          if (xl <= xr) this.drawScanline(xl, xr, y >> MDP_PREC);
          drawing = false;
        }
        e.x = (e.x + e.dx) | 0;
      }
      if (drawing && xl <= rightBnd) this.drawScanline(xl, rightBnd, y >> MDP_PREC);
    }
  }

  // ProcessPath; false when the coords array is too short
  processPath(transX: number, transY: number, coords: Float32Array, maxCoords: number, types: Int8Array, numTypes: number): boolean {
    const tc = new Float32Array(8), closeCoord = new Float32Array(2), pi = new Int32Array(5);
    let skip = false, subpathStarted = false, lastX: number, lastY: number, index = 0;
    let transXf = f(transX), transYf = f(transY);
    if (this.pure) {
      closeCoord[0] = -0.5;
      closeCoord[1] = -0.5;
      transXf = f(transXf - 0.5);
      transYf = f(transYf - 0.5);
    }
    const adjust = (x: number) => (x < LOWER_OUT_BND ? LOWER_OUT_BND : x > UPPER_OUT_BND ? UPPER_OUT_BND : x);
    this.xMin = adjust(this.xMin);
    this.yMin = adjust(this.yMin);
    this.xMax = adjust(this.xMax);
    this.yMax = adjust(this.yMax);
    this.xMinf = f(this.xMin - 0.5);
    this.yMinf = f(this.yMin - 0.5);
    this.xMaxf = f(f(this.xMax - 0.5) - EPSF);
    this.yMaxf = f(f(this.yMax - 0.5) - EPSF);

    const valid = (x: number, y: number) => x < UPPER_BND && x > LOWER_BND && y < UPPER_BND && y > LOWER_BND;
    const closeSubpath = () => {
      if (this.fill && (tc[0] !== closeCoord[0] || tc[1] !== closeCoord[1])) this.processLine(tc[0], tc[1], closeCoord[0], closeCoord[1], pi);
      this.endSubPath();
    };

    for (let i = 0; i < numTypes; i++) {
      switch (types[i]) {
        case 0:
          if (index + 2 > maxCoords) return false;
          if (subpathStarted && !skip) closeSubpath();
          tc[0] = coords[index++] + transXf;
          tc[1] = coords[index++] + transYf;
          if (valid(tc[0], tc[1])) {
            subpathStarted = true;
            skip = false;
            closeCoord[0] = tc[0];
            closeCoord[1] = tc[1];
          } else {
            skip = true;
          }
          break;
        case 1:
          if (index + 2 > maxCoords) return false;
          tc[2] = coords[index++] + transXf;
          tc[3] = coords[index++] + transYf;
          lastX = tc[2];
          lastY = tc[3];
          if (valid(lastX, lastY)) {
            if (skip) {
              tc[0] = closeCoord[0] = lastX;
              tc[1] = closeCoord[1] = lastY;
              subpathStarted = true;
              skip = false;
            } else {
              this.processLine(tc[0], tc[1], tc[2], tc[3], pi);
              tc[0] = lastX;
              tc[1] = lastY;
            }
          }
          break;
        case 2:
          if (index + 4 > maxCoords) return false;
          tc[2] = coords[index++] + transXf;
          tc[3] = coords[index++] + transYf;
          tc[4] = coords[index++] + transXf;
          tc[5] = coords[index++] + transYf;
          lastX = tc[4];
          lastY = tc[5];
          if (valid(lastX, lastY)) {
            if (skip) {
              tc[0] = closeCoord[0] = lastX;
              tc[1] = closeCoord[1] = lastY;
              subpathStarted = true;
              skip = false;
            } else {
              if (valid(tc[2], tc[3])) this.processQuad(tc, pi);
              else this.processLine(tc[0], tc[1], tc[4], tc[5], pi);
              tc[0] = lastX;
              tc[1] = lastY;
            }
          }
          break;
        case 3:
          if (index + 6 > maxCoords) return false;
          tc[2] = coords[index++] + transXf;
          tc[3] = coords[index++] + transYf;
          tc[4] = coords[index++] + transXf;
          tc[5] = coords[index++] + transYf;
          tc[6] = coords[index++] + transXf;
          tc[7] = coords[index++] + transYf;
          lastX = tc[6];
          lastY = tc[7];
          if (valid(lastX, lastY)) {
            if (skip) {
              tc[0] = closeCoord[0] = tc[6];
              tc[1] = closeCoord[1] = tc[7];
              subpathStarted = true;
              skip = false;
            } else {
              if (valid(tc[2], tc[3]) && valid(tc[4], tc[5])) this.processCubic(tc, pi);
              else this.processLine(tc[0], tc[1], tc[6], tc[7], pi);
              tc[0] = lastX;
              tc[1] = lastY;
            }
          }
          break;
        case 4:
          if (subpathStarted && !skip) {
            skip = false;
            if (tc[0] !== closeCoord[0] || tc[1] !== closeCoord[1]) {
              this.processLine(tc[0], tc[1], closeCoord[0], closeCoord[1], pi);
              tc[0] = closeCoord[0];
              tc[1] = closeCoord[1];
            }
            this.endSubPath();
          }
          break;
      }
    }
    if (subpathStarted && !skip) closeSubpath();
    return true;
  }
}

// ---- natives --------------------------------------------------------------

const STROKE_PURE = 2;
const PATH2D = "java/awt/geom/Path2D";

function pathLoop(fill: boolean) {
  return (t: any, [self, sg2d, sd, transX, transY, p2df]: any[]) => {
    const vm = t.vm;
    const strokeHint = sgInt(vm, sg2d, "strokeHint");
    const s = surfOf(t, sd);
    const types = vm.getField(p2df, PATH2D, "pointTypes") as JArray | null;
    const coordsArray = vm.getField(p2df, PATH2D + "$Float", "floatCoords") as JArray | null;
    if (coordsArray === null) throw new PendingThrow("java/lang/NullPointerException", "coordinates array");
    const numTypes = vm.getField(p2df, PATH2D, "numTypes") as number;
    const rule = vm.getField(p2df, PATH2D, "windingRule") as number;
    if (types === null || types.a.length < numTypes) throw new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", "types array");
    if (!s) return;
    const b = clipBounds(vm, vm.getField(sg2d, "sun/java2d/SunGraphics2D", "clipRegion"));
    if (!lockBounds(b, s)) return;
    const h = new Handler(s, b, sgInt(vm, sg2d, "pixel"), fill, strokeHint === STROKE_PURE, penOf(vm, self, sg2d));
    const coords = coordsArray.a as Float32Array;
    if (!h.processPath(transX, transY, coords, coords.length, types.a as Int8Array, numTypes)) {
      throw new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", "coords array");
    }
    if (fill) h.fillPolygon(rule !== 1);
  };
}

// ---- parallelograms -------------------------------------------------------

// PGRAM_MIN_MAX, non-AA; dv1 is a1 + b1 and dv2 is a2 + b2 as the C macro spells them
function pgramMinMax(v0: number, a1: number, b1: number, a2: number, b2: number): [number, number] {
  let vmin: number, vmax: number;
  if (a1 + b1 < 0) {
    vmin = v0 + a1 + b1;
    vmax = v0;
  } else {
    vmin = v0;
    vmax = v0 + a1 + b1;
  }
  if (a2 + b2 < 0) vmin += a2 + b2;
  else vmax += a2 + b2;
  return [toInt(Math.floor(vmin + 0.5)), toInt(Math.floor(vmax + 0.5))];
}

// PGRAM_INIT_X
const pgramInitX = (starty: number, x: number, y: number, slope: number) =>
  wrap(toLong(x + slope * (starty + 0.5 - y)) + (1n << 31n) - 1n);

// The solid FillParallelogram inner loop
function fillPgram(s: Surf, pixel: number, lox: number, loy: number, hix: number, hiy: number, leftx: bigint, dleftx: bigint, rightx: bigint, drightx: bigint) {
  while (loy < hiy) {
    let lx = Number(leftx >> 32n) | 0;
    let rx = Number(rightx >> 32n) | 0;
    if (lx < lox) lx = lox;
    if (rx > hix) rx = hix;
    let o = s.off + loy * s.scan + lx * s.ps;
    for (; lx < rx; lx++, o += s.ps) putPixel(s, o, pixel);
    leftx = wrap(leftx + dleftx);
    rightx = wrap(rightx + drightx);
    loy++;
  }
}

// SORT_PGRAM; returns the vectors, with the line widths swapped along when asked
function sortPgram(v: number[], lw?: number[]) {
  if (v[3] < 0) {
    v[0] += v[2];
    v[1] += v[3];
    v[2] = -v[2];
    v[3] = -v[3];
  }
  if (v[5] < 0) {
    v[0] += v[4];
    v[1] += v[5];
    v[4] = -v[4];
    v[5] = -v[5];
  }
  if (v[2] * v[5] > v[4] * v[3]) {
    let x = v[2];
    v[2] = v[4];
    v[4] = x;
    x = v[3];
    v[3] = v[5];
    v[5] = x;
    if (lw) {
      x = lw[0];
      lw[0] = lw[1];
      lw[1] = x;
    }
  }
}

function pgramBounds(t: any, sg2d: JObject, sd: JObject | null, ix1: number, iy1: number, ix2: number, iy2: number) {
  const vm = t.vm;
  const s = surfOf(t, sd);
  if (!s) return null;
  const b = clipBounds(vm, vm.getField(sg2d, "sun/java2d/SunGraphics2D", "clipRegion"));
  intersect(b, ix1, iy1, ix2, iy2);
  if (b.y2 <= b.y1 || b.x2 <= b.x1) return null;
  if (!lockBounds(b, s)) return null;
  return { s, b, pixel: sgInt(vm, sg2d, "pixel") };
}

function fillParallelogram(t: any, [, sg2d, sd, x0, y0, dx1, dy1, dx2, dy2]: any[]) {
  if ((dy1 === 0 && dx1 === 0) || (dy2 === 0 && dx2 === 0)) return;
  const v = [x0, y0, dx1, dy1, dx2, dy2];
  sortPgram(v);
  [x0, y0, dx1, dy1, dx2, dy2] = v;
  const [ix1, ix2] = pgramMinMax(x0, dx1, 0, dx2, 0);
  const iy1 = toInt(Math.floor(y0 + 0.5)), iy2 = toInt(Math.floor(y0 + dy1 + dy2 + 0.5));
  const r = pgramBounds(t, sg2d, sd, ix1, iy1, ix2, iy2);
  if (!r) return;
  const { s, b, pixel } = r;
  const lslope = dy1 === 0 ? 0 : dx1 / dy1, rslope = dy2 === 0 ? 0 : dx2 / dy2;
  const ldx = toLong(lslope), rdx = toLong(rslope);
  dx1 += x0;
  dy1 += y0;
  dx2 += x0;
  dy2 += y0;
  const cy1 = toInt(Math.floor(dy1 + 0.5)), cy2 = toInt(Math.floor(dy2 + 0.5));
  const fill = (loy: number, hiy: number, lx: bigint, ldxv: bigint, rx: bigint, rdxv: bigint) =>
    fillPgram(s, pixel, b.x1, loy, b.x2, hiy, lx, ldxv, rx, rdxv);
  const ymin = b.y1, ymax = b.y2;

  let loy = ymin, hiy = cy1 < cy2 ? cy1 : cy2;
  if (hiy > ymax) hiy = ymax;
  if (loy < hiy) fill(loy, hiy, pgramInitX(loy, x0, y0, lslope), ldx, pgramInitX(loy, x0, y0, rslope), rdx);

  if (cy1 < cy2) {
    loy = cy1;
    hiy = cy2;
    if (loy < ymin) loy = ymin;
    if (hiy > ymax) hiy = ymax;
    if (loy < hiy) fill(loy, hiy, pgramInitX(loy, dx1, dy1, rslope), rdx, pgramInitX(loy, x0, y0, rslope), rdx);
  } else if (cy2 < cy1) {
    loy = cy2;
    hiy = cy1;
    if (loy < ymin) loy = ymin;
    if (hiy > ymax) hiy = ymax;
    if (loy < hiy) fill(loy, hiy, pgramInitX(loy, x0, y0, lslope), ldx, pgramInitX(loy, dx2, dy2, lslope), ldx);
  }

  loy = cy1 > cy2 ? cy1 : cy2;
  if (loy < ymin) loy = ymin;
  hiy = ymax;
  if (loy < hiy) fill(loy, hiy, pgramInitX(loy, dx1, dy1, rslope), rdx, pgramInitX(loy, dx2, dy2, lslope), ldx);
}

interface PgramEdge {
  x0: number;
  y0: number;
  slope: number;
  dx: bigint;
  ystart: number;
  yend: number;
}

function storeEdge(x0: number, y0: number, y1: number, slope: number, dx: bigint): PgramEdge {
  return { x0, y0, slope, dx, ystart: toInt(Math.floor(y0 + 0.5)), yend: toInt(Math.floor(y1 + 0.5)) };
}

function storePgram(edges: PgramEdge[], lt: number, rt: number, X0: number, Y0: number, dX1: number, dY1: number, dX2: number, dY2: number,
  slope1: number, slope2: number, deltaX1: bigint, deltaX2: bigint) {
  edges[lt] = storeEdge(X0, Y0, Y0 + dY1, slope1, deltaX1);
  edges[rt] = storeEdge(X0, Y0, Y0 + dY2, slope2, deltaX2);
  edges[lt + 1] = storeEdge(X0 + dX1, Y0 + dY1, Y0 + dY1 + dY2, slope2, deltaX2);
  edges[rt + 1] = storeEdge(X0 + dX2, Y0 + dY2, Y0 + dY1 + dY2, slope1, deltaX1);
}

function drawParallelogram(t: any, [, sg2d, sd, x0, y0, dx1, dy1, dx2, dy2, lw1, lw2]: any[]) {
  const v = [x0, y0, dx1, dy1, dx2, dy2], lw = [lw1, lw2];
  sortPgram(v, lw);
  [x0, y0, dx1, dy1, dx2, dy2] = v;
  [lw1, lw2] = lw;
  const ldx1 = dx1 * lw1, ldy1 = dy1 * lw1, ldx2 = dx2 * lw2, ldy2 = dy2 * lw2;
  const ox0 = x0 - (ldx1 + ldx2) / 2, oy0 = y0 - (ldy1 + ldy2) / 2;
  const [ix1, ix2] = pgramMinMax(ox0, dx1, ldx1, dx2, ldx2);
  const iy1 = toInt(Math.floor(oy0 + 0.5)), iy2 = toInt(Math.floor(oy0 + dy1 + ldy1 + dy2 + ldy2 + 0.5));
  const r = pgramBounds(t, sg2d, sd, ix1, iy1, ix2, iy2);
  if (!r) return;
  const { s, b, pixel } = r;
  const lslope = dy1 === 0 ? 0 : dx1 / dy1, rslope = dy2 === 0 ? 0 : dx2 / dy2;
  const ldx = toLong(lslope), rdx = toLong(rslope);
  const edges: PgramEdge[] = [];
  let numedges: number;
  if (lw1 < 1 && lw2 < 1) {
    lw1 = Math.sqrt(ldx1 * ldx1 + ldy1 * ldy1);
    lw2 = Math.sqrt(ldx2 * ldx2 + ldy2 * ldy2);
    if (lw1 <= 1.0001 && lw2 <= 1.0001) {
      dx1 += x0;
      dy1 += y0;
      const x3 = dx1 + dx2, y3 = dy1 + dy2;
      dx2 += x0;
      dy2 += y0;
      const edge = (X1: number, Y1: number, X2: number, Y2: number) =>
        processLine(s, b, pixel, toInt(Math.floor(X1)), toInt(Math.floor(Y1)), toInt(Math.floor(X2)), toInt(Math.floor(Y2)), 1);
      edge(x0, y0, dx1, dy1);
      edge(dx1, dy1, x3, y3);
      edge(x3, y3, dx2, dy2);
      edge(dx2, dy2, x0, y0);
      return;
    }
    storePgram(edges, 2, 4, ox0 + ldx1 + ldx2, oy0 + ldy1 + ldy2, dx1 - ldx1, dy1 - ldy1, dx2 - ldx2, dy2 - ldy2, lslope, rslope, ldx, rdx);
    numedges = 8;
  } else {
    numedges = 4;
  }
  storePgram(edges, 0, numedges - 2, ox0, oy0, dx1 + ldx1, dy1 + ldy1, dx2 + ldx2, dy2 + ldy2, lslope, rslope, ldx, rdx);

  const ymax = b.y2;
  let loy = edges[0].ystart;
  if (loy < b.y1) loy = b.y1;
  while (loy < ymax) {
    const active: PgramEdge[] = [];
    let hiy = ymax;
    for (let cur = 0; cur < numedges; cur++) {
      const e = edges[cur];
      if (loy < e.yend) {
        if (loy < e.ystart) {
          if (hiy > e.ystart) hiy = e.ystart;
        } else {
          active.push(e);
          if (hiy > e.yend) hiy = e.yend;
        }
      }
    }
    for (let cur = 0; cur < active.length; cur += 2) {
      const l = active[cur], rr = active[cur + 1];
      fillPgram(s, pixel, b.x1, loy, b.x2, hiy, pgramInitX(loy, l.x0, l.y0, l.slope), l.dx, pgramInitX(loy, rr.x0, rr.y0, rr.slope), rr.dx);
    }
    loy = hiy;
  }
}

export const natives: Natives = {
  "sun/java2d/loops/FillPath.FillPath": pathLoop(true),
  "sun/java2d/loops/DrawPath.DrawPath": pathLoop(false),
  "sun/java2d/loops/FillParallelogram.FillParallelogram": fillParallelogram,
  "sun/java2d/loops/DrawParallelogram.DrawParallelogram": drawParallelogram,
};
