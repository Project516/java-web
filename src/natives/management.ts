// java.management natives: what HotSpot's JMM interface (services/management.cpp)
// reports, for a VM with green threads on the JS engine's collector. Memory
// managers and pools have the names HotSpot gives them with G1, its default
// collector. Heap usage is the JS heap's; collections are the explicit
// System.gc() calls, which HotSpot counts as full collections.

import { INITIALIZED, JArray, JClass, JObject, MAX_HEAP } from "../runtime.ts";
import type { JMethod } from "../runtime.ts";
import {
  Frame, JThread, NativeFrame, PendingThrow, STATUS_BLOCKED, STATUS_NEW, STATUS_PARKED, STATUS_PARKED_TIMED, STATUS_RUNNABLE,
  STATUS_TERMINATED, STATUS_TIMED_WAITING, STATUS_WAITING, TERMINATED,
} from "../thread.ts";
import type { NativeGen } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import { openFdCount } from "./io.ts";
import { box, initialized } from "./reflect.ts";
import { continuationEntry } from "./continuation.ts";
import { fillElement } from "./lang.ts";
import type { Natives } from "./util.ts";

// the memory managers and pools of HotSpot's default collector, G1
const MANAGERS = [
  { name: "CodeCacheManager", gc: false, pools: ["CodeHeap 'profiled nmethods'", "CodeHeap 'non-nmethods'", "CodeHeap 'non-profiled nmethods'"] },
  { name: "Metaspace Manager", gc: false, pools: ["Metaspace", "Compressed Class Space"] },
  { name: "G1 Young Generation", gc: true, pools: ["G1 Eden Space", "G1 Survivor Space", "G1 Old Gen"] },
  { name: "G1 Concurrent GC", gc: true, pools: ["G1 Old Gen"] },
  { name: "G1 Old Generation", gc: true, pools: ["G1 Eden Space", "G1 Survivor Space", "G1 Old Gen"] },
];
// in HotSpot's order, with whether each supports usage and collection thresholds
const POOLS = [
  { name: "CodeHeap 'non-nmethods'", heap: false, usage: true, collection: false },
  { name: "Metaspace", heap: false, usage: true, collection: false },
  { name: "CodeHeap 'profiled nmethods'", heap: false, usage: true, collection: false },
  { name: "Compressed Class Space", heap: false, usage: true, collection: false },
  { name: "G1 Eden Space", heap: true, usage: false, collection: true },
  { name: "G1 Old Gen", heap: true, usage: true, collection: true },
  { name: "G1 Survivor Space", heap: true, usage: false, collection: true },
  { name: "CodeHeap 'non-profiled nmethods'", heap: false, usage: true, collection: false },
];
const FULL_GC = "G1 Old Generation";
const OLD = "G1 Old Gen";

interface Beans {
  pools: JObject[];
  managers: JObject[];
}

export interface GcStats {
  count: number;
  ms: number;
}

// Explicit collections so far, for GarbageCollectorMXBean.
export function gcStats(vm: JVM): GcStats {
  let s = vm.state.get("gcStats") as GcStats | undefined;
  if (!s) vm.state.set("gcStats", (s = { count: 0, ms: 0 }));
  return s;
}

// The JS heap as Java sees it, with used <= committed <= -Xmx; primitive
// arrays are typed arrays, outside the JS heap. Null where the engine cannot tell.
export function javaHeap(): { used: number; committed: number } | null {
  let used: number, committed: number;
  const node = (globalThis as any).process?.memoryUsage?.();
  const chrome = (globalThis as any).performance?.memory;
  if (node) {
    used = node.heapUsed + node.arrayBuffers;
    committed = node.heapTotal + node.arrayBuffers;
  } else if (chrome) {
    used = chrome.usedJSHeapSize;
    committed = chrome.totalJSHeapSize;
  } else return null;
  committed = Math.min(Math.max(used, committed), MAX_HEAP);
  return { used: Math.min(used, committed), committed };
}

function* beans(t: JThread): NativeGen {
  const vm = t.vm;
  let b = vm.state.get("mgmtBeans") as Beans | undefined;
  if (b) return b;
  const helper = vm.loadBoot("sun/management/ManagementFactoryHelper")!;
  const method = (key: string): JMethod => helper.methodMap.get(key)!;
  const pools: JObject[] = [];
  for (const p of POOLS) {
    pools.push(yield t.call(method("createMemoryPool(Ljava/lang/String;ZJJ)Ljava/lang/management/MemoryPoolMXBean;"),
      vm.str(p.name), p.heap ? 1 : 0, p.usage ? 0n : -1n, p.collection ? 0n : -1n));
  }
  const managers: JObject[] = [];
  for (const m of MANAGERS) {
    managers.push(m.gc
      ? yield t.call(method("createGarbageCollector(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/management/GarbageCollectorMXBean;"), vm.str(m.name), null)
      : yield t.call(method("createMemoryManager(Ljava/lang/String;)Ljava/lang/management/MemoryManagerMXBean;"), vm.str(m.name)));
  }
  b = { pools, managers };
  vm.state.set("mgmtBeans", b);
  return b;
}

function* usage(t: JThread, init: number, used: number, committed: number, max: number): NativeGen {
  const vm = t.vm;
  const c = vm.loadBoot("java/lang/management/MemoryUsage")!;
  const o = vm.newObject(c);
  yield t.call(c.methodMap.get("<init>(JJJJ)V")!, o, BigInt(init), BigInt(used), BigInt(committed), BigInt(max));
  return o;
}

function* poolUsage(t: JThread, self: JObject): NativeGen {
  const b: Beans = yield* beans(t);
  const pool = POOLS[b.pools.indexOf(self)];
  if (pool.name !== OLD) return yield* usage(t, 0, 0, 0, -1);
  return yield* heapUsage(t);
}

function* heapUsage(t: JThread): NativeGen {
  const h = javaHeap() ?? { used: 0, committed: 0 };
  return yield* usage(t, 0, h.used, h.committed, MAX_HEAP);
}

function liveThreads(vm: JVM): JThread[] {
  return [...vm.threads].filter((x) => x.state !== TERMINATED && x.obj);
}

// A host module under Node; none in a browser.
function host(name: string): any {
  return (globalThis as any).process?.getBuiltinModule?.(name);
}

// A number from a /proc file's line that starts with the label, in its unit
function procValue(file: string, label: string, field = 1): number {
  try {
    const line = host("node:fs").readFileSync(file, "utf8").split("\n").find((l: string) => l.startsWith(label));
    return Number(line?.trim().split(/\s+/)[field]);
  } catch {
    return NaN;
  }
}

const orElse = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

// the soft limit, as HotSpot reads getrlimit's rlim_cur; an unlimited one is -1 after its jlong cast
function maxOpenFiles(): bigint {
  try {
    const line = host("node:fs").readFileSync("/proc/self/limits", "utf8").split("\n").find((l: string) => l.startsWith("Max open files"));
    const soft = line.trim().split(/\s+/)[3];
    return soft === "unlimited" ? -1n : BigInt(soft);
  } catch {
    return 1024n;
  }
}
const KB = 1024;

// The VM options java-web can state, as HotSpot reports them with G1
const FLAGS: { name: string; value: boolean | number; writeable: boolean }[] = [
  { name: "HeapDumpOnOutOfMemoryError", value: false, writeable: true },
  { name: "LockingMode", value: 2, writeable: false },
  { name: "MaxHeapSize", value: MAX_HEAP, writeable: false },
  { name: "PrintConcurrentLocks", value: false, writeable: true },
  { name: "UseCompressedOops", value: true, writeable: false },
  { name: "UseG1GC", value: true, writeable: false },
  { name: "UseParallelGC", value: false, writeable: false },
  { name: "UseSerialGC", value: false, writeable: false },
];

const TH = "java/lang/Thread";
const AOS = "java/util/concurrent/locks/AbstractOwnableSynchronizer";
const THREAD_INFO = "java/lang/management/ThreadInfo";
const THREAD_INFO_INIT = "<init>(Ljava/lang/Thread;ILjava/lang/Object;Ljava/lang/Thread;JJJJ[Ljava/lang/StackTraceElement;)V";
const THREAD_INFO_LOCKS_INIT =
  "<init>(Ljava/lang/Thread;ILjava/lang/Object;Ljava/lang/Thread;JJJJ[Ljava/lang/StackTraceElement;[Ljava/lang/Object;[I[Ljava/lang/Object;)V";

function threadStatus(vm: JVM, t: JThread): number {
  const holder = vm.getField(t.obj!, TH, "holder");
  return holder ? vm.getField(holder, "java/lang/Thread$FieldHolder", "threadStatus") : STATUS_NEW;
}

// The live platform thread with this id, as HotSpot's thread list has it.
function threadById(vm: JVM, tid: bigint): JThread | null {
  for (const t of liveThreads(vm)) {
    if (vm.getField(t.obj!, TH, "tid") === tid && threadStatus(vm, t) !== STATUS_TERMINATED) return t;
  }
  return null;
}

// A carrier thread with a virtual thread mounted
function isCarrier(t: JThread): boolean {
  return t.mounted !== null && t.mounted !== t.obj;
}

function isSynchronizer(vm: JVM, o: JObject | null): boolean {
  return o !== null && o.cls.isAssignableTo(vm.loadBoot(AOS)!);
}

function synchronizerOwner(vm: JVM, o: JObject): JObject | null {
  return vm.getField(o, AOS, "exclusiveOwnerThread");
}

function platformThread(o: JObject | null): JThread | null {
  const x = o?.x;
  return x instanceof JThread && x.state !== TERMINATED ? x : null;
}

function parkBlocker(vm: JVM, t: JThread): JObject | null {
  return vm.getField(t.obj!, TH, "parkBlocker");
}

interface Shown {
  m: JMethod;
  pc: number;
  // index in the thread's frame stack
  at: number;
}

// The Java frames HotSpot shows for a thread, top first: all of them, hidden
// ones too. A carrier thread shows its own frames, below its virtual thread's.
function threadFrames(t: JThread, maxDepth: number): Shown[] {
  const out: Shown[] = [];
  let i = t.frames.length - 1;
  if (isCarrier(t)) {
    while (i >= 0) {
      const f = t.frames[i--];
      if (f instanceof NativeFrame && continuationEntry(t.vm, f)?.virtual) break;
    }
  }
  for (; i >= 0 && (maxDepth < 0 || out.length < maxDepth); i--) {
    const f = t.frames[i];
    if (f instanceof NativeFrame) {
      if (continuationEntry(t.vm, f)) continue;
      if (f.m) out.push({ m: f.m, pc: -2, at: i });
    } else out.push({ m: f.m, pc: f.pc, at: i });
  }
  return out;
}

interface Block {
  start: number;
  end: number;
  slot: number;
}

const blockCache = new WeakMap<JMethod, Block[]>();

// The synchronized blocks of a method, as compilers emit them: a catch-any
// handler that starts with "astore; aload slot; monitorexit", where slot holds
// the lock object from the monitorenter until the monitorexit.
function syncBlocks(m: JMethod): Block[] {
  let blocks = blockCache.get(m);
  if (blocks) return blocks;
  blocks = [];
  const code = m.code!.code;
  const slotAt = (pc: number, base: number, op: number): [number, number] | null =>
    code[pc] >= base && code[pc] <= base + 3 ? [code[pc] - base, 1] : code[pc] === op ? [code[pc + 1], 2] : null;
  for (const h of m.code!.handlers) {
    if (h.catchType !== 0) continue;
    const store = slotAt(h.handler, 0x4b, 0x3a);
    const load = store && slotAt(h.handler + store[1], 0x2a, 0x19);
    if (!load || code[h.handler + store![1] + load[1]] !== 0xc3) continue;
    blocks.push({ start: h.start, end: h.end, slot: load[0] });
  }
  blockCache.set(m, blocks);
  return blocks;
}

// Monitors each frame locked, newest first as javaVFrame::locked_monitors
// lists them, found from the frame's pc and the locals that hold the objects.
// A monitor the thread owns that no frame accounts for is listed with depth -1.
function lockedMonitors(t: JThread, frames: Shown[]): { o: JObject; depth: number }[] {
  const byFrame = new Map<number, JObject[]>();
  const accounted = new Map<JObject, number>();
  const owned = new Set<JObject>();
  t.frames.forEach((f, at) => {
    if (!(f instanceof Frame)) return;
    const held: JObject[] = [];
    const locals: any[] = f.locals ?? [];
    for (const v of locals) if (v instanceof JObject && v.mon?.owner === t) owned.add(v);
    if (locals.length) {
      const active = syncBlocks(f.m).filter((b) => b.start <= f.pc && f.pc < b.end);
      // a handler's own range is listed too, so one lock can appear twice
      const slots = [...new Set(active.sort((x, y) => y.start - x.start).map((b) => b.slot))];
      for (const slot of slots) {
        const v = locals[slot];
        if (v instanceof JObject && v.mon?.owner === t) held.push(v);
      }
    }
    if (f.lock && !f.needLock && f.lock.mon?.owner === t) held.push(f.lock);
    for (const o of held) accounted.set(o, (accounted.get(o) ?? 0) + 1);
    byFrame.set(at, held);
  });
  const out: { o: JObject; depth: number }[] = [];
  frames.forEach((fr, depth) => {
    for (const o of byFrame.get(fr.at) ?? []) out.push({ o, depth });
  });
  for (const o of owned) {
    for (let n = o.mon!.count - (accounted.get(o) ?? 0); n > 0; n--) out.push({ o, depth: -1 });
  }
  return out;
}

interface Snapshot {
  thread: JThread;
  status: number;
  blocker: JObject | null;
  owner: JObject | null;
  frames: Shown[];
}

// ThreadSnapshot::initialize
function snapshot(vm: JVM, t: JThread, maxDepth: number): Snapshot {
  let status = threadStatus(vm, t);
  let blocker: JObject | null = null;
  let owner: JObject | null = null;
  if (isCarrier(t)) {
    status = STATUS_WAITING;
    blocker = owner = t.mounted;
  } else if (status === STATUS_BLOCKED || status === STATUS_WAITING || status === STATUS_TIMED_WAITING) {
    const o = t.waitingOn ?? t.pendingOn;
    if (o === null) status = STATUS_RUNNABLE;
    else {
      const holder = o.mon?.owner ?? null;
      if (holder === null && status === STATUS_BLOCKED) status = STATUS_RUNNABLE;
      else {
        blocker = o;
        owner = holder?.obj ?? null;
      }
    }
  } else if (status === STATUS_PARKED || status === STATUS_PARKED_TIMED) {
    blocker = parkBlocker(vm, t);
    if (isSynchronizer(vm, blocker)) owner = synchronizerOwner(vm, blocker!);
  }
  return { thread: t, status, blocker, owner, frames: threadFrames(t, maxDepth) };
}

function stackTraceOf(t: JThread, frames: Shown[]): JObject {
  const vm = t.vm;
  const ste = vm.loadBoot("java/lang/StackTraceElement")!;
  return vm.newObjectArray("java/lang/StackTraceElement", frames.map(({ m, pc }) => {
    const e = vm.newObject(ste);
    fillElement(t, e, m.cls, m.name, pc, m);
    return e;
  }));
}

interface Locks {
  monitors: { o: JObject; depth: number }[];
  syncs: JObject[];
}

function* threadInfo(t: JThread, s: Snapshot, withStack: boolean, locks: Locks | null): NativeGen {
  const vm = t.vm;
  const c = vm.loadBoot(THREAD_INFO)!;
  if (c.state !== INITIALIZED) yield* vm.initGen(t, c);
  const o = vm.newObject(c);
  // contention monitoring is off, so there are counts but no times
  const args = [o, s.thread.obj, s.status, s.blocker, s.owner, BigInt(s.thread.blockedCount), -1n, BigInt(s.thread.waitedCount), -1n,
    withStack ? stackTraceOf(t, s.frames) : null];
  if (locks === null) yield t.call(c.methodMap.get(THREAD_INFO_INIT)!, ...args);
  else {
    const ints = vm.newArray(vm.primClass("I"), locks.monitors.length);
    locks.monitors.forEach((x, i) => ((ints.a as Int32Array)[i] = x.depth));
    args.push(
      vm.newObjectArray("java/lang/Object", locks.monitors.map((x) => x.o)),
      ints,
      vm.newObjectArray("java/lang/Object", locks.syncs),
    );
    yield t.call(c.methodMap.get(THREAD_INFO_LOCKS_INIT)!, ...args);
  }
  return o;
}

// The ownable synchronizers each thread owns, by owner. HotSpot finds them by
// inspecting the heap; so does this, from the class statics and thread stacks,
// which keeps the lock and unlock paths as they are.
function ownedSynchronizers(vm: JVM): Map<JObject, JObject[]> {
  const aos = vm.loadBoot(AOS)!;
  const slot = aos.findField("exclusiveOwnerThread")!.slot;
  const isSync = new Map<JClass, boolean>();
  const seen = new Set<JObject>();
  const classes = new Set<JClass>();
  const stack: JObject[] = [];
  const out = new Map<JObject, JObject[]>();
  const visit = (v: unknown) => {
    if (v instanceof JObject && !seen.has(v)) {
      seen.add(v);
      stack.push(v);
    }
  };
  const visitClass = (c: JClass) => {
    if (classes.has(c)) return;
    classes.add(c);
    if (c.mirror) visit(c.mirror);
    for (const v of c.statics) visit(v);
  };
  for (const c of vm.boot.values()) visitClass(c);
  for (const t of vm.threads) {
    visit(t.obj);
    visit(t.mounted);
    for (const f of t.frames) {
      if (!(f instanceof Frame)) continue;
      visitClass(f.m.cls);
      for (const v of f.locals ?? []) visit(v);
      for (let i = 0; i < f.sp; i++) visit(f.stack?.[i]);
      visit(f.lock);
    }
  }
  while (stack.length > 0) {
    const o = stack.pop()!;
    let sync = isSync.get(o.cls);
    if (sync === undefined) isSync.set(o.cls, (sync = o.cls.isAssignableTo(aos)));
    if (sync) {
      const owner = o.f[slot];
      if (owner) {
        const list = out.get(owner);
        if (list) list.push(o);
        else out.set(owner, [o]);
      }
    }
    visitClass(o.cls);
    if (o instanceof JArray) {
      if (Array.isArray(o.a)) for (const v of o.a) visit(v);
    } else for (const v of o.f) visit(v);
    // a class loader keeps the classes it defined
    const x = o.x;
    if (x instanceof JClass) visitClass(x);
    else if (x?.classes instanceof Map) for (const c of x.classes.values()) visitClass(c);
  }
  return out;
}

function checkIds(ids: JArray) {
  for (const id of ids.a as BigInt64Array) {
    if (id <= 0n) throw new PendingThrow("java/lang/IllegalArgumentException", "Invalid thread ID entry");
  }
}

function* dumpThreads(t: JThread, ids: JArray | null, monitors: boolean, syncs: boolean, maxDepth: number): NativeGen {
  const vm = t.vm;
  if (ids) checkIds(ids);
  const threads = ids
    ? [...(ids.a as BigInt64Array)].map((id) => threadById(vm, id))
    : liveThreads(vm).filter((x) => threadStatus(vm, x) !== STATUS_TERMINATED);
  const owned = syncs ? ownedSynchronizers(vm) : null;
  // all snapshots are taken before any Java code runs
  const dumps = threads.map((x) => {
    if (!x) return null;
    const s = snapshot(vm, x, maxDepth);
    const locks: Locks = {
      monitors: monitors ? lockedMonitors(x, s.frames) : [],
      syncs: syncs ? owned!.get(x.obj!) ?? [] : [],
    };
    return { s, locks };
  });
  const out: (JObject | null)[] = [];
  for (const d of dumps) {
    out.push(d ? yield* threadInfo(t, d.s, true, d.locks) : null);
  }
  return vm.newObjectArray(THREAD_INFO, out);
}

// Cycles of threads waiting on each other, as ThreadService::find_deadlocks_at_safepoint
// finds them. Only monitors, or ownable synchronizers too when asked.
function findDeadlocks(vm: JVM, synchronizers: boolean): JObject | null {
  const pending = (x: JThread) => x.pendingOn;
  const blocker = (x: JThread) => (synchronizers ? parkBlocker(vm, x) : null);
  const dfn = new Map<JThread, number>();
  const cycles: JThread[] = [];
  let next = 0;
  for (const start of liveThreads(vm)) {
    if (isCarrier(start) || dfn.has(start)) continue;
    const first = next;
    dfn.set(start, next++);
    let prev = start;
    let cur: JThread | null = start;
    const path: JThread[] = [];
    let mon = pending(start);
    let park = blocker(start);
    while (cur && (mon || park)) {
      path.push(cur);
      if (mon) {
        const owner = mon.mon?.owner ?? null;
        if (owner !== null) cur = owner.state === TERMINATED ? null : owner;
      } else if (isSynchronizer(vm, park)) {
        cur = platformThread(synchronizerOwner(vm, park!));
      } else cur = null;
      if (cur === null || isCarrier(cur)) break;
      const d = dfn.get(cur);
      if (d === undefined) dfn.set(cur, next++);
      else if (d < first || cur === prev) break;
      else {
        cycles.push(...path);
        break;
      }
      prev = cur;
      mon = pending(cur);
      park = blocker(cur);
    }
  }
  return cycles.length === 0 ? null : vm.newObjectArray(TH, cycles.map((x) => x.obj!));
}

const V = "sun/management/VMManagementImpl.";
const OS = "com/sun/management/internal/OperatingSystemImpl.";
const P = "sun/management/MemoryPoolImpl.";
const T = "sun/management/ThreadImpl.";

export const natives: Natives = {
  [`${V}getVersion0()Ljava/lang/String;`]: (t) => t.vm.str("4.0"),
  [`${V}initOptionalSupportFields()V`]: (t) => {
    const c = t.vm.loadBoot("sun/management/VMManagementImpl")!;
    t.vm.setStatic(c, "objectMonitorUsageSupport", 1);
    t.vm.setStatic(c, "synchronizerUsageSupport", 1);
  },
  [`${V}isThreadContentionMonitoringEnabled()Z`]: () => 0,
  [`${V}isThreadCpuTimeEnabled()Z`]: () => 0,
  [`${V}isThreadAllocatedMemoryEnabled()Z`]: () => 0,
  [`${V}endAOTRecording()Z`]: () => 0,
  [`${V}getTotalClassCount()J`]: (t) => BigInt(t.vm.classCount),
  [`${V}getUnloadedClassCount()J`]: () => 0n,
  [`${V}getVerboseClass()Z`]: () => 0,
  [`${V}getVerboseGC()Z`]: () => 0,
  [`${V}getProcessId()I`]: () => (globalThis as any).process?.pid ?? 1,
  [`${V}getVmArguments0()[Ljava/lang/String;`]: (t) => t.vm.newObjectArray("java/lang/String", []),
  [`${V}getStartupTime()J`]: (t) => BigInt(t.vm.startTime),
  [`${V}getUptime0()J`]: (t) => BigInt(Date.now() - t.vm.startTime),
  [`${V}getAvailableProcessors()I`]: () => 1,
  [`${V}getTotalCompileTime()J`]: () => 0n,
  [`${V}getTotalThreadCount()J`]: (t) => BigInt(t.vm.threadsStarted),
  [`${V}getLiveThreadCount()I`]: (t) => liveThreads(t.vm).length,
  [`${V}getPeakThreadCount()I`]: (t) => Math.max(t.vm.peakThreads, liveThreads(t.vm).length),
  [`${V}getDaemonThreadCount()I`]: (t) => liveThreads(t.vm).filter((x) => x.daemon).length,
  [`${V}getSafepointCount()J`]: () => 0n,
  [`${V}getTotalSafepointTime()J`]: () => 0n,
  [`${V}getSafepointSyncTime()J`]: () => 0n,
  [`${V}getTotalApplicationNonStoppedTime()J`]: (t) => BigInt(Date.now() - t.vm.startTime),
  [`${V}getLoadedClassSize()J`]: () => 0n,
  [`${V}getUnloadedClassSize()J`]: () => 0n,
  [`${V}getClassLoadingTime()J`]: () => 0n,
  [`${V}getMethodDataSize()J`]: () => 0n,
  [`${V}getInitializedClassCount()J`]: () => 0n,
  [`${V}getClassInitializationTime()J`]: () => 0n,
  [`${V}getClassVerificationTime()J`]: () => 0n,

  "sun/management/MemoryImpl.getMemoryPools0()[Ljava/lang/management/MemoryPoolMXBean;": function* (t): NativeGen {
    const b: Beans = yield* beans(t);
    return t.vm.newObjectArray("java/lang/management/MemoryPoolMXBean", b.pools);
  },
  "sun/management/MemoryImpl.getMemoryManagers0()[Ljava/lang/management/MemoryManagerMXBean;": function* (t): NativeGen {
    const b: Beans = yield* beans(t);
    return t.vm.newObjectArray("java/lang/management/MemoryManagerMXBean", b.managers);
  },
  "sun/management/MemoryImpl.getMemoryUsage0(Z)Ljava/lang/management/MemoryUsage;": function* (t, [, heap]): NativeGen {
    if (!heap) return yield* usage(t, 0, 0, 0, -1);
    return yield* heapUsage(t);
  },
  "sun/management/MemoryImpl.setVerboseGC(Z)V": () => undefined,

  [`${P}getUsage0()Ljava/lang/management/MemoryUsage;`]: (t, [self]) => poolUsage(t, self),
  [`${P}getPeakUsage0()Ljava/lang/management/MemoryUsage;`]: (t, [self]) => poolUsage(t, self),
  [`${P}getCollectionUsage0()Ljava/lang/management/MemoryUsage;`]: function* (t, [self]): NativeGen {
    const b: Beans = yield* beans(t);
    return POOLS[b.pools.indexOf(self)].collection ? yield* poolUsage(t, self) : null;
  },
  [`${P}setUsageThreshold0(JJ)V`]: () => undefined,
  [`${P}setCollectionThreshold0(JJ)V`]: () => undefined,
  [`${P}resetPeakUsage0()V`]: () => undefined,
  [`${P}getMemoryManagers0()[Ljava/lang/management/MemoryManagerMXBean;`]: function* (t, [self]): NativeGen {
    const b: Beans = yield* beans(t);
    const name = POOLS[b.pools.indexOf(self)].name;
    // HotSpot lists a pool's managers last added first
    return t.vm.newObjectArray("java/lang/management/MemoryManagerMXBean", b.managers.filter((_, i) => MANAGERS[i].pools.includes(name)).reverse());
  },
  [`${P}setPoolUsageSensor(Lsun/management/Sensor;)V`]: () => undefined,
  [`${P}setPoolCollectionSensor(Lsun/management/Sensor;)V`]: () => undefined,

  "sun/management/MemoryManagerImpl.getMemoryPools0()[Ljava/lang/management/MemoryPoolMXBean;": function* (t, [self]): NativeGen {
    const b: Beans = yield* beans(t);
    const names = MANAGERS[b.managers.indexOf(self)].pools;
    return t.vm.newObjectArray("java/lang/management/MemoryPoolMXBean", names.map((n) => b.pools[POOLS.findIndex((p) => p.name === n)]));
  },
  "sun/management/GarbageCollectorImpl.getCollectionCount()J": function* (t, [self]): NativeGen {
    const b: Beans = yield* beans(t);
    return MANAGERS[b.managers.indexOf(self)].name === FULL_GC ? BigInt(gcStats(t.vm).count) : 0n;
  },
  "sun/management/GarbageCollectorImpl.getCollectionTime()J": function* (t, [self]): NativeGen {
    const b: Beans = yield* beans(t);
    return MANAGERS[b.managers.indexOf(self)].name === FULL_GC ? BigInt(Math.round(gcStats(t.vm).ms)) : 0n;
  },

  [`${T}getThreads()[Ljava/lang/Thread;`]: (t) => t.vm.newObjectArray("java/lang/Thread", liveThreads(t.vm).map((x) => x.obj!)),
  [`${T}getThreadTotalCpuTime0(J)J`]: () => -1n,
  [`${T}getThreadUserCpuTime0(J)J`]: () => -1n,
  [`${T}getThreadAllocatedMemory0(J)J`]: () => -1n,
  [`${T}getTotalThreadAllocatedMemory()J`]: () => -1n,
  [`${T}setThreadCpuTimeEnabled0(Z)V`]: () => undefined,
  [`${T}setThreadAllocatedMemoryEnabled0(Z)V`]: () => undefined,
  [`${T}setThreadContentionMonitoringEnabled0(Z)V`]: () => undefined,
  [`${T}findMonitorDeadlockedThreads0()[Ljava/lang/Thread;`]: (t) => findDeadlocks(t.vm, false),
  [`${T}findDeadlockedThreads0()[Ljava/lang/Thread;`]: (t) => findDeadlocks(t.vm, true),
  [`${T}getThreadInfo1([JI[Ljava/lang/management/ThreadInfo;)V`]: function* (t, [ids, maxDepth, result]): NativeGen {
    if (!ids || !result) throw new PendingThrow("java/lang/NullPointerException");
    if (maxDepth < -1) throw new PendingThrow("java/lang/IllegalArgumentException", "Invalid maxDepth");
    checkIds(ids);
    if (ids.a.length !== result.a.length) {
      throw new PendingThrow("java/lang/IllegalArgumentException",
        "The length of the given ThreadInfo array does not match the length of the given array of thread IDs");
    }
    const vm = t.vm;
    const snaps = [...(ids.a as BigInt64Array)].map((id) => {
      const x = threadById(vm, id);
      return x && snapshot(vm, x, maxDepth);
    });
    for (const [i, s] of snaps.entries()) if (s) result.a[i] = yield* threadInfo(t, s, maxDepth !== 0, null);
  },
  [`${T}dumpThreads0([JZZI)[Ljava/lang/management/ThreadInfo;`]: (t, [ids, monitors, syncs, maxDepth]) =>
    dumpThreads(t, ids, monitors === 1, syncs === 1, maxDepth),
  [`${T}resetPeakThreadCount0()V`]: (t) => void (t.vm.peakThreads = liveThreads(t.vm).length),
  [`${T}resetContentionTimes0(J)V`]: () => undefined,
  "sun/management/HotspotThread.getInternalThreadCount()I": () => 0,
  "sun/management/HotspotThread.getInternalThreadTimes0([Ljava/lang/String;[J)I": () => 0,
  "sun/management/ClassLoadingImpl.setVerboseClass(Z)V": () => undefined,

  // no container limits: Container.metrics() is null
  "jdk/internal/platform/CgroupMetrics.isUseContainerSupport()Z": () => 0,
  "jdk/internal/platform/CgroupMetrics.isContainerized0()Z": () => 0,
  "jdk/internal/platform/CgroupMetrics.getTotalMemorySize0()J": () => BigInt(host("node:os")?.totalmem() ?? MAX_HEAP),
  "jdk/internal/platform/CgroupMetrics.getTotalSwapSize0()J": () => BigInt(orElse(procValue("/proc/meminfo", "SwapTotal:") * KB, 0)),

  "com/sun/management/internal/Flag.initialize()V": () => undefined,
  "com/sun/management/internal/Flag.getInternalFlagCount()I": () => FLAGS.length,
  "com/sun/management/internal/Flag.getAllFlagNames()[Ljava/lang/String;": (t) => t.vm.newObjectArray("java/lang/String", FLAGS.map((f) => t.vm.str(f.name))),
  "com/sun/management/internal/Flag.getFlags([Ljava/lang/String;[Lcom/sun/management/internal/Flag;I)I": function* (t, [names, out, count]): NativeGen {
    const vm = t.vm;
    const cls = vm.loadBoot("com/sun/management/internal/Flag")!;
    const origin = yield* initialized(t, "com/sun/management/VMOption$Origin");
    const defaultOrigin = yield t.call(origin.methodMap.get("valueOf(Ljava/lang/String;)Lcom/sun/management/VMOption$Origin;")!, vm.str("DEFAULT"));
    const wanted = names ? (names.a as (JObject | null)[]).map((n) => (n ? vm.jsString(n) : null)) : FLAGS.map((f) => f.name);
    let filled = 0;
    for (let i = 0; i < Math.min(count, wanted.length); i++) {
      const f = FLAGS.find((x) => x.name === wanted[i]);
      if (!f) continue;
      const value = typeof f.value === "boolean" ? yield* box(t, "Z", f.value ? 1 : 0) : yield* box(t, "J", BigInt(f.value));
      const flag = vm.newObject(cls);
      yield t.call(cls.methodMap.get("<init>(Ljava/lang/String;Ljava/lang/Object;ZZLcom/sun/management/VMOption$Origin;)V")!, flag, vm.str(f.name), value, f.writeable ? 1 : 0, 1, defaultOrigin);
      (out.a as (JObject | null)[])[i] = flag;
      filled++;
    }
    return filled;
  },

  [`${OS}initialize0()V`]: () => undefined,
  [`${OS}getOpenFileDescriptorCount0()J`]: (t) => BigInt(openFdCount(t.vm)),
  [`${OS}getMaxFileDescriptorCount0()J`]: () => maxOpenFiles(),
  [`${OS}getCommittedVirtualMemorySize0()J`]: () => BigInt(orElse(procValue("/proc/self/statm", "", 0) * 4096, (globalThis as any).process?.memoryUsage?.().rss ?? -1)),
  [`${OS}getTotalMemorySize0()J`]: () => BigInt(host("node:os")?.totalmem() ?? MAX_HEAP),
  [`${OS}getFreeMemorySize0()J`]: () => BigInt(host("node:os")?.freemem() ?? 0),
  [`${OS}getTotalSwapSpaceSize0()J`]: () => BigInt(orElse(procValue("/proc/meminfo", "SwapTotal:") * KB, 0)),
  [`${OS}getFreeSwapSpaceSize0()J`]: () => BigInt(orElse(procValue("/proc/meminfo", "SwapFree:") * KB, 0)),
  [`${OS}getProcessCpuTime0()J`]: () => {
    const u = (globalThis as any).process?.cpuUsage?.();
    return u ? BigInt(u.user + u.system) * 1000n : -1n;
  },
  [`${OS}getProcessCpuLoad0()D`]: () => -1,
  [`${OS}getCpuLoad0()D`]: () => -1,
  [`${OS}getSingleCpuLoad0(I)D`]: () => -1,
  [`${OS}getHostConfiguredCpuCount0()I`]: () => host("node:os")?.availableParallelism() ?? 1,
  [`${OS}getHostOnlineCpuCount0()I`]: () => host("node:os")?.availableParallelism() ?? 1,
  [`${OS}getHostTotalCpuTicks0()J`]: () => -1n,
};
