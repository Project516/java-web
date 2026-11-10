// java.lang.ref on the JS engine's collector. A weak, soft or phantom reference
// holds its referent through a JS WeakRef, so the referent can be collected;
// a FinalizationRegistry then puts the reference on the pending list that the
// Reference Handler thread enqueues from. A soft referent is also held by a
// table that is emptied when memory runs short. An object whose class has a
// finalizer is watched too: its wrapper is collected, and the Finalizer gets a
// new wrapper over the same storage.

import { INITIALIZED, MAX_HEAP, freeHeap, hasMaxHeap, releasePins, setReclaim, wrapperOver } from "../runtime.ts";
import { JObject } from "../runtime.ts";
import type { JClass } from "../runtime.ts";
import type { JThread, NativeGen } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import { engineHeap } from "./management.ts";
import type { Natives } from "./util.ts";

const R = "java/lang/ref/Reference";

// What a finalizable object's new wrapper needs. It must not lead back to the
// object: f is null once its fields are found to lead back to it (see forgetCycles).
interface Fin {
  fin: JObject;
  cls: JClass;
  f: any[] | null;
  hash: number;
  x: any;
}

// A reference whose referent is watched, a finalizer, or a collect() probe.
type Held = WeakRef<JObject> | Fin | (() => void);

interface RefState {
  pending: JObject[];
  waiters: (() => void)[];
  // finalizers whose objects are not known to be on a cycle
  fins: Fin[];
  registered: number;
  registry: FinalizationRegistry<Held>;
  weak: JClass;
  phantom: JClass;
  soft: JClass;
  finalizer: JClass;
  // soft reference -> referent: held while the reference is alive, until memory runs short
  softs: WeakMap<JObject, JObject>;
  softCount: number;
}

function refs(vm: JVM): RefState {
  let s = vm.state.get("refs") as RefState | undefined;
  if (!s) {
    s = {
      pending: [],
      waiters: [],
      fins: [],
      registered: 0,
      // Holds the reference weakly: as in HotSpot, a reference that is itself
      // unreachable is never enqueued, and holding it would keep its referent
      // alive whenever the reference's other fields lead back to it.
      registry: new FinalizationRegistry((held: Held) => {
        if (typeof held === "function") return held();
        if ("cls" in held) return resurrect(vm, s!, held);
        const ref = held.deref();
        if (!ref || !(ref.x instanceof WeakRef)) return;
        ref.x = null;
        addPending(s!, ref);
      }),
      weak: vm.loadBoot("java/lang/ref/WeakReference")!,
      phantom: vm.loadBoot("java/lang/ref/PhantomReference")!,
      soft: vm.loadBoot("java/lang/ref/SoftReference")!,
      finalizer: vm.loadBoot("java/lang/ref/Finalizer")!,
      softs: new WeakMap(),
      softCount: 0,
    };
    setReclaim(() => {
      const soft = clearSoftReferences(vm);
      return releasePins() || soft;
    });
    vm.state.set("refs", s);
  }
  return s;
}

function addPending(s: RefState, ref: JObject) {
  s.pending.push(ref);
  for (const w of s.waiters.splice(0)) w();
}

function referent(t: JThread, r: JObject): JObject | null {
  if (r.x instanceof WeakRef) return r.x.deref() ?? null;
  return t.vm.getField(r, R, "referent");
}

function clear(t: JThread, r: JObject) {
  if (r.x instanceof WeakRef) {
    const s = refs(t.vm);
    s.registry.unregister(r);
    s.softs.delete(r);
  }
  r.x = null;
  t.vm.setField(r, R, "referent", null);
}

// A weak, soft or phantom reference to obj; a reference with a queue is
// enqueued when obj is collected.
function watch(s: RefState, self: JObject, obj: JObject, queued: boolean) {
  self.x = new WeakRef(obj);
  if (self.cls.isSubclassOf(s.soft)) {
    s.softs.set(self, obj);
    s.softCount++;
  }
  if (queued) s.registry.register(obj, new WeakRef(self), self);
}

// Lets the engine collect the soft referents nothing else reaches. Returns
// whether there were any soft references.
function clearSoftReferences(vm: JVM): boolean {
  const s = refs(vm);
  if (s.softCount === 0) return false;
  s.softs = new WeakMap();
  s.softCount = 0;
  return true;
}

function memoryShort(): boolean {
  if (hasMaxHeap()) return freeHeap() < MAX_HEAP / 2;
  const h = engineHeap();
  return h !== null && h.used > h.limit / 2;
}

// HotSpot clears soft references when memory is short: here, on System.gc()
// with more than half of the heap limit in use.
export function releaseSoftReferences(vm: JVM) {
  if (refs(vm).softCount === 0 || !memoryShort()) return;
  clearSoftReferences(vm);
}

const PROBE_MS = 50;
// Runs a collection and resolves once the engine has run the callbacks it
// queued: they come in later tasks, and a probe in the same registry arrives
// with them. The timer only bounds the wait.
export function collect(vm: JVM, gc: () => void): Promise<void> {
  const s = refs(vm);
  return new Promise<void>((done) => {
    probe(s, done);
    gc();
    setTimeout(done, PROBE_MS);
  });
}
// Its own frame: a temporary in the caller's frame would keep the probe alive.
function probe(s: RefState, done: () => void) {
  s.registry.register({}, done);
}

// The object is gone: the Finalizer's referent becomes a new wrapper over its
// storage, and the Reference Handler passes it on to finalize().
function resurrect(vm: JVM, s: RefState, h: Fin) {
  const fin = h.fin;
  if (!(fin.x instanceof WeakRef)) return;
  if (h.f === null) {
    // nothing to finalize: the Finalizer thread unlinks it, and its finalize(null) fails quietly
    fin.x = null;
    return addPending(s, fin);
  }
  const o = wrapperOver(h.cls, h.f);
  o.hash = h.hash;
  o.x = h.x;
  fin.x = null;
  vm.setField(fin, R, "referent", o);
  addPending(s, fin);
}

// Links a Finalizer for obj into the unfinalized list, as Finalizer.register
// does for an object of a class with a finalizer.
export function registerFinalizer(vm: JVM, obj: JObject) {
  const s = refs(vm);
  if (s.finalizer.state !== INITIALIZED || vm.opts.finalization === false) return;
  const F = "java/lang/ref/Finalizer";
  const fin = vm.newObject(s.finalizer);
  vm.setField(fin, R, "queue", vm.getStatic(s.finalizer, "queue"));
  const head = vm.getStatic(s.finalizer, "unfinalized") as JObject | null;
  if (head) {
    vm.setField(fin, F, "next", head);
    vm.setField(head, F, "prev", fin);
  }
  vm.setStatic(s.finalizer, "unfinalized", fin);
  watchFinalizer(vm, s, fin, obj);
  if (++s.registered % CHECK_EVERY === 0) forgetCycles(s, SCAN_WHILE_RUNNING);
}

// The registry holds a finalizable object's fields, so an object they lead back
// to would never be collected, finalized or not. JS cannot finalize such an
// object (that takes tracing from the roots), so it is released instead, as if
// it had no finalizer: the fields of an object found on a cycle are dropped.
const CHECK_EVERY = 2048, SCAN_PER_OBJECT = 2000, SCAN_WHILE_RUNNING = 20000, SCAN_AT_GC = 200000;

function leadsBack(w: JObject, f: any[], budget: { left: number }): boolean {
  const seen = new Set<JObject>();
  const todo: any[][] = [f];
  let scanned = 0;
  while (todo.length) {
    for (const v of todo.pop()!) {
      if (!(v instanceof JObject)) continue;
      if (v === w) return true;
      if (seen.has(v)) continue;
      seen.add(v);
      if (++scanned > SCAN_PER_OBJECT) {
        budget.left -= scanned;
        return false;
      }
      todo.push(v.f);
      const a = (v as { a?: unknown }).a;
      if (Array.isArray(a)) todo.push(a);
    }
  }
  budget.left -= scanned;
  return false;
}

function forgetCycles(s: RefState, scan: number) {
  const budget = { left: scan };
  const list = s.fins;
  const kept: Fin[] = [];
  let i = 0;
  for (; i < list.length && budget.left > 0; i++) {
    const h = list[i];
    const w = h.f !== null && h.fin.x instanceof WeakRef ? h.fin.x.deref() : undefined;
    if (w === undefined) continue;
    if (leadsBack(w, h.f!, budget)) h.f = null;
    else kept.push(h);
  }
  s.fins = list.slice(i).concat(kept);
}

export function releaseFinalizerCycles(vm: JVM) {
  forgetCycles(refs(vm), SCAN_AT_GC);
}

function watchFinalizer(vm: JVM, s: RefState, fin: JObject, obj: JObject) {
  fin.x = new WeakRef(obj);
  const h: Fin = { fin, cls: obj.cls, f: obj.f, hash: vm.identityHash(obj), x: obj.x };
  s.fins.push(h);
  s.registry.register(obj, h, fin);
}

// A weak, soft, phantom or final reference restored from a snapshot: watch its
// referent again.
export function restoreReference(vm: JVM, self: JObject, obj: JObject) {
  const s = refs(vm);
  if (self.cls === s.finalizer) return watchFinalizer(vm, s, self, obj);
  const none = vm.getStatic(vm.loadBoot("java/lang/ref/ReferenceQueue")!, "NULL_QUEUE");
  watch(s, self, obj, vm.getField(self, R, "queue") !== none);
}

export function restorePending(vm: JVM, pending: JObject[]) {
  refs(vm).pending.push(...pending);
}

// Replace methods that read or write the referent field.
export const intrinsics: Natives = {
  [`${R}.<init>(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V`]: function* (t, [self, obj, queue]): NativeGen {
    const vm = t.vm;
    const rq = vm.loadBoot("java/lang/ref/ReferenceQueue")!;
    if (rq.state !== INITIALIZED) yield* vm.initGen(t, rq);
    const none = vm.getStatic(rq, "NULL_QUEUE");
    vm.setField(self, R, "queue", queue ?? none);
    const s = refs(vm);
    const c = self.cls;
    if (obj !== null && (c.isSubclassOf(s.weak) || c.isSubclassOf(s.phantom) || c.isSubclassOf(s.soft))) watch(s, self, obj, queue !== null && queue !== none);
    else vm.setField(self, R, "referent", obj);
  },
  [`${R}.get()Ljava/lang/Object;`]: (t, [self]) => referent(t, self),
};

export const natives: Natives = {
  [`${R}.refersTo0(Ljava/lang/Object;)Z`]: (t, [r, o]) => (referent(t, r) === o ? 1 : 0),
  [`${R}.clear0()V`]: (t, [r]) => clear(t, r),
  "java/lang/ref/PhantomReference.refersTo0(Ljava/lang/Object;)Z": (t, [r, o]) => (referent(t, r) === o ? 1 : 0),
  "java/lang/ref/PhantomReference.clear0()V": (t, [r]) => clear(t, r),
  [`${R}.hasReferencePendingList()Z`]: (t) => (refs(t.vm).pending.length > 0 ? 1 : 0),
  // the pending list is linked through discovered and ends in null
  [`${R}.getAndClearReferencePendingList()Ljava/lang/ref/Reference;`]: (t) => {
    const list = refs(t.vm).pending.splice(0);
    for (let i = 0; i < list.length; i++) t.vm.setField(list[i], R, "discovered", list[i + 1] ?? null);
    return list[0] ?? null;
  },
  [`${R}.waitForReferencePendingList()V`]: function* (t): NativeGen {
    const s = refs(t.vm);
    while (s.pending.length === 0) yield t.block(new Promise<void>((r) => s.waiters.push(r)));
  },
  "java/lang/ref/Finalizer.isFinalizationEnabled()Z": (t) => (t.vm.opts.finalization === false ? 0 : 1),
  "java/lang/ref/Finalizer.reportComplete(Ljava/lang/Object;)V": () => undefined,
};
