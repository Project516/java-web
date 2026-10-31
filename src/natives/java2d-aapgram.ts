// Port of the antialiased parallelogram part of libawt's MaskFill.c
// (FillAAPgram, DrawAAPgram) and ParallelogramUtils.h. They drive the
// primitive's own maskfill loop with a row mask, as the C does. Double math
// stays double and the accumulation buffer is float, so pixels match HotSpot.

import type { JObject } from "../runtime.ts";
import type { JThread } from "../thread.ts";
import type { Natives } from "./util.ts";
import { fmts } from "./java2d-loops.ts";
import type { Ctx as LoopCtx, MaskFillFn, Surf } from "./java2d-loops.ts";
import { clipBounds, compOf, intersect, lockBounds, primOf, sgInt, surfOf } from "./java2d-surface.ts";
import type { Bounds } from "./java2d-surface.ts";

const MASK_BUF_LEN = 1024;
const MIN_DELTA = 1.0 / 256.0;
const localMask = new Uint8Array(MASK_BUF_LEN);
const localAccum = new Float32Array(MASK_BUF_LEN + 2);

// C (jint) cast of a double, saturating as the JVM and aarch64 do
function d2i(v: number): number {
  if (v !== v) return 0;
  if (v >= 2147483647) return 2147483647;
  if (v <= -2147483648) return -2147483648;
  return v | 0;
}

// (unsigned char) of a double as x64 libawt does it: cvttsd2si to int32
// (INT_MIN when out of range or NaN), then the low byte
function dblToMask(v: number): number {
  v *= 255.9999;
  return v >= -2147483648 && v < 2147483648 ? v & 0xff : 0;
}

interface Ctx {
  s: Surf;
  fn: MaskFillFn;
  ps: number;
  scan: number;
  color: number;
  rule: number;
  mask: Uint8Array;
  b: Bounds;
  // the fills dither from the raster bounds, wherever they draw
  at: LoopCtx;
}

function fillRow(c: Ctx, o: number, mask: Uint8Array | null, w: number, h: number) {
  c.fn(c.s, o, mask, 0, 0, w, h, c.color, c.rule, c.at);
}

function fillAARect(c: Ctx, dst: number, x1: number, y1: number, x2: number, y2: number) {
  const cx1 = c.b.x1, cx2 = c.b.x2, cy2 = c.b.y2;
  let cy1 = c.b.y1;
  const pMask = c.mask;
  const rx1 = d2i(Math.ceil(x1));
  const ry1 = d2i(Math.ceil(y1));
  let rx2 = d2i(Math.floor(x2));
  let ry2 = d2i(Math.floor(y2));
  const width = cx2 - cx1;
  x1 = rx1 - x1;
  y1 = ry1 - y1;
  x2 = x2 - rx2;
  y2 = y2 - ry2;
  if (ry2 < ry1) {
    y1 = y1 + y2 - 1.0;
    ry2 = cy2;
  }
  if (rx2 < rx1) {
    x1 = x1 + x2 - 1.0;
    rx2 = cx2;
  }
  if (cy1 < ry1) {
    pMask.fill(dblToMask(y1), 0, width);
    if (cx1 < rx1) pMask[0] = dblToMask(y1 * x1);
    if (cx2 > rx2) pMask[width - 1] = dblToMask(y1 * x2);
    fillRow(c, dst, pMask, width, 1);
    dst += c.scan;
    cy1++;
  }
  if (cy1 < ry2 && cy1 < cy2) {
    const midh = (ry2 < cy2 ? ry2 : cy2) - cy1;
    let midx = cx1;
    let pMid = dst;
    if (midx < rx1) {
      pMask[0] = dblToMask(x1);
      fillRow(c, pMid, pMask, 1, midh);
      pMid += c.ps;
      midx++;
    }
    if (midx < rx2 && midx < cx2) {
      const midw = (rx2 < cx2 ? rx2 : cx2) - midx;
      fillRow(c, pMid, null, midw, midh);
      pMid += midw * c.ps;
      midx += midw;
    }
    if (midx < cx2) {
      pMask[0] = dblToMask(x2);
      fillRow(c, pMid, pMask, 1, midh);
    }
    cy1 += midh;
    dst += midh * c.scan;
  }
  if (cy1 < cy2) {
    pMask.fill(dblToMask(y2), 0, width);
    if (cx1 < rx1) pMask[0] = dblToMask(y2 * x1);
    if (cx2 > rx2) pMask[width - 1] = dblToMask(y2 * x2);
    fillRow(c, dst, pMask, width, 1);
  }
}

class Edge {
  x = 0;
  y = 0;
  xbot = 0;
  ybot = 0;
  xnexty = 0;
  ynextx = 0;
  xnextx = 0;
  linedx = 0;
  celldx = 0;
  celldy = 0;
  isTrailing = false;
}

function storeEdge(e: Edge, x: number, y: number, dx: number, dy: number, cx1: number, cy1: number, cx2: number, cy2: number, isTrailing: boolean): boolean {
  const xbot = x + dx;
  const ybot = y + dy;
  let ret: boolean;
  e.x = x;
  e.y = y;
  e.xbot = xbot;
  e.ybot = ybot;
  if (dy > MIN_DELTA && ybot > cy1 && y < cy2 && xbot === xbot && (x < cx2 || xbot < cx2)) {
    if (dx < -MIN_DELTA || dx > MIN_DELTA) {
      const linedx = dx / dy;
      const celldy = dy / dx;
      let nextx: number;
      if (y < cy1) {
        e.x = x = x + (cy1 - y) * linedx;
        e.y = y = cy1;
      }
      e.linedx = linedx;
      if (dx < 0) {
        e.celldx = -1.0;
        e.celldy = -celldy;
        e.xnextx = nextx = Math.ceil(x) - 1.0;
      } else {
        e.celldx = +1.0;
        e.celldy = celldy;
        e.xnextx = nextx = Math.floor(x) + 1.0;
      }
      e.ynextx = y + (nextx - x) * celldy;
      e.xnexty = x + ((Math.floor(y) + 1) - y) * linedx;
    } else {
      if (y < cy1) e.y = y = cy1;
      e.xbot = x;
      e.linedx = 0.0;
      e.celldx = 0.0;
      e.celldy = 1.0;
      e.xnextx = x;
      e.xnexty = x;
      e.ynextx = ybot;
    }
    ret = true;
  } else {
    e.ybot = y;
    e.linedx = dx;
    e.celldx = dx;
    e.celldy = 0.0;
    e.xnextx = xbot;
    e.xnexty = xbot;
    e.ynextx = y;
    ret = false;
  }
  e.isTrailing = isTrailing;
  return ret;
}

function storePgram(edges: Edge[], left: number, right: number, x: number, y: number, dx1: number, dy1: number, dx2: number, dy2: number,
  cx1: number, cy1: number, cx2: number, cy2: number, inverted: boolean): boolean {
  let ret = false;
  ret = storeEdge(edges[left], x, y, dx1, dy1, cx1, cy1, cx2, cy2, inverted) || ret;
  ret = storeEdge(edges[left + 1], x + dx1, y + dy1, dx2, dy2, cx1, cy1, cx2, cy2, inverted) || ret;
  ret = storeEdge(edges[right], x, y, dx2, dy2, cx1, cy1, cx2, cy2, !inverted) || ret;
  ret = storeEdge(edges[right + 1], x + dx2, y + dy2, dx1, dy1, cx1, cy1, cx2, cy2, !inverted) || ret;
  return ret;
}

// Range of accum entries touched, as the C macros' IMIN and IMAX
let imin = 0;
let imax = 0;

function insertAccum(acc: Float32Array, x0: number, y0: number, x1: number, y1: number, cx1: number, cx2: number, mult: number) {
  const xmid = (x0 + x1) * 0.5;
  if (xmid < cx2) {
    const sliceh = y1 - y0;
    let i: number;
    let slicearea: number;
    if (xmid < cx1) {
      i = 0;
      slicearea = sliceh;
    } else {
      const xpos = Math.floor(xmid);
      i = d2i(xpos) - cx1;
      slicearea = (xpos + 1 - xmid) * sliceh;
    }
    if (imin > i) imin = i;
    acc[i] += Math.fround(mult * slicearea);
    i++;
    acc[i] += Math.fround(mult * (sliceh - slicearea));
    i++;
    if (imax < i) imax = i;
  }
}

function accumEdge(e: Edge, acc: Float32Array, cx1: number, cy1: number, cx2: number, cy2: number) {
  let y = e.y;
  const dy = e.celldy;
  let ylast = e.ybot;
  if (ylast <= cy1 || y >= cy2 || dy === 0.0) return;
  let x = e.x;
  const dx = e.celldx;
  let xlast: number;
  if (ylast > cy2) {
    ylast = cy2;
    xlast = e.xnexty;
  } else {
    xlast = e.xbot;
  }
  let xnext = e.xnextx;
  let ynext = e.ynextx;
  const mult = e.isTrailing ? -1.0 : 1.0;
  while (ynext <= ylast) {
    insertAccum(acc, x, y, xnext, ynext, cx1, cx2, mult);
    x = xnext;
    y = ynext;
    xnext += dx;
    ynext += dy;
  }
  e.ynextx = ynext;
  e.xnextx = xnext;
  insertAccum(acc, x, y, xlast, ylast, cx1, cx2, mult);
  e.x = xlast;
  e.y = ylast;
  e.xnexty = xlast + e.linedx;
}

function newAccum(width: number): Float32Array {
  if (width > MASK_BUF_LEN) return new Float32Array(width + 2);
  localAccum.fill(0, 0, width + 2);
  return localAccum;
}

function fillAAPgram(c: Ctx, dst: number, x1: number, y1: number, dx1: number, dy1: number, dx2: number, dy2: number) {
  const cx1 = c.b.x1, cx2 = c.b.x2, cy2 = c.b.y2;
  let cy1 = c.b.y1;
  const width = cx2 - cx1;
  const edges = Array.from({ length: 4 }, () => new Edge());
  if (!storePgram(edges, 0, 2, x1, y1, dx1, dy1, dx2, dy2, cx1, cy1, cx2, cy2, false)) return;
  const pAccum = newAccum(width);
  const pMask = c.mask;

  while (cy1 < cy2) {
    imin = width + 2;
    imax = 0;
    accumEdge(edges[0], pAccum, cx1, cy1, cx2, cy1 + 1);
    accumEdge(edges[1], pAccum, cx1, cy1, cx2, cy1 + 1);
    const lmin = imin;
    let lmax = imax;
    imin = width + 2;
    imax = 0;
    accumEdge(edges[2], pAccum, cx1, cy1, cx2, cy1 + 1);
    accumEdge(edges[3], pAccum, cx1, cy1, cx2, cy1 + 1);
    const rmin = imin;
    let rmax = imax;
    if (lmax > width) lmax = width;
    if (rmax > width) rmax = width;
    if (rmin <= lmax) lmax = rmax;

    let x = lmin;
    let accum = 0.0;
    let moff = 0;
    let lastcov = 0;
    while (x < lmax) {
      accum += pAccum[x];
      pAccum[x] = 0.0;
      pMask[moff++] = lastcov = dblToMask(accum);
      x++;
    }
    if (lastcov === 0xff) {
      if (moff > 0) {
        fillRow(c, dst + (x - moff) * c.ps, pMask, moff, 1);
        moff = 0;
      }
      const endx = rmin < rmax ? rmin : width;
      if (x < endx) {
        fillRow(c, dst + x * c.ps, null, endx - x, 1);
        x = endx;
      }
    } else if (lastcov > 0 && rmin >= rmax) {
      rmax = width;
    }
    while (x < rmax) {
      accum += pAccum[x];
      pAccum[x] = 0.0;
      pMask[moff++] = dblToMask(accum);
      x++;
    }
    if (moff > 0) fillRow(c, dst + (x - moff) * c.ps, pMask, moff, 1);
    dst += c.scan;
    cy1++;
  }
}

function drawAAPgram(c: Ctx, dst: number, ox0: number, oy0: number, dx1: number, dy1: number, dx2: number, dy2: number,
  ldx1: number, ldy1: number, ldx2: number, ldy2: number) {
  const cx1 = c.b.x1, cx2 = c.b.x2, cy2 = c.b.y2;
  let cy1 = c.b.y1;
  const width = cx2 - cx1;
  const edges = Array.from({ length: 8 }, () => new Edge());
  if (!storePgram(edges, 0, 6, ox0, oy0, dx1 + ldx1, dy1 + ldy1, dx2 + ldx2, dy2 + ldy2, cx1, cy1, cx2, cy2, false)) return;
  storePgram(edges, 2, 4, ox0 + ldx1 + ldx2, oy0 + ldy1 + ldy2, dx1 - ldx1, dy1 - ldy1, dx2 - ldx2, dy2 - ldy2, cx1, cy1, cx2, cy2, true);
  const pAccum = newAccum(width);
  const pMask = c.mask;

  while (cy1 < cy2) {
    imin = width + 2;
    imax = 0;
    for (let k = 0; k < 4; k++) accumEdge(edges[k], pAccum, cx1, cy1, cx2, cy1 + 1);
    const lmin = imin;
    let lmax = imax;
    imin = width + 2;
    imax = 0;
    for (let k = 4; k < 8; k++) accumEdge(edges[k], pAccum, cx1, cy1, cx2, cy1 + 1);
    const rmin = imin;
    let rmax = imax;
    if (lmax > width) lmax = width;
    if (rmax > width) rmax = width;
    if (rmin <= lmax) lmax = rmax;

    let x = lmin;
    let accum = 0.0;
    let moff = 0;
    let lastcov = 0;
    while (x < lmax) {
      accum += pAccum[x];
      pAccum[x] = 0.0;
      pMask[moff++] = lastcov = dblToMask(accum);
      x++;
    }
    if (lastcov === 0 || lastcov === 0xff) {
      if (moff > 0) {
        fillRow(c, dst + (x - moff) * c.ps, pMask, moff, 1);
        moff = 0;
      }
      const endx = rmin < rmax ? rmin : width;
      if (x < endx) {
        if (lastcov === 0xff) fillRow(c, dst + x * c.ps, null, endx - x, 1);
        x = endx;
      }
    } else if (rmin >= rmax) {
      rmax = width;
    }
    while (x < rmax) {
      accum += pAccum[x];
      pAccum[x] = 0.0;
      pMask[moff++] = lastcov = dblToMask(accum);
      x++;
    }
    if (moff > 0) fillRow(c, dst + (x - moff) * c.ps, pMask, moff, 1);
    if (lastcov === 0xff && x < width) fillRow(c, dst + x * c.ps, null, width - x, 1);
    dst += c.scan;
    cy1++;
  }
}

// The part of the C prologue both natives share: clip, lock and masks.
// Calls draw with the context and the offset of the first pixel.
function withContext(t: JThread, self: JObject, sg2d: JObject, sd: JObject | null, comp: JObject | null,
  ix1: number, iy1: number, ix2: number, iy2: number, draw: (c: Ctx, dst: number) => void) {
  const vm = t.vm;
  const prim = primOf(vm, self);
  const s = surfOf(t, sd);
  if (!s) return;
  const b = clipBounds(vm, vm.getField(sg2d, "sun/java2d/SunGraphics2D", "clipRegion"));
  intersect(b, ix1, iy1, ix2, iy2);
  if (b.y2 <= b.y1 || b.x2 <= b.x1) return;
  if (!lockBounds(b, s)) return;
  const width = b.x2 - b.x1;
  const f = fmts[prim.dst], ps = f.packed ? 0 : f.ps;
  const c: Ctx = {
    s, fn: prim.fn as MaskFillFn, ps, scan: s.scan,
    color: sgInt(vm, sg2d, "eargb"), rule: compOf(vm, comp).rule,
    mask: width > MASK_BUF_LEN ? new Uint8Array(width) : localMask, b,
    at: { sx: 0, dx: b.x1, dy: b.y1, xor: 0, mask: 0 },
  };
  draw(c, s.off + b.y1 * s.scan + b.x1 * ps);
}

function sortPgram(v: number[], swapLw: boolean, lw: number[]) {
  // v = [x0, y0, dx1, dy1, dx2, dy2]
  if (v[3] < 0) {
    v[0] += v[2]; v[1] += v[3];
    v[2] = -v[2]; v[3] = -v[3];
  }
  if (v[5] < 0) {
    v[0] += v[4]; v[1] += v[5];
    v[4] = -v[4]; v[5] = -v[5];
  }
  if (v[2] * v[5] > v[4] * v[3]) {
    let t = v[2]; v[2] = v[4]; v[4] = t;
    t = v[3]; v[3] = v[5]; v[5] = t;
    if (swapLw) {
      t = lw[0]; lw[0] = lw[1]; lw[1] = t;
    }
  }
}

// PGRAM_MIN_MAX with AA set: [min, max] of the integer bounds on one axis
function minMax(v0: number, dv1: number, dv2: number): [number, number] {
  let vmin: number, vmax: number;
  if (dv1 < 0) {
    vmin = v0 + dv1;
    vmax = v0;
  } else {
    vmin = v0;
    vmax = v0 + dv1;
  }
  if (dv2 < 0) vmin += dv2;
  else vmax += dv2;
  return [d2i(Math.floor(vmin)), d2i(Math.ceil(vmax))];
}

function fillAAPgramNative(t: JThread, self: JObject, sg2d: JObject, sd: JObject | null, comp: JObject | null,
  x0: number, y0: number, dx1: number, dy1: number, dx2: number, dy2: number) {
  if ((dy1 === 0 && dx1 === 0) || (dy2 === 0 && dx2 === 0)) return;
  const v = [x0, y0, dx1, dy1, dx2, dy2];
  sortPgram(v, false, []);
  [x0, y0, dx1, dy1, dx2, dy2] = v;
  const [ix1, ix2] = minMax(x0, dx1, dx2);
  const iy1 = d2i(Math.floor(y0));
  const iy2 = d2i(Math.ceil(y0 + dy1 + dy2));
  withContext(t, self, sg2d, sd, comp, ix1, iy1, ix2, iy2, (c, dst) => {
    if (dy1 === 0 && dx2 === 0) {
      if (dx1 < 0) {
        x0 += dx1;
        dx1 = -dx1;
      }
      fillAARect(c, dst, x0, y0, x0 + dx1, y0 + dy2);
    } else if (dx1 === 0 && dy2 === 0) {
      if (dx2 < 0) {
        x0 += dx2;
        dx2 = -dx2;
      }
      fillAARect(c, dst, x0, y0, x0 + dx2, y0 + dy1);
    } else {
      fillAAPgram(c, dst, x0, y0, dx1, dy1, dx2, dy2);
    }
  });
}

export const natives: Natives = {
  "sun/java2d/loops/MaskFill.FillAAPgram"(t, [self, sg2d, sd, comp, x0, y0, dx1, dy1, dx2, dy2]) {
    fillAAPgramNative(t, self, sg2d, sd, comp, x0, y0, dx1, dy1, dx2, dy2);
  },

  "sun/java2d/loops/MaskFill.DrawAAPgram"(t, [self, sg2d, sd, comp, x0, y0, dx1, dy1, dx2, dy2, lw1, lw2]) {
    if ((dy1 === 0 && dx1 === 0) || (dy2 === 0 && dx2 === 0)) return;
    const v = [x0, y0, dx1, dy1, dx2, dy2];
    const lw = [lw1, lw2];
    sortPgram(v, true, lw);
    [x0, y0, dx1, dy1, dx2, dy2] = v;
    [lw1, lw2] = lw;
    const ldx1 = dx1 * lw1;
    const ldy1 = dy1 * lw1;
    const ldx2 = dx2 * lw2;
    const ldy2 = dy2 * lw2;
    const ox0 = x0 - (ldx1 + ldx2) / 2.0;
    const oy0 = y0 - (ldy1 + ldy2) / 2.0;
    if (lw1 >= 1.0 || lw2 >= 1.0) {
      fillAAPgramNative(t, self, sg2d, sd, comp, ox0, oy0, dx1 + ldx1, dy1 + ldy1, dx2 + ldx2, dy2 + ldy2);
      return;
    }
    const [ix1, ix2] = minMax(ox0, dx1 + ldx1, dx2 + ldx2);
    const iy1 = d2i(Math.floor(oy0));
    const iy2 = d2i(Math.ceil(oy0 + dy1 + ldy1 + dy2 + ldy2));
    withContext(t, self, sg2d, sd, comp, ix1, iy1, ix2, iy2, (c, dst) => {
      drawAAPgram(c, dst, ox0, oy0, dx1, dy1, dx2, dy2, ldx1, ldy1, ldx2, ldy2);
    });
  },
};
