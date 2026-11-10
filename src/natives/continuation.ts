// jdk.internal.vm.Continuation on the thread's own frame stack. Frames live on
// the heap here, so a yield moves the frames between the continuation's entry
// and the yield into the continuation, and continuing moves them back. A yield
// across a native frame pins the continuation, as in HotSpot. A monitor a
// virtual thread took belongs to its carrier while it is mounted and to the
// virtual thread while it is not (JEP 491): a yield, a contended enter and
// Object.wait all unmount it, and the monitors move to a stand-in owner.

import type { JObject, Monitor } from "../runtime.ts";
import { Frame, JThread, NativeFrame, PendingThrow, RUNNABLE, Signal, WAITING } from "../thread.ts";
import type { AnyFrame, NativeGen } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import type { Natives } from "./util.ts";

const C = "jdk/internal/vm/Continuation";
const CHUNK = "jdk/internal/vm/StackChunk";
// codes of Continuation.pinnedReason
const PINNED_CRITICAL_SECTION = 2, PINNED_NATIVE = 3;

const VT = "java/lang/VirtualThread";
// VirtualThread.state values the VM sets
const BLOCKING = 12;

type Entry = NonNullable<NativeFrame["entry"]>;

// What a yielded continuation needs to resume, kept in its object's x.
interface Frozen {
  // its frames, bottom first
  frames: AnyFrame[];
  // the top frame re-executes its instruction instead of taking a result
  retry: boolean;
  // monitors its virtual thread owns, and the owner standing in for it
  monitors: JObject[];
  owner: JThread | null;
}

interface State {
  // virtual threads whose monitor was released, for the unblocker thread
  unblock: JObject[];
  unblocker: (() => void) | null;
  active: number;
  frozenCount: number;
  busy: boolean;
}

function state(vm: JVM): State {
  let s = vm.state.get("continuations") as State | undefined;
  if (!s) vm.state.set("continuations", (s = { unblock: [], unblocker: null, active: 0, frozenCount: 0, busy: false }));
  return s;
}

// The continuation a native frame is the entry of, if it is one.
// The frames of a yielded continuation, bottom first.
export function frozenFrames(c: JObject): AnyFrame[] | undefined {
  return (c.x as Frozen | undefined)?.frames;
}

// Index in t.frames of the innermost mounted continuation's entry frame.
function innermost(t: JThread): number {
  for (let i = t.frames.length - 2; i >= 0; i--) {
    const f = t.frames[i];
    if (f instanceof NativeFrame && f.entry !== null) return i;
  }
  return -1;
}

// 0, or why the frames above entry e cannot be moved.
function pinned(t: JThread, e: number): number {
  if (t.pins > 0) return PINNED_CRITICAL_SECTION;
  for (let i = e + 1; i < t.frames.length - 1; i++) if (!(t.frames[i] instanceof Frame)) return PINNED_NATIVE;
  return 0;
}

// Whether the virtual thread mounted on t can unmount from where it is.
export function canUnmount(t: JThread): boolean {
  const e = innermost(t);
  return e >= 0 && (t.frames[e] as NativeFrame).entry!.virtual && pinned(t, e) === 0;
}

export function dropOwned(t: JThread, o: JObject) {
  const a = t.owned;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] === o) {
      a.splice(i, 1);
      return;
    }
  }
}

// Moves frames after the entry at index e into the continuation, count of
// them, and the monitors the virtual thread took to an owner that stands in
// for it while it is unmounted.
function freeze(t: JThread, e: number, count: number, retry: boolean) {
  const s = state(t.vm);
  const entry = (t.frames[e] as NativeFrame).entry!;
  const info: Frozen = { frames: [], retry, monitors: [], owner: null };
  if (entry.virtual) {
    const monitors = [...new Set(t.owned)].filter((o) => o.mon?.owner === t);
    t.owned = [];
    if (monitors.length > 0) {
      const owner = new JThread(t.vm);
      owner.obj = t.mounted;
      owner.state = WAITING;
      for (const o of monitors) o.mon!.owner = owner;
      info.monitors = monitors;
      info.owner = owner;
    }
  }
  info.frames = t.frames.splice(e + 1, count);
  entry.cont.x = info;
  s.frozenCount++;
  s.busy = true;
  setChunk(t, entry.cont, true);
  // enterSpecial returns to Continuation.run as if the continuation had finished
  (t.frames[e] as NativeFrame).input = 0;
}

function queueUnblock(vm: JVM, vt: JObject) {
  if (vm.getField(vt, VT, "onWaitingList") === 1) return;
  vm.setField(vt, VT, "onWaitingList", 1);
  const s = state(vm);
  s.unblock.push(vt);
  const wake = s.unblocker;
  s.unblocker = null;
  wake?.();
}

// Queues vt for the unblocker thread when mon is released.
export function unblockOnRelease(vm: JVM, vt: JObject, mon: Monitor) {
  mon.entry.push(() => queueUnblock(vm, vt));
}

// A virtual thread that tried to take o's monitor and cannot: unmounts it,
// to be unblocked when the monitor is released.
export function unmountBlocked(t: JThread) {
  const o = t.unmounting!;
  t.unmounting = null;
  const e = innermost(t);
  freeze(t, e, t.frames.length - e - 1, true);
  t.vm.setField(t.mounted!, VT, "state", BLOCKING);
  unblockOnRelease(t.vm, t.mounted!, o.mon!);
  t.state = RUNNABLE;
}

// A native on top of the stack that asked to unmount; it resumes in place.
export function unmountNative(t: JThread) {
  const e = innermost(t);
  freeze(t, e, t.frames.length - e - 1, false);
}

// Continuation.tail: isStarted() and isEmpty() read it, so a yielded
// continuation has a chunk that is not empty, and a mounted one an empty chunk.
function setChunk(t: JThread, c: JObject, frozen: boolean) {
  const vm = t.vm;
  let chunk = vm.getField(c, C, "tail") as JObject | null;
  if (!chunk) {
    chunk = vm.newObject(vm.loadBoot(CHUNK)!);
    vm.setField(c, C, "tail", chunk);
  }
  vm.setField(chunk, CHUNK, "bottom", 1);
  vm.setField(chunk, CHUNK, "sp", frozen ? 0 : 1);
}

export const natives: Natives = {
  "jdk/internal/vm/ContinuationSupport.isSupported0()Z": () => 1,
  [`${C}.registerNatives()V`]: () => undefined,
  [`${C}.enterSpecial(Ljdk/internal/vm/Continuation;ZZ)V`]: function* (t, [c, isContinue, isVirtual]): NativeGen {
    const s = state(t.vm);
    (t.top as NativeFrame).entry = { cont: c, virtual: isVirtual === 1 };
    s.active++;
    s.busy = true;
    try {
      if (!isContinue) {
        const enter = t.vm.loadBoot(C)!.methodMap.get("enter(Ljdk/internal/vm/Continuation;Z)V")!;
        yield t.call(enter, c, 0);
        return;
      }
      const info = c.x as Frozen | undefined;
      if (!info) throw new PendingThrow("java/lang/IllegalStateException", "Continuation has no frames");
      c.x = undefined;
      s.frozenCount--;
      setChunk(t, c, false);
      t.frames.push(...info.frames);
      if (info.owner) {
        for (const o of info.monitors) o.mon!.owner = t;
        t.owned = info.monitors;
      }
      const top = t.top;
      // a native resumes with the thread it now runs on; a frame that yielded gets the result
      if (top instanceof NativeFrame) top.input = t;
      else if (!info.retry) {
        top.stack[top.sp++] = 0;
        top.pc += 3;
      }
      yield { kind: "resume" };
    } finally {
      (t.top as NativeFrame).entry = null;
      s.active--;
      s.busy = s.active > 0 || s.frozenCount > 0;
    }
  },
  // Its own frame stays on top, so its result goes to enterSpecial, which then
  // returns to Continuation.run as if the continuation had finished.
  [`${C}.doYield()I`]: function* (t): NativeGen {
    const e = innermost(t);
    if (e < 0) throw new PendingThrow("java/lang/IllegalStateException", "Not in a continuation");
    const why = pinned(t, e);
    if (why) return why;
    freeze(t, e, t.frames.length - e - 2, false);
    return 0;
  },
  [`${C}.pin()V`]: (t) => void t.pins++,
  [`${C}.unpin()V`]: (t) => {
    if (t.pins === 0) throw new PendingThrow("java/lang/IllegalStateException", "Not pinned");
    t.pins--;
  },
  // virtual threads that blocked on a monitor or in wait and can try again, linked by next
  "java/lang/VirtualThread.takeVirtualThreadListToUnblock()Ljava/lang/VirtualThread;": function* (t): NativeGen {
    const s = state(t.vm);
    while (s.unblock.length === 0) yield t.block(new Signal((r) => (s.unblocker = r)));
    const list = s.unblock;
    s.unblock = [];
    let next: JObject | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      t.vm.setField(list[i], VT, "next", next);
      next = list[i];
    }
    return next;
  },
  "java/lang/VirtualThread.registerNatives()V": () => undefined,
  "java/lang/VirtualThread.postPinnedEvent(Ljava/lang/String;)V": () => undefined,
  "java/lang/VirtualThread.notifyJvmtiStart()V": () => undefined,
  "java/lang/VirtualThread.notifyJvmtiEnd()V": () => undefined,
  "java/lang/VirtualThread.notifyJvmtiMount(Z)V": () => undefined,
  "java/lang/VirtualThread.notifyJvmtiUnmount(Z)V": () => undefined,
  "java/lang/VirtualThread.notifyJvmtiDisableSuspend(Z)V": () => undefined,
  [`${C}.isPinned0(Ljdk/internal/vm/ContinuationScope;)I`]: (t) => {
    const e = innermost(t);
    return e < 0 ? 0 : pinned(t, e);
  },
};
