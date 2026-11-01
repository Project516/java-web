// java.lang natives: Object, System, Thread, Throwable, String, Runtime, ...

import { isHidden } from "./stackwalk.ts";
import { gcStats } from "./management.ts";
import { assertionsEnabled } from "../assertions.ts";
import { normalize } from "../fs.ts";
import { ACC_INTERFACE, JArray, JClass, JObject, MAX_HEAP, newArrayData } from "../runtime.ts";
import {
  Frame, JThread, JavaThrow, PendingThrow, STATUS_BLOCKED, STATUS_RUNNABLE, STATUS_SLEEPING, STATUS_TIMED_WAITING,
  STATUS_WAITING, TERMINATED,
} from "../thread.ts";
import type { NativeGen } from "../thread.ts";
import { javaFrames, jstr, nonNull, sourceFile } from "./util.ts";
import type { Natives } from "./util.ts";

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);
const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);

function setThreadStatus(t: JThread, status: number) {
  t.vm.setThreadStatus(t, status);
}

function checkInterrupt(t: JThread) {
  if (t.interrupted) {
    t.interrupted = false;
    throw new PendingThrow("java/lang/InterruptedException");
  }
}

// Sleeps up to ms (forever when ms is null), waking early on t.wake.
export function interruptibleWait(t: JThread, ms: number | null, register?: (wake: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        t.vm.timers.delete(timer);
      }
      t.wake = null;
      resolve();
    };
    t.wake = done;
    register?.(done);
    if (ms !== null) {
      timer = setTimeout(done, Math.max(0, ms));
      t.vm.timers.add(timer);
    }
  });
}

function* waitImpl(t: JThread, self: JObject, ms: bigint): NativeGen {
  const vm = t.vm;
  const mon = self.mon;
  if (!mon || mon.owner !== t) throw new PendingThrow("java/lang/IllegalMonitorStateException", "current thread is not owner");
  checkInterrupt(t);
  const count = mon.count;
  vm.releaseMonitor(mon);
  setThreadStatus(t, ms > 0n ? STATUS_TIMED_WAITING : STATUS_WAITING);
  let entry: { t: JThread; wake: () => void } | null = null;
  yield t.block(interruptibleWait(t, ms > 0n ? Number(ms) : null, (wake) => {
    entry = { t, wake };
    mon.waiters.push(entry);
  }));
  const i = mon.waiters.indexOf(entry!);
  if (i >= 0) mon.waiters.splice(i, 1);
  if (mon.owner !== null) setThreadStatus(t, STATUS_BLOCKED);
  while (mon.owner !== null) yield t.block(new Promise<void>((r) => mon.entry.push(r)));
  mon.owner = t;
  mon.count = count;
  setThreadStatus(t, STATUS_RUNNABLE);
  checkInterrupt(t);
}

function arraycopy(t: JThread, src: JObject | null, sp: number, dst: JObject | null, dp: number, n: number) {
  if (src === null || dst === null) throw new PendingThrow("java/lang/NullPointerException");
  if (!(src instanceof JArray)) throw new PendingThrow("java/lang/ArrayStoreException", `arraycopy: source type ${src.cls.javaName} is not an array`);
  if (!(dst instanceof JArray)) throw new PendingThrow("java/lang/ArrayStoreException", `arraycopy: destination type ${dst.cls.javaName} is not an array`);
  const sc = src.cls.component!, dc = dst.cls.component!;
  if ((sc.prim || dc.prim) && sc !== dc) {
    throw new PendingThrow("java/lang/ArrayStoreException",
      `arraycopy: type mismatch: can not copy ${src.cls.javaName.replace(/^\[/, "")}[] into ${dst.cls.javaName.replace(/^\[/, "")}[]`);
  }
  const sa = src.a, da = dst.a;
  if (n < 0 || sp < 0 || dp < 0 || sp + n > sa.length || dp + n > da.length) {
    let what: string;
    if (sp < 0) what = `arraycopy: source index ${sp} out of bounds for ${typeName(src)}`;
    else if (dp < 0) what = `arraycopy: destination index ${dp} out of bounds for ${typeName(dst)}`;
    else if (n < 0) what = `arraycopy: length ${n} is negative`;
    else if (sp + n > sa.length) what = `arraycopy: last source index ${sp + n} out of bounds for ${typeName(src)}`;
    else what = `arraycopy: last destination index ${dp + n} out of bounds for ${typeName(dst)}`;
    throw new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", what);
  }
  if (n === 0) return;
  if (!Array.isArray(sa)) {
    // small copies are cheaper as a loop than through a subarray view
    if (n <= 32) SMALL_COPY[sc.prim!](sa, sp, da, dp, n);
    else if (sa === da) (da as Int32Array).copyWithin(dp, sp, sp + n);
    else (da as Int32Array).set((sa as Int32Array).subarray(sp, sp + n), dp);
    return;
  }
  const d = da as (JObject | null)[];
  if (sc === dc || sc.isAssignableTo(dc)) {
    if (sa === da && sp < dp) for (let i = n - 1; i >= 0; i--) d[dp + i] = sa[sp + i];
    else for (let i = 0; i < n; i++) d[dp + i] = sa[sp + i];
    return;
  }
  for (let i = 0; i < n; i++) {
    const v = sa[sp + i];
    if (v !== null && !v.cls.isAssignableTo(dc)) {
      throw new PendingThrow("java/lang/ArrayStoreException",
        `arraycopy: element type mismatch: can not cast one of the elements of ${src.cls.javaName.replace(/^\[L(.*);$/, "$1")}[] to the type of the destination array, ${dc.javaName}`);
    }
    d[dp + i] = v;
  }
}

// One copy loop per element type, so each loop sees a single array kind.
// Separate code needs new Function; pages that forbid eval share one loop.
type Copy = (s: any, sp: number, d: any, dp: number, n: number) => void;
const COPY_SRC = "if(s===d&&sp<dp)for(let i=n-1;i>=0;i--)d[dp+i]=s[sp+i];else for(let i=0;i<n;i++)d[dp+i]=s[sp+i];";
const copyAny: Copy = (s, sp, d, dp, n) => {
  if (s === d && sp < dp) for (let i = n - 1; i >= 0; i--) d[dp + i] = s[sp + i];
  else for (let i = 0; i < n; i++) d[dp + i] = s[sp + i];
};
function copyLoop(): Copy {
  try {
    return new Function("s", "sp", "d", "dp", "n", COPY_SRC) as Copy;
  } catch {
    return copyAny;
  }
}
const SMALL_COPY: Record<string, Copy> = {
  Z: copyLoop(), B: copyLoop(), C: copyLoop(), S: copyLoop(), I: copyLoop(), J: copyLoop(), F: copyLoop(), D: copyLoop(),
};

function typeName(a: JArray) {
  const c = a.cls.component!;
  return `${c.prim ? c.javaName : "object array"}[${a.a.length}]`;
}

export function cloneObject(t: JThread, o: JObject): JObject {
  if (o instanceof JArray) {
    const a = o.a;
    if (Array.isArray(a)) return new JArray(o.cls, a.slice());
    const copy = newArrayData(o.cls.component!.prim!, a.length) as Int32Array;
    copy.set(a as Int32Array);
    return new JArray(o.cls, copy);
  }
  if (!o.cls.allSupers().has(t.vm.loadBoot("java/lang/Cloneable")!)) {
    throw new PendingThrow("java/lang/CloneNotSupportedException", o.cls.javaName);
  }
  const copy = new JObject(o.cls, o.f.slice());
  copy.x = o.x;
  return copy;
}

const PRIMS: Record<string, string> = {
  boolean: "Z", byte: "B", char: "C", short: "S", int: "I", long: "J", float: "F", double: "D", void: "V",
};

export const natives: Natives = {
  // Object
  "java/lang/Object.getClass()Ljava/lang/Class;": (t, [o]) => t.vm.mirror(o.cls),
  "java/lang/Object.hashCode()I": (t, [o]) => t.vm.identityHash(o),
  "java/lang/Object.clone()Ljava/lang/Object;": (t, [o]) => cloneObject(t, o),
  "java/lang/Object.notify()V": (t, [o]) => {
    const mon = o.mon;
    if (!mon || mon.owner !== t) throw new PendingThrow("java/lang/IllegalMonitorStateException", "current thread is not owner");
    mon.waiters.shift()?.wake();
  },
  "java/lang/Object.notifyAll()V": (t, [o]) => {
    if (!o.mon || o.mon.owner !== t) throw new PendingThrow("java/lang/IllegalMonitorStateException", "current thread is not owner");
    t.vm.notifyAll(o);
  },
  "java/lang/Object.wait0(J)V": (t, [o, ms]) => waitImpl(t, o, ms),

  // System
  "java/lang/System.setIn0(Ljava/io/InputStream;)V": (t, [v]) => t.vm.setStatic(t.vm.loadBoot("java/lang/System")!, "in", v),
  "java/lang/System.setOut0(Ljava/io/PrintStream;)V": (t, [v]) => t.vm.setStatic(t.vm.loadBoot("java/lang/System")!, "out", v),
  "java/lang/System.setErr0(Ljava/io/PrintStream;)V": (t, [v]) => t.vm.setStatic(t.vm.loadBoot("java/lang/System")!, "err", v),
  "java/lang/System.currentTimeMillis()J": () => BigInt(Date.now()),
  "java/lang/System.nanoTime()J": () => BigInt(Math.round(performance.now() * 1e6)),
  "java/lang/System.arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V": (t, [s, sp, d, dp, n]) => arraycopy(t, s, sp, d, dp, n),
  "java/lang/System.identityHashCode(Ljava/lang/Object;)I": (t, [o]) => (o === null ? 0 : t.vm.identityHash(o)),
  // A library the page provides is a JS module, name.js, found on java.library.path
  "java/lang/System.mapLibraryName(Ljava/lang/String;)Ljava/lang/String;": (t, [n]) => {
    const name = jstr(t, nonNull(n));
    const dirs = (t.vm.props.get("java.library.path") ?? "").split(":").filter(Boolean);
    const found = dirs.some((d) => t.vm.fs.stat(normalize(`${d}/${name}.js`)));
    return t.vm.str(found ? `${name}.js` : `lib${name}.so`);
  },

  // Class
  "java/lang/Class.getPrimitiveClass(Ljava/lang/String;)Ljava/lang/Class;": (t, [n]) => {
    const d = PRIMS[t.vm.jsString(n)];
    if (!d) throw new PendingThrow("java/lang/ClassNotFoundException", t.vm.jsString(n));
    return t.vm.mirror(t.vm.primClass(d));
  },
  "java/lang/Class.desiredAssertionStatus0(Ljava/lang/Class;)Z": (t, [c]) => {
    const a = t.vm.opts.assertions;
    const cls = t.vm.classOf(nonNull(c));
    return a && assertionsEnabled(a, cls.javaName, cls.loader === null) ? 1 : 0;
  },
  "java/lang/Class.initClassName()Ljava/lang/String;": (t, [m]) => {
    const s = t.vm.intern(t.vm.classOf(m).javaName);
    t.vm.setField(m, "java/lang/Class", "name", s);
    return s;
  },
  "java/lang/Class.isInstance(Ljava/lang/Object;)Z": (t, [m, o]) => o !== null && o.cls.isAssignableTo(t.vm.classOf(m)),
  "java/lang/Class.isAssignableFrom(Ljava/lang/Class;)Z": (t, [m, other]) => t.vm.classOf(nonNull(other)).isAssignableTo(t.vm.classOf(m)),
  "java/lang/Class.getSuperclass()Ljava/lang/Class;": (t, [m]) => {
    const c = t.vm.classOf(m);
    if (c.isInterface || c.prim) return null;
    return c.superclass ? t.vm.mirror(c.superclass) : null;
  },
  "java/lang/Class.getInterfaces0()[Ljava/lang/Class;": (t, [m]) => {
    const c = t.vm.classOf(m);
    return t.vm.newObjectArray("java/lang/Class", c.interfaces.map((i) => t.vm.mirror(i)));
  },
  "java/lang/Class.isHidden()Z": (t, [m]) => t.vm.classOf(m).hidden,
  "java/lang/Class.getClassAccessFlagsRaw0()I": (t, [m]) => t.vm.classOf(m).access,
  "java/lang/Class.getClassFileVersion0()I": (t, [m]) => {
    let c = t.vm.classOf(m);
    while (c.component) c = c.component;
    const cf = c.cf;
    return cf ? cf.major | (cf.minor << 16) : 69;
  },
  "java/lang/Class.forName0(Ljava/lang/String;ZLjava/lang/ClassLoader;Ljava/lang/Class;)Ljava/lang/Class;":
    (t, [name, init, loader]) => forName(t, t.vm.jsString(nonNull(name)), init === 1, loader),

  // Thread
  "java/lang/Thread.currentThread()Ljava/lang/Thread;": (t) => t.mounted ?? t.obj,
  "java/lang/Thread.currentCarrierThread()Ljava/lang/Thread;": (t) => t.obj,
  "java/lang/Thread.setCurrentThread(Ljava/lang/Thread;)V": (t, [, thread]) => void (t.mounted = thread === t.obj ? null : thread),
  "java/lang/Thread.findScopedValueBindings()Ljava/lang/Object;": () => null,
  "java/lang/Thread.scopedValueCache()[Ljava/lang/Object;": (t) => t.scopedValueCache,
  "java/lang/Thread.setScopedValueCache([Ljava/lang/Object;)V": (t, [c]) => void (t.scopedValueCache = c),
  "java/lang/Thread.ensureMaterializedForStackWalk(Ljava/lang/Object;)V": () => undefined,
  "java/lang/Thread.yield0()V": () => undefined,
  "java/lang/Thread.sleepNanos0(J)V": function* (t, [nanos]): NativeGen {
    checkInterrupt(t);
    setThreadStatus(t, STATUS_SLEEPING);
    // timers can fire a little early by the clock nanoTime reads; sleep at least as asked
    const end = performance.now() + Number(nanos) / 1e6;
    try {
      for (let left = end - performance.now(); left > 0; left = end - performance.now()) {
        yield t.block(interruptibleWait(t, left));
        checkInterrupt(t);
      }
    } finally {
      setThreadStatus(t, STATUS_RUNNABLE);
    }
  },
  "java/lang/Thread.start0()V": (t, [obj]) => {
    const nt = t.vm.javaThread(obj);
    t.vm.setField(obj, "java/lang/Thread", "eetop", BigInt(nt.id));
    const holder = t.vm.getField(obj, "java/lang/Thread", "holder");
    t.vm.setField(holder, "java/lang/Thread$FieldHolder", "threadStatus", STATUS_RUNNABLE);
    t.vm.startThread(nt);
  },
  "java/lang/Thread.holdsLock(Ljava/lang/Object;)Z": (t, [o]) => nonNull<JObject>(o).mon?.owner === t,
  "java/lang/Thread.getThreads()[Ljava/lang/Thread;": (t) => t.vm.newObjectArray("java/lang/Thread",
    [...t.vm.threads].filter((x) => x.state !== TERMINATED && x.obj).map((x) => x.obj!)),
  "java/lang/Thread.setPriority0(I)V": () => undefined,
  "java/lang/Thread.interrupt0()V": (t, [obj]) => {
    const target = obj.x as JThread | undefined;
    target?.wake?.();
  },
  "java/lang/Thread.clearInterruptEvent()V": () => undefined,
  "java/lang/Thread.setNativeName(Ljava/lang/String;)V": () => undefined,
  "java/lang/Thread.getNextThreadIdOffset()J": (t) => {
    let addr = t.vm.state.get("tidAddr");
    if (addr === undefined) {
      addr = t.vm.mem.malloc(8);
      // ids below 4 are reserved; 3 is the main thread's, which Thread sets itself
      t.vm.mem.dv.setBigInt64(addr, 4n, true);
      t.vm.state.set("tidAddr", addr);
    }
    return BigInt(addr);
  },

  // Throwable
  "java/lang/Throwable.fillInStackTrace(I)Ljava/lang/Throwable;": (t, [self]) => {
    const frames: { m: any; pc: number }[] = [];
    let skipping = true;
    for (const fr of javaFrames(t)) {
      if (skipping) {
        if (fr.m.name === "fillInStackTrace" && self.cls.isSubclassOf(fr.m.cls)) continue;
        if (fr.m.name === "<init>" && self.cls.isSubclassOf(fr.m.cls)) continue;
        skipping = false;
      }
      if (isHidden(fr.m)) continue;
      // HotSpot's MaxJavaStackTraceDepth
      if (frames.length === 1024) break;
      frames.push(fr);
    }
    t.vm.setField(self, "java/lang/Throwable", "backtrace", frames);
    t.vm.setField(self, "java/lang/Throwable", "depth", frames.length);
    return self;
  },
  "java/lang/StackTraceElement.initStackTraceElements([Ljava/lang/StackTraceElement;Ljava/lang/Object;I)V":
    (t, [elements, bt, depth]) => {
      for (let i = 0; i < depth; i++) fillElement(t, elements.a[i], bt[i].m.cls, bt[i].m.name, bt[i].pc, bt[i].m);
    },

  // String and boxes
  "java/lang/String.intern()Ljava/lang/String;": (t, [s]) => t.vm.internObject(s),
  "java/lang/StringUTF16.isBigEndian()Z": () => 0,
  "java/lang/Float.floatToRawIntBits(F)I": (_t, [v]) => { f32[0] = v; return i32[0]; },
  "java/lang/Float.intBitsToFloat(I)F": (_t, [v]) => { i32[0] = v; return f32[0]; },
  "java/lang/Double.doubleToRawLongBits(D)J": (_t, [v]) => { f64[0] = v; return i64[0]; },
  "java/lang/Double.longBitsToDouble(J)D": (_t, [v]) => { i64[0] = v; return f64[0]; },

  // Runtime
  "java/lang/Runtime.availableProcessors()I": () => 1,
  // free <= total <= max, as callers that compute available memory expect
  "java/lang/Runtime.freeMemory()J": () => BigInt(Math.min(512 << 20, MAX_HEAP) / 2),
  "java/lang/Runtime.totalMemory()J": () => BigInt(Math.min(512 << 20, MAX_HEAP)),
  "java/lang/Runtime.maxMemory()J": () => BigInt(MAX_HEAP),
  // Collects where the engine allows it (node --expose-gc), in a new JS job:
  // a WeakRef read earlier in a job keeps its target alive until the job ends.
  "java/lang/Runtime.gc()V": function* (t): NativeGen {
    const stats = gcStats(t.vm);
    stats.count++;
    const gc = (globalThis as { gc?: () => void }).gc;
    if (!gc) return;
    yield t.block(new Promise((r) => setTimeout(r, 0)));
    // values popped off an operand stack are not roots in HotSpot
    for (const th of t.vm.threads) for (const f of th.frames) if (f instanceof Frame && f.stack) f.stack.fill(undefined, f.sp);
    const t0 = performance.now();
    gc();
    stats.ms += performance.now() - t0;
  },
  "java/lang/Shutdown.beforeHalt()V": () => undefined,
  "java/lang/Shutdown.halt0(I)V": (t, [code]) => t.vm.halt(code),

};

export function fillElement(t: JThread, e: JObject, c: JClass, method: string, pc: number, m: any) {
  const vm = t.vm;
  const S = "java/lang/StackTraceElement";
  vm.setField(e, S, "declaringClassObject", vm.mirror(c));
  vm.setField(e, S, "declaringClass", vm.intern(c.javaName));
  vm.setField(e, S, "methodName", vm.intern(method));
  if (c.loader) {
    const name = vm.getField(c.loader, "java/lang/ClassLoader", "name");
    if (name) vm.setField(e, S, "classLoaderName", name);
  }
  const mod = vm.moduleOf(c);
  if (mod) {
    const name = vm.getField(mod, "java/lang/Module", "name");
    if (name) {
      vm.setField(e, S, "moduleName", name);
      const version = vm.shownVersion(mod);
      if (version) vm.setField(e, S, "moduleVersion", vm.intern(version));
    }
  }
  const src = sourceFile(c);
  vm.setField(e, S, "fileName", src ? vm.intern(src) : null);
  vm.setField(e, S, "lineNumber", pc === -2 ? -2 : m ? m.lineAt(pc) : -1);
}

function* forName(t: JThread, name: string, init: boolean, loader: JObject | null): NativeGen {
  const vm = t.vm;
  if (name.includes("/") || name.length === 0 || /^\[{256}/.test(name)) throw new PendingThrow("java/lang/ClassNotFoundException", name);
  const internal = name.replace(/\./g, "/");
  let c: JClass;
  try {
    c = yield* vm.loadClassGen(t, loader, internal, true);
  } catch (e) {
    if (e instanceof PendingThrow && e.cls === "java/lang/NoClassDefFoundError") {
      throw new PendingThrow("java/lang/ClassNotFoundException", name);
    }
    throw e;
  }
  if (init && c.state !== 3 && !c.component) yield* vm.initGen(t, c);
  return vm.mirror(c);
}

export { forName, ACC_INTERFACE, JavaThrow };
