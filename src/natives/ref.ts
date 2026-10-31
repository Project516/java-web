// java.lang.ref on the JS engine's collector. A weak or phantom reference
// holds its referent through a JS WeakRef, so the referent can be collected;
// a FinalizationRegistry then puts the reference on the pending list that the
// Reference Handler thread enqueues from. Soft and final references stay
// strong: HotSpot clears soft ones only under memory pressure.

import { INITIALIZED } from "../runtime.ts";
import type { JClass, JObject } from "../runtime.ts";
import type { JThread, NativeGen } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import type { Natives } from "./util.ts";

const R = "java/lang/ref/Reference";

interface RefState {
  pending: JObject[];
  waiters: (() => void)[];
  registry: FinalizationRegistry<WeakRef<JObject>>;
  weak: JClass;
  phantom: JClass;
}

function refs(vm: JVM): RefState {
  let s = vm.state.get("refs") as RefState | undefined;
  if (!s) {
    s = {
      pending: [],
      waiters: [],
      // Holds the reference weakly: as in HotSpot, a reference that is itself
      // unreachable is never enqueued, and holding it would keep its referent
      // alive whenever the reference's other fields lead back to it.
      registry: new FinalizationRegistry((held: WeakRef<JObject>) => {
        const ref = held.deref();
        if (!ref || !(ref.x instanceof WeakRef)) return;
        ref.x = null;
        s!.pending.push(ref);
        for (const w of s!.waiters.splice(0)) w();
      }),
      weak: vm.loadBoot("java/lang/ref/WeakReference")!,
      phantom: vm.loadBoot("java/lang/ref/PhantomReference")!,
    };
    vm.state.set("refs", s);
  }
  return s;
}

function referent(t: JThread, r: JObject): JObject | null {
  if (r.x instanceof WeakRef) return r.x.deref() ?? null;
  return t.vm.getField(r, R, "referent");
}

function clear(t: JThread, r: JObject) {
  if (r.x instanceof WeakRef) refs(t.vm).registry.unregister(r);
  r.x = null;
  t.vm.setField(r, R, "referent", null);
}

// Replace methods that read or write the referent field.
export const intrinsics: Natives = {
  [`${R}.<init>(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V`]: function* (t, [self, obj, queue]): NativeGen {
    const vm = t.vm;
    const rq = vm.loadBoot("java/lang/ref/ReferenceQueue")!;
    if (rq.state !== INITIALIZED) yield* vm.initGen(t, rq);
    const none = vm.getStatic(rq, "NULL_QUEUE");
    const q = queue ?? none;
    vm.setField(self, R, "queue", q);
    const s = refs(vm);
    if (obj !== null && (self.cls.isSubclassOf(s.weak) || self.cls.isSubclassOf(s.phantom))) {
      self.x = new WeakRef(obj);
      if (q !== none) s.registry.register(obj, new WeakRef(self), self);
    } else vm.setField(self, R, "referent", obj);
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
  "java/lang/ref/Finalizer.isFinalizationEnabled()Z": () => 0,
  "java/lang/ref/Finalizer.reportComplete(Ljava/lang/Object;)V": () => undefined,
};
