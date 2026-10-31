// Bytecode interpreter and the per-thread run loop.

import {
  INITIALIZED, JArray, JClass, JMethod, JObject, isWide, newArrayData,
} from "./runtime.ts";
import {
  Frame, JThread, JavaThrow, NativeFrame, PendingThrow, RUNNABLE, TERMINATED, WAITING, fromNative,
} from "./thread.ts";
import type { NativeGen } from "./thread.ts";
import type { JVM } from "./jvm.ts";
import { compileIfHot, hooks, noteBackedge } from "./jit.ts";

const MAX_FRAMES = 6000;

// Over the limit, a StackOverflowError is thrown with some headroom so it can
// be constructed and handled; the limit drops back once the stack unwinds.
function checkStack(t: JThread) {
  if (t.frames.length < t.stackLimit) return;
  if (t.stackLimit >= 2 * MAX_FRAMES) throw new Error("stack overflow while handling a stack overflow");
  t.stackLimit = t.frames.length + 1500;
  throw new PendingThrow("java/lang/StackOverflowError");
}
const INT_MIN = -2147483648;
const LONG_MIN = -(1n << 63n);
const LONG_MAX = (1n << 63n) - 1n;

const wrap64 = (v: any): bigint => BigInt.asIntN(64, v);

function f2i(v: number) {
  if (v !== v) return 0;
  if (v >= 2147483647) return 2147483647;
  if (v <= INT_MIN) return INT_MIN;
  return v | 0;
}

function f2l(v: number) {
  if (v !== v) return 0n;
  if (v >= 9223372036854775807) return LONG_MAX;
  if (v <= -9223372036854775808) return LONG_MIN;
  return BigInt(Math.trunc(v));
}

function fcmp(a: number, b: number, nan: number) {
  if (a > b) return 1;
  if (a < b) return -1;
  if (a === b) return 0;
  return nan;
}

function npe(): never {
  throw new PendingThrow("java/lang/NullPointerException");
}

function aioobe(i: number, len: number): never {
  throw new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", `Index ${i} out of bounds for length ${len}`);
}

function arr(o: JObject | null, i: number): any {
  if (o === null) npe();
  const a = (o as JArray).a;
  if (i >>> 0 >= a.length) aioobe(i, a.length);
  return a;
}

function divZero(): never {
  throw new PendingThrow("java/lang/ArithmeticException", "/ by zero");
}

// Interprets frame f until it calls out, returns, throws or runs out of budget.
export { MAX_FRAMES };

function findHandlerAt(t: JThread, f: Frame, pc: number, exc: JObject): number {
  const save = f.pc;
  f.pc = pc;
  const h = findHandler(t.vm, f, exc);
  f.pc = save;
  if (h >= 0 && t.frames.length < MAX_FRAMES - 500) t.stackLimit = MAX_FRAMES;
  return h;
}

Object.assign(hooks, {
  interpret: (t: JThread, f: Frame, budget: number) => interpret(t, f, budget),
  deliver: (t: JThread, v: any, ret: string, reexec: boolean) => deliver(t, v, ret, reexec),
  raise: (t: JThread, exc: JObject) => raise(t, exc),
  handleError: (t: JThread, e: unknown) => handleError(t, e),
  popFrame: (t: JThread, f: Frame) => popFrame(t, f),
  findHandler: findHandlerAt,
  checkStack: (t: JThread) => checkStack(t),
});

export function interpret(t: JThread, f: Frame, budget: number): number {
  const vm = t.vm;
  const m = f.m;
  const cls = m.cls;
  const code = f.code;
  const locals = f.locals;
  const stack = f.stack;
  let pc = f.pc;
  let sp = f.sp;
  let ipc = pc;
  let v: any, w: any, x: any, idx: number, o: any;
  try {
    while (budget-- > 0) {
      ipc = pc;
      switch (code[pc]) {
        case 0x00: pc++; break;
        case 0x01: stack[sp++] = null; pc++; break;
        case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08:
          stack[sp++] = code[pc] - 3; pc++; break;
        case 0x09: case 0x0a: stack[sp++] = BigInt(code[pc] - 0x09); stack[sp++] = undefined; pc++; break;
        case 0x0b: case 0x0c: case 0x0d: stack[sp++] = code[pc] - 0x0b; pc++; break;
        case 0x0e: case 0x0f: stack[sp++] = code[pc] - 0x0e; stack[sp++] = undefined; pc++; break;
        case 0x10: stack[sp++] = (code[pc + 1] << 24) >> 24; pc += 2; break;
        case 0x11: stack[sp++] = (((code[pc + 1] << 8) | code[pc + 2]) << 16) >> 16; pc += 3; break;
        case 0x12: case 0x13: case 0x14: {
          const op = code[pc];
          idx = op === 0x12 ? code[pc + 1] : (code[pc + 1] << 8) | code[pc + 2];
          v = cls.ldc[idx];
          if (v === undefined) {
            v = vm.constant(t, cls, idx);
            if (v === undefined) { f.pc = ipc; f.sp = sp; return budget; }
          }
          stack[sp++] = v;
          if (op === 0x14) stack[sp++] = undefined;
          pc += op === 0x12 ? 2 : 3;
          break;
        }
        case 0x15: case 0x17: case 0x19: stack[sp++] = locals[code[pc + 1]]; pc += 2; break;
        case 0x16: case 0x18: stack[sp++] = locals[code[pc + 1]]; stack[sp++] = undefined; pc += 2; break;
        case 0x1a: case 0x1b: case 0x1c: case 0x1d: stack[sp++] = locals[code[pc] - 0x1a]; pc++; break;
        case 0x1e: case 0x1f: case 0x20: case 0x21:
          stack[sp++] = locals[code[pc] - 0x1e]; stack[sp++] = undefined; pc++; break;
        case 0x22: case 0x23: case 0x24: case 0x25: stack[sp++] = locals[code[pc] - 0x22]; pc++; break;
        case 0x26: case 0x27: case 0x28: case 0x29:
          stack[sp++] = locals[code[pc] - 0x26]; stack[sp++] = undefined; pc++; break;
        case 0x2a: case 0x2b: case 0x2c: case 0x2d: stack[sp++] = locals[code[pc] - 0x2a]; pc++; break;
        // array loads
        case 0x2e: case 0x30: case 0x32: case 0x33: case 0x34: case 0x35:
          idx = stack[--sp]; o = stack[--sp];
          stack[sp++] = arr(o, idx)[idx]; pc++; break;
        case 0x2f: case 0x31:
          idx = stack[--sp]; o = stack[--sp];
          stack[sp++] = arr(o, idx)[idx]; stack[sp++] = undefined; pc++; break;
        case 0x36: case 0x38: case 0x3a: locals[code[pc + 1]] = stack[--sp]; pc += 2; break;
        case 0x37: case 0x39: sp -= 2; locals[code[pc + 1]] = stack[sp]; pc += 2; break;
        case 0x3b: case 0x3c: case 0x3d: case 0x3e: locals[code[pc] - 0x3b] = stack[--sp]; pc++; break;
        case 0x3f: case 0x40: case 0x41: case 0x42: sp -= 2; locals[code[pc] - 0x3f] = stack[sp]; pc++; break;
        case 0x43: case 0x44: case 0x45: case 0x46: locals[code[pc] - 0x43] = stack[--sp]; pc++; break;
        case 0x47: case 0x48: case 0x49: case 0x4a: sp -= 2; locals[code[pc] - 0x47] = stack[sp]; pc++; break;
        case 0x4b: case 0x4c: case 0x4d: case 0x4e: locals[code[pc] - 0x4b] = stack[--sp]; pc++; break;
        // array stores
        case 0x4f: case 0x51: case 0x54: case 0x55: case 0x56:
          v = stack[--sp]; idx = stack[--sp]; o = stack[--sp];
          arr(o, idx)[idx] = v; pc++; break;
        case 0x50: case 0x52:
          sp -= 2; v = stack[sp]; idx = stack[--sp]; o = stack[--sp];
          arr(o, idx)[idx] = v; pc++; break;
        case 0x53:
          v = stack[--sp]; idx = stack[--sp]; o = stack[--sp];
          w = arr(o, idx);
          if (v !== null && !v.cls.isAssignableTo(o.cls.component)) {
            throw new PendingThrow("java/lang/ArrayStoreException", v.cls.javaName);
          }
          w[idx] = v; pc++; break;
        // stack ops
        case 0x57: sp--; pc++; break;
        case 0x58: sp -= 2; pc++; break;
        case 0x59: stack[sp] = stack[sp - 1]; sp++; pc++; break;
        case 0x5a: v = stack[sp - 1]; w = stack[sp - 2];
          stack[sp - 2] = v; stack[sp - 1] = w; stack[sp] = v; sp++; pc++; break;
        case 0x5b: v = stack[sp - 1]; w = stack[sp - 2]; x = stack[sp - 3];
          stack[sp - 3] = v; stack[sp - 2] = x; stack[sp - 1] = w; stack[sp] = v; sp++; pc++; break;
        case 0x5c: stack[sp] = stack[sp - 2]; stack[sp + 1] = stack[sp - 1]; sp += 2; pc++; break;
        case 0x5d: { // dup2_x1: c b a -> b a c b a
          const a1 = stack[sp - 1], b1 = stack[sp - 2], c1 = stack[sp - 3];
          stack[sp - 3] = b1; stack[sp - 2] = a1; stack[sp - 1] = c1; stack[sp] = b1; stack[sp + 1] = a1;
          sp += 2; pc++; break;
        }
        case 0x5e: { // dup2_x2: d c b a -> b a d c b a
          const a1 = stack[sp - 1], b1 = stack[sp - 2], c1 = stack[sp - 3], d1 = stack[sp - 4];
          stack[sp - 4] = b1; stack[sp - 3] = a1; stack[sp - 2] = d1; stack[sp - 1] = c1;
          stack[sp] = b1; stack[sp + 1] = a1; sp += 2; pc++; break;
        }
        case 0x5f: v = stack[sp - 1]; stack[sp - 1] = stack[sp - 2]; stack[sp - 2] = v; pc++; break;
        // arithmetic
        case 0x60: v = stack[--sp]; stack[sp - 1] = (stack[sp - 1] + v) | 0; pc++; break;
        case 0x61: sp -= 2; stack[sp - 2] = wrap64(stack[sp - 2] + stack[sp]); pc++; break;
        case 0x62: v = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] + v); pc++; break;
        case 0x63: sp -= 2; stack[sp - 2] += stack[sp]; pc++; break;
        case 0x64: v = stack[--sp]; stack[sp - 1] = (stack[sp - 1] - v) | 0; pc++; break;
        case 0x65: sp -= 2; stack[sp - 2] = wrap64(stack[sp - 2] - stack[sp]); pc++; break;
        case 0x66: v = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] - v); pc++; break;
        case 0x67: sp -= 2; stack[sp - 2] -= stack[sp]; pc++; break;
        case 0x68: v = stack[--sp]; stack[sp - 1] = Math.imul(stack[sp - 1], v); pc++; break;
        case 0x69: sp -= 2; stack[sp - 2] = wrap64(stack[sp - 2] * stack[sp]); pc++; break;
        case 0x6a: v = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] * v); pc++; break;
        case 0x6b: sp -= 2; stack[sp - 2] *= stack[sp]; pc++; break;
        case 0x6c: v = stack[sp - 1]; if (v === 0) divZero();
          sp--; stack[sp - 1] = (stack[sp - 1] / v) | 0; pc++; break;
        case 0x6d: v = stack[sp - 2]; if (v === 0n) divZero();
          sp -= 2; stack[sp - 2] = wrap64(stack[sp - 2] / v); pc++; break;
        case 0x6e: v = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] / v); pc++; break;
        case 0x6f: sp -= 2; stack[sp - 2] /= stack[sp]; pc++; break;
        case 0x70: v = stack[sp - 1]; if (v === 0) divZero();
          sp--; stack[sp - 1] = (stack[sp - 1] % v) | 0; pc++; break;
        case 0x71: v = stack[sp - 2]; if (v === 0n) divZero();
          sp -= 2; stack[sp - 2] = stack[sp - 2] % v; pc++; break;
        case 0x72: v = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] % v); pc++; break;
        case 0x73: sp -= 2; stack[sp - 2] %= stack[sp]; pc++; break;
        case 0x74: stack[sp - 1] = (-stack[sp - 1]) | 0; pc++; break;
        case 0x75: stack[sp - 2] = wrap64(-stack[sp - 2]); pc++; break;
        case 0x76: stack[sp - 1] = -stack[sp - 1]; pc++; break;
        case 0x77: stack[sp - 2] = -stack[sp - 2]; pc++; break;
        case 0x78: v = stack[--sp]; stack[sp - 1] = stack[sp - 1] << v; pc++; break;
        case 0x79: v = stack[--sp]; stack[sp - 2] = wrap64(stack[sp - 2] << BigInt(v & 63)); pc++; break;
        case 0x7a: v = stack[--sp]; stack[sp - 1] = stack[sp - 1] >> v; pc++; break;
        case 0x7b: v = stack[--sp]; stack[sp - 2] = stack[sp - 2] >> BigInt(v & 63); pc++; break;
        case 0x7c: v = stack[--sp]; stack[sp - 1] = (stack[sp - 1] >>> v) | 0; pc++; break;
        case 0x7d: v = stack[--sp];
          stack[sp - 2] = wrap64(BigInt.asUintN(64, stack[sp - 2]) >> BigInt(v & 63)); pc++; break;
        case 0x7e: v = stack[--sp]; stack[sp - 1] &= v; pc++; break;
        case 0x7f: sp -= 2; stack[sp - 2] &= stack[sp]; pc++; break;
        case 0x80: v = stack[--sp]; stack[sp - 1] |= v; pc++; break;
        case 0x81: sp -= 2; stack[sp - 2] |= stack[sp]; pc++; break;
        case 0x82: v = stack[--sp]; stack[sp - 1] ^= v; pc++; break;
        case 0x83: sp -= 2; stack[sp - 2] ^= stack[sp]; pc++; break;
        case 0x84: locals[code[pc + 1]] = (locals[code[pc + 1]] + ((code[pc + 2] << 24) >> 24)) | 0; pc += 3; break;
        // conversions
        case 0x85: stack[sp - 1] = BigInt(stack[sp - 1]); stack[sp++] = undefined; pc++; break;
        case 0x86: stack[sp - 1] = Math.fround(stack[sp - 1]); pc++; break;
        case 0x87: stack[sp++] = undefined; pc++; break;
        case 0x88: sp--; stack[sp - 1] = Number(BigInt.asIntN(32, stack[sp - 1])); pc++; break;
        case 0x89: sp--; stack[sp - 1] = Math.fround(Number(stack[sp - 1])); pc++; break;
        case 0x8a: stack[sp - 2] = Number(stack[sp - 2]); pc++; break;
        case 0x8b: stack[sp - 1] = f2i(stack[sp - 1]); pc++; break;
        case 0x8c: stack[sp - 1] = f2l(stack[sp - 1]); stack[sp++] = undefined; pc++; break;
        case 0x8d: stack[sp++] = undefined; pc++; break;
        case 0x8e: sp--; stack[sp - 1] = f2i(stack[sp - 1]); pc++; break;
        case 0x8f: stack[sp - 2] = f2l(stack[sp - 2]); pc++; break;
        case 0x90: sp--; stack[sp - 1] = Math.fround(stack[sp - 1]); pc++; break;
        case 0x91: stack[sp - 1] = (stack[sp - 1] << 24) >> 24; pc++; break;
        case 0x92: stack[sp - 1] &= 0xffff; pc++; break;
        case 0x93: stack[sp - 1] = (stack[sp - 1] << 16) >> 16; pc++; break;
        // comparisons
        case 0x94: sp -= 3; v = stack[sp - 1]; w = stack[sp + 1];
          stack[sp - 1] = v > w ? 1 : v < w ? -1 : 0; pc++; break;
        case 0x95: case 0x96: v = stack[--sp];
          stack[sp - 1] = fcmp(stack[sp - 1], v, code[pc] === 0x95 ? -1 : 1); pc++; break;
        case 0x97: case 0x98: sp -= 3; v = stack[sp + 1];
          stack[sp - 1] = fcmp(stack[sp - 1], v, code[pc] === 0x97 ? -1 : 1); pc++; break;
        case 0x99: if (stack[--sp] === 0) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0x9a: if (stack[--sp] !== 0) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0x9b: if (stack[--sp] < 0) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0x9c: if (stack[--sp] >= 0) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0x9d: if (stack[--sp] > 0) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0x9e: if (stack[--sp] <= 0) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0x9f: case 0xa5: sp -= 2; if (stack[sp] === stack[sp + 1]) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0xa0: case 0xa6: sp -= 2; if (stack[sp] !== stack[sp + 1]) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0xa1: sp -= 2; if (stack[sp] < stack[sp + 1]) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0xa2: sp -= 2; if (stack[sp] >= stack[sp + 1]) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0xa3: sp -= 2; if (stack[sp] > stack[sp + 1]) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0xa4: sp -= 2; if (stack[sp] <= stack[sp + 1]) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0xa7: v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; break;
        case 0xa8: stack[sp++] = pc + 3; pc += s16(code, pc); break;
        case 0xa9: pc = locals[code[pc + 1]]; break;
        case 0xaa: { // tableswitch
          let p = (pc + 4) & ~3;
          const def = s32(code, p), lo = s32(code, p + 4), hi = s32(code, p + 8);
          v = stack[--sp];
          pc += v < lo || v > hi ? def : s32(code, p + 12 + (v - lo) * 4);
          break;
        }
        case 0xab: { // lookupswitch
          let p = (pc + 4) & ~3;
          const def = s32(code, p), n = s32(code, p + 4);
          v = stack[--sp];
          let lo = 0, hi = n - 1, off = def;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1, key = s32(code, p + 8 + mid * 8);
            if (key === v) { off = s32(code, p + 12 + mid * 8); break; }
            if (key < v) lo = mid + 1; else hi = mid - 1;
          }
          pc += off;
          break;
        }
        // returns
        case 0xac: case 0xae: case 0xb0:
          v = stack[sp - 1];
          popFrame(t, f);
          deliver(t, v, m.ret, false);
          return budget;
        case 0xad: case 0xaf:
          v = stack[sp - 2];
          popFrame(t, f);
          deliver(t, v, m.ret, false);
          return budget;
        case 0xb1:
          popFrame(t, f);
          deliver(t, undefined, "V", false);
          return budget;
        // fields
        case 0xb2: case 0xb3: {
          idx = (code[pc + 1] << 8) | code[pc + 2];
          const fld = cls.rcp[idx] ?? vm.fieldRef(t, cls, idx);
          if (fld === undefined) { f.pc = ipc; f.sp = sp; return budget; }
          const fc = fld.cls;
          if (fc.state !== INITIALIZED && !vm.initialize(t, fc)) { f.pc = ipc; f.sp = sp; return budget; }
          if (code[pc] === 0xb2) {
            stack[sp++] = fc.statics[fld.slot];
            if (fld.wide) stack[sp++] = undefined;
          } else {
            if (fld.wide) sp--;
            fc.statics[fld.slot] = stack[--sp];
          }
          pc += 3;
          break;
        }
        case 0xb4: {
          idx = (code[pc + 1] << 8) | code[pc + 2];
          const fld = cls.rcp[idx] ?? vm.fieldRef(t, cls, idx);
          if (fld === undefined) { f.pc = ipc; f.sp = sp; return budget; }
          o = stack[sp - 1];
          if (o === null) npe();
          stack[sp - 1] = o.f[fld.slot];
          if (fld.wide) stack[sp++] = undefined;
          pc += 3;
          break;
        }
        case 0xb5: {
          idx = (code[pc + 1] << 8) | code[pc + 2];
          const fld = cls.rcp[idx] ?? vm.fieldRef(t, cls, idx);
          if (fld === undefined) { f.pc = ipc; f.sp = sp; return budget; }
          if (fld.wide) sp--;
          v = stack[--sp];
          o = stack[--sp];
          if (o === null) npe();
          o.f[fld.slot] = v;
          pc += 3;
          break;
        }
        // invokes
        case 0xb6: case 0xb7: case 0xb8: case 0xb9: {
          const op = code[pc];
          idx = (code[pc + 1] << 8) | code[pc + 2];
          let target: JMethod | undefined = cls.rcp[idx] ?? vm.methodRef(t, cls, idx);
          if (target === undefined) { f.pc = ipc; f.sp = sp; return budget; }
          if (op === 0xb8) {
            const tc = target.cls;
            if (tc.state !== INITIALIZED && !vm.initialize(t, tc)) { f.pc = ipc; f.sp = sp; return budget; }
            if (target.polymorphic) {
              f.pc = ipc; f.sp = sp;
              if (vm.invokePolymorphic(t, f, target, idx)) { pc = f.pc; sp = f.sp; break; }
              return budget;
            }
          } else {
            if (target.polymorphic) {
              f.pc = ipc; f.sp = sp;
              if (vm.invokePolymorphic(t, f, target, idx)) { pc = f.pc; sp = f.sp; break; }
              return budget;
            }
            o = stack[sp - target.argSlots];
            if (o === null) npe();
            if (op === 0xb7) {
              target = vm.specialTarget(cls, target);
            } else if (!target.isPrivate) {
              const cache = m.cache ??= [];
              const ic = cache[ipc];
              if (ic !== undefined && ic.c === o.cls) target = ic.m;
              else {
                const sel = o.cls.selectMethod(target.key);
                if (!sel) throw new PendingThrow("java/lang/AbstractMethodError", `${o.cls.javaName}.${target.name}${target.desc}`);
                cache[ipc] = { c: o.cls, m: sel };
                target = sel;
              }
            }
          }
          f.pc = ipc; f.sp = sp;
          if (invoke(t, f, target as JMethod)) { pc = f.pc; sp = f.sp; break; }
          return budget;
        }
        case 0xba: {
          f.pc = ipc; f.sp = sp;
          const site = vm.callSite(t, f, (code[pc + 1] << 8) | code[pc + 2]);
          if (site === undefined) return budget;
          if (site.appendix !== undefined) f.stack[f.sp++] = site.appendix;
          if (invoke(t, f, site.m)) { pc = f.pc; sp = f.sp; break; }
          return budget;
        }
        // objects
        case 0xbb: {
          idx = (code[pc + 1] << 8) | code[pc + 2];
          const c: JClass | undefined = cls.rcp[idx] ?? vm.classRef(t, cls, idx);
          if (c === undefined) { f.pc = ipc; f.sp = sp; return budget; }
          if (c.state !== INITIALIZED && !vm.initialize(t, c)) { f.pc = ipc; f.sp = sp; return budget; }
          if (c.access & 0x0600) throw new PendingThrow("java/lang/InstantiationError", c.javaName);
          stack[sp++] = new JObject(c, c.template.slice());
          pc += 3;
          break;
        }
        case 0xbc: {
          v = stack[sp - 1];
          if (v < 0) throw new PendingThrow("java/lang/NegativeArraySizeException", String(v));
          const elem = "?ZCFDBSIJ"[code[pc + 1] - 3];
          stack[sp - 1] = new JArray(vm.primArrayClass(elem), newArrayData(elem, v));
          pc += 2;
          break;
        }
        case 0xbd: {
          idx = (code[pc + 1] << 8) | code[pc + 2];
          const c: JClass | undefined = cls.rcp[idx] ?? vm.classRef(t, cls, idx);
          if (c === undefined) { f.pc = ipc; f.sp = sp; return budget; }
          v = stack[sp - 1];
          if (v < 0) throw new PendingThrow("java/lang/NegativeArraySizeException", String(v));
          stack[sp - 1] = new JArray(vm.arrayOf(c), newArrayData("L", v));
          pc += 3;
          break;
        }
        case 0xbe:
          o = stack[sp - 1];
          if (o === null) npe();
          stack[sp - 1] = o.a.length;
          pc++;
          break;
        case 0xbf:
          o = stack[sp - 1];
          if (o === null) npe();
          throw new JavaThrow(o);
        case 0xc0: case 0xc1: {
          idx = (code[pc + 1] << 8) | code[pc + 2];
          o = stack[sp - 1];
          const isCast = code[pc] === 0xc0;
          if (o === null) {
            if (!isCast) stack[sp - 1] = 0;
            pc += 3;
            break;
          }
          const c: JClass | undefined = cls.rcp[idx] ?? vm.classRef(t, cls, idx);
          if (c === undefined) { f.pc = ipc; f.sp = sp; return budget; }
          const ok = o.cls === c || o.cls.isAssignableTo(c);
          if (isCast) {
            if (!ok) {
              throw new PendingThrow("java/lang/ClassCastException", vm.castMessage(o.cls, c));
            }
          } else stack[sp - 1] = ok ? 1 : 0;
          pc += 3;
          break;
        }
        case 0xc2:
          o = stack[sp - 1];
          if (o === null) npe();
          if (!vm.monitorEnter(t, o)) { f.pc = ipc; f.sp = sp; return budget; }
          sp--;
          pc++;
          break;
        case 0xc3:
          o = stack[--sp];
          if (o === null) npe();
          vm.monitorExit(t, o);
          pc++;
          break;
        case 0xc4: { // wide
          const op = code[pc + 1];
          idx = (code[pc + 2] << 8) | code[pc + 3];
          switch (op) {
            case 0x15: case 0x17: case 0x19: stack[sp++] = locals[idx]; break;
            case 0x16: case 0x18: stack[sp++] = locals[idx]; stack[sp++] = undefined; break;
            case 0x36: case 0x38: case 0x3a: locals[idx] = stack[--sp]; break;
            case 0x37: case 0x39: sp -= 2; locals[idx] = stack[sp]; break;
            case 0x84: locals[idx] = (locals[idx] + ((((code[pc + 4] << 8) | code[pc + 5]) << 16) >> 16)) | 0;
              pc += 2; break;
            case 0xa9: pc = locals[idx]; continue;
            default: throw new Error(`bad wide opcode ${op}`);
          }
          pc += 4;
          break;
        }
        case 0xc5: {
          idx = (code[pc + 1] << 8) | code[pc + 2];
          const c: JClass | undefined = cls.rcp[idx] ?? vm.classRef(t, cls, idx);
          if (c === undefined) { f.pc = ipc; f.sp = sp; return budget; }
          const dims = code[pc + 3];
          const counts: number[] = [];
          for (let i = 0; i < dims; i++) counts.unshift(stack[--sp]);
          for (const n of counts) if (n < 0) throw new PendingThrow("java/lang/NegativeArraySizeException", String(n));
          stack[sp++] = vm.multiArray(c, counts);
          pc += 4;
          break;
        }
        case 0xc6: if (stack[--sp] === null) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0xc7: if (stack[--sp] !== null) { v = s16(code, pc); pc += v; if (v < 0 && backedge(t, f, pc, sp)) return budget; } else pc += 3; break;
        case 0xc8: pc += s32(code, pc + 1); break;
        case 0xc9: stack[sp++] = pc + 5; pc += s32(code, pc + 1); break;
        default:
          throw new Error(`unknown opcode 0x${code[pc].toString(16)} at ${m}:${pc}`);
      }
    }
    f.pc = pc;
    f.sp = sp;
    return budget;
  } catch (e) {
    f.pc = ipc;
    f.sp = sp;
    handleError(t, e);
    return budget;
  }
}

// Counts a taken backward branch; true when the method got compiled and the
// run loop should switch to the compiled code at the branch target.
function backedge(t: JThread, f: Frame, pc: number, sp: number): boolean {
  const m = f.m;
  if (m.jit === null) {
    if (m.noJit) return false;
    noteBackedge(t, m);
    if (m.jit === null) return false;
  }
  f.pc = pc;
  f.sp = sp;
  return true;
}

function s16(code: Uint8Array, pc: number) {
  return (((code[pc + 1] << 8) | code[pc + 2]) << 16) >> 16;
}

function s32(code: Uint8Array, p: number) {
  return (code[p] << 24) | (code[p + 1] << 16) | (code[p + 2] << 8) | code[p + 3];
}

// Pops the arguments for m off f's stack and calls it. Returns true when the
// call finished synchronously and f can keep running.
export function invoke(t: JThread, f: Frame, m: JMethod): boolean {
  const n = m.argSlots;
  const base = f.sp - n;
  const stack = f.stack;
  if (m.code) {
    checkStack(t);
    if (m.jit === null && !m.noJit) compileIfHot(t, m);
    const callee = new Frame(m);
    const locals = callee.locals;
    for (let i = 0; i < n; i++) locals[i] = stack[base + i];
    f.sp = base;
    if (m.isSynchronized) lockFrame(t, callee, m.isStatic ? t.vm.mirror(m.cls) : locals[0]);
    t.frames.push(callee);
    return false;
  }
  const args: any[] = [];
  let i = base;
  if (!m.isStatic) args.push(stack[i++]);
  for (const p of m.params) {
    args.push(stack[i]);
    i += isWide(p) ? 2 : 1;
  }
  f.sp = base;
  return callNative(t, m, args);
}

// Calls a native or abstract method. True when it completed synchronously
// and its result has been delivered.
function callNative(t: JThread, m: JMethod, args: any[]): boolean {
  if (m.isAbstract) throw new PendingThrow("java/lang/AbstractMethodError", `${m.cls.javaName}.${m.name}${m.desc}`);
  const fn = m.native ?? t.vm.bindNative(m);
  let r;
  try {
    r = fn(t, args);
  } catch (e) {
    throw fromNative(e, m);
  }
  if (isGenerator(r)) {
    t.pushNative(r, m, m.ret, false);
    return false;
  }
  deliver(t, r, m.ret, false);
  return true;
}

function isGenerator(r: any): r is NativeGen {
  return r !== null && typeof r === "object" && typeof r.next === "function" && typeof r.throw === "function";
}

function lockFrame(t: JThread, f: Frame, o: JObject) {
  f.lock = o;
  f.needLock = !t.vm.monitorEnter(t, o);
}

function popFrame(t: JThread, f: Frame) {
  t.frames.pop();
  if (f.lock) t.vm.monitorExit(t, f.lock);
}

function normalize(v: any, ret: string): any {
  if (ret === "Z" && typeof v === "boolean") return v ? 1 : 0;
  return v;
}

// Hands a return value to whatever frame is now on top.
export function deliver(t: JThread, v: any, ret: string, reexec: boolean) {
  const c = t.top;
  if (c === undefined) return;
  if (c instanceof NativeFrame) {
    c.input = normalize(v, ret);
    return;
  }
  if (reexec) return;
  if (ret !== "V") {
    c.stack[c.sp++] = normalize(v, ret);
    if (ret === "J" || ret === "D") c.stack[c.sp++] = undefined;
  }
  c.pc += c.code[c.pc] >= 0xb9 ? 5 : 3;
}

// Unwinds to the nearest handler for exc.
export function raise(t: JThread, exc: JObject) {
  while (t.frames.length > 0) {
    const f = t.top;
    if (f instanceof NativeFrame) {
      f.thrown = exc;
      return;
    }
    const h = findHandler(t.vm, f, exc);
    if (h >= 0) {
      if (t.frames.length < MAX_FRAMES - 500) t.stackLimit = MAX_FRAMES;
      f.sp = 0;
      f.stack[f.sp++] = exc;
      f.pc = h;
      return;
    }
    popFrame(t, f);
  }
}

function findHandler(vm: JVM, f: Frame, exc: JObject): number {
  const handlers = f.m.code!.handlers;
  const pc = f.pc;
  for (const h of handlers) {
    if (pc < h.start || pc >= h.end) continue;
    if (h.catchType === 0) return h.handler;
    const name = vm.cpClassName(f.m.cls, h.catchType);
    for (let c: JClass | null = exc.cls; c; c = c.superclass) if (c.name === name) return h.handler;
  }
  return -1;
}

export function handleError(t: JThread, e: unknown) {
  if (e instanceof JavaThrow) raise(t, e.obj);
  else if (e instanceof PendingThrow) t.vm.throwNew(t, e.cls, e.msg, e.ctor, e.native);
  else t.vm.internalError(t, e);
}

// Feeds a native frame its pending input and acts on what it yields.
function stepNative(t: JThread, f: NativeFrame) {
  let r: IteratorResult<any, any>;
  try {
    if (f.thrown) {
      const e = f.thrown;
      f.thrown = null;
      r = f.gen.throw(new JavaThrow(e));
    } else {
      const v = f.input;
      f.input = undefined;
      r = f.gen.next(v);
    }
  } catch (e) {
    t.frames.pop();
    handleError(t, f.m ? fromNative(e, f.m) : e);
    return;
  }
  if (r.done) {
    t.frames.pop();
    deliver(t, r.value, f.ret, f.reexec);
    return;
  }
  const req = r.value;
  if (req.kind === "invoke") {
    const m: JMethod = req.m;
    const args: any[] = req.args;
    try {
      if (m.code) {
        checkStack(t);
        const callee = new Frame(m);
        let slot = 0;
        if (!m.isStatic) callee.locals[slot++] = args[0];
        const off = m.isStatic ? 0 : 1;
        for (let i = 0; i < m.params.length; i++) {
          callee.locals[slot] = args[i + off];
          slot += isWide(m.params[i]) ? 2 : 1;
        }
        if (m.isSynchronized) lockFrame(t, callee, m.isStatic ? t.vm.mirror(m.cls) : args[0]);
        t.frames.push(callee);
      } else {
        callNative(t, m, args);
      }
    } catch (e) {
      handleError(t, e);
    }
  } else if (req.kind === "wait") {
    t.state = WAITING;
    req.promise.then(
      (v: any) => { f.input = v; t.vm.wake(t); },
      (e: any) => {
        if (e instanceof JavaThrow) f.thrown = e.obj;
        else if (e instanceof PendingThrow) t.vm.throwNew(t, e.cls, e.msg, e.ctor);
        else t.vm.internalError(t, e);
        t.vm.wake(t);
      },
    );
  }
}

const entryStats = typeof process !== "undefined" && process.env?.JW_JIT_STATS ? new Map<string, number>() : null;
if (entryStats) process.on("exit", () => {
  console.error("-- run loop entries into compiled code");
  for (const [k, v] of [...entryStats].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.error(String(v).padStart(8), k);
});

// Counts an entry into compiled code by the caller that made it.
function countEntry(t: JThread, f: Frame) {
  const c = t.frames[t.frames.length - 2];
  const caller = c instanceof Frame
    ? `${c.m} @${c.pc} op=${c.code[c.pc]?.toString(16)} ${c.m.jit ? "jit" : c.m.noJit ? "nojit" : "interp"}`
    : "native";
  const k = `${f.m.name} @${f.pc} from ${caller}`;
  entryStats!.set(k, (entryStats!.get(k) ?? 0) + 1);
}

// Runs t for up to budget instructions.
export function runThread(t: JThread, budget: number) {
  while (budget > 0 && t.state === RUNNABLE) {
    const f = t.top;
    if (f === undefined) {
      terminate(t);
      return;
    }
    if (f instanceof NativeFrame) {
      stepNative(t, f);
      budget--;
      continue;
    }
    if (f.needLock) {
      if (!t.vm.monitorEnter(t, f.lock!)) return;
      f.needLock = false;
    }
    const jit = f.m.jit;
    if (jit !== null) {
      if (entryStats) countEntry(t, f);
      t.base = t.frames.length;
      try {
        jit(t, f);
      } catch (e) {
        handleError(t, e);
      }
      budget -= 4000;
    } else budget = interpret(t, f, budget);
  }
  if (t.frames.length === 0 && t.state !== TERMINATED) terminate(t);
}

// The VM forgets a finished thread, so its Thread object and thread locals can be collected.
function terminate(t: JThread) {
  t.state = TERMINATED;
  t.vm.threads.delete(t);
  t.onExit?.();
}
