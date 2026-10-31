// Java threads are green threads: each has its own frame stack and the
// scheduler interleaves them at instruction boundaries.

import type { JMethod, JObject } from "./runtime.ts";
import type { JVM } from "./jvm.ts";

export class Frame {
  m: JMethod;
  code: Uint8Array;
  // While this frame is calling out, pc stays on the invoke instruction.
  pc = 0;
  sp = 0;
  // null for frames of direct compiled calls until they spill
  locals: any[];
  stack: any[];
  // monitor taken by a synchronized method, and whether it is still owed
  lock: JObject | null = null;
  needLock = false;
  // called directly by compiled code, which takes the return value from t.ret
  direct = false;
  // index in its thread's pool of direct-call frames, or -1
  poolSlot = -1;
  constructor(m: JMethod, lazy = false) {
    const code = m.code!;
    this.m = m;
    this.code = code.code;
    this.locals = lazy ? (null as any) : new Array(code.maxLocals);
    this.stack = lazy ? (null as any) : new Array(code.maxStack + 2);
  }
}

// What a generator native can yield. "resume" waits for frames the native
// pushed itself to return to it.
export type Request =
  | { kind: "invoke"; m: JMethod; args: any[] }
  | { kind: "wait"; promise: Promise<any> }
  | { kind: "resume" };

export type NativeGen = Generator<Request, any, any>;

// Runs JS code that calls back into Java. The generator yields Requests and
// its return value goes to the caller frame.
export class NativeFrame {
  readonly gen: NativeGen;
  // native method this frame implements, or null for VM-internal work
  readonly m: JMethod | null;
  // return type descriptor delivered to the caller ("V" for nothing)
  readonly ret: string;
  // when set, the caller re-executes its current instruction instead of
  // taking a return value (used for class loading and initialization)
  readonly reexec: boolean;
  input: any = undefined;
  thrown: JObject | null = null;
  constructor(gen: NativeGen, m: JMethod | null, ret: string, reexec: boolean) {
    this.gen = gen;
    this.m = m;
    this.ret = ret;
    this.reexec = reexec;
  }
}

export type AnyFrame = Frame | NativeFrame;

// A Java exception in flight through JS code.
export class JavaThrow extends Error {
  readonly obj: JObject;
  constructor(obj: JObject) {
    super("java exception");
    this.obj = obj;
  }
}

// Thrown by JS code that wants a new Java exception; the interpreter
// constructs it with its real constructor before throwing it.
export class PendingThrow extends Error {
  readonly cls: string;
  readonly msg: string | null;
  // a constructor other than (String) or (), with its arguments
  readonly ctor?: { desc: string; args: any[] };
  // bytecode position of the failing instruction, set by compiled code
  pc?: number;
  // the native method that threw it, which its stack trace starts with
  native?: JMethod;
  constructor(cls: string, msg: string | null = null, ctor?: { desc: string; args: any[] }) {
    super(`${cls}: ${msg}`);
    this.cls = cls;
    this.msg = msg;
    this.ctor = ctor;
  }
}

export function fromNative(e: unknown, m: JMethod): unknown {
  if (e instanceof PendingThrow && !m.intrinsic && !m.polymorphic) e.native ??= m;
  return e;
}

export const RUNNABLE = 0, WAITING = 1, TERMINATED = 2;

// JVMTI thread status values stored in Thread.FieldHolder.threadStatus
export const STATUS_NEW = 0, STATUS_RUNNABLE = 5, STATUS_TERMINATED = 2;
export const STATUS_SLEEPING = 0x00e1, STATUS_WAITING = 0x0191, STATUS_TIMED_WAITING = 0x01a1;
export const STATUS_PARKED = 0x0291, STATUS_PARKED_TIMED = 0x02a1, STATUS_BLOCKED = 0x0401;

let nextId = 1;

export class JThread {
  readonly vm: JVM;
  readonly id = nextId++;
  obj: JObject | null = null;
  frames: AnyFrame[] = [];
  // waiting to enter a monitor
  blockedOnMonitor = false;
  // monitor entries not yet exited, and Continuation.pin() depth
  held = 0;
  pins = 0;
  // the virtual thread mounted on this carrier thread, if any
  mounted: JObject | null = null;
  // Thread.scopedValueCache
  scopedValueCache: JObject | null = null;
  state = RUNNABLE;
  daemon = false;
  parkPermit = false;
  // frame count that triggers StackOverflowError
  stackLimit = 6000;
  // return value of a direct compiled call, and the frame count when the
  // run loop last entered compiled code
  ret: any = undefined;
  base = 0;
  // wakes the thread early from sleep, park or wait, for interrupt/unpark
  wake: (() => void) | null = null;
  // set when the bottom frame finishes
  onExit: (() => void) | null = null;
  constructor(vm: JVM) {
    this.vm = vm;
  }

  // Frames for direct compiled calls, reused by stack depth once popped. A
  // frame that suspends leaves the pool, so the pool never keeps the values
  // it spilled.
  private pool: (Frame | null)[] = [];

  directFrame(m: JMethod): Frame {
    const d = this.frames.length;
    // filled without holes, which would make V8 store it as a dictionary
    while (this.pool.length <= d) this.pool.push(this.pooled(m, this.pool.length));
    const f = this.pool[d] ?? (this.pool[d] = this.pooled(m, d));
    f.m = m;
    f.code = m.code!.code;
    f.pc = 0;
    f.sp = 0;
    f.locals = null as any;
    f.stack = null as any;
    f.lock = null;
    f.needLock = false;
    f.direct = true;
    return f;
  }

  private pooled(m: JMethod, slot: number): Frame {
    const f = new Frame(m, true);
    f.poolSlot = slot;
    return f;
  }

  // A direct frame whose call suspended: the run loop finishes it like any frame.
  unpool(f: Frame) {
    f.direct = false;
    if (this.pool[f.poolSlot] === f) this.pool[f.poolSlot] = null;
  }

  get top(): AnyFrame {
    return this.frames[this.frames.length - 1];
  }

  get name(): string {
    if (!this.obj) return `thread-${this.id}`;
    const n = this.vm.getField(this.obj, "java/lang/Thread", "name");
    return n ? this.vm.jsString(n) : `thread-${this.id}`;
  }

  get interrupted(): boolean {
    return !!this.obj && this.vm.getField(this.obj, "java/lang/Thread", "interrupted") === 1;
  }

  set interrupted(v: boolean) {
    if (this.obj) this.vm.setField(this.obj, "java/lang/Thread", "interrupted", v ? 1 : 0);
  }

  pushNative(gen: NativeGen, m: JMethod | null, ret: string, reexec: boolean) {
    this.frames.push(new NativeFrame(gen, m, ret, reexec));
  }

  // Blocks the thread until the promise settles. Resolves to the value, or
  // throws into the generator when the promise rejects with a JavaThrow.
  block(promise: Promise<any>): Request {
    return { kind: "wait", promise };
  }

  // A Request to call a method directly (no virtual dispatch).
  call(m: JMethod, ...args: any[]): Request {
    return { kind: "invoke", m, args };
  }

  // A Request to call a method through virtual dispatch on args[0].
  callVirtual(recv: JObject, name: string, desc: string, ...args: any[]): Request {
    const m = recv.cls.selectMethod(name + desc);
    if (!m) throw new Error(`no method ${name}${desc} in ${recv.cls.name}`);
    return { kind: "invoke", m, args: [recv, ...args] };
  }
}
