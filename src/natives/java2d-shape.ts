// Ports of libawt's ShapeSpanIterator.c and SpanClipRenderer.c. C jfloat
// arithmetic is 32-bit, so every float result goes through Math.fround.

import type { JArray, JObject } from "../runtime.ts";
import { PendingThrow } from "../thread.ts";
import type { JThread } from "../thread.ts";
import type { Natives } from "./util.ts";

const SSI = "sun/java2d/pipe/ShapeSpanIterator";
const SCR = "sun/java2d/pipe/SpanClipRenderer";

export interface SpanIter {
  getPathBox(box: Int32Array): void;
  intersectClipBox(x1: number, y1: number, x2: number, y2: number): void;
  nextSpan(out: Int32Array): boolean;
  skipDownTo(y: number): void;
}

const STATE_INIT = 0, STATE_HAVE_CLIP = 1, STATE_HAVE_RULE = 2, STATE_PATH_DONE = 3, STATE_SPAN_STARTED = 4;
const SEG_CURX = 0, SEG_CURY = 1, SEG_LASTY = 2, SEG_ERROR = 3, SEG_BUMPX = 4, SEG_BUMPERR = 5, SEG_WIND = 6, SEG_STRIDE = 7;
const SUBDIVIDE_MAX = 10, ERRSTEP_MAX = 0x7fffffff, OUT_XLO = 1, OUT_XHI = 2, OUT_YLO = 4, OUT_YHI = 8;
const F = Math.fround;

// C (jint) cast of a double, as the JVM and aarch64 do it
function d2i(v: number): number {
  if (v !== v) return 0;
  if (v >= 2147483647) return 2147483647;
  if (v <= -2147483648) return -2147483648;
  return v | 0;
}

const fract = (f: number) => d2i(f * ERRSTEP_MAX);

// distance of (px,py) from the segment, squared, all in float
function ptSegDistSq(x0: number, y0: number, x1: number, y1: number, px: number, py: number): number {
  x1 = F(x1 - x0);
  y1 = F(y1 - y0);
  px = F(px - x0);
  py = F(py - y0);
  let dotprod = F(F(px * x1) + F(py * y1));
  let projlenSq: number;
  if (dotprod <= 0) {
    projlenSq = 0;
  } else {
    px = F(x1 - px);
    py = F(y1 - py);
    dotprod = F(F(px * x1) + F(py * y1));
    if (dotprod <= 0) projlenSq = 0;
    else projlenSq = F(F(dotprod * dotprod) / F(F(x1 * x1) + F(y1 * y1)));
  }
  return F(F(F(px * px) + F(py * py)) - projlenSq);
}

// steps * a and err + steps * b, as 64-bit C arithmetic truncated like (jint)
function stepsLow(steps: number, a: number): number {
  const p = steps * a;
  if (Math.abs(p) < 9007199254740992) return p | 0;
  return Number(BigInt.asIntN(32, BigInt(steps) * BigInt(a)));
}

function stepsErr(steps: number, err: number, b: number): [number, number] {
  const m = steps * b;
  if (Math.abs(m) < 4503599627370496) {
    const s = err + m;
    return [Math.floor(s / 2147483648) | 0, s | 0];
  }
  const s = BigInt(err) + BigInt(steps) * BigInt(b);
  return [Number(BigInt.asIntN(32, s >> 31n)), Number(BigInt.asIntN(32, s))];
}

class Path implements SpanIter {
  state = STATE_INIT;
  evenodd = false;
  first = true;
  adjust: boolean;

  lox = 0; loy = 0; hix = 0; hiy = 0;
  curx = 0; cury = 0; movx = 0; movy = 0;
  adjx = 0; adjy = 0;
  pathlox = 0; pathloy = 0; pathhix = 0; pathhiy = 0;

  seg = new Int32Array(20 * SEG_STRIDE);
  numSegments = 0;
  table: Int32Array = new Int32Array(0);
  lowSegment = 0; curSegment = 0; hiSegment = 0;
  scratch = new Int32Array(4);

  constructor(adjust: boolean) {
    this.adjust = adjust;
  }

  boxPoint(x: number, y: number) {
    if (this.first) {
      this.pathlox = this.pathhix = x;
      this.pathloy = this.pathhiy = y;
      this.first = false;
    } else {
      if (this.pathlox > x) this.pathlox = x;
      if (this.pathloy > y) this.pathloy = y;
      if (this.pathhix < x) this.pathhix = x;
      if (this.pathhiy < y) this.pathhiy = y;
    }
  }

  moveTo(x0: number, y0: number) {
    this.close();
    if (this.adjust) {
      const nx = F(Math.floor(F(x0 + 0.25)) + 0.25), ny = F(Math.floor(F(y0 + 0.25)) + 0.25);
      this.adjx = F(nx - x0);
      this.adjy = F(ny - y0);
      x0 = nx;
      y0 = ny;
    }
    this.movx = x0;
    this.movy = y0;
    this.boxPoint(x0, y0);
    this.curx = x0;
    this.cury = y0;
  }

  lineTo(x1: number, y1: number) {
    if (this.adjust) {
      const nx = F(Math.floor(F(x1 + 0.25)) + 0.25), ny = F(Math.floor(F(y1 + 0.25)) + 0.25);
      this.adjx = F(nx - x1);
      this.adjy = F(ny - y1);
      x1 = nx;
      y1 = ny;
    }
    this.subdivideLine(this.curx, this.cury, x1, y1);
    this.boxPoint(x1, y1);
    this.curx = x1;
    this.cury = y1;
  }

  quadTo(x1: number, y1: number, x2: number, y2: number) {
    if (this.adjust) {
      const nx = F(Math.floor(F(x2 + 0.25)) + 0.25), ny = F(Math.floor(F(y2 + 0.25)) + 0.25);
      const newadjx = F(nx - x2), newadjy = F(ny - y2);
      x2 = nx;
      y2 = ny;
      // the C adds newadjy to both control point axes
      x1 = F(x1 + F(F(this.adjx + newadjy) / 2));
      y1 = F(y1 + F(F(this.adjy + newadjy) / 2));
      this.adjx = newadjx;
      this.adjy = newadjy;
    }
    this.subdivideQuad(0, this.curx, this.cury, x1, y1, x2, y2);
    this.boxPoint(x1, y1);
    this.boxPoint(x2, y2);
    this.curx = x2;
    this.cury = y2;
  }

  cubicTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    if (this.adjust) {
      const nx = F(Math.floor(F(x3 + 0.25)) + 0.25), ny = F(Math.floor(F(y3 + 0.25)) + 0.25);
      const newadjx = F(nx - x3), newadjy = F(ny - y3);
      x3 = nx;
      y3 = ny;
      x1 = F(x1 + this.adjx);
      y1 = F(y1 + this.adjy);
      x2 = F(x2 + newadjx);
      y2 = F(y2 + newadjy);
      this.adjx = newadjx;
      this.adjy = newadjy;
    }
    this.subdivideCubic(0, this.curx, this.cury, x1, y1, x2, y2, x3, y3);
    this.boxPoint(x1, y1);
    this.boxPoint(x2, y2);
    this.boxPoint(x3, y3);
    this.curx = x3;
    this.cury = y3;
  }

  close() {
    if (this.curx !== this.movx || this.cury !== this.movy) {
      this.subdivideLine(this.curx, this.cury, this.movx, this.movy);
      this.curx = this.movx;
      this.cury = this.movy;
    }
  }

  endPath() {
    this.close();
    this.state = STATE_PATH_DONE;
  }

  appendSegment(x0: number, y0: number, x1: number, y1: number) {
    let windDir: number;
    if (y0 > y1) {
      let t = x0; x0 = x1; x1 = t;
      t = y0; y0 = y1; y1 = t;
      windDir = -1;
    } else {
      windDir = 1;
    }
    const istarty = d2i(Math.ceil(F(y0 - 0.5)));
    const ilasty = d2i(Math.ceil(F(y1 - 0.5)));
    if (istarty >= ilasty || istarty >= this.hiy || ilasty <= this.loy) return;

    if ((this.numSegments + 1) * SEG_STRIDE > this.seg.length) {
      const grown = new Int32Array(this.seg.length * 2);
      grown.set(this.seg);
      this.seg = grown;
    }

    const dx = F(x1 - x0), dy = F(y1 - y0);
    const slope = F(dx / dy);
    const ystartbump = F(F(F(istarty) + 0.5) - y0);
    x0 = F(x0 + F(F(ystartbump * dx) / dy));
    const istartx = d2i(Math.ceil(F(x0 - 0.5)));
    const fl = Math.floor(slope);
    const bumpx = d2i(fl);
    const bumperr = fract(slope - fl);
    const error = fract(F(x0 - F(F(istartx) - 0.5)));

    const b = this.numSegments++ * SEG_STRIDE, s = this.seg;
    s[b + SEG_CURX] = istartx;
    s[b + SEG_CURY] = istarty;
    s[b + SEG_LASTY] = ilasty;
    s[b + SEG_ERROR] = error;
    s[b + SEG_BUMPX] = bumpx;
    s[b + SEG_BUMPERR] = bumperr;
    s[b + SEG_WIND] = windDir;
  }

  subdivideLine(x0: number, y0: number, x1: number, y1: number) {
    const minx = x0 < x1 ? x0 : x1, maxx = x0 < x1 ? x1 : x0;
    const miny = y0 < y1 ? y0 : y1, maxy = y0 < y1 ? y1 : y0;
    if (maxy <= F(this.loy) || miny >= F(this.hiy) || minx >= F(this.hix)) return;
    if (maxx <= F(this.lox)) {
      this.appendSegment(maxx, y0, maxx, y1);
      return;
    }
    this.appendSegment(x0, y0, x1, y1);
  }

  subdivideQuad(level: number, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) {
    const [minx, maxx] = minmax3(x0, x1, x2);
    const [miny, maxy] = minmax3(y0, y1, y2);
    if (maxy <= F(this.loy) || miny >= F(this.hiy) || minx >= F(this.hix)) return;
    if (maxx <= F(this.lox)) {
      this.appendSegment(maxx, y0, maxx, y2);
      return;
    }
    if (level < SUBDIVIDE_MAX && ptSegDistSq(x0, y0, x2, y2, x1, y1) > 1) {
      const cx1 = F(F(x0 + x1) / 2), cx2 = F(F(x1 + x2) / 2);
      x1 = F(F(cx1 + cx2) / 2);
      const cy1 = F(F(y0 + y1) / 2), cy2 = F(F(y1 + y2) / 2);
      y1 = F(F(cy1 + cy2) / 2);
      level++;
      this.subdivideQuad(level, x0, y0, cx1, cy1, x1, y1);
      this.subdivideQuad(level, x1, y1, cx2, cy2, x2, y2);
      return;
    }
    this.appendSegment(x0, y0, x2, y2);
  }

  subdivideCubic(level: number, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    const [minx, maxx] = minmax4(x0, x1, x2, x3);
    const [miny, maxy] = minmax4(y0, y1, y2, y3);
    if (maxy <= F(this.loy) || miny >= F(this.hiy) || minx >= F(this.hix)) return;
    if (maxx <= F(this.lox)) {
      this.appendSegment(maxx, y0, maxx, y3);
      return;
    }
    if (level < SUBDIVIDE_MAX && (ptSegDistSq(x0, y0, x3, y3, x1, y1) > 1 || ptSegDistSq(x0, y0, x3, y3, x2, y2) > 1)) {
      let ctrx = F(F(x1 + x2) / 2);
      x1 = F(F(x0 + x1) / 2);
      x2 = F(F(x2 + x3) / 2);
      const cx12 = F(F(x1 + ctrx) / 2), cx21 = F(F(ctrx + x2) / 2);
      ctrx = F(F(cx12 + cx21) / 2);

      let ctry = F(F(y1 + y2) / 2);
      y1 = F(F(y0 + y1) / 2);
      y2 = F(F(y2 + y3) / 2);
      const cy12 = F(F(y1 + ctry) / 2), cy21 = F(F(ctry + y2) / 2);
      ctry = F(F(cy12 + cy21) / 2);

      level++;
      this.subdivideCubic(level, x0, y0, x1, y1, cx12, cy12, ctrx, ctry);
      this.subdivideCubic(level, ctrx, ctry, cx21, cy21, x2, y2, x3, y3);
      return;
    }
    this.appendSegment(x0, y0, x3, y3);
  }

  appendPoly(xs: Int32Array, ys: Int32Array, n: number, ixoff: number, iyoff: number) {
    let xoff = F(ixoff), yoff = F(iyoff);
    if (this.adjust) {
      xoff = F(xoff + 0.25);
      yoff = F(yoff + 0.25);
    }
    if (n > 0) {
      let x = F(F(xs[0]) + xoff), y = F(F(ys[0]) + yoff);
      let outc0 = this.outcodes(x, y);
      this.movx = this.curx = x;
      this.movy = this.cury = y;
      this.pathlox = this.pathhix = x;
      this.pathloy = this.pathhiy = y;
      this.first = false;
      for (let i = 1; i < n; i++) {
        x = F(F(xs[i]) + xoff);
        y = F(F(ys[i]) + yoff);
        if (y === this.cury) {
          if (x !== this.curx) {
            outc0 = this.outcodes(x, y);
            this.curx = x;
            if (this.pathlox > x) this.pathlox = x;
            if (this.pathhix < x) this.pathhix = x;
          }
          continue;
        }
        const outc1 = this.outcodes(x, y);
        outc0 &= outc1;
        if (outc0 === 0) this.appendSegment(this.curx, this.cury, x, y);
        else if (outc0 === OUT_XLO) this.appendSegment(F(this.lox), this.cury, F(this.lox), y);
        if (this.pathlox > x) this.pathlox = x;
        if (this.pathloy > y) this.pathloy = y;
        if (this.pathhix < x) this.pathhix = x;
        if (this.pathhiy < y) this.pathhiy = y;
        outc0 = outc1;
        this.curx = x;
        this.cury = y;
      }
    }
    this.endPath();
  }

  outcodes(x: number, y: number): number {
    let c: number;
    if (y <= F(this.loy)) c = OUT_YLO;
    else if (y >= F(this.hiy)) c = OUT_YHI;
    else c = 0;
    if (x <= F(this.lox)) c |= OUT_XLO;
    else if (x >= F(this.hix)) c |= OUT_XHI;
    return c;
  }

  getPathBox(box: Int32Array) {
    box[0] = d2i(Math.floor(this.pathlox));
    box[1] = d2i(Math.floor(this.pathloy));
    box[2] = d2i(Math.ceil(this.pathhix));
    box[3] = d2i(Math.ceil(this.pathhiy));
  }

  intersectClipBox(clox: number, cloy: number, chix: number, chiy: number) {
    if (clox > this.lox) this.lox = clox;
    if (cloy > this.loy) this.loy = cloy;
    if (chix < this.hix) this.hix = chix;
    if (chiy < this.hiy) this.hiy = chiy;
  }

  // The sort is stable like glibc's merge sort, which orders equal segments.
  initSegmentTable() {
    const n = this.numSegments, s = this.seg;
    const table = new Int32Array(n);
    for (let i = 0; i < n; i++) table[i] = i;
    table.sort((a, b) => {
      a *= SEG_STRIDE;
      b *= SEG_STRIDE;
      if (s[a + SEG_CURY] !== s[b + SEG_CURY]) return s[a + SEG_CURY] < s[b + SEG_CURY] ? -1 : 1;
      if (s[a + SEG_CURX] !== s[b + SEG_CURX]) return s[a + SEG_CURX] < s[b + SEG_CURX] ? -1 : 1;
      if (s[a + SEG_LASTY] !== s[b + SEG_LASTY]) return s[a + SEG_LASTY] < s[b + SEG_LASTY] ? -1 : 1;
      return 0;
    });
    this.table = table;
    this.state = STATE_SPAN_STARTED;
    let cur = 0;
    while (cur < n && s[table[cur] * SEG_STRIDE + SEG_LASTY] <= this.loy) cur++;
    this.lowSegment = this.curSegment = this.hiSegment = cur;
    this.loy = (this.loy - 1) | 0;
  }

  nextSpan(out: Int32Array): boolean {
    if (this.state !== STATE_SPAN_STARTED) this.initSegmentTable();
    const table = this.table, s = this.seg, num = this.numSegments;
    let lo = this.lowSegment, cur = this.curSegment, hi = this.hiSegment, loy = this.loy;
    let ret = false;

    while (lo < num) {
      if (cur < hi) {
        let b = table[cur] * SEG_STRIDE;
        let x0 = s[b + SEG_CURX];
        if (x0 >= this.hix) {
          cur = hi;
          continue;
        }
        if (x0 < this.lox) x0 = this.lox;
        let x1: number;
        if (this.evenodd) {
          cur += 2;
          x1 = cur <= hi ? s[table[cur - 1] * SEG_STRIDE + SEG_CURX] : this.hix;
        } else {
          let wind = s[b + SEG_WIND];
          cur++;
          for (;;) {
            if (cur >= hi) {
              x1 = this.hix;
              break;
            }
            b = table[cur++] * SEG_STRIDE;
            wind += s[b + SEG_WIND];
            if (wind === 0) {
              x1 = s[b + SEG_CURX];
              break;
            }
          }
        }
        if (x1 > this.hix) x1 = this.hix;
        if (x1 <= x0) continue;
        out[0] = x0;
        out[1] = loy;
        out[2] = x1;
        out[3] = (loy + 1) | 0;
        ret = true;
        break;
      }

      loy = (loy + 1) | 0;
      if (loy >= this.hiy) {
        lo = cur = hi = num;
        break;
      }

      // drop segments that end above loy
      let nw = cur = hi;
      while (--cur >= lo) {
        const sg = table[cur];
        if (s[sg * SEG_STRIDE + SEG_LASTY] > loy) table[--nw] = sg;
      }
      lo = nw;
      if (lo === hi && lo < num) {
        // segments are not clipped to the output area, so never jump backwards
        const sy = s[table[lo] * SEG_STRIDE + SEG_CURY];
        if (loy < sy) loy = sy;
      }

      while (hi < num && s[table[hi] * SEG_STRIDE + SEG_CURY] <= loy) hi++;

      for (cur = lo; cur < hi; cur++) {
        const sg = table[cur], b = sg * SEG_STRIDE;
        let x0 = s[b + SEG_CURX], y0 = s[b + SEG_CURY], err = s[b + SEG_ERROR];
        if ((y0 = (y0 + 1) | 0) === loy) {
          x0 = (x0 + s[b + SEG_BUMPX]) | 0;
          err = (err + s[b + SEG_BUMPERR]) | 0;
          x0 = (x0 - (err >> 31)) | 0;
          err &= ERRSTEP_MAX;
        } else {
          const steps = loy - ((y0 - 1) | 0);
          y0 = loy;
          x0 = (x0 + stepsLow(steps, s[b + SEG_BUMPX])) | 0;
          const [hiPart, loPart] = stepsErr(steps, err, s[b + SEG_BUMPERR]);
          x0 = (x0 + hiPart) | 0;
          err = loPart & ERRSTEP_MAX;
        }
        s[b + SEG_CURX] = x0;
        s[b + SEG_CURY] = y0;
        s[b + SEG_ERROR] = err;

        for (nw = cur; nw > lo; nw--) {
          const s2 = table[nw - 1];
          if (s[s2 * SEG_STRIDE + SEG_CURX] <= x0) break;
          table[nw] = s2;
        }
        table[nw] = sg;
      }
      cur = lo;
    }

    this.lowSegment = lo;
    this.hiSegment = hi;
    this.curSegment = cur;
    this.loy = loy;
    return ret;
  }

  skipDownTo(y: number) {
    if (this.state !== STATE_SPAN_STARTED) this.initSegmentTable();
    if (this.loy < y) {
      this.loy = (y - 1) | 0;
      this.curSegment = this.hiSegment;
    }
  }
}

function minmax3(v1: number, v2: number, v3: number): [number, number] {
  if (v1 < v2) {
    if (v1 < v3) return [v1, v2 < v3 ? v3 : v2];
    return [v3, v2];
  }
  if (v1 < v3) return [v2, v3];
  return [v2 < v3 ? v2 : v3, v1];
}

function minmax4(v1: number, v2: number, v3: number, v4: number): [number, number] {
  if (v1 < v2) {
    if (v3 < v4) return [v1 < v3 ? v1 : v3, v2 < v4 ? v4 : v2];
    return [v1 < v4 ? v1 : v4, v2 < v3 ? v3 : v2];
  }
  if (v3 < v4) return [v2 < v3 ? v2 : v3, v1 < v4 ? v4 : v1];
  return [v2 < v4 ? v2 : v4, v1 < v3 ? v3 : v1];
}

export function spanIterOf(o: JObject): SpanIter | null {
  return o.x instanceof Path ? o.x : null;
}

function internal(msg: string): never {
  throw new PendingThrow("java/lang/InternalError", msg);
}

function npe(msg: string): never {
  throw new PendingThrow("java/lang/NullPointerException", msg);
}

function data(o: JObject, min: number, max: number): Path {
  const p = o.x;
  if (!(p instanceof Path)) return npe("private data");
  if (p.state < min || p.state > max) return internal("bad path delivery sequence");
  return p;
}

function ints4(a: JArray | null): Int32Array {
  if (a === null) return npe("int array");
  const v = a.a as Int32Array;
  if (v.length < 4) throw new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", "Array region 0..4 out of bounds for length " + v.length);
  return v;
}

const outOfBounds = (msg: string) => new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", msg);

const RI = "sun/java2d/pipe/RegionIterator", REGION = "sun/java2d/pipe/Region";

function fill(alpha: Int8Array, offset: number, tsize: number, x: number, y: number, w: number, h: number, value: number) {
  let p = (offset + y * tsize + x) | 0;
  const skip = (tsize - w) | 0;
  while (--h >= 0) {
    for (let i = 0; i < w; i++) alpha[p++] = value;
    p += skip;
  }
}

function eraseTile(t: JThread, ri: JObject | null, alphaTile: JArray | null, offset: number, tsize: number, boxArray: JArray | null) {
  if (boxArray === null) npe("band array");
  const box = boxArray.a as Int32Array;
  if (box.length < 4) throw outOfBounds("band array");
  if (alphaTile === null || ri === null) return npe("alpha tile array");
  const vm = t.vm;
  const alpha = alphaTile.a as Int8Array, alphalen = alpha.length;
  let saveCurIndex = vm.getField(ri, RI, "curIndex") as number;
  let saveNumXbands = vm.getField(ri, RI, "numXbands") as number;
  const region = vm.getField(ri, RI, "region") as JObject | null;
  if (region === null) return npe("region");
  const bandsArray = vm.getField(region, REGION, "bands") as JArray | null;
  if (bandsArray === null) return npe("bands");
  const bands = bandsArray.a as Int32Array;
  let endIndex = vm.getField(region, REGION, "endIndex") as number;
  if (endIndex > bands.length) endIndex = bands.length;

  const lox = box[0], loy = box[1], hix = box[2], hiy = box[3];
  if (alphalen < offset || alphalen < ((offset + ((hix - lox) | 0)) | 0) || ((((alphalen - offset - ((hix - lox) | 0)) | 0) / tsize) | 0) < ((hiy - loy - 1) | 0)) {
    throw outOfBounds("alpha tile array");
  }

  let curIndex = saveCurIndex, numXbands = saveNumXbands;
  let firsty = hiy, lasty = hiy, firstx = hix, lastx = lox;
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0;

  while (true) {
    // nextYRange
    curIndex = (curIndex + numXbands * 2) | 0;
    if (!(curIndex + 3 < endIndex)) {
      numXbands = 0;
      break;
    }
    b1 = bands[curIndex++];
    b3 = bands[curIndex++];
    numXbands = bands[curIndex++];

    if (b3 <= loy) {
      saveNumXbands = numXbands;
      saveCurIndex = curIndex;
      continue;
    }
    if (b1 >= hiy) break;
    if (b1 < loy) b1 = loy;
    if (b3 > hiy) b3 = hiy;
    let curx = lox;
    // nextXBand
    while (numXbands > 0 && curIndex + 2 <= endIndex) {
      numXbands--;
      b0 = bands[curIndex++];
      b2 = bands[curIndex++];
      if (b2 <= lox) continue;
      if (b0 >= hix) break;
      if (b0 < lox) b0 = lox;
      if (lasty < b1) fill(alpha, offset, tsize, 0, lasty - loy, hix - lox, b1 - lasty, 0);
      lasty = b3;
      if (firstx > b0) firstx = b0;
      if (curx < b0) fill(alpha, offset, tsize, curx - lox, b1 - loy, b0 - curx, b3 - b1, 0);
      curx = b2;
      if (curx >= hix) {
        curx = hix;
        break;
      }
    }
    if (curx > lox) {
      if (curx < hix) fill(alpha, offset, tsize, curx - lox, b1 - loy, hix - curx, b3 - b1, 0);
      if (firsty > b1) firsty = b1;
    }
    if (lastx < curx) lastx = curx;
  }

  box[0] = firstx;
  box[1] = firsty;
  box[2] = lastx;
  box[3] = lasty;
  vm.setField(ri, RI, "curIndex", saveCurIndex);
  vm.setField(ri, RI, "numXbands", saveNumXbands);
}

function fillTile(t: JThread, ri: JObject | null, alphaTile: JArray | null, offset: number, tsize: number, boxArray: JArray | null) {
  if (boxArray === null) npe("band array");
  const box = boxArray.a as Int32Array;
  if (box.length < 4) throw outOfBounds("band array");
  if (alphaTile === null) return npe("alpha tile array");
  const alpha = alphaTile.a as Int8Array;
  const w = (box[2] - box[0]) | 0, h = (box[3] - box[1]) | 0;
  if (alpha.length < offset || ((((alpha.length - offset) | 0) / tsize) | 0) < h) throw outOfBounds("alpha tile array");
  fill(alpha, offset, tsize, 0, 0, w, h, -1);
  eraseTile(t, ri, alphaTile, offset, tsize, boxArray);
}

export const natives: Natives = {
  [`${SSI}.setNormalize(Z)V`]: (_t, [self, adjust]) => {
    if (self.x instanceof Path) internal("private data already initialized");
    self.x = new Path(!!adjust);
  },
  [`${SSI}.setOutputAreaXYXY(IIII)V`]: (_t, [self, lox, loy, hix, hiy]) => {
    const p = data(self, STATE_INIT, STATE_INIT);
    p.lox = lox;
    p.loy = loy;
    p.hix = hix;
    p.hiy = hiy;
    p.state = STATE_HAVE_CLIP;
  },
  [`${SSI}.setRule(I)V`]: (_t, [self, rule]) => {
    const p = data(self, STATE_HAVE_CLIP, STATE_HAVE_CLIP);
    p.evenodd = rule === 0;
    p.state = STATE_HAVE_RULE;
  },
  [`${SSI}.addSegment(I[F)V`]: (_t, [self, type, coordObj]) => {
    const p = data(self, STATE_HAVE_RULE, STATE_HAVE_RULE);
    if (coordObj === null) npe("coords");
    const c = coordObj.a as Float32Array;
    if (c.length < 6) throw outOfBounds(`Array region 0..6 out of bounds for length ${c.length}`);
    switch (type) {
      case 0: p.moveTo(c[0], c[1]); break;
      case 1: p.lineTo(c[0], c[1]); break;
      case 2: p.quadTo(c[0], c[1], c[2], c[3]); break;
      case 3: p.cubicTo(c[0], c[1], c[2], c[3], c[4], c[5]); break;
      case 4: p.close(); break;
      default: internal("bad path segment type");
    }
  },
  [`${SSI}.getPathBox([I)V`]: (_t, [self, box]) => {
    const p = data(self, STATE_PATH_DONE, STATE_PATH_DONE);
    p.getPathBox(ints4(box));
  },
  [`${SSI}.intersectClipBox(IIII)V`]: (_t, [self, clox, cloy, chix, chiy]) => {
    data(self, STATE_PATH_DONE, STATE_PATH_DONE).intersectClipBox(clox, cloy, chix, chiy);
  },
  [`${SSI}.nextSpan([I)Z`]: (_t, [self, box]) => {
    const p = data(self, STATE_PATH_DONE, STATE_SPAN_STARTED);
    if (!p.nextSpan(p.scratch)) return 0;
    ints4(box).set(p.scratch);
    return 1;
  },
  [`${SSI}.skipDownTo(I)V`]: (_t, [self, y]) => {
    data(self, STATE_PATH_DONE, STATE_SPAN_STARTED).skipDownTo(y);
  },
  [`${SSI}.getNativeIterator()J`]: () => 1n,
  [`${SSI}.dispose()V`]: (_t, [self]) => {
    self.x = null;
  },
  [`${SSI}.appendPoly([I[IIII)V`]: (_t, [self, xArray, yArray, nPoints, xoff, yoff]) => {
    const p = data(self, STATE_HAVE_CLIP, STATE_HAVE_CLIP);
    p.evenodd = true;
    p.state = STATE_HAVE_RULE;
    if (xArray === null || yArray === null) npe("polygon data arrays");
    const xs = xArray.a as Int32Array, ys = yArray.a as Int32Array;
    if (xs.length < nPoints || ys.length < nPoints) throw outOfBounds("polygon data arrays");
    p.appendPoly(xs, ys, nPoints, xoff, yoff);
  },
  [`${SSI}.moveTo(FF)V`]: (_t, [self, x, y]) => data(self, STATE_HAVE_RULE, STATE_HAVE_RULE).moveTo(x, y),
  [`${SSI}.lineTo(FF)V`]: (_t, [self, x, y]) => data(self, STATE_HAVE_RULE, STATE_HAVE_RULE).lineTo(x, y),
  [`${SSI}.quadTo(FFFF)V`]: (_t, [self, x1, y1, x2, y2]) => data(self, STATE_HAVE_RULE, STATE_HAVE_RULE).quadTo(x1, y1, x2, y2),
  [`${SSI}.curveTo(FFFFFF)V`]: (_t, [self, x1, y1, x2, y2, x3, y3]) => data(self, STATE_HAVE_RULE, STATE_HAVE_RULE).cubicTo(x1, y1, x2, y2, x3, y3),
  [`${SSI}.closePath()V`]: (_t, [self]) => data(self, STATE_HAVE_RULE, STATE_HAVE_RULE).close(),
  [`${SSI}.pathDone()V`]: (_t, [self]) => data(self, STATE_HAVE_RULE, STATE_HAVE_RULE).endPath(),
  [`${SSI}.getNativeConsumer()J`]: (_t, [self]) => {
    data(self, STATE_HAVE_RULE, STATE_HAVE_RULE);
    return 1n;
  },

  [`${SCR}.fillTile(L${RI};[BII[I)V`]: (t, [, ri, alpha, offset, tsize, box]) => fillTile(t, ri, alpha, offset, tsize, box),
  [`${SCR}.eraseTile(L${RI};[BII[I)V`]: (t, [, ri, alpha, offset, tsize, box]) => eraseTile(t, ri, alpha, offset, tsize, box),
};
