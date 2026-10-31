// Baseline JIT: compiles a hot method's bytecode to a JS function.
//
// Compiled code keeps the interpreter's frame model. Locals and operand
// stack slots become JS variables; at any point where the thread may have to
// wait (calls into interpreted code, class initialization, contention,
// natives that call back into Java) the code spills them into its Frame and
// returns SUSPEND, and the run loop carries on. Re-entry is by pc: branch and
// handler targets and the pcs the code leaves at are cases of the dispatch
// switch; a frame the interpreter left anywhere else steps to the next one.
//
// Calls from compiled code to compiled code are direct JS calls with a fresh
// Frame on the thread's stack (so stack walks still see it). A callee that
// returns normally hands its value back in t.ret; one that suspends makes the
// caller spill too, and later delivers its result through the frame like an
// interpreted call.

import { Tag, utf8 } from "./classfile.ts";
import {
  ACC_FINAL, INITIALIZED, JArray, JClass, JField, JMethod, JObject, isWide, newArrayData, parseMethodDesc,
} from "./runtime.ts";
import { memberTarget } from "./natives/invoke.ts";
import { concatStrings } from "./natives/strings.ts";
import { Frame, JavaThrow, NativeFrame, PendingThrow, fromNative } from "./thread.ts";
import type { JThread } from "./thread.ts";

export const RET = 0, SUSPEND = 1;
export type Compiled = (t: JThread, f: Frame) => number;

const THRESHOLD = 500;
const BACKEDGE_THRESHOLD = 2000;
const MAX_CODE = 6000;
// compiled frames nested on one JS stack before calls go through the run loop
const MAX_DIRECT = 120;
const MAX_FALLBACKS = 5000;
// callees inlined as regions: bytecode outside throw-only blocks (HotSpot's
// MaxInlineSize), nesting, and bytecode inlined into one compiled method
const MAX_INLINE_BYTES = 35;
const MAX_INLINE_DEPTH = 5;
const MAX_INLINED = 500;
// deopts after which a callee is no longer inlined, as HotSpot recompiles
// after repeated uncommon traps
const MAX_DEOPTS = 20;

// filled in by interp.ts to avoid a module cycle
export const hooks = {
  interpret: null as unknown as (t: JThread, f: Frame, budget: number) => number,
  deliver: null as unknown as (t: JThread, v: any, ret: string, reexec: boolean) => void,
  raise: null as unknown as (t: JThread, exc: JObject) => void,
  handleError: null as unknown as (t: JThread, e: unknown) => void,
  popFrame: null as unknown as (t: JThread, f: Frame) => void,
  findHandler: null as unknown as (t: JThread, f: Frame, pc: number, exc: JObject) => number,
  checkStack: null as unknown as (t: JThread) => void,
};

let disabled = typeof process !== "undefined" && !!process.env?.JW_NOJIT;
const noInline = typeof process !== "undefined" && !!process.env?.JW_NOINLINE;
const dump = typeof process !== "undefined" ? process.env?.JW_JIT_DUMP : undefined;

export function compileIfHot(t: JThread, m: JMethod) {
  if (++m.hot >= THRESHOLD) compile(t, m);
}

export function noteBackedge(t: JThread, m: JMethod) {
  m.hot += 4;
  if (m.hot >= BACKEDGE_THRESHOLD && m.jit === null && !m.noJit) compile(t, m);
}

function compile(t: JThread, m: JMethod) {
  if (disabled || m.noJit || !m.code || m.name === "<clinit>" || m.code.code.length > MAX_CODE) return;
  try {
    const { src, consts } = generate(t, m);
    if (dump && m.toString().includes(dump)) console.error(`// ${m}\n${src}`);
    m.jit = new Function("rt", "K", src)(runtime, consts) as Compiled;
    if (stats) stats.set(`compiled ${m}`, src.length);
    m.fallbacks = 0;
  } catch (e) {
    if (e instanceof EvalError || (e instanceof Error && /unsafe-eval|Content Security/i.test(e.message))) disabled = true;
    if (!(e instanceof Unsupported)) t.vm.debug("jit failed for", m.toString(), e);
    if (stats) stats.set(`nojit ${m}: ${e instanceof Error ? e.message : e}`, 1e9);
    m.noJit = true;
  }
}

// Called by compiled code each time it falls back to the interpreter for an
// instruction; methods that keep doing it are recompiled later, once their
// constant pool entries are resolved.
const stats = typeof process !== "undefined" && process.env?.JW_JIT_STATS ? new Map<string, number>() : null;
let regionCount = 0, deoptCount = 0;
if (stats) process.on("exit", () => {
  const compiled = [...stats.keys()].filter((k) => k.startsWith("compiled "));
  console.error(`-- ${compiled.length} methods compiled, ${compiled.reduce((n, k) => n + stats.get(k)!, 0)} bytes of JS, ${regionCount} regions inlined, ${deoptCount} deopts`);
  for (const [k, v] of [...stats].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.error(String(v).padStart(8), k);
});

function fallback(t: JThread, f: Frame) {
  const m = f.m;
  if (stats) {
    const k = `${m} @${f.pc} op=${f.code[f.pc].toString(16)}`;
    stats.set(k, (stats.get(k) ?? 0) + 1);
  }
  if (++m.fallbacks > MAX_FALLBACKS || (m.fallbacks > 50 && m.fallbacks > m.hot)) {
    m.jit = null;
    m.hot = 0;
    m.recompiles++;
    if (m.recompiles > 3) {
      m.noJit = true;
      if (stats) stats.set(`nojit churn ${m} @${f.pc} op=${f.code[f.pc].toString(16)}`, 1e9);
    }
  }
  hooks.interpret(t, f, 1);
  return SUSPEND;
}

// A call compiled code cannot make directly; not a reason to recompile.
function viaInterpreter(t: JThread, f: Frame) {
  hooks.interpret(t, f, 1);
  return SUSPEND;
}

class Unsupported extends Error {}
// a callee that cannot be inlined at this call site
class NoInline extends Error {}

function npeAt(pc: number): never {
  throw at(new PendingThrow("java/lang/NullPointerException"), pc);
}

function at(e: PendingThrow, pc: number | undefined): PendingThrow {
  if (pc !== undefined) e.pc = pc;
  return e;
}

// results of runtime.slowCall
const PUSHED = Object.freeze({ pushed: true }), INTERPRET = Object.freeze({ interpret: true });

const STRING_BUILDER = "java/lang/StringBuilder";

const LONG_MIN = -(1n << 63n), LONG_MAX = (1n << 63n) - 1n;

const runtime = {
  JObject, JArray, Frame, NativeFrame, JavaThrow, PendingThrow, newArrayData,
  hooks,
  concat: concatStrings,
  fallback,
  viaInterpreter,
  basicTarget(t: JThread, mh: JObject | null, pc: number): JMethod {
    if (mh === null) npeAt(pc);
    const form = t.vm.getField(mh, "java/lang/invoke/MethodHandle", "form") as JObject;
    return memberTarget(t, t.vm.getField(form, "java/lang/invoke/LambdaForm", "vmentry"));
  },
  memberTarget,
  virtualTarget(t: JThread, mn: JObject, recv: JObject | null, pc: number): JMethod {
    const m = memberTarget(t, mn);
    if (recv === null) npeAt(pc);
    const sel = recv.cls.selectMethod(m.key);
    if (!sel) throw new PendingThrow("java/lang/AbstractMethodError", `${recv.cls.javaName}.${m.name}${m.desc}`);
    return sel;
  },
  // an interpreter frame of m rebuilt from a deoptimized inlined region
  frame(m: JMethod, locals: any[], stack: any[], pc: number, sp: number): Frame {
    const f = new Frame(m);
    for (let i = 0; i < locals.length; i++) f.locals[i] = locals[i];
    for (let i = 0; i < stack.length; i++) f.stack[i] = stack[i];
    f.pc = pc;
    f.sp = sp;
    return f;
  },
  // the pushed frame of a direct call to compiled m, or null when the call
  // goes through the run loop: the stack is too deep or the monitor is taken
  enter(t: JThread, m: JMethod, recv: JObject | null): Frame | null {
    if (t.frames.length - t.base >= MAX_DIRECT || t.frames.length >= t.stackLimit) return null;
    let lock: JObject | null = null;
    if (m.isSynchronized) {
      lock = m.isStatic ? t.vm.mirror(m.cls) : recv!;
      if (!t.vm.tryMonitorEnter(t, lock)) return null;
    }
    const f = t.directFrame(m);
    f.lock = lock;
    t.frames.push(f);
    return f;
  },
  // A call that is not direct: a native's result, PUSHED once a native that
  // must wait is on the stack, or INTERPRET for the run loop to make the call.
  slowCall(t: JThread, m: JMethod, args: any[]): any {
    if (m.native === null || m.isAbstract) return INTERPRET;
    let r;
    try {
      r = m.native(t, args);
    } catch (e) {
      throw fromNative(e, m);
    }
    if (runtime.isGen(r)) {
      t.frames.push(new NativeFrame(r, m, m.ret, false));
      return PUSHED;
    }
    return m.ret === "Z" && typeof r === "boolean" ? (r ? 1 : 0) : r;
  },
  PUSHED,
  INTERPRET,
  npe: npeAt,
  arr(o: JArray | null, i: number, pc?: number): any {
    if (o === null) throw at(new PendingThrow("java/lang/NullPointerException"), pc);
    const a = o.a;
    if (i >>> 0 >= a.length) {
      throw at(new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", `Index ${i} out of bounds for length ${a.length}`), pc);
    }
    return a;
  },
  div0(pc?: number): never { throw at(new PendingThrow("java/lang/ArithmeticException", "/ by zero"), pc); },
  aastore(o: JArray, i: number, v: JObject | null, pc?: number) {
    const a = runtime.arr(o, i, pc);
    if (v !== null && !v.cls.isAssignableTo(o.cls.component!)) throw at(new PendingThrow("java/lang/ArrayStoreException", v.cls.javaName), pc);
    a[i] = v;
  },
  newarray(c: JClass, elem: string, n: number, pc?: number) {
    if (n < 0) throw at(new PendingThrow("java/lang/NegativeArraySizeException", String(n)), pc);
    return new JArray(c, newArrayData(elem, n));
  },
  cast(t: JThread, o: JObject, c: JClass, pc?: number) {
    if (o.cls !== c && !o.cls.isAssignableTo(c)) {
      throw at(new PendingThrow("java/lang/ClassCastException", t.vm.castMessage(o.cls, c)), pc);
    }
  },
  f2i(v: number) {
    if (v !== v) return 0;
    if (v >= 2147483647) return 2147483647;
    if (v <= -2147483648) return -2147483648;
    return v | 0;
  },
  f2l(v: number) {
    if (v !== v) return 0n;
    if (v >= 9223372036854775807) return LONG_MAX;
    if (v <= -9223372036854775808) return LONG_MIN;
    return BigInt(Math.trunc(v));
  },
  fcmp(a: number, b: number, nan: number) { return a > b ? 1 : a < b ? -1 : a === b ? 0 : nan; },
  lcmp(a: bigint, b: bigint) { return a > b ? 1 : a < b ? -1 : 0; },
  // cell: the inline cache, [receiver class, method, method key]
  select(o: JObject | null, cell: any[], pc: number): JMethod {
    if (o === null) return runtime.npe(pc);
    if (cell[0] === o.cls) return cell[1];
    const key = cell[2] as string;
    const m = o.cls.selectMethod(key);
    if (!m) throw new PendingThrow("java/lang/AbstractMethodError", `${o.cls.javaName}.${key}`);
    cell[0] = o.cls;
    cell[1] = m;
    return m;
  },
  isGen(r: any) { return r !== null && typeof r === "object" && typeof r.next === "function" && typeof r.throw === "function"; },
  // thrown inside an inlined region to continue in the interpreter
  DEOPT: Object.freeze({ deopt: true }),
  // a callee that keeps deoptimizing is not inlined again; its caller
  // recompiles without it later
  deopted(callee: JMethod, caller: JMethod) {
    const n = (deopts.get(callee) ?? 0) + 1;
    deopts.set(callee, n);
    if (n >= MAX_DEOPTS && caller.jit !== null) {
      caller.jit = null;
      caller.hot = 0;
    }
  },
  // counts a deopt in JW_JIT_STATS, by the inlined callee it happened in
  noteDeopt(m: JMethod, e: unknown) {
    deoptCount++;
    const why = e === runtime.DEOPT ? "cold block" : e instanceof JavaThrow ? "throw" : e instanceof PendingThrow ? e.cls : "error";
    const k = `deopt ${m} (${why})`;
    stats!.set(k, (stats!.get(k) ?? 0) + 1);
  },
  // raises exc from the run loop, once every compiled caller has spilled
  *rethrow(exc: JObject): Generator<never, void, unknown> { throw new JavaThrow(exc); },
  MAX_DIRECT,
};

// ---- analysis ----------------------------------------------------------------

function s16(c: Uint8Array, p: number) { return (((c[p] << 8) | c[p + 1]) << 16) >> 16; }
function s32(c: Uint8Array, p: number) { return (c[p] << 24) | (c[p + 1] << 16) | (c[p + 2] << 8) | c[p + 3]; }
function u16(c: Uint8Array, p: number) { return (c[p] << 8) | c[p + 1]; }

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

// lengths of fixed-size instructions; 0 marks variable or invalid ones
const LEN = new Uint8Array(256).fill(1);
for (const op of [0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xa9, 0xbc]) LEN[op] = 2;
for (const op of [0x11, 0x13, 0x14, 0x84, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7]) LEN[op] = 3;
for (let op = 0x99; op <= 0xa8; op++) LEN[op] = 3;
LEN[0xb9] = 5; LEN[0xba] = 5; LEN[0xc5] = 4; LEN[0xc8] = 5; LEN[0xc9] = 5;

interface Analysis {
  pcs: number[];
  leaders: Set<number>;
  // where control can arrive other than by falling through: entry, branch and handler targets
  targets: Set<number>;
  depth: Map<number, number>;
}

const analyses = new WeakMap<JMethod, Analysis>();

// Instruction starts, block leaders (entry, branch targets, handler bounds,
// line starts, and the instruction after anything that may leave the
// compiled code) and the operand stack depth at every reachable instruction.
function analyze(m: JMethod): Analysis {
  const known = analyses.get(m);
  if (known) return known;
  const cls = m.cls;
  const code = m.code!;
  const c = code.code;
  const leaders = new Set<number>([0]);
  const targets = new Set<number>([0]);
  for (const h of code.handlers) { leaders.add(h.start); leaders.add(h.end); leaders.add(h.handler); targets.add(h.handler); }
  if (code.lines) for (let i = 0; i < code.lines.length; i += 2) leaders.add(code.lines[i]);
  const pcs: number[] = [];
  for (let pc = 0; pc < c.length;) {
    pcs.push(pc);
    const op = c[pc];
    const len = insnLength(c, pc);
    if (op === 0xa8 || op === 0xa9 || op === 0xc9 || len === 0) throw new Unsupported("jsr/ret");
    const next = pc + len;
    if ((op >= 0x99 && op <= 0xa7) || op === 0xc6 || op === 0xc7) { targets.add(pc + s16(c, pc + 1)); leaders.add(next); }
    else if (op === 0xc8) { targets.add(pc + s32(c, pc + 1)); leaders.add(next); }
    else if (op === 0xaa || op === 0xab) {
      for (const x of switchTargets(c, pc)) targets.add(x);
      leaders.add(next);
    } else if (MAY_LEAVE.has(op)) {
      leaders.add(pc);
      leaders.add(next);
    } else if (op >= 0xac && op <= 0xb1 || op === 0xbf) leaders.add(next);
    pc = next;
  }
  for (const x of targets) leaders.add(x);

  const depth = new Map<number, number>();
  const work: [number, number][] = [[0, 0]];
  for (const h of code.handlers) work.push([h.handler, 1]);
  const indexOf = new Map(pcs.map((p, i) => [p, i]));
  while (work.length) {
    let [pc, d] = work.pop()!;
    for (;;) {
      const seen = depth.get(pc);
      if (seen !== undefined) {
        if (seen !== d) throw new Unsupported("inconsistent stack");
        break;
      }
      if (!indexOf.has(pc)) throw new Unsupported("bad pc");
      depth.set(pc, d);
      const op = c[pc];
      d += stackDelta(cls, c, pc);
      const next = pc + insnLength(c, pc);
      if ((op >= 0x99 && op <= 0xa6) || op === 0xc6 || op === 0xc7) { work.push([pc + s16(c, pc + 1), d]); pc = next; continue; }
      if (op === 0xa7) { pc += s16(c, pc + 1); continue; }
      if (op === 0xc8) { pc += s32(c, pc + 1); continue; }
      if (op === 0xaa || op === 0xab) {
        for (const x of switchTargets(c, pc)) work.push([x, d]);
        break;
      }
      if ((op >= 0xac && op <= 0xb1) || op === 0xbf) break;
      pc = next;
    }
  }
  const a = { pcs, leaders, targets, depth };
  analyses.set(m, a);
  return a;
}

// Targets of a tableswitch or lookupswitch, default first.
function switchTargets(c: Uint8Array, pc: number): number[] {
  const p = (pc + 4) & ~3;
  const out = [pc + s32(c, p)];
  if (c[pc] === 0xaa) for (let i = 0, n = s32(c, p + 8) - s32(c, p + 4) + 1; i < n; i++) out.push(pc + s32(c, p + 12 + i * 4));
  else for (let i = 0, n = s32(c, p + 4); i < n; i++) out.push(pc + s32(c, p + 12 + i * 8));
  return out;
}

interface RegionInfo {
  a: Analysis;
  // basic block starts, and those of blocks that cannot reach a return
  starts: Set<number>;
  cold: Set<number>;
  // bytecode outside the cold blocks
  bytes: number;
}

const regionInfos = new WeakMap<JMethod, RegionInfo | null>();
const deopts = new WeakMap<JMethod, number>();

// Small loop-free callees without handlers can be inlined. Their cold blocks,
// which can only end in a throw, run in the interpreter after a deopt.
function regionInfo(m: JMethod): RegionInfo | null {
  let r = regionInfos.get(m);
  if (r !== undefined) return r;
  r = null;
  const code = m.code;
  if (code && !m.isSynchronized && !m.isAbstract && !m.polymorphic && m.name !== "<clinit>" && code.handlers.length === 0 && code.code.length <= 400) {
    try {
      r = basicBlocks(m, analyze(m));
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
    }
  }
  regionInfos.set(m, r);
  return r;
}

function basicBlocks(m: JMethod, a: Analysis): RegionInfo | null {
  const c = m.code!.code;
  const starts = new Set<number>([0]);
  for (const pc of a.pcs) {
    const op = c[pc];
    const next = pc + insnLength(c, pc);
    let targets: number[] | null = null;
    if ((op >= 0x99 && op <= 0xa7) || op === 0xc6 || op === 0xc7) targets = [pc + s16(c, pc + 1)];
    else if (op === 0xc8) targets = [pc + s32(c, pc + 1)];
    else if (op === 0xaa || op === 0xab) targets = switchTargets(c, pc);
    if (targets) {
      for (const x of targets) {
        if (x <= pc) return null;
        starts.add(x);
      }
      starts.add(next);
    } else if ((op >= 0xac && op <= 0xb1) || op === 0xbf) starts.add(next);
  }
  starts.delete(c.length);
  // branches only go forward, so successors are decided before their predecessors
  const order = [...starts].sort((x, y) => y - x);
  const warm = new Set<number>();
  let bytes = 0;
  let end = c.length;
  for (const s of order) {
    let last = s;
    for (let pc = s; pc < end; pc += insnLength(c, pc)) last = pc;
    const op = c[last];
    const next = last + insnLength(c, last);
    let succ: number[];
    if ((op >= 0x99 && op <= 0xa6) || op === 0xc6 || op === 0xc7) succ = [last + s16(c, last + 1), next];
    else if (op === 0xa7) succ = [last + s16(c, last + 1)];
    else if (op === 0xc8) succ = [last + s32(c, last + 1)];
    else if (op === 0xaa || op === 0xab) succ = switchTargets(c, last);
    else if (op === 0xbf || (op >= 0xac && op <= 0xb1)) succ = [];
    else succ = [next];
    if (a.depth.has(s) && ((op >= 0xac && op <= 0xb1) || succ.some((x) => warm.has(x)))) {
      warm.add(s);
      bytes += end - s;
    }
    end = s;
  }
  if (!warm.has(0) || bytes > MAX_INLINE_BYTES) return null;
  const cold = new Set([...starts].filter((s) => !warm.has(s)));
  return { a, starts, cold, bytes };
}

// ---- code generation ---------------------------------------------------------

// A method body being emitted: the compiled method, or a callee inlined into
// it as a region.
interface Body {
  m: JMethod;
  a: Analysis;
  L: (i: number) => string;
  S: (i: number) => string;
  out: string[];
  region: Region | null;
  // instructions before this pc were emitted already, as part of a fused sequence
  skip: number;
}

interface Region {
  // value of ifs while the region runs
  id: number;
  level: number;
  pcVar: string;
  // variable that takes the return value
  result: string | null;
  parent: Body;
  // the invoke in parent, and parent's operand stack below its arguments
  callPc: number;
  base: number;
}

// How the shared exit leaves compiled code.
const EXIT_SUSPEND = 0, EXIT_FALLBACK = 1, EXIT_INTERPRET = 2, EXIT_RETHROW = 3, EXIT_ERROR = 4;

// where the shared exit leaves the frame (pc and stack depth) and how, as one number
function exitCode(pc: number, sp: number, kind: number): number {
  if (sp > 1023) throw new Unsupported("operand stack too deep");
  return pc * 8192 + sp * 8 + kind;
}

// State of one compilation.
interface Gen {
  t: JThread;
  K: (v: any) => string;
  vars: Set<string>;
  regions: Body[];
  inlined: number;
  top: Body;
  // pcs the shared exit leaves at: the frame resumes there or at the next instruction
  resume: Set<number>;
  // leave through the shared exit, which spills the frame's state; kind is an EXIT_* value
  exit: (pc: number, sp: number, kind: number) => string;
  // run this one instruction in the interpreter
  slow: (pc: number, sp: number) => string;
  call: (pc: number, sp: number) => string;
}

function generate(t: JThread, m: JMethod): { src: string; consts: any[] } {
  const code = m.code!;
  const a = analyze(m);
  const consts: any[] = [];
  const K = (v: any) => {
    consts.push(v);
    return `K[${consts.length - 1}]`;
  };
  const nl = code.maxLocals, ns = code.maxStack + 2;
  const L = (i: number) => `l${i}`;
  const S = (i: number) => `s${i}`;
  const alloc = `if(L===null){L=f.locals=new Array(${nl});S=f.stack=new Array(${ns});}`;
  const spillLocals = () => alloc + Array.from({ length: nl }, (_, i) => `L[${i}]=${L(i)};`).join("");
  const top: Body = { m, a, L, S, out: [], region: null, skip: 0 };
  const resume = new Set<number>();
  const exit = (pc: number, sp: number, kind: number) => {
    resume.add(pc);
    return `{x=${exitCode(pc, sp, kind)};break X;}`;
  };
  const g: Gen = {
    t, K, vars: new Set(), regions: [], inlined: 0, top, resume, exit,
    slow: (pc, sp) => exit(pc, sp, EXIT_FALLBACK),
    call: (pc, sp) => exit(pc, sp, EXIT_INTERPRET),
  };
  for (let i = 0; i < nl; i++) g.vars.add(L(i));
  for (let i = 0; i < ns; i++) g.vars.add(S(i));

  // where each leader's code starts in top.out; its label is known once all exits are
  const marks: [number, number][] = [];
  for (const pc of a.pcs) {
    if (pc < top.skip) continue;
    if (a.leaders.has(pc)) marks.push([pc, top.out.push("") - 1]);
    if (!a.depth.has(pc)) continue; // unreachable
    insn(g, top, pc);
  }
  regionCount += g.regions.length;
  // A frame resumes at an exit's pc or, once the call there returns, the next
  // one. Other leaders only keep pc right for handlers and line numbers.
  for (const r of g.regions) {
    let q: Body = r;
    while (q.region!.parent.region) q = q.region!.parent;
    resume.add(q.region!.callPc);
  }
  const entries = new Set(a.targets);
  a.pcs.forEach((pc, i) => {
    if (!resume.has(pc)) return;
    entries.add(pc);
    if (i + 1 < a.pcs.length) entries.add(a.pcs[i + 1]);
  });
  for (const [pc, i] of marks) top.out[i] = `${entries.has(pc) ? `case ${pc}:` : ""}pc=${pc};`;

  const params = Array.from({ length: m.argSlots }, (_, i) => `a${i}`);
  const fname = `${m.cls.name}_${m.name}`.replace(/[^A-Za-z0-9_$]/g, "_");
  const out: string[] = [];
  // direct calls pass arguments as parameters and a frame without arrays
  out.push(`return function ${fname}(t,f${params.map((p) => "," + p).join("")}){let L=f.locals,S=f.stack;const vm=t.vm,H=rt.hooks;`);
  out.push(`let pc=f.pc,bud=4000,tm,cf,r,a,v,ic,ifs=0,dpc=0,dsp=0,x=0,xs=0,xe=null,${[...g.vars].join(",")};`);
  out.push(`if(L===null){${params.map((p, i) => `${L(i)}=${p};`).join("")}}else{${Array.from({ length: nl }, (_, i) => `${L(i)}=L[${i}];`).join("")}${Array.from({ length: ns }, (_, i) => `${S(i)}=S[${i}];`).join("")}}`);
  out.push(`X:{for(;;){try{switch(pc){`);
  out.push(...top.out);
  // a frame the interpreter left elsewhere steps to the next entry
  out.push(`default:return rt.viaInterpreter(t,f);}}catch(e){`);
  if (g.regions.length) out.push(deoptCatch(g));
  out.push(`if(e instanceof rt.JavaThrow){const h=H.findHandler(t,f,pc,e.obj);if(h>=0){${S(0)}=e.obj;pc=h;continue;}`);
  out.push(`H.popFrame(t,f);if(f.direct)throw e;H.raise(t,e.obj);return 1;}`);
  out.push(`x=(e instanceof rt.PendingThrow&&e.pc!==undefined?e.pc:pc)*${exitCode(1, 0, 0)}+${EXIT_ERROR};xe=e;if(f.direct)f.direct=false;break X;}}}`);
  // the shared exit: spill into the frame's arrays, then leave as x says
  const stack = Array.from({ length: ns }, (_, i) => `case ${ns - i}:S[${ns - i - 1}]=${S(ns - i - 1)};`).join("");
  out.push(`f.pc=x>>>13;xs=x>>>3&1023;${spillLocals()}switch(xs){${stack}}f.sp=xs;`);
  out.push(`switch(x&7){case ${EXIT_FALLBACK}:return rt.fallback(t,f);case ${EXIT_INTERPRET}:return rt.viaInterpreter(t,f);` +
    `case ${EXIT_RETHROW}:t.pushNative(rt.rethrow(xe.obj),null,"V",false);return 1;` +
    `case ${EXIT_ERROR}:H.handleError(t,xe);return 1;}return 1;}`);
  return { src: out.join("\n"), consts };
}

// An exception or deopt inside a region: give each inlined callee a real
// frame, so stack traces and handlers see them, then continue from the
// innermost one in the run loop.
function deoptCatch(g: Gen): string {
  const cases = g.regions.map((r) => {
    const chain: Body[] = [];
    for (let q: Body = r; q.region; q = q.region.parent) chain.unshift(q);
    const outer = chain[0].region!;
    let s = `case ${r.region!.id}:rt.deopted(${g.K(r.m)},f.m);${stats ? `rt.noteDeopt(${g.K(r.m)},e);` : ""}`;
    chain.forEach((q, k) => {
      const code = q.m.code!;
      const inner = chain[k + 1]?.region;
      const locals = Array.from({ length: code.maxLocals }, (_, i) => q.L(i));
      const stack = Array.from({ length: inner ? inner.base : code.maxStack }, (_, i) => q.S(i));
      const at = inner ? `${inner.callPc},${inner.base}` : "dpc,dsp";
      s += `t.frames.push(rt.frame(${g.K(q.m)},[${locals}],[${stack}],${at}));`;
    });
    return s + `x=${exitCode(outer.callPc, outer.base, 0)};break;`;
  });
  return `if(ifs!==0){if(e!==rt.DEOPT){dpc=e instanceof rt.PendingThrow&&e.pc!==undefined?e.pc:0;dsp=0;}` +
    `switch(ifs){${cases.join("")}}ifs=0;if(f.direct)f.direct=false;` +
    `x+=e===rt.DEOPT?${EXIT_SUSPEND}:e instanceof rt.JavaThrow?${EXIT_RETHROW}:${EXIT_ERROR};xe=e;break X;}`;
}

// Inlines callee at an invoke in parent, as a labeled block (or a loop over
// its blocks) on variables of its own. Throws NoInline when it cannot be.
function genRegion(g: Gen, parent: Body, callee: JMethod, args: string[], result: string | null, callPc: number, base: number): string {
  const level = (parent.region?.level ?? 0) + 1;
  const info = !noInline && level <= MAX_INLINE_DEPTH && (deopts.get(callee) ?? 0) < MAX_DEOPTS ? regionInfo(callee) : null;
  if (!info || g.inlined + info.bytes > MAX_INLINED) throw new NoInline();
  for (let q: Body | null = parent; q; q = q.region?.parent ?? null) if (q.m === callee) throw new NoInline();
  const code = callee.code!;
  const id = g.regions.length + 1;
  const p = `i${level}_`;
  const label = `R${id}`;
  const single = info.starts.size === 1;
  const b: Body = {
    m: callee, a: info.a, L: (i) => `${p}l${i}`, S: (i) => `${p}s${i}`, out: [],
    region: { id, level, pcVar: `${p}pc`, result, parent, callPc, base }, skip: 0,
  };
  const mark = g.regions.length, inlined = g.inlined;
  g.regions.push(b);
  g.inlined += info.bytes;
  try {
    for (let i = 0; i < code.maxLocals; i++) g.vars.add(b.L(i));
    for (let i = 0; i < code.maxStack + 2; i++) g.vars.add(b.S(i));
    if (!single) g.vars.add(`${p}pc`);
    for (let i = 0; i < args.length; i++) b.out.push(`${b.L(i)}=${args[i]};`);
    b.out.push(`ifs=${id};`, single ? `${label}:{` : `${p}pc=0;${label}:for(;;){switch(${p}pc){`);
    let cold = false;
    for (const pc of info.a.pcs) {
      if (pc < b.skip) continue;
      if (info.starts.has(pc)) {
        if (!single) b.out.push(`case ${pc}:`);
        cold = info.cold.has(pc);
        if (cold) b.out.push(`dpc=${pc};dsp=${info.a.depth.get(pc) ?? 0};throw rt.DEOPT;`);
      }
      if (cold || !info.a.depth.has(pc)) continue;
      insn(g, b, pc);
    }
    b.out.push(single ? "}" : `default:throw new Error("jit: bad region pc");}}`, `ifs=${parent.region?.id ?? 0};`);
    return b.out.join("");
  } catch (e) {
    g.regions.length = mark;
    g.inlined = inlined;
    throw e;
  }
}

// Emits the instruction at pc of body b.
function insn(g: Gen, b: Body, pc: number) {
  const { m, L, S, region } = b;
  const t = g.t, vm = t.vm, K = g.K;
  const cls = m.cls;
  const cp = cls.cf!.cp;
  const c = m.code!.code;
  const emit = (s: string) => b.out.push(s);
  // instructions that leave compiled code cannot be inlined
  const slow = (pc: number, sp: number) => {
    if (region) throw new NoInline();
    return g.slow(pc, sp);
  };
  let d = b.a.depth.get(pc)!;
  const op = c[pc];
  const next = pc + insnLength(c, pc);
  const top = (k = 0) => S(d - 1 - k);
  const jump = (target: number) => {
    if (region) return `{${region.pcVar}=${target};continue R${region.id};}`;
    if (target <= pc) return `{if(--bud===0)${g.exit(target, b.a.depth.get(target)!, EXIT_SUSPEND)}pc=${target};continue;}`;
    return `{pc=${target};continue;}`;
  };
  const idx2 = u16(c, pc + 1);
  switch (op) {
    case 0x00: break;
    case 0x01: emit(`${S(d)}=null;`); break;
    case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: emit(`${S(d)}=${op - 3};`); break;
    case 0x09: case 0x0a: emit(`${S(d)}=${op - 9}n;`); break;
    case 0x0b: case 0x0c: case 0x0d: emit(`${S(d)}=${op - 0x0b};`); break;
    case 0x0e: case 0x0f: emit(`${S(d)}=${op - 0x0e};`); break;
    case 0x10: emit(`${S(d)}=${(c[pc + 1] << 24) >> 24};`); break;
    case 0x11: emit(`${S(d)}=${s16(c, pc + 1)};`); break;
    case 0x12: case 0x13: case 0x14: {
      const i = op === 0x12 ? c[pc + 1] : idx2;
      const e = cp[i]!;
      if (e.tag === Tag.Integer || e.tag === Tag.Float || e.tag === Tag.Double) emit(`${S(d)}=${numLit(e.value as number)};`);
      else if (e.tag === Tag.Long) emit(`${S(d)}=${e.value}n;`);
      else {
        const v = cls.ldc[i];
        if (v === undefined) { emit(slow(pc, d)); break; }
        emit(`${S(d)}=${K(v)};`);
      }
      break;
    }
    case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: emit(`${S(d)}=${L(c[pc + 1])};`); break;
    case 0x1a: case 0x1b: case 0x1c: case 0x1d: emit(`${S(d)}=${L(op - 0x1a)};`); break;
    case 0x1e: case 0x1f: case 0x20: case 0x21: emit(`${S(d)}=${L(op - 0x1e)};`); break;
    case 0x22: case 0x23: case 0x24: case 0x25: emit(`${S(d)}=${L(op - 0x22)};`); break;
    case 0x26: case 0x27: case 0x28: case 0x29: emit(`${S(d)}=${L(op - 0x26)};`); break;
    case 0x2a: case 0x2b: case 0x2c: case 0x2d: emit(`${S(d)}=${L(op - 0x2a)};`); break;
    case 0x2e: case 0x2f: case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      emit(`if(${top(1)}===null)rt.npe(${pc});a=${top(1)}.a;if(${top()}>>>0>=a.length)rt.arr(${top(1)},${top()},${pc});${top(1)}=a[${top()}];`);
      break;
    case 0x36: case 0x38: case 0x3a: emit(`${L(c[pc + 1])}=${top()};`); break;
    case 0x37: case 0x39: emit(`${L(c[pc + 1])}=${top(1)};`); break;
    case 0x3b: case 0x3c: case 0x3d: case 0x3e: emit(`${L(op - 0x3b)}=${top()};`); break;
    case 0x3f: case 0x40: case 0x41: case 0x42: emit(`${L(op - 0x3f)}=${top(1)};`); break;
    case 0x43: case 0x44: case 0x45: case 0x46: emit(`${L(op - 0x43)}=${top()};`); break;
    case 0x47: case 0x48: case 0x49: case 0x4a: emit(`${L(op - 0x47)}=${top(1)};`); break;
    case 0x4b: case 0x4c: case 0x4d: case 0x4e: emit(`${L(op - 0x4b)}=${top()};`); break;
    case 0x4f: case 0x51: case 0x54: case 0x55: case 0x56:
      emit(`if(${top(2)}===null)rt.npe(${pc});a=${top(2)}.a;if(${top(1)}>>>0>=a.length)rt.arr(${top(2)},${top(1)},${pc});a[${top(1)}]=${top()};`);
      break;
    case 0x50: case 0x52:
      emit(`if(${top(3)}===null)rt.npe(${pc});a=${top(3)}.a;if(${top(2)}>>>0>=a.length)rt.arr(${top(3)},${top(2)},${pc});a[${top(2)}]=${top(1)};`);
      break;
    case 0x53: emit(`rt.aastore(${top(2)},${top(1)},${top()},${pc});`); break;
    case 0x57: case 0x58: break;
    case 0x59: emit(`${S(d)}=${top()};`); break;
    case 0x5a: emit(`${S(d)}=${top()};${top()}=${top(1)};${top(1)}=${S(d)};`); break;
    case 0x5b: emit(`${S(d)}=${top()};${top()}=${top(1)};${top(1)}=${top(2)};${top(2)}=${S(d)};`); break;
    case 0x5c: emit(`${S(d)}=${top(1)};${S(d + 1)}=${top()};`); break;
    case 0x5d: emit(`${S(d + 1)}=${top()};${S(d)}=${top(1)};${top()}=${top(2)};${top(1)}=${S(d + 1)};${top(2)}=${S(d)};`); break;
    case 0x5e: emit(`${S(d + 1)}=${top()};${S(d)}=${top(1)};${top()}=${top(2)};${top(1)}=${top(3)};${top(2)}=${S(d + 1)};${top(3)}=${S(d)};`); break;
    case 0x5f: emit(`v=${top()};${top()}=${top(1)};${top(1)}=v;`); break;
    case 0x60: emit(`${top(1)}=(${top(1)}+${top()})|0;`); break;
    case 0x61: emit(`${top(3)}=BigInt.asIntN(64,${top(3)}+${top(1)});`); break;
    case 0x62: emit(`${top(1)}=Math.fround(${top(1)}+${top()});`); break;
    case 0x63: emit(`${top(3)}+=${top(1)};`); break;
    case 0x64: emit(`${top(1)}=(${top(1)}-${top()})|0;`); break;
    case 0x65: emit(`${top(3)}=BigInt.asIntN(64,${top(3)}-${top(1)});`); break;
    case 0x66: emit(`${top(1)}=Math.fround(${top(1)}-${top()});`); break;
    case 0x67: emit(`${top(3)}-=${top(1)};`); break;
    case 0x68: emit(`${top(1)}=Math.imul(${top(1)},${top()});`); break;
    case 0x69: emit(`${top(3)}=BigInt.asIntN(64,${top(3)}*${top(1)});`); break;
    case 0x6a: emit(`${top(1)}=Math.fround(${top(1)}*${top()});`); break;
    case 0x6b: emit(`${top(3)}*=${top(1)};`); break;
    case 0x6c: emit(`if(${top()}===0)rt.div0(${pc});${top(1)}=(${top(1)}/${top()})|0;`); break;
    case 0x6d: emit(`if(${top(1)}===0n)rt.div0(${pc});${top(3)}=BigInt.asIntN(64,${top(3)}/${top(1)});`); break;
    case 0x6e: emit(`${top(1)}=Math.fround(${top(1)}/${top()});`); break;
    case 0x6f: emit(`${top(3)}/=${top(1)};`); break;
    case 0x70: emit(`if(${top()}===0)rt.div0(${pc});${top(1)}=(${top(1)}%${top()})|0;`); break;
    case 0x71: emit(`if(${top(1)}===0n)rt.div0(${pc});${top(3)}%=${top(1)};`); break;
    case 0x72: emit(`${top(1)}=Math.fround(${top(1)}%${top()});`); break;
    case 0x73: emit(`${top(3)}%=${top(1)};`); break;
    case 0x74: emit(`${top()}=(-${top()})|0;`); break;
    case 0x75: emit(`${top(1)}=BigInt.asIntN(64,-${top(1)});`); break;
    case 0x76: emit(`${top()}=-${top()};`); break;
    case 0x77: emit(`${top(1)}=-${top(1)};`); break;
    case 0x78: emit(`${top(1)}<<=${top()};`); break;
    case 0x79: emit(`${top(2)}=BigInt.asIntN(64,${top(2)}<<BigInt(${top()}&63));`); break;
    case 0x7a: emit(`${top(1)}>>=${top()};`); break;
    case 0x7b: emit(`${top(2)}>>=BigInt(${top()}&63);`); break;
    case 0x7c: emit(`${top(1)}=(${top(1)}>>>${top()})|0;`); break;
    case 0x7d: emit(`${top(2)}=BigInt.asIntN(64,BigInt.asUintN(64,${top(2)})>>BigInt(${top()}&63));`); break;
    case 0x7e: emit(`${top(1)}&=${top()};`); break;
    case 0x7f: emit(`${top(3)}&=${top(1)};`); break;
    case 0x80: emit(`${top(1)}|=${top()};`); break;
    case 0x81: emit(`${top(3)}|=${top(1)};`); break;
    case 0x82: emit(`${top(1)}^=${top()};`); break;
    case 0x83: emit(`${top(3)}^=${top(1)};`); break;
    case 0x84: emit(`${L(c[pc + 1])}=(${L(c[pc + 1])}+${(c[pc + 2] << 24) >> 24})|0;`); break;
    case 0x85: emit(`${top()}=BigInt(${top()});`); break;
    case 0x86: emit(`${top()}=Math.fround(${top()});`); break;
    case 0x87: break;
    case 0x88: emit(`${top(1)}=Number(BigInt.asIntN(32,${top(1)}));`); break;
    case 0x89: emit(`${top(1)}=Math.fround(Number(${top(1)}));`); break;
    case 0x8a: emit(`${top(1)}=Number(${top(1)});`); break;
    case 0x8b: emit(`${top()}=rt.f2i(${top()});`); break;
    case 0x8c: emit(`${top()}=rt.f2l(${top()});`); break;
    case 0x8d: break;
    case 0x8e: emit(`${top(1)}=rt.f2i(${top(1)});`); break;
    case 0x8f: emit(`${top(1)}=rt.f2l(${top(1)});`); break;
    case 0x90: emit(`${top(1)}=Math.fround(${top(1)});`); break;
    case 0x91: emit(`${top()}=(${top()}<<24)>>24;`); break;
    case 0x92: emit(`${top()}&=65535;`); break;
    case 0x93: emit(`${top()}=(${top()}<<16)>>16;`); break;
    case 0x94: emit(`${top(3)}=rt.lcmp(${top(3)},${top(1)});`); break;
    case 0x95: case 0x96: emit(`${top(1)}=rt.fcmp(${top(1)},${top()},${op === 0x95 ? -1 : 1});`); break;
    case 0x97: case 0x98: emit(`${top(3)}=rt.fcmp(${top(3)},${top(1)},${op === 0x97 ? -1 : 1});`); break;
    case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e: {
      const rel = ["===", "!==", "<", ">=", ">", "<="][op - 0x99];
      emit(`if(${top()}${rel}0)${jump(pc + s16(c, pc + 1))}`);
      break;
    }
    case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: {
      const rel = ["===", "!==", "<", ">=", ">", "<="][op - 0x9f];
      emit(`if(${top(1)}${rel}${top()})${jump(pc + s16(c, pc + 1))}`);
      break;
    }
    case 0xa5: emit(`if(${top(1)}===${top()})${jump(pc + s16(c, pc + 1))}`); break;
    case 0xa6: emit(`if(${top(1)}!==${top()})${jump(pc + s16(c, pc + 1))}`); break;
    case 0xa7: emit(jump(pc + s16(c, pc + 1))); break;
    case 0xc8: emit(jump(pc + s32(c, pc + 1))); break;
    case 0xc6: emit(`if(${top()}===null)${jump(pc + s16(c, pc + 1))}`); break;
    case 0xc7: emit(`if(${top()}!==null)${jump(pc + s16(c, pc + 1))}`); break;
    case 0xaa: case 0xab: {
      const p = (pc + 4) & ~3;
      emit(`switch(${top()}){`);
      if (op === 0xaa) {
        const lo = s32(c, p + 4), hi = s32(c, p + 8);
        for (let k = lo; k <= hi; k++) emit(`case ${k}:${jump(pc + s32(c, p + 12 + (k - lo) * 4))}`);
      } else {
        for (let i = 0, n = s32(c, p + 4); i < n; i++) emit(`case ${s32(c, p + 8 + i * 8)}:${jump(pc + s32(c, p + 12 + i * 8))}`);
      }
      emit(`default:${jump(pc + s32(c, p))}}`);
      break;
    }
    case 0xac: case 0xad: case 0xae: case 0xaf: case 0xb0: case 0xb1: {
      const v = op === 0xb1 ? "undefined" : op === 0xad || op === 0xaf ? top(1) : top();
      if (region) {
        emit(`${region.result !== null && op !== 0xb1 ? `${region.result}=${v};` : ""}break R${region.id};`);
        break;
      }
      const pop = m.isSynchronized ? "H.popFrame(t,f);" : "t.frames.pop();";
      emit(`${pop}if(f.direct){t.ret=${v};return 0;}H.deliver(t,${v},${JSON.stringify(m.ret)},false);return 0;`);
      break;
    }
    case 0xb2: case 0xb3: {
      const fld = cls.rcp[idx2] as JField | undefined;
      if (!fld || fld.cls.state !== INITIALIZED) { emit(slow(pc, d)); break; }
      const st = `${K(fld.cls)}.statics[${fld.slot}]`;
      if (op === 0xb2) emit(`${S(d)}=${st};`);
      else emit(`${st}=${fld.wide ? top(1) : top()};`);
      break;
    }
    case 0xb4: case 0xb5: {
      const fld = cls.rcp[idx2] as JField | undefined;
      if (!fld) { emit(slow(pc, d)); break; }
      if (op === 0xb4) emit(`if(${top()}===null)rt.npe(${pc});${top()}=${top()}.f[${fld.slot}];`);
      else {
        const obj = fld.wide ? top(2) : top(1);
        emit(`if(${obj}===null)rt.npe(${pc});${obj}.f[${fld.slot}]=${fld.wide ? top(1) : top()};`);
      }
      break;
    }
    case 0xb6: case 0xb7: case 0xb8: case 0xb9: {
      const target = cls.rcp[idx2] as JMethod | undefined;
      if (region) { emit(regionInvoke(g, b, op, pc, d, target)); break; }
      if (!target || (op === 0xb8 && target.cls.state !== INITIALIZED)) { emit(slow(pc, d)); break; }
      if (target.polymorphic) emit(genPolymorphic(g, pc, next, d, target));
      else emit(genInvoke(g, op, pc, next, d, target, cls));
      break;
    }
    case 0xba: {
      const site = m.cache?.[pc];
      if (!site || region) { emit(slow(pc, d)); break; }
      let dd = d;
      if (site.appendix !== undefined) { emit(`${S(dd)}=${K(site.appendix)};`); dd++; }
      emit(genInvoke(g, 0xb8, pc, next, dd, site.m, cls, d));
      break;
    }
    case 0xbb: {
      const fused = fuseConcat(g, b, pc);
      if (fused) {
        emit(`${S(d)}=rt.concat(t,${pc},[${fused.pieces}]);`);
        b.skip = fused.end;
        break;
      }
      const k = cls.rcp[idx2] as JClass | undefined;
      if (!k || k.state !== INITIALIZED || k.access & 0x0600) { emit(slow(pc, d)); break; }
      emit(`${S(d)}=new rt.JObject(${K(k)},${K(k)}.template.slice());`);
      break;
    }
    case 0xbc: {
      const elem = "?ZCFDBSIJ"[c[pc + 1] - 3];
      emit(`${top()}=rt.newarray(${K(vm.primArrayClass(elem))},"${elem}",${top()},${pc});`);
      break;
    }
    case 0xbd: {
      const k = cls.rcp[idx2] as JClass | undefined;
      if (!k) { emit(slow(pc, d)); break; }
      emit(`${top()}=rt.newarray(${K(vm.arrayOf(k))},"L",${top()},${pc});`);
      break;
    }
    case 0xbe: emit(`if(${top()}===null)rt.npe(${pc});${top()}=${top()}.a.length;`); break;
    case 0xbf:
      if (region) throw new NoInline();
      emit(`if(${top()}===null)rt.npe(${pc});throw new rt.JavaThrow(${top()});`);
      break;
    case 0xc0: case 0xc1: {
      const k = cls.rcp[idx2] as JClass | undefined;
      // unresolved: the interpreter resolves it only for a non-null value
      if (!k) {
        emit(`if(${top()}===null){${op === 0xc1 ? `${top()}=0;` : ""}}else{${slow(pc, d)}}`);
        break;
      }
      const kc = K(k);
      if (op === 0xc0) emit(`if(${top()}!==null)rt.cast(t,${top()},${kc},${pc});`);
      else emit(`${top()}=${top()}!==null&&(${top()}.cls===${kc}||${top()}.cls.isAssignableTo(${kc}))?1:0;`);
      break;
    }
    case 0xc2:
      if (region) throw new NoInline();
      emit(`if(${top()}===null)rt.npe(${pc});if(!vm.monitorEnter(t,${top()}))${g.exit(pc, d, EXIT_SUSPEND)}`);
      break;
    case 0xc3:
      if (region) throw new NoInline();
      emit(`if(${top()}===null)rt.npe(${pc});vm.monitorExit(t,${top()});`);
      break;
    case 0xc4: {
      const wop = c[pc + 1], i = u16(c, pc + 2);
      if (wop === 0x84) emit(`${L(i)}=(${L(i)}+${s16(c, pc + 4)})|0;`);
      else if (wop >= 0x15 && wop <= 0x19) emit(`${S(d)}=${L(i)};`);
      else if (wop === 0x37 || wop === 0x39) emit(`${L(i)}=${top(1)};`);
      else emit(`${L(i)}=${top()};`);
      break;
    }
    case 0xc5: emit(slow(pc, d)); break;
    default: throw new Unsupported(`opcode ${op}`);
  }
}

// A javac -XDstringConcat=inline chain at pc, which HotSpot's
// OptimizeStringConcat collapses:
//   new StringBuilder; dup; <init>()V; (aload|ldc String; append(String))+; toString()
// Returns the JS for each pushed value and the pc after the chain, or null
// when the chain differs or control can enter or be caught inside it.
function fuseConcat(g: Gen, b: Body, pc: number): { pieces: string[]; end: number } | null {
  const { m } = b;
  const cls = m.cls;
  const c = m.code!.code;
  const sbMethod = (p: number, op: number, name: string, desc: string) => {
    const t = cls.rcp[u16(c, p + 1)] as JMethod | undefined;
    return c[p] === op && !!t && t.cls.name === STRING_BUILDER && t.cls.loader === null && t.name === name && t.desc === desc;
  };
  const k = cls.rcp[u16(c, pc + 1)] as JClass | undefined;
  if (!k || k.name !== STRING_BUILDER || k.loader !== null || k.state !== INITIALIZED) return null;
  let p = pc + 3;
  if (c[p] !== 0x59 || !sbMethod(p + 1, 0xb7, "<init>", "()V")) return null;
  p += 4;
  const pieces: (() => string)[] = [];
  for (;;) {
    const op = c[p];
    if (op >= 0x2a && op <= 0x2d) { const i = op - 0x2a; pieces.push(() => b.L(i)); p += 1; }
    else if (op === 0x19) { const i = c[p + 1]; pieces.push(() => b.L(i)); p += 2; }
    else if (op === 0x12 || op === 0x13) {
      const i = op === 0x12 ? c[p + 1] : u16(c, p + 1);
      const v = cls.ldc[i];
      if (cls.cf!.cp[i]!.tag !== Tag.String || v === undefined) return null;
      pieces.push(() => g.K(v));
      p += op === 0x12 ? 2 : 3;
    } else return null;
    if (!sbMethod(p, 0xb6, "append", "(Ljava/lang/String;)Ljava/lang/StringBuilder;")) return null;
    p += 3;
    if (sbMethod(p, 0xb6, "toString", "()Ljava/lang/String;")) break;
  }
  const last = p;
  for (const q of b.a.pcs) if (q > pc && q <= last && b.a.targets.has(q)) return null;
  for (const h of m.code!.handlers) {
    if ((h.start > pc && h.start <= last) || (h.end > pc && h.end <= last)) return null;
  }
  return { pieces: pieces.map((f) => f()), end: last + 3 };
}

// An invoke inside a region: the target must be fixed and inlinable itself.
function regionInvoke(g: Gen, b: Body, op: number, pc: number, d: number, target: JMethod | undefined): string {
  if (!target || target.polymorphic || op === 0xb9 || (op === 0xb8 && target.cls.state !== INITIALIZED)) throw new NoInline();
  const callee = op === 0xb7 ? g.t.vm.specialTarget(b.m.cls, target) : target;
  if (!callee.code || callee.isAbstract || !isFixed(op, callee)) throw new NoInline();
  const n = target.argSlots;
  const base = d - n;
  const args = Array.from({ length: n }, (_, i) => b.S(base + i));
  const result = target.ret === "V" ? null : b.S(base);
  const trivial = trivialBody(callee);
  if (trivial) return genInline(trivial, result ?? "v", args, pc, callee.isStatic);
  return (callee.isStatic ? "" : `if(${args[0]}===null)rt.npe(${pc});`) + genRegion(g, b, callee, args, result, pc, base);
}

// The callee of an invoke does not depend on the receiver's class.
function isFixed(op: number, callee: JMethod): boolean {
  return op !== 0xb6 || callee.isPrivate || (callee.access & ACC_FINAL) !== 0 || (callee.cls.access & ACC_FINAL) !== 0;
}

// Opcodes that may leave compiled code mid-method.
const MAY_LEAVE = new Set([0x12, 0x13, 0x14, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbd, 0xc0, 0xc1, 0xc2, 0xc5]);

function numLit(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
  if (Object.is(v, -0)) return "-0";
  return String(v);
}

// Bodies that can be inlined at a call site: they neither call nor throw.
type Trivial =
  | { kind: "empty" } | { kind: "get"; slot: number } | { kind: "set"; slot: number } | { kind: "const"; value: string }
  | { kind: "expr"; build: (args: string[]) => string };

// Pure arithmetic on parameters, as one JS expression, or null. Only
// operations that cannot throw, so the missing frame is never observable.
const BINARY: Record<number, (a: string, b: string) => string> = {
  0x60: (a, b) => `((${a}+${b})|0)`, 0x61: (a, b) => `BigInt.asIntN(64,${a}+${b})`, 0x62: (a, b) => `Math.fround(${a}+${b})`, 0x63: (a, b) => `(${a}+${b})`,
  0x64: (a, b) => `((${a}-${b})|0)`, 0x65: (a, b) => `BigInt.asIntN(64,${a}-${b})`, 0x66: (a, b) => `Math.fround(${a}-${b})`, 0x67: (a, b) => `(${a}-${b})`,
  0x68: (a, b) => `Math.imul(${a},${b})`, 0x69: (a, b) => `BigInt.asIntN(64,${a}*${b})`, 0x6a: (a, b) => `Math.fround(${a}*${b})`, 0x6b: (a, b) => `(${a}*${b})`,
  0x6e: (a, b) => `Math.fround(${a}/${b})`, 0x6f: (a, b) => `(${a}/${b})`,
  0x78: (a, b) => `(${a}<<${b})`, 0x79: (a, b) => `BigInt.asIntN(64,${a}<<BigInt(${b}&63))`,
  0x7a: (a, b) => `(${a}>>${b})`, 0x7b: (a, b) => `(${a}>>BigInt(${b}&63))`,
  0x7c: (a, b) => `((${a}>>>${b})|0)`, 0x7d: (a, b) => `BigInt.asIntN(64,BigInt.asUintN(64,${a})>>BigInt(${b}&63))`,
  0x7e: (a, b) => `(${a}&${b})`, 0x7f: (a, b) => `(${a}&${b})`, 0x80: (a, b) => `(${a}|${b})`, 0x81: (a, b) => `(${a}|${b})`,
  0x82: (a, b) => `(${a}^${b})`, 0x83: (a, b) => `(${a}^${b})`,
};
const UNARY: Record<number, (a: string) => string> = {
  0x74: (a) => `((-${a})|0)`, 0x75: (a) => `BigInt.asIntN(64,-${a})`, 0x76: (a) => `(-${a})`, 0x77: (a) => `(-${a})`,
  0x85: (a) => `BigInt(${a})`, 0x86: (a) => `Math.fround(${a})`, 0x87: (a) => a, 0x88: (a) => `Number(BigInt.asIntN(32,${a}))`,
  0x89: (a) => `Math.fround(Number(${a}))`, 0x8a: (a) => `Number(${a})`, 0x8b: (a) => `rt.f2i(${a})`, 0x8c: (a) => `rt.f2l(${a})`,
  0x8d: (a) => a, 0x8e: (a) => `rt.f2i(${a})`, 0x8f: (a) => `rt.f2l(${a})`, 0x90: (a) => `Math.fround(${a})`,
  0x91: (a) => `((${a}<<24)>>24)`, 0x92: (a) => `(${a}&65535)`, 0x93: (a) => `((${a}<<16)>>16)`,
};

function leafExpr(m: JMethod): ((args: string[]) => string) | null {
  const code = m.code!;
  const c = code.code;
  if (c.length > 32 || code.handlers.length > 0) return null;
  // the expression is built from tokens: ["arg", slot] refers to a parameter
  type Tok = string | ["arg", number] | ["field", number, number];
  const stack: Tok[][] = [];
  // negative literals in parentheses, so "a - -5" cannot become "a--5"
  const lit = (s: string): Tok[] => [s.startsWith("-") ? `(${s})` : s];
  const load = (i: number): Tok[] | null => (i < m.argSlots ? [["arg", i]] : null);
  for (let pc = 0; pc < c.length;) {
    const op = c[pc];
    let len = 1;
    let push: Tok[] | null = null;
    if (op === 0x01) push = lit("null");
    else if (op >= 0x02 && op <= 0x08) push = lit(String(op - 3));
    else if (op === 0x09 || op === 0x0a) push = lit(`${op - 9}n`);
    else if (op >= 0x0b && op <= 0x0f) push = lit(String(op >= 0x0e ? op - 0x0e : op - 0x0b));
    else if (op === 0x10) { push = lit(String((c[pc + 1] << 24) >> 24)); len = 2; }
    else if (op === 0x11) { push = lit(String((((c[pc + 1] << 8) | c[pc + 2]) << 16) >> 16)); len = 3; }
    else if (op >= 0x15 && op <= 0x19) { push = load(c[pc + 1]); len = 2; if (!push) return null; }
    else if (op >= 0x1a && op <= 0x2d) { push = load((op - 0x1a) % 4); if (!push) return null; }
    else if (BINARY[op]) {
      const b = stack.pop(), a = stack.pop();
      if (!a || !b) return null;
      const f = BINARY[op];
      push = [{ op: f, a, b } as any];
    } else if (UNARY[op]) {
      const a = stack.pop();
      if (!a) return null;
      push = [{ op1: UNARY[op], a } as any];
    } else if (op === 0xb4 && !m.isStatic) {
      const a = stack.pop();
      const fld = m.cls.rcp[(c[pc + 1] << 8) | c[pc + 2]] as JField | undefined;
      if (!a || !fld || a.length !== 1 || !Array.isArray(a[0]) || a[0][0] !== "arg" || a[0][1] !== 0) return null;
      push = [["field", 0, fld.slot]];
      len = 3;
    } else if (op >= 0xac && op <= 0xb0) {
      if (pc + 1 !== c.length || stack.length !== 1) return null;
      const result = stack[0];
      return (args) => render(result, args);
    } else return null;
    stack.push(push!);
    pc += len;
  }
  return null;

  function render(toks: Tok[], args: string[]): string {
    return toks.map((x: any) => {
      if (typeof x === "string") return x;
      if (Array.isArray(x)) return x[0] === "arg" ? args[x[1]] : `${args[x[1]]}.f[${x[2]}]`;
      if (x.op) return x.op(render(x.a, args), render(x.b, args));
      return x.op1(render(x.a, args));
    }).join("");
  }
}

function trivialBody(m: JMethod): Trivial | null {
  if (!m.code || m.isSynchronized || m.isAbstract) return null;
  const c = m.code.code;
  const field = () => m.cls.rcp[(c[2] << 8) | c[3]] as JField | undefined;
  if (c.length === 1 && c[0] === 0xb1) return { kind: "empty" };
  if (c.length === 2 && c[0] >= 0x01 && c[0] <= 0x08 && (c[1] === 0xac || c[1] === 0xb0)) {
    return { kind: "const", value: c[0] === 0x01 ? "null" : String(c[0] - 3) };
  }
  if (m.isStatic || c[0] !== 0x2a) {
    const build = leafExpr(m);
    return build ? { kind: "expr", build } : null;
  }
  // aload_0 getfield xreturn
  if (c.length === 5 && c[1] === 0xb4 && c[4] >= 0xac && c[4] <= 0xb0) {
    const f = field();
    return f ? { kind: "get", slot: f.slot } : null;
  }
  // aload_0 xload_1 putfield return
  if (c.length === 6 && [0x1b, 0x1f, 0x23, 0x27, 0x2b].includes(c[1]) && c[2] === 0xb5 && c[5] === 0xb1) {
    const f = m.cls.rcp[(c[3] << 8) | c[4]] as JField | undefined;
    return f ? { kind: "set", slot: f.slot } : null;
  }
  const build = leafExpr(m);
  return build ? { kind: "expr", build } : null;
}

function genInline(body: Trivial, res: string, args: string[], pc: number, isStatic: boolean): string {
  const nullCheck = isStatic ? "" : `if(${args[0]}===null)rt.npe(${pc});`;
  switch (body.kind) {
    case "empty": return nullCheck;
    case "const": return `${nullCheck}${res}=${body.value};`;
    case "get": return `${nullCheck}${res}=${args[0]}.f[${body.slot}];`;
    case "set": return `${nullCheck}${args[0]}.f[${body.slot}]=${args[1]};`;
    case "expr": return `${nullCheck}${res}=${body.build(args)};`;
  }
}

function genInvoke(
  g: Gen, op: number, pc: number, next: number, d: number, target: JMethod, cls: JClass,
  slowDepth = d, inline = op !== 0xb9 && slowDepth === d,
): string {
  const { t, K, exit, call } = g;
  const n = target.argSlots;
  const base = d - n;
  const args = Array.from({ length: n }, (_, i) => `s${base + i}`);
  // inline the callee, guarded by the receiver's class unless the target is fixed
  if (inline) {
    const callee = op === 0xb7 ? t.vm.specialTarget(cls, target) : target;
    const res = `s${base}`;
    let code: string | null = null;
    const trivial = trivialBody(callee);
    if (trivial) code = genInline(trivial, res, args, pc, callee.isStatic);
    else if (callee.code && !callee.isAbstract) {
      try {
        const nullCheck = callee.isStatic ? "" : `if(${args[0]}===null)rt.npe(${pc});`;
        code = nullCheck + genRegion(g, g.top, callee, args, target.ret === "V" ? null : res, pc, base);
      } catch (e) {
        if (!(e instanceof NoInline)) throw e;
      }
    }
    if (code !== null) {
      if (isFixed(op, callee)) return code;
      return `if(${args[0]}!==null&&${args[0]}.cls===${K(callee.cls)}){${code}}else{${genInvoke(g, op, pc, next, d, target, cls, d, false)}}`;
    }
  }
  const parts: string[] = [`f.pc=${pc};`];
  // pick the method
  if (op === 0xb6 || op === 0xb9) {
    if (target.isPrivate) parts.push(`tm=${K(target)};if(${args[0]}===null)rt.npe(${pc});`);
    else {
      const cell = K([null, null, target.key]);
      parts.push(`ic=${cell};tm=${args[0]}!==null&&${args[0]}.cls===ic[0]?ic[1]:rt.select(${args[0]},ic,${pc});`);
    }
  } else if (op === 0xb7) {
    const special = t.vm.specialTarget(cls, target);
    parts.push(`tm=${K(special)};if(${args[0]}===null)rt.npe(${pc});`);
  } else parts.push(`tm=${K(target)};`);
  const ret = target.ret;
  const res = (v: string) => (ret === "V" ? "" : `s${base}=${v};`);
  // compiled callee: direct call
  const recv = target.isStatic ? "null" : args[0];
  parts.push(`if(tm.jit!==null&&(cf=rt.enter(t,tm,${recv}))!==null){`);
  parts.push(`r=tm.jit(t,cf${args.map((x) => "," + x).join("")});if(r!==0){t.unpool(cf);${exit(pc, base, EXIT_SUSPEND)}}`);
  parts.push(`${res("t.ret")}}`);
  // a native callee runs here; anything else goes through the interpreter
  parts.push(`else{v=rt.slowCall(t,tm,[${nativeArgs(target, args)}]);`);
  parts.push(`if(v===rt.PUSHED)${exit(pc, base, EXIT_SUSPEND)}if(v===rt.INTERPRET)${call(pc, slowDepth)}`);
  parts.push(`${res("v")}if(t.state!==0)${exit(next, ret === "V" ? base : base + (isWide(ret) ? 2 : 1), EXIT_SUSPEND)}}`);
  return parts.join("");
}

// Signature-polymorphic calls, dispatched as the interpreter does: invokeBasic
// to the handle's LambdaForm entry, linkTo* to the trailing MemberName, and
// the rest (MethodHandle.invoke, VarHandle.get, ...) to the invoker linked for
// their descriptor. Targets that cannot be called directly go through the
// interpreter.
function genPolymorphic(g: Gen, pc: number, next: number, d: number, target: JMethod): string {
  const { K, exit, call } = g;
  const n = target.argSlots;
  const base = d - n;
  const args = Array.from({ length: n }, (_, i) => `s${base + i}`);
  let select: string;
  let callArgs = args;
  switch (target.name) {
    case "invokeBasic":
      select = `tm=rt.basicTarget(t,${args[0]},${pc});`;
      break;
    case "linkToStatic": case "linkToSpecial":
      callArgs = args.slice(0, -1);
      select = `tm=rt.memberTarget(t,${args[n - 1]});`;
      break;
    case "linkToVirtual": case "linkToInterface":
      callArgs = args.slice(0, -1);
      select = `tm=rt.virtualTarget(t,${args[n - 1]},${callArgs[0]},${pc});`;
      break;
    default: {
      const link = target.link;
      if (!link || link.m.cls.state !== INITIALIZED) return call(pc, d);
      let dd = d;
      let code = "";
      if (link.m.argSlots === n + 1) { code = `s${dd}=${K(link.appendix)};`; dd++; }
      return code + genInvoke(g, 0xb8, pc, next, dd, link.m, g.top.m.cls, d, false);
    }
  }
  const push = target.ret === "V" ? "" : `s${base}=t.ret;`;
  return `f.pc=${pc};${select}` +
    `if(tm.jit!==null&&tm.cls.state===${INITIALIZED}&&(cf=rt.enter(t,tm,${callArgs[0] ?? "null"}))!==null){` +
    `r=tm.jit(t,cf${callArgs.map((x) => "," + x).join("")});if(r!==0){t.unpool(cf);${exit(pc, base, EXIT_SUSPEND)}}` +
    `${push}}else{${call(pc, d)}}`;
}

function nativeArgs(m: JMethod, args: string[]): string {
  const out: string[] = [];
  let i = 0;
  if (!m.isStatic) out.push(args[i++]);
  for (const p of m.params) {
    out.push(args[i]);
    i += isWide(p) ? 2 : 1;
  }
  return out.join(",");
}

// Operand stack change of the instruction at pc, in slots.
function stackDelta(cls: JClass, c: Uint8Array, pc: number): number {
  const op = c[pc];
  const cp = cls.cf!.cp;
  const fieldSize = (idx: number) => {
    const nat = cp[cp[idx]!.b]!;
    return isWide(utf8(cp, nat.b)) ? 2 : 1;
  };
  const methodSlots = (idx: number, withReceiver: boolean) => {
    const e = cp[idx]!;
    const nat = cp[e.b]!;
    const { params, ret } = parseMethodDesc(utf8(cp, nat.b));
    let n = withReceiver ? 1 : 0;
    for (const p of params) n += isWide(p) ? 2 : 1;
    return (ret === "V" ? 0 : isWide(ret) ? 2 : 1) - n;
  };
  switch (op) {
    case 0x12: case 0x13: return 1;
    case 0x14: return 2;
    case 0xb2: return fieldSize(u16(c, pc + 1));
    case 0xb3: return -fieldSize(u16(c, pc + 1));
    case 0xb4: return fieldSize(u16(c, pc + 1)) - 1;
    case 0xb5: return -fieldSize(u16(c, pc + 1)) - 1;
    case 0xb6: case 0xb7: case 0xb9: return methodSlots(u16(c, pc + 1), true);
    case 0xb8: case 0xba: return methodSlots(u16(c, pc + 1), false);
    case 0xc5: return 1 - c[pc + 3];
    case 0xc4: {
      const w = c[pc + 1];
      if (w === 0x84 || w === 0xa9) return 0;
      if (w === 0x16 || w === 0x18) return 2;
      if (w >= 0x15 && w <= 0x19) return 1;
      if (w === 0x37 || w === 0x39) return -2;
      return -1;
    }
  }
  const dlt = DELTA[op];
  if (dlt === 99) throw new Unsupported(`opcode ${op}`);
  return dlt;
}

const DELTA = new Int8Array(256).fill(99);
{
  const set = (ops: number[], v: number) => { for (const o of ops) DELTA[o] = v; };
  set([0x00, 0x74, 0x76, 0x84, 0x86, 0x8b, 0x91, 0x92, 0x93, 0xa7, 0xc8, 0xbc, 0xbd, 0xbe, 0xc0, 0xc1], 0);
  DELTA[0x75] = 0; DELTA[0x77] = 0; DELTA[0x8a] = 0; DELTA[0x8f] = 0;
  set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0d, 0x10, 0x11, 0x15, 0x17, 0x19,
    0x1a, 0x1b, 0x1c, 0x1d, 0x22, 0x23, 0x24, 0x25, 0x2a, 0x2b, 0x2c, 0x2d, 0x59, 0xbb], 1);
  set([0x09, 0x0a, 0x0e, 0x0f, 0x16, 0x18, 0x1e, 0x1f, 0x20, 0x21, 0x26, 0x27, 0x28, 0x29, 0x5c], 2);
  set([0x5a, 0x5b], 1);
  set([0x5d, 0x5e], 2);
  set([0x2e, 0x30, 0x32, 0x33, 0x34, 0x35], -1);
  set([0x2f, 0x31], 0);
  set([0x36, 0x38, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x43, 0x44, 0x45, 0x46, 0x4b, 0x4c, 0x4d, 0x4e, 0x57,
    0x60, 0x62, 0x64, 0x66, 0x68, 0x6a, 0x6c, 0x6e, 0x70, 0x72, 0x78, 0x7a, 0x7c, 0x7e, 0x80, 0x82,
    0x95, 0x96, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0xaa, 0xab, 0xc2, 0xc3, 0xc6, 0xc7, 0x88, 0x89, 0x8e, 0x90,
    0x79, 0x7b, 0x7d, 0xac, 0xae, 0xb0, 0xbf], -1);
  set([0x37, 0x39, 0x3f, 0x40, 0x41, 0x42, 0x47, 0x48, 0x49, 0x4a, 0x58, 0x61, 0x63, 0x65, 0x67, 0x69, 0x6b,
    0x6d, 0x6f, 0x71, 0x73, 0x7f, 0x81, 0x83, 0x9f, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xad, 0xaf], -2);
  set([0x4f, 0x51, 0x53, 0x54, 0x55, 0x56], -3);
  set([0x94, 0x97, 0x98], -3);
  set([0x50, 0x52], -4);
  set([0x85, 0x87, 0x8c, 0x8d], 1);
  set([0xb1], 0);
  set([0x5f], 0);
}
