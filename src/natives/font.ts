// java.desktop's font natives for one bundled TrueType font: the fontconfig
// answers, the FreeType scaler (sun.font.FreetypeFontScaler), the glyph cache
// structs (StrikeCache) and the text layout engine (SunLayoutEngine).
// Glyph images are GlyphInfo structs in native memory, laid out as
// StrikeCache.GlyphImageLayout reads them.

import { INITIALIZED } from "../runtime.ts";
import type { JArray, JObject } from "../runtime.ts";
import type { JThread, NativeGen } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import type { Natives } from "./util.ts";
import { BadGlyph, TTF, controlBox, decompose, divFix, embolden, mulDiv, mulFix, outlineBBox, rasterize, transformOutline, SEG_CLOSE, SEG_LINETO, SEG_MOVETO, SEG_QUADTO } from "./font-ttf.ts";
import type { Outline } from "./font-ttf.ts";

const FONT_FILE = "DejaVuSans.ttf";

const TEXT_AA_OFF = 1, TEXT_FM_ON = 2;
const INVISIBLE_GLYPHS = 0xfffe;
const GLYPHINFO = 40;
const MAX_GLYPH_DIM = 1024;
const OBLIQUE = 0x366a;
const fr = Math.fround;

// the transform is a 16.16 fixed point matrix, like FreeType's
interface Ctx {
  ttf: TTF;
  ptsz26: number;
  scale: number;
  xx: number;
  xy: number;
  yx: number;
  yy: number;
  aa: number;
  fm: number;
  bold: boolean;
  italic: boolean;
}

// What the VM keeps for fonts. Scaler and context "pointers" are native
// memory blocks, so they stay unique and the JDK can free them. A font's data
// lives as long as its scaler; only the JDK's own fonts are shared.
class Fonts {
  bundled = new Map<string, TTF>();
  scalers = new Map<number, TTF>();
  contexts = new Map<number, Ctx>();
  nullContext = 0;
}

const states = new WeakMap<JVM, Fonts>();

function fonts(vm: JVM): Fonts {
  let s = states.get(vm);
  if (!s) states.set(vm, (s = new Fonts()));
  return s;
}

const CHUNK = 65536;

// The file as FreeType reads it: through the Font2D, whose open channel
// outlives a later delete or rewrite of the path
function* readThrough(t: JThread, font2D: JObject, size: number): NativeGen {
  if (size <= 0) return null;
  const bb = yield* init(t, "java/nio/ByteBuffer");
  const buf = yield t.call(bb.methodMap.get("allocate(I)Ljava/nio/ByteBuffer;")!, Math.min(size, CHUNK));
  const hb = (t.vm.getField(buf, "java/nio/ByteBuffer", "hb") as JArray).a as Int8Array;
  const out = new Uint8Array(size);
  try {
    for (let off = 0; off < size; off += CHUNK) {
      const len = Math.min(CHUNK, size - off);
      const n = yield t.callVirtual(font2D, "readBlock", "(Ljava/nio/ByteBuffer;II)I", buf, off, len);
      if (n !== len) return null;
      out.set(new Uint8Array(hb.buffer, hb.byteOffset, len), off);
    }
  } catch {
    return null;
  }
  return out;
}

// null where FreeType cannot open the face, which gives the font a null scaler
function* openFont(t: JThread, font2D: JObject, index: number, size: number): NativeGen {
  const vm = t.vm, s = fonts(vm);
  const platName = vm.getField(font2D, "sun/font/PhysicalFont", "platName") as JObject | null;
  const name = platName && vm.jsString(platName);
  const shared = name !== null && name.startsWith(`${fontDir(vm)}/`);
  const known = shared ? s.bundled.get(name) : undefined;
  if (known) return known;
  const data: Uint8Array | null = shared ? vm.fs.read(name) : yield* readThrough(t, font2D, size);
  if (!data) return null;
  try {
    const ttf = new TTF(data, index);
    if (shared) s.bundled.set(name, ttf);
    return ttf;
  } catch {
    return null;
  }
}

function* init(t: JThread, name: string) {
  const c = t.vm.loadBootOrFail(name);
  if (c.state !== INITIALIZED) yield* t.vm.initGen(t, c);
  return c;
}

// new name(args), running the constructor with descriptor desc
function* make(t: JThread, name: string, desc: string, ...args: any[]): NativeGen {
  const c = yield* init(t, name);
  const o = t.vm.newObject(c);
  yield t.call(c.methodMap.get(`<init>${desc}`)!, o, ...args);
  return o;
}

function* point(t: JThread, x: number, y: number) {
  return yield* make(t, "java/awt/geom/Point2D$Float", "(FF)V", x, y);
}

// ---- GlyphInfo -------------------------------------------------------------

function newGlyph(vm: JVM, advX: number, advY: number, w: number, h: number, left: number, top: number, pixels: Uint8Array | null): number {
  const n = pixels ? pixels.length : 0, mem = vm.mem;
  const addr = mem.malloc(GLYPHINFO + n);
  mem.u8.fill(0, addr, addr + GLYPHINFO + n);
  const dv = mem.dv;
  dv.setFloat32(addr, advX, true);
  dv.setFloat32(addr + 4, advY, true);
  dv.setUint16(addr + 8, w, true);
  dv.setUint16(addr + 10, h, true);
  dv.setUint16(addr + 12, w, true);
  dv.setFloat32(addr + 16, left, true);
  dv.setFloat32(addr + 20, top, true);
  if (pixels && n > 0) {
    dv.setBigUint64(addr + 32, BigInt(addr + GLYPHINFO), true);
    mem.u8.set(pixels, addr + GLYPHINFO);
  }
  return addr;
}

// ---- scaler contexts -------------------------------------------------------

const ft16 = (v: number) => Math.trunc(fr(fr(v) * 65536));

function createContext(vm: JVM, ttf: TTF, m: Float64Array, aaType: number, fmType: number, boldness: number, italic: number): bigint {
  let ptsz = Math.hypot(m[2], m[3]);
  if (ptsz < 1) ptsz = 1;
  if (ptsz > 16384) {
    ptsz = 16384;
    fmType = TEXT_FM_ON;
  }
  for (const v of m) if (Math.abs(Math.trunc(v / ptsz)) > 32766) return 0n;
  const s = fonts(vm), addr = vm.mem.malloc(16), ptsz26 = Math.trunc(ptsz * 64);
  s.contexts.set(addr, {
    ttf,
    ptsz26,
    scale: divFix(ptsz26, ttf.upem),
    xx: ft16(m[0] / ptsz),
    yx: -ft16(m[1] / ptsz),
    xy: -ft16(m[2] / ptsz),
    yy: ft16(m[3] / ptsz),
    aa: aaType,
    fm: fmType,
    bold: boldness !== 1,
    italic: italic !== 0,
  });
  return BigInt(addr);
}

function ctxOf(vm: JVM, p: bigint): Ctx | null {
  return fonts(vm).contexts.get(Number(p)) ?? null;
}

// The glyph transform, with the italic shear applied first
function matrix(c: Ctx): [number, number, number, number] {
  if (!c.italic) return [c.xx, c.xy, c.yx, c.yy];
  return [c.xx, mulFix(c.xx, OBLIQUE) + c.xy, c.yx, mulFix(c.yx, OBLIQUE) + c.yy];
}

// FreeType's FT_MulFix(upem, y_scale) / 32 for the synthetic bold
const boldExtra = (c: Ctx) => Math.trunc(mulFix(c.ttf.upem, c.scale) / 32);

interface Loaded {
  // the unhinted outline in 26.6 pixels, emboldened if the style asks
  o: Outline | null;
  ax: number;
  ay: number;
}

// FT_Load_Glyph and the JDK's synthetic bold; null where FreeType fails to
// load the glyph. The advance is linear with fractional metrics, else rounded
// to whole pixels as hinting does.
function load(c: Ctx, gid: number): Loaded | null {
  const ttf = c.ttf;
  if (gid >= ttf.numGlyphs) return null;
  let raw: Outline | null;
  try {
    raw = ttf.scaled(gid, c.scale);
  } catch (e) {
    if (e instanceof BadGlyph) return null;
    throw e;
  }
  const box = raw && controlBox(raw);
  const inked = box !== null && box[0] !== box[2] && box[1] !== box[3];
  const o = raw && transformOutline(raw, matrix(c));
  if (o && inked && c.bold) embolden(o, boldExtra(c));
  const units = ttf.advance(gid), linear = mulDiv(units, c.scale, 64);
  const extra = c.bold && inked && linear !== 0 ? boldExtra(c) : 0;
  if (c.fm === TEXT_FM_ON) {
    const lin = fr((linear + extra * 1024) / 65536);
    return { o, ax: fr(lin * fr(c.xx / 65536)), ay: fr(-(lin * fr(c.yx / 65536))) };
  }
  const adv = Math.round((units * c.ptsz26) / 64 / ttf.upem) * 64, m = matrix(c);
  let x = mulFix(adv, m[0]), y = mulFix(adv, m[2]);
  if (extra && x) x += mulFix(extra, c.xx);
  if (extra && y) y += mulFix(extra, c.yx);
  return { o, ax: x / 64, ay: y ? -y / 64 : 0 };
}

// The outline getFTOutline hands to the path and bounds natives
function outlineOf(c: Ctx, gid: number): Outline | null {
  return gid >= INVISIBLE_GLYPHS ? null : (load(c, gid)?.o ?? null);
}

function glyphImage(vm: JVM, c: Ctx | null, gid: number): number {
  const g = c && load(c, gid);
  if (!g) return newGlyph(vm, 0, 0, 0, 0, 0, 0, null);
  const bmp = g.o && g.o.x.length > 0 ? rasterize(g.o, c.aa === TEXT_AA_OFF, MAX_GLYPH_DIM) : null;
  if (bmp && bmp.pixels.length === 0) return newGlyph(vm, 0, 0, 0, 0, 0, 0, null);
  return newGlyph(vm, g.ax, g.ay, bmp?.width ?? 0, bmp?.height ?? 0, bmp?.left ?? 0, bmp ? -bmp.top : 0, bmp?.pixels ?? null);
}

// ---- outlines as GeneralPath -----------------------------------------------

class PathData {
  types: number[] = [];
  coords: number[] = [];

  add(o: Outline, dx: number, dy: number) {
    const pt = (x: number, y: number) => this.coords.push(fr((x + dx) / 64), fr(-(y + dy) / 64));
    decompose(o, {
      move: (x, y) => {
        if (this.coords.length) this.types.push(SEG_CLOSE);
        pt(x, y);
        this.types.push(SEG_MOVETO);
      },
      line: (x, y) => {
        pt(x, y);
        this.types.push(SEG_LINETO);
      },
      quad: (cx, cy, x, y) => {
        pt(cx, cy);
        pt(x, y);
        this.types.push(SEG_QUADTO);
      },
      close: () => {},
    });
    if (this.coords.length) this.types.push(SEG_CLOSE);
  }
}

function* generalPath(t: JThread, p: PathData | null): NativeGen {
  if (!p || p.coords.length === 0) return yield* make(t, "java/awt/geom/GeneralPath", "()V");
  const vm = t.vm;
  const types = vm.newArray(vm.primClass("B"), p.types.length), coords = vm.newArray(vm.primClass("F"), p.coords.length);
  (types.a as Int8Array).set(p.types);
  (coords.a as Float32Array).set(p.coords);
  return yield* make(t, "java/awt/geom/GeneralPath", "(I[BI[FI)V", 0, types, p.types.length, coords, p.coords.length);
}

// FreeType translates the outline by (xpos, -ypos) in 26.6 before decomposing
const toF26 = (v: number) => Math.trunc(v * 64);

// ---- natives ---------------------------------------------------------------

const FFS = "sun/font/FreetypeFontScaler.";
const TRUETYPE_FONT = 1;

const scaler: Natives = {
  [FFS + "initIDs"]: () => undefined,

  [FFS + "initNativeScaler"]: function* (t, [, font2D, type, index, , size]): NativeGen {
    const ttf = type === TRUETYPE_FONT ? yield* openFont(t, font2D, index, size) : null;
    if (!ttf) return 0n;
    const addr = t.vm.mem.malloc(16);
    fonts(t.vm).scalers.set(addr, ttf);
    return BigInt(addr);
  },

  [FFS + "disposeNativeScaler"](t, [, , pScaler]) {
    const s = fonts(t.vm), addr = Number(pScaler);
    if (s.scalers.delete(addr)) t.vm.mem.freeBlock(addr);
  },

  [FFS + "createScalerContextNative"](t, [, pScaler, matrixArr, aa, fm, boldness, italic]) {
    const ttf = fonts(t.vm).scalers.get(Number(pScaler));
    if (!ttf) return 0n;
    return createContext(t.vm, ttf, (matrixArr as JArray).a as Float64Array, aa, fm, boldness, italic);
  },

  [FFS + "getNumGlyphsNative"](t, [, pScaler]) {
    return fonts(t.vm).scalers.get(Number(pScaler))?.numGlyphs ?? 1;
  },

  [FFS + "getMissingGlyphCodeNative"]: () => 0,

  [FFS + "getUnitsPerEMNative"](t, [, pScaler]) {
    return BigInt(fonts(t.vm).scalers.get(Number(pScaler))?.upem ?? 2048);
  },

  [FFS + "getGlyphCodeNative"](t, [, , pScaler, ch]) {
    return fonts(t.vm).scalers.get(Number(pScaler))?.glyphIndex(ch) ?? 0;
  },

  [FFS + "getGlyphAdvanceNative"](t, [, , pCtx, , gid]) {
    const c = ctxOf(t.vm, pCtx);
    return (c && load(c, gid)?.ax) || 0;
  },

  [FFS + "getGlyphMetricsNative"](t, [, , pCtx, , gid, metrics]) {
    const c = ctxOf(t.vm, pCtx), g = c && load(c, gid);
    t.vm.setField(metrics, "java/awt/geom/Point2D$Float", "x", g ? g.ax : 0);
    t.vm.setField(metrics, "java/awt/geom/Point2D$Float", "y", g ? g.ay : 0);
  },

  [FFS + "getGlyphImageNative"](t, [, , pCtx, , gid]) {
    return BigInt(glyphImage(t.vm, ctxOf(t.vm, pCtx), gid));
  },

  [FFS + "getFontMetricsNative"]: function* (t, [, , pCtx]): NativeGen {
    const c = ctxOf(t.vm, pCtx);
    let v = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (c) {
      const f = c.ttf, yScale = c.scale, xScale = yScale;
      const shift6 = (a: number, b: number) => fr((a * b) / 65536 / 64);
      const ay = -shift6(f.ascender, yScale), dy = -shift6(f.descender, yScale);
      const ly = shift6(f.height, yScale) + ay - dy;
      const round = (v26: number) => (v26 + 32) & ~63;
      const height = round(Math.round((f.height * yScale) / 65536));
      const maxAdv = round(Math.round((f.maxAdvance * xScale) / 65536));
      const mx = (maxAdv + (c.italic ? Math.trunc((height * 0x366a) / 0x10000) : 0) + (c.bold ? boldExtra(c) : 0)) / 64;
      const X = (x: number, y: number) => fr((c.xx / 65536) * x - (c.xy / 65536) * y), Y = (x: number, y: number) => fr((-c.yx / 65536) * x + (c.yy / 65536) * y);
      v = [X(0, ay), Y(0, ay), X(0, dy), Y(0, dy), 0, 0, X(0, ly), Y(0, ly), X(mx, 0), Y(mx, 0)];
    }
    return yield* make(t, "sun/font/StrikeMetrics", "(FFFFFFFFFF)V", ...v);
  },

  [FFS + "getGlyphOutlineBoundsNative"]: function* (t, [, , pCtx, , gid]): NativeGen {
    const c = ctxOf(t.vm, pCtx), o = c && outlineOf(c, gid);
    if (o) {
      const [x0, y0, x1, y1] = outlineBBox(o);
      if (x0 < x1 && y0 < y1) return yield* make(t, "java/awt/geom/Rectangle2D$Float", "(FFFF)V", x0 / 64, -y1 / 64, (x1 - x0) / 64, (y1 - y0) / 64);
    }
    return yield* make(t, "java/awt/geom/Rectangle2D$Float", "()V");
  },

  [FFS + "getGlyphOutlineNative"]: function* (t, [, , pCtx, , gid, x, y]): NativeGen {
    const c = ctxOf(t.vm, pCtx), o = c && outlineOf(c, gid);
    let p: PathData | null = null;
    if (o) {
      p = new PathData();
      p.add(o, toF26(x), toF26(-y));
    }
    return yield* generalPath(t, p);
  },

  [FFS + "getGlyphVectorOutlineNative"]: function* (t, [, , pCtx, , glyphs, n, x, y]): NativeGen {
    const c = ctxOf(t.vm, pCtx), p = new PathData();
    const g = (glyphs as JArray).a as Int32Array;
    for (let i = 0; c && i < n; i++) {
      const o = outlineOf(c, g[i]);
      if (o) p.add(o, toF26(x), toF26(-y));
    }
    return yield* generalPath(t, p);
  },

  [FFS + "getGlyphPointNative"]: function* (t, [, , pCtx, , gid, num]): NativeGen {
    const c = ctxOf(t.vm, pCtx), o = c && outlineOf(c, gid);
    return yield* point(t, o && o.x.length > num ? o.x[num] / 64 : 0, o && o.x.length > num ? -o.y[num] / 64 : 0);
  },
};

const strikeCache: Natives = {
  "sun/font/StrikeCache.getInvisibleGlyphPtr"(t) {
    return BigInt(newGlyph(t.vm, 0, 0, 0, 0, 0, 0, null));
  },
  "sun/font/StrikeCache.freeIntPointer"(t, [p]) {
    if (p) t.vm.mem.freeBlock(p);
  },
  "sun/font/StrikeCache.freeLongPointer"(t, [p]) {
    if (p) t.vm.mem.freeBlock(Number(p));
  },
  "sun/font/StrikeCache.freeIntMemory"(t, [arr, pCtx]) {
    for (const p of (arr as JArray).a as Int32Array) if (p) t.vm.mem.freeBlock(p);
    freeContext(t.vm, pCtx);
  },
  "sun/font/StrikeCache.freeLongMemory"(t, [arr, pCtx]) {
    for (const p of (arr as JArray).a as BigInt64Array) if (p) t.vm.mem.freeBlock(Number(p));
    freeContext(t.vm, pCtx);
  },
  "sun/font/SunFontManager.initIDs": () => undefined,
  "sun/font/NullFontScaler.getNullScalerContext"(t) {
    const s = fonts(t.vm);
    return BigInt(s.nullContext || (s.nullContext = t.vm.mem.malloc(16)));
  },
  "sun/font/NullFontScaler.getGlyphImage"(t) {
    return BigInt(newGlyph(t.vm, 0, 0, 0, 0, 0, 0, null));
  },
};

function freeContext(vm: JVM, p: bigint) {
  const s = fonts(vm), addr = Number(p);
  if (addr && addr !== s.nullContext) {
    s.contexts.delete(addr);
    vm.mem.freeBlock(addr);
  }
}

// ---- fontconfig ------------------------------------------------------------

const FCM = "sun/font/FontConfigManager";

const fontDir = (vm: JVM) => `${vm.opts.javaHome}/lib/fonts`;

const fontconfig: Natives = {
  "sun/awt/FcFontManager.getFontPathNative"(t) {
    return t.vm.str(fontDir(t.vm));
  },
  [`${FCM}.getFontConfigVersion`]: () => 21402,
  // the bundled font stands in for every family, as a system with only it installed would
  [`${FCM}.getFontConfigAASettings`]: () => 2,
  [`${FCM}.getFontConfig`]: function* (t, [, info, comps, fallbacks]): NativeGen {
    const vm = t.vm;
    vm.setField(info, `${FCM}$FontConfigInfo`, "fcVersion", 21402);
    const font = yield* make(t, `${FCM}$FontConfigFont`, "()V");
    const F = `${FCM}$FontConfigFont`;
    vm.setField(font, F, "familyName", vm.str("DejaVu Sans"));
    vm.setField(font, F, "styleStr", vm.str("Book"));
    vm.setField(font, F, "fullName", vm.str("DejaVu Sans"));
    vm.setField(font, F, "fontFile", vm.str(`${fontDir(vm)}/${FONT_FILE}`));
    for (const comp of (comps as JArray).a as JObject[]) {
      vm.setField(comp, `${FCM}$FcCompFont`, "firstFont", font);
      if (fallbacks) vm.setField(comp, `${FCM}$FcCompFont`, "allFonts", vm.newObjectArray(F, [font]));
    }
  },
};

// ---- layout ----------------------------------------------------------------

const TYPO_KERN = 1, TYPO_RTL = 0x80000000 | 0;

// hb_unicode_funcs_t::is_default_ignorable: HarfBuzz hides these with a zero advance
const ignorable = (cp: number) =>
  cp === 0xad || cp === 0x34f || cp === 0x61c || (cp >= 0x17b4 && cp <= 0x17b5) || (cp >= 0x180b && cp <= 0x180e) ||
  (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff || (cp >= 0xfff0 && cp <= 0xfff8) || (cp >= 0x1d173 && cp <= 0x1d17a) ||
  (cp >= 0xe0000 && cp <= 0xe0fff);

const INVISIBLE_GLYPH = 0xffff;

// A glyph from the Font2D's own mapper, as HarfBuzz asks the JDK. It maps
// tabs, line breaks and the like to the invisible glyph.
function* glyphOf(t: JThread, font2D: JObject, name: string, desc: string, ...cps: number[]): NativeGen {
  try {
    const g = yield t.callVirtual(font2D, name, desc, ...cps);
    return g < 0 ? 0 : g;
  } catch {
    return 0;
  }
}

// HarfBuzz's fallback for a space the font lacks: the font's own space glyph
// with an advance from the em. The values divide the em; the rest are special.
const SPACE_EM = new Map([[0x2000, 2], [0x2001, 1], [0x2002, 2], [0x2003, 1], [0x2004, 3], [0x2005, 4], [0x2006, 6], [0x2009, 5], [0x200a, 16], [0x3000, 1]]);
const SPACE_OTHER = new Set([0x20, 0xa0, 0x2007, 0x2008, 0x202f, 0x205f]);

const isVariationSelector = (cp: number) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);

const SLE = "sun/font/SunLayoutEngine.";

// One glyph per code point, in logical or (right to left) reversed order, with
// pair kerning from the kern table when asked. No ligatures or shaping: those
// need the OpenType layout tables.
const layout: Natives = {
  [SLE + "createFace"]: () => 1n,
  [SLE + "disposeFace"]: () => undefined,
  [SLE + "shape"]: function* (t, [font2D, strike, ptSize, , , chars, gv, , offset, limit, baseIndex, startPt, flags, slot]): NativeGen {
    const vm = t.vm;
    const c = ctxOf(vm, vm.getField(strike, "sun/font/PhysicalStrike", "pScalerContext"));
    const text = (chars as JArray).a as Uint16Array;
    const cps: { gid: number; cluster: number; adv: number }[] = [];
    for (let i = offset; i < limit; i++) {
      let cp = text[i];
      const cluster = i;
      if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < limit && text[i + 1] >= 0xdc00 && text[i + 1] < 0xe000) cp = 0x10000 + ((cp - 0xd800) << 10) + (text[++i] - 0xdc00);
      else if (cp >= 0xd800 && cp < 0xe000) cp = 0xfffd;
      let gid = -1;
      const hi = text[i + 1], lo = text[i + 2];
      const vs = hi >= 0xd800 && hi < 0xdc00 && i + 2 < limit && lo >= 0xdc00 && lo < 0xe000 ? 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00) : hi;
      if (i + 1 < limit && isVariationSelector(vs)) {
        // the selector joins its base when the font has a glyph for the pair
        gid = yield* glyphOf(t, font2D, "charToVariationGlyph", "(II)I", cp, vs);
        if (gid === 0) gid = -1;
        else i += vs > 0xffff ? 2 : 1;
      }
      if (ignorable(cp)) gid = INVISIBLE_GLYPH;
      else if (gid < 0) gid = yield* glyphOf(t, font2D, "charToGlyph", "(I)I", cp);
      // advances are HarfBuzz's 16.16 fixed point
      const fixed = (g: number) => (c && (g & 0xfffe) !== 0xfffe ? Math.trunc(fr(load(c, g)?.ax ?? 0) * 65536) : 0);
      let adv = fixed(gid);
      if (gid === 0 && (SPACE_EM.has(cp) || SPACE_OTHER.has(cp))) {
        const space = yield* glyphOf(t, font2D, "charToGlyph", "(I)I", 0x20), em = Math.trunc(ptSize * 65536);
        gid = space || INVISIBLE_GLYPH;
        adv = space ? fixed(space) : Math.trunc(em / 4);
        const div = SPACE_EM.get(cp);
        if (div) adv = Math.trunc((em + (div >> 1)) / div);
        else if (cp === 0x205f) adv = Math.trunc((em * 4) / 18);
        else if (cp === 0x202f) adv = Math.trunc(adv / 2);
        else if (cp === 0x2007 || cp === 0x2008) {
          for (const u of cp === 0x2007 ? "0123456789" : ".,") {
            const g = yield* glyphOf(t, font2D, "charToGlyph", "(I)I", u.charCodeAt(0));
            if (g) {
              adv = fixed(g);
              break;
            }
          }
        }
      }
      cps.push({ gid, cluster, adv: adv / 65536 });
    }
    if (c && flags & TYPO_KERN) {
      const ttf = c.ttf;
      const xScale = Math.trunc(ptSize * 65536);
      for (let i = 0; i + 1 < cps.length; i++) {
        const k = ttf.kern(cps[i].gid, cps[i + 1].gid);
        if (k) cps[i].adv += Math.round((k * xScale) / ttf.upem) / 65536;
      }
    }
    if (flags & TYPO_RTL) cps.reverse();
    const G = "sun/font/GlyphLayout$GVData";
    const initial = vm.getField(gv, G, "_count") as number;
    const need = Math.max(limit - offset, cps.length) + initial;
    for (;;) {
      const g = vm.getField(gv, G, "_glyphs") as JArray, p = vm.getField(gv, G, "_positions") as JArray;
      if (need <= (g.a as Int32Array).length && need * 2 + 2 <= (p.a as Float32Array).length) break;
      yield t.call(gv.cls.methodMap.get("grow()V")!, gv);
    }
    const glyphs = (vm.getField(gv, G, "_glyphs") as JArray).a as Int32Array;
    const pos = (vm.getField(gv, G, "_positions") as JArray).a as Float32Array;
    const idx = (vm.getField(gv, G, "_indices") as JArray).a as Int32Array;
    const P = "java/awt/geom/Point2D$Float";
    const sx = vm.getField(startPt, P, "x") as number, sy = vm.getField(startPt, P, "y") as number;
    let x = 0;
    cps.forEach((g, i) => {
      const k = i + initial;
      idx[k] = baseIndex + g.cluster - offset;
      glyphs[k] = g.gid | slot;
      pos[k * 2] = sx + x;
      pos[k * 2 + 1] = sy;
      x = fr(x + g.adv);
    });
    const end = initial + cps.length;
    pos[end * 2] = fr(sx + x);
    pos[end * 2 + 1] = sy;
    vm.setField(startPt, P, "x", fr(sx + x));
    vm.setField(gv, G, "_count", end);
    return 1;
  },
};

export const natives: Natives = { ...scaler, ...strikeCache, ...fontconfig, ...layout };
