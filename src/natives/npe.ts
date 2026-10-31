// Helpful NullPointerException messages (JEP 358), ported from HotSpot's
// bytecodeUtils.cpp. A data-flow pass records which bytecode pushed each
// operand stack slot, then the message is built by walking back from the
// bytecode that hit null.

import { Tag, className, utf8 } from "../classfile.ts";
import type { ClassFile } from "../classfile.ts";
import type { JMethod } from "../runtime.ts";
import type { Natives } from "./util.ts";

const CONFLICT = 0, INT = 1, LONG = 2, FLOAT = 3, DOUBLE = 4, OBJECT = 5, ARRAY = 6, ADDRESS = 7;
const BOOLEAN = 8, BYTE = 9, CHAR = 10, SHORT = 11, VOID = 12;

const INVALID = 0x1ffff;
const MAX_ENTRIES = 1000000;
const MAX_CAUSE_DETAIL = 5;
const NPE_EXPLICIT = -2;
const NPE_INVALID = -1;

class Bail extends Error {}

// A stack slot is (bci << 4) | type. The bci is INVALID when ambiguous.
const slot = (bci: number, type: number) => (bci << 4) | type;
const slotBci = (s: number) => s >> 4;
const slotType = (s: number) => s & 15;
const typeSize = (t: number) => (t === LONG || t === DOUBLE ? 2 : t === VOID ? 0 : 1);

function mergeSlot(a: number, b: number): number {
  const ta = slotType(a), tb = slotType(b);
  if (ta !== tb) {
    if ((ta === OBJECT || ta === ARRAY) && (tb === OBJECT || tb === ARRAY)) {
      return slotBci(a) === slotBci(b) ? slot(slotBci(a), OBJECT) : slot(INVALID, OBJECT);
    }
    return slot(INVALID, CONFLICT);
  }
  return slotBci(a) === slotBci(b) ? a : slot(INVALID, ta);
}

function descType(ch: string): number {
  switch (ch) {
    case "Z": return BOOLEAN;
    case "B": return BYTE;
    case "C": return CHAR;
    case "S": return SHORT;
    case "I": return INT;
    case "J": return LONG;
    case "F": return FLOAT;
    case "D": return DOUBLE;
    case "L": return OBJECT;
    case "[": return ARRAY;
    default: return VOID;
  }
}

// Descriptors of the parameters of a method descriptor.
function paramDescs(desc: string): string[] {
  const out: string[] = [];
  for (let i = 1; desc[i] !== ")";) {
    const s = i;
    while (desc[i] === "[") i++;
    i = desc[i] === "L" ? desc.indexOf(";", i) + 1 : i + 1;
    out.push(desc.slice(s, i));
  }
  return out;
}

const argSlots = (desc: string) => paramDescs(desc).reduce((n, p) => n + typeSize(descType(p[0])), 0);

const PRIM_NAMES: Record<string, string> = {
  Z: "boolean", B: "byte", C: "char", S: "short", I: "int", J: "long", F: "float", D: "double",
};

function externalType(d: string): string {
  let dims = 0;
  while (d[dims] === "[") dims++;
  const base = d[dims] === "L" ? d.slice(dims + 1, -1).replace(/\//g, ".") : PRIM_NAMES[d[dims]];
  return base + "[]".repeat(dims);
}

// Quirk kept from HotSpot: the match is a 16 character prefix, so
// java.lang.StringBuilder also becomes StringBuilder.
function trimWellKnown(params: string): string {
  return params.replace(/(^|, )java\.lang\.(?=Object|String)/g, "$1");
}

function klassName(internal: string): string {
  const n = internal.replace(/\//g, ".");
  return n === "java.lang.Object" ? "Object" : n === "java.lang.String" ? "String" : n;
}

const LEN = new Uint8Array(256).fill(1);
for (const op of [0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xa9, 0xbc]) LEN[op] = 2;
for (const op of [0x11, 0x13, 0x14, 0x84, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7]) LEN[op] = 3;
for (let op = 0x99; op <= 0xa8; op++) LEN[op] = 3;
LEN[0xb9] = 5; LEN[0xba] = 5; LEN[0xc5] = 4; LEN[0xc8] = 5; LEN[0xc9] = 5;

function s32(c: Uint8Array, p: number) { return (c[p] << 24) | (c[p + 1] << 16) | (c[p + 2] << 8) | c[p + 3]; }
function u16(c: Uint8Array, p: number) { return (c[p] << 8) | c[p + 1]; }
function s16(c: Uint8Array, p: number) { return (u16(c, p) << 16) >> 16; }

function insnLength(c: Uint8Array, pc: number): number {
  const op = c[pc];
  if (op === 0xaa) {
    const p = (pc + 4) & ~3;
    return p + 12 + (s32(c, p + 8) - s32(c, p + 4) + 1) * 4 - pc;
  }
  if (op === 0xab) {
    const p = (pc + 4) & ~3;
    return p + 8 + s32(c, p + 4) * 8 - pc;
  }
  if (op === 0xc4) return c[pc + 1] === 0x84 ? 6 : 4;
  return LEN[op];
}

// Stack effect of the bytecodes that only pop and push one typed value.
const POP = new Int8Array(256);
const PUSH = new Int8Array(256).fill(-1);
function def(op: number, pop: number, push: number) { POP[op] = pop; PUSH[op] = push; }
function defRange(first: number, n: number, pop: number, push: number | ((i: number) => number)) {
  for (let i = 0; i < n; i++) def(first + i, pop, typeof push === "number" ? push : push(i));
}
const ILFD = [INT, LONG, FLOAT, DOUBLE];
def(0x00, 0, VOID);
def(0x01, 0, OBJECT);
defRange(0x02, 7, 0, INT);
defRange(0x09, 2, 0, LONG);
defRange(0x0b, 3, 0, FLOAT);
defRange(0x0e, 2, 0, DOUBLE);
defRange(0x10, 2, 0, INT);
defRange(0x15, 5, 0, (i) => (i === 4 ? OBJECT : ILFD[i]));
defRange(0x1a, 20, 0, (i) => (i >= 16 ? OBJECT : ILFD[i >> 2]));
def(0x2e, 2, INT); def(0x2f, 2, LONG); def(0x30, 2, FLOAT); def(0x31, 2, DOUBLE);
def(0x32, 2, OBJECT); def(0x33, 2, INT); def(0x34, 2, INT); def(0x35, 2, INT);
def(0x4f, 3, VOID); def(0x50, 4, VOID); def(0x51, 3, VOID); def(0x52, 4, VOID);
def(0x53, 3, VOID); def(0x54, 3, VOID); def(0x55, 3, VOID); def(0x56, 3, VOID);
def(0x57, 1, VOID); def(0x58, 2, VOID);
defRange(0x60, 20, 0, (i) => ILFD[i & 3]);
for (let op = 0x60; op <= 0x73; op++) POP[op] = 2 * typeSize(PUSH[op]);
defRange(0x74, 4, 0, (i) => ILFD[i]);
for (let op = 0x74; op <= 0x77; op++) POP[op] = typeSize(PUSH[op]);
defRange(0x78, 6, 0, (i) => (i & 1 ? LONG : INT));
for (let op = 0x78; op <= 0x7d; op++) POP[op] = 1 + typeSize(PUSH[op]);
defRange(0x7e, 6, 0, (i) => (i & 1 ? LONG : INT));
for (let op = 0x7e; op <= 0x83; op++) POP[op] = 2 * typeSize(PUSH[op]);
def(0x84, 0, VOID);
def(0x85, 1, LONG); def(0x86, 1, FLOAT); def(0x87, 1, DOUBLE);
def(0x88, 2, INT); def(0x89, 2, FLOAT); def(0x8a, 2, DOUBLE);
def(0x8b, 1, INT); def(0x8c, 1, LONG); def(0x8d, 1, DOUBLE);
def(0x8e, 2, INT); def(0x8f, 2, LONG); def(0x90, 2, FLOAT);
def(0x91, 1, BYTE); def(0x92, 1, CHAR); def(0x93, 1, SHORT);
def(0x94, 4, INT); def(0x95, 2, INT); def(0x96, 2, INT); def(0x97, 4, INT); def(0x98, 4, INT);
def(0xbb, 0, OBJECT);
def(0xbc, 1, ARRAY); def(0xbd, 1, ARRAY);
def(0xbe, 1, INT);
def(0xc1, 1, BOOLEAN);
def(0xc2, 1, VOID); def(0xc3, 1, VOID);

class Stack {
  s: number[];
  lo = 0;
  hi = 0;
  constructor(from?: Stack) {
    this.s = from ? from.s.slice() : [];
    if (from) { this.lo = from.lo; this.hi = from.hi; }
  }
  pushRaw(d: number) {
    if (slotType(d) !== VOID) this.s.push(d);
  }
  push(bci: number, type: number) {
    const d = slot(bci, type);
    this.pushRaw(d);
    if (typeSize(type) === 2) this.pushRaw(d);
  }
  pop(n: number) {
    if (n > this.s.length) throw new Bail();
    this.s.length -= n;
  }
  // slot 0 is the top of the stack
  at(i: number): number {
    if (i >= this.s.length) throw new Bail();
    return this.s[this.s.length - i - 1];
  }
  merge(other: Stack) {
    if (this.s.length !== other.s.length) throw new Bail();
    for (let i = this.s.length - 1; i >= 0; i--) this.s[i] = mergeSlot(this.s[i], other.s[i]);
    this.lo |= other.lo;
    this.hi |= other.hi;
  }
  setWritten(i: number) {
    if (i > 63) return;
    if (i < 32) this.lo |= 1 << i;
    else this.hi |= 1 << (i - 32);
  }
  wasWritten(i: number): boolean {
    if (i > 63) return true;
    return (i < 32 ? this.lo & (1 << i) : this.hi & (1 << (i - 32))) !== 0;
  }
}

class Builder {
  readonly m: JMethod;
  readonly c: Uint8Array;
  readonly cp: ClassFile["cp"];
  readonly stacks: (Stack | null)[];
  out = "";
  private entries = 0;
  private addedOne = true;
  private allProcessed = false;

  constructor(m: JMethod, bci: number) {
    this.m = m;
    const code = m.code!;
    this.c = code.code;
    this.cp = m.cls.cf!.cp;
    const len = this.c.length;
    this.stacks = new Array(len + 1).fill(null);
    this.stacks[0] = new Stack();
    for (const h of code.handlers) {
      if (!this.stacks[h.handler]) {
        this.stacks[h.handler] = new Stack();
        this.stacks[h.handler]!.push(h.handler, OBJECT);
      }
    }
    while (!this.allProcessed && this.addedOne) {
      this.allProcessed = true;
      this.addedOne = false;
      for (let i = 0; i < len;) {
        i += this.step(i);
        if (bci === i && this.stacks[i]) {
          this.allProcessed = true;
          break;
        }
        if (this.entries > MAX_ENTRIES) return;
      }
    }
  }

  private merge(bci: number, stack: Stack) {
    const old = this.stacks[bci];
    if (old) stack.merge(old);
    else this.entries += stack.s.length;
    this.stacks[bci] = new Stack(stack);
  }

  private mergeTo(bci: number, stack: Stack) {
    if (!this.stacks[bci]) this.addedOne = true;
    this.merge(bci, stack);
  }

  private refDesc(i: number): string {
    return utf8(this.cp, this.cp[this.cp[i]!.b]!.b);
  }
  private refName(i: number): string {
    return utf8(this.cp, this.cp[this.cp[i]!.b]!.a);
  }

  private step(bci: number): number {
    const c = this.c;
    const len = insnLength(c, bci);
    const old = this.stacks[bci];
    if (!old) {
      this.allProcessed = false;
      return len;
    }
    const st = new Stack(old);
    let dest = -1;
    const dests: number[] = [];
    let ended = false;
    let op = c[bci];
    let pos = bci + 1;
    if (op === 0xc4) {
      op = c[bci + 1];
      pos++;
    }

    if (PUSH[op] >= 0) {
      st.pop(POP[op]);
      st.push(bci, PUSH[op]);
    } else if (op >= 0x36 && op <= 0x4e) {
      let index: number;
      let kind: number;
      if (op <= 0x3a) {
        index = pos !== bci + 1 ? u16(c, bci + 2) : c[bci + 1];
        kind = op - 0x36;
      } else {
        index = (op - 0x3b) & 3;
        kind = (op - 0x3b) >> 2;
      }
      st.setWritten(index);
      st.pop(kind === 1 || kind === 3 ? 2 : 1);
    } else {
      switch (op) {
        case 0x12: case 0x13: case 0x14: {
          const e = this.cp[op === 0x12 ? c[pos] : u16(c, pos)]!;
          if (e.tag === Tag.Integer) st.push(bci, INT);
          else if (e.tag === Tag.Long) st.push(bci, LONG);
          else if (e.tag === Tag.Float) st.push(bci, FLOAT);
          else if (e.tag === Tag.Double) st.push(bci, DOUBLE);
          else if (e.tag === Tag.Dynamic) st.push(bci, descType(utf8(this.cp, this.cp[e.b]!.b)[0]));
          else st.push(bci, OBJECT);
          break;
        }
        case 0x59: st.pushRaw(st.at(0)); break;
        case 0x5a: {
          const t1 = st.at(0), t2 = st.at(1);
          st.pop(2);
          st.pushRaw(t1); st.pushRaw(t2); st.pushRaw(t1);
          break;
        }
        case 0x5b: {
          const t1 = st.at(0), t2 = st.at(1), t3 = st.at(2);
          st.pop(3);
          st.pushRaw(t1); st.pushRaw(t3); st.pushRaw(t2); st.pushRaw(t1);
          break;
        }
        case 0x5c:
          st.pushRaw(st.at(1));
          st.pushRaw(st.at(1));
          break;
        case 0x5d: {
          const t1 = st.at(0), t2 = st.at(1), t3 = st.at(2);
          st.pop(3);
          st.pushRaw(t2); st.pushRaw(t1); st.pushRaw(t3); st.pushRaw(t2); st.pushRaw(t1);
          break;
        }
        case 0x5e: {
          const t1 = st.at(0), t2 = st.at(1), t3 = st.at(2), t4 = st.at(3);
          st.pop(4);
          st.pushRaw(t2); st.pushRaw(t1); st.pushRaw(t4); st.pushRaw(t3); st.pushRaw(t2); st.pushRaw(t1);
          break;
        }
        case 0x5f: {
          const t1 = st.at(0), t2 = st.at(1);
          st.pop(2);
          st.pushRaw(t1);
          st.pushRaw(t2);
          break;
        }
        case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e: case 0xc6: case 0xc7:
          st.pop(1);
          dest = bci + s16(c, pos);
          break;
        case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: case 0xa5: case 0xa6:
          st.pop(2);
          dest = bci + s16(c, pos);
          break;
        case 0xa7:
          dest = bci + s16(c, pos);
          ended = true;
          break;
        case 0xc8:
          dest = bci + s32(c, pos);
          ended = true;
          break;
        case 0xa8:
          st.push(bci, ADDRESS);
          dest = bci + s16(c, pos);
          ended = true;
          break;
        case 0xc9:
          st.push(bci, ADDRESS);
          dest = bci + s32(c, pos);
          ended = true;
          break;
        case 0xa9:
          ended = true;
          break;
        case 0xaa: {
          st.pop(1);
          const p = (pos + 3) & ~3;
          dest = bci + s32(c, p);
          const low = s32(c, p + 4), high = s32(c, p + 8);
          for (let i = low; i <= high; i++) dests.push(bci + s32(c, p + 12 + 4 * (i - low)));
          break;
        }
        case 0xab: {
          st.pop(1);
          const p = (pos + 3) & ~3;
          dest = bci + s32(c, p);
          const n = s32(c, p + 4);
          for (let i = 0; i < n; i++) dests.push(bci + s32(c, p + 12 + 8 * i));
          break;
        }
        case 0xac: case 0xae: case 0xb0: case 0xbf:
          st.pop(1);
          ended = true;
          break;
        case 0xad: case 0xaf:
          st.pop(2);
          ended = true;
          break;
        case 0xb1:
          ended = true;
          break;
        case 0xb2: case 0xb4: {
          if (op === 0xb4) st.pop(1);
          st.push(bci, descType(this.refDesc(u16(c, pos))[0]));
          break;
        }
        case 0xb3: case 0xb5: {
          const size = typeSize(descType(this.refDesc(u16(c, pos))[0]));
          st.pop(op === 0xb3 ? size : size + 1);
          break;
        }
        case 0xb6: case 0xb7: case 0xb8: case 0xb9: case 0xba: {
          const desc = this.refDesc(u16(c, pos));
          if (op !== 0xb8 && op !== 0xba) st.pop(1);
          st.pop(argSlots(desc));
          st.push(bci, descType(desc[desc.indexOf(")") + 1]));
          break;
        }
        case 0xc0: break;
        case 0xc5:
          st.pop(c[pos + 2]);
          st.push(bci, OBJECT);
          break;
        default:
          this.allProcessed = false;
          this.addedOne = false;
          return len;
      }
    }

    if (!ended) this.mergeTo(bci + len, st);
    if (dest !== -1) this.mergeTo(dest, st);
    for (const d of dests) this.mergeTo(d, st);
    return len;
  }

  // Slot of the operand stack holding the null reference, or a negative code.
  nullSlot(bci: number): number {
    const c = this.c;
    let op = c[bci];
    let pos = bci + 1;
    if (op === 0xc4) {
      op = c[bci + 1];
      pos++;
    }
    switch (op) {
      case 0xb4: case 0xbe: case 0xbf: case 0xc2: case 0xc3:
        return 0;
      case 0x2e: case 0x30: case 0x32: case 0x33: case 0x34: case 0x35: case 0x2f: case 0x31:
        return 1;
      case 0x4f: case 0x51: case 0x53: case 0x54: case 0x55: case 0x56:
        return 2;
      case 0x50: case 0x52:
        return 3;
      case 0xb5:
        return typeSize(descType(this.refDesc(u16(c, pos))[0]));
      case 0xb6: case 0xb7: case 0xb9:
        // a constructor cannot throw NullPointerException: it was created explicitly
        if (this.refName(u16(c, pos)) === "<init>") return NPE_EXPLICIT;
        return argSlots(this.refDesc(u16(c, pos)));
      default:
        return NPE_INVALID;
    }
  }

  private methodName(i: number): string {
    const e = this.cp[i]!;
    const desc = this.refDesc(i);
    const params = paramDescs(desc).map(externalType).join(", ");
    return `${klassName(className(this.cp, e.a))}.${this.refName(i)}(${trimWellKnown(params)})`;
  }

  private localVar(bci: number, index: number, isParameter: boolean): string {
    const m = this.m;
    const lv = m.code!.localVars;
    if (lv) {
      for (let n = u16(lv, 0), p = 2; n > 0; n--, p += 10) {
        const start = u16(lv, p);
        if (bci >= start && bci < start + u16(lv, p + 2) && u16(lv, p + 8) === index) {
          return utf8(this.cp, u16(lv, p + 4));
        }
      }
    }
    if (!m.isStatic && index === 0 && isParameter) return "this";
    let curr = m.isStatic ? 0 : 1;
    let paramIndex = 1;
    for (const p of paramDescs(m.desc)) {
      const size = typeSize(descType(p[0]));
      if (index >= curr && index < curr + size) return isParameter ? `<parameter${paramIndex}>` : `<local${index}>`;
      paramIndex++;
      curr += size;
    }
    return `<local${index}>`;
  }

  // Prints what produced the value in `slotNr` before bytecode `bci`.
  private cause0(bci: number, slotNr: number, maxDetail: number, inner = false, prefix?: string): boolean {
    if (maxDetail <= 0) return false;
    const stack = this.stacks[bci];
    if (!stack) return false;
    const data = stack.at(slotNr);
    if (slotBci(data) === INVALID) return false;
    const c = this.c;
    const src = slotBci(data);
    let op = c[src];
    let pos = src + 1;
    let wide = false;
    if (op === 0xc4) {
      wide = true;
      op = c[src + 1];
      pos++;
    }
    const isInvoke = op >= 0xb6 && op <= 0xb9;
    if (maxDetail === MAX_CAUSE_DETAIL && prefix !== undefined && !isInvoke) this.out += prefix;

    let index = -1;
    if (op >= 0x1a && op <= 0x1d) index = op - 0x1a;
    else if (op >= 0x2a && op <= 0x2d) index = op - 0x2a;
    else if (op === 0x15 || op === 0x19) index = wide ? u16(c, src + 2) : c[src + 1];
    if (index >= 0) {
      this.out += this.localVar(src, index, !stack.wasWritten(index));
      return true;
    }

    switch (op) {
      case 0x01: this.out += "null"; return true;
      case 0x02: this.out += "-1"; return true;
      case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08:
        this.out += String(op - 0x03);
        return true;
      case 0x10: this.out += String((c[src + 1] << 24) >> 24); return true;
      case 0x11: this.out += String(u16(c, src + 1)); return true;
      case 0x2e: case 0x32:
        if (!this.cause0(src, 1, maxDetail - 1, inner)) this.out += "<array>";
        this.out += "[";
        if (!this.cause0(src, 0, maxDetail, true)) this.out += "...";
        this.out += "]";
        return true;
      case 0xb2: {
        const i = u16(c, pos);
        this.out += `${klassName(className(this.cp, this.cp[i]!.a))}.${this.refName(i)}`;
        return true;
      }
      case 0xb4:
        if (this.cause0(src, 0, maxDetail - 1, inner)) this.out += ".";
        this.out += this.refName(u16(c, pos));
        return true;
      case 0xb6: case 0xb7: case 0xb8: case 0xb9:
        if (maxDetail === MAX_CAUSE_DETAIL && !inner) this.out += ' because the return value of "';
        this.out += this.methodName(u16(c, pos));
        return true;
      default:
        return false;
    }
  }

  cause(bci: number, slotNr: number) {
    if (this.cause0(bci, slotNr, MAX_CAUSE_DETAIL, false, ' because "')) this.out += '" is null';
  }

  failedAction(bci: number) {
    const c = this.c;
    let op = c[bci];
    let pos = bci + 1;
    if (op === 0xc4) {
      op = c[bci + 1];
      pos++;
    }
    const ARRAYS = ["int", "long", "float", "double", "object", "byte/boolean", "char", "short"];
    if (op >= 0x2e && op <= 0x35) this.out += `Cannot load from ${ARRAYS[op - 0x2e]} array`;
    else if (op >= 0x4f && op <= 0x56) this.out += `Cannot store to ${ARRAYS[op - 0x4f]} array`;
    else if (op === 0xbe) this.out += "Cannot read the array length";
    else if (op === 0xbf) this.out += "Cannot throw exception";
    else if (op === 0xc2) this.out += "Cannot enter synchronized block";
    else if (op === 0xc3) this.out += "Cannot exit synchronized block";
    else if (op === 0xb4) this.out += `Cannot read field "${this.refName(u16(c, pos))}"`;
    else if (op === 0xb5) this.out += `Cannot assign field "${this.refName(u16(c, pos))}"`;
    else this.out += `Cannot invoke "${this.methodName(u16(c, pos))}"`;
  }
}

// Returns null where HotSpot prints no message.
export function npeMessage(m: JMethod, bci: number): string | null {
  try {
    const b = new Builder(m, bci);
    const slotNr = b.nullSlot(bci);
    if (slotNr < 0) return null;
    b.failedAction(bci);
    b.cause(bci, slotNr);
    return b.out;
  } catch {
    return null;
  }
}

export const natives: Natives = {
  "java/lang/NullPointerException.getExtendedNPEMessage()Ljava/lang/String;": (t, [self]) => {
    const bt = t.vm.getField(self, "java/lang/Throwable", "backtrace");
    if (!Array.isArray(bt) || bt.length === 0) return null;
    const { m, pc } = bt[0] as { m: JMethod; pc: number };
    if (m.isNative || !m.code || pc < 0) return null;
    if (m.cls.name === "jdk/internal/reflect/DirectConstructorHandleAccessor$NativeAccessor") return null;
    const msg = npeMessage(m, pc);
    return msg === null ? null : t.vm.str(msg);
  },
};
