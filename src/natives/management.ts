// java.management natives: what HotSpot's JMM interface (services/management.cpp)
// reports, for a VM with green threads on the JS engine's collector. Memory
// managers and pools have the names HotSpot gives them with the Serial
// collector, which it picks for a heap of java-web's size. Heap usage is the JS
// heap's; collections are the explicit System.gc() calls, which HotSpot counts
// as full collections.

import { MAX_HEAP } from "../runtime.ts";
import type { JMethod, JObject } from "../runtime.ts";
import { TERMINATED } from "../thread.ts";
import type { JThread, NativeGen } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import type { Natives } from "./util.ts";

const MANAGERS = [
  { name: "CodeCacheManager", gc: false, pools: ["CodeHeap 'profiled nmethods'", "CodeHeap 'non-nmethods'", "CodeHeap 'non-profiled nmethods'"] },
  { name: "Metaspace Manager", gc: false, pools: ["Metaspace", "Compressed Class Space"] },
  { name: "Copy", gc: true, pools: ["Eden Space", "Survivor Space"] },
  { name: "MarkSweepCompact", gc: true, pools: ["Eden Space", "Survivor Space", "Tenured Gen"] },
];
// in HotSpot's order, with whether each supports usage and collection thresholds
const POOLS = [
  { name: "CodeHeap 'non-nmethods'", heap: false, usage: true, collection: false },
  { name: "Metaspace", heap: false, usage: true, collection: false },
  { name: "Tenured Gen", heap: true, usage: true, collection: true },
  { name: "CodeHeap 'profiled nmethods'", heap: false, usage: true, collection: false },
  { name: "Eden Space", heap: true, usage: false, collection: true },
  { name: "Survivor Space", heap: true, usage: false, collection: true },
  { name: "Compressed Class Space", heap: false, usage: true, collection: false },
  { name: "CodeHeap 'non-profiled nmethods'", heap: false, usage: true, collection: false },
];
const FULL_GC = "MarkSweepCompact";
const OLD = "Tenured Gen";

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

function jsHeap(): { used: number; committed: number } {
  const node = (globalThis as any).process?.memoryUsage?.();
  if (node) return { used: node.heapUsed, committed: node.heapTotal };
  const chrome = (globalThis as any).performance?.memory;
  if (chrome) return { used: chrome.usedJSHeapSize, committed: chrome.totalJSHeapSize };
  return { used: 0, committed: 0 };
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
  const h = jsHeap();
  return yield* usage(t, 0, h.used, Math.max(h.used, h.committed), MAX_HEAP);
}

function liveThreads(vm: JVM): JThread[] {
  return [...vm.threads].filter((x) => x.state !== TERMINATED && x.obj);
}

const V = "sun/management/VMManagementImpl.";
const P = "sun/management/MemoryPoolImpl.";
const T = "sun/management/ThreadImpl.";

export const natives: Natives = {
  [`${V}getVersion0()Ljava/lang/String;`]: (t) => t.vm.str("4.0"),
  [`${V}initOptionalSupportFields()V`]: () => undefined,
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
    const h = jsHeap();
    return yield* usage(t, 0, h.used, Math.max(h.used, h.committed), MAX_HEAP);
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
    return t.vm.newObjectArray("java/lang/management/MemoryManagerMXBean", b.managers.filter((_, i) => MANAGERS[i].pools.includes(name)));
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
  [`${T}findMonitorDeadlockedThreads0()[Ljava/lang/Thread;`]: () => null,
  [`${T}findDeadlockedThreads0()[Ljava/lang/Thread;`]: () => null,
  [`${T}resetPeakThreadCount0()V`]: (t) => void (t.vm.peakThreads = liveThreads(t.vm).length),
  [`${T}resetContentionTimes0(J)V`]: () => undefined,
  "sun/management/HotspotThread.getInternalThreadCount()I": () => 0,
  "sun/management/HotspotThread.getInternalThreadTimes0([Ljava/lang/String;[J)I": () => 0,
  "sun/management/ClassLoadingImpl.setVerboseClass(Z)V": () => undefined,
};
