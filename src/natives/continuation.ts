// jdk.internal.vm.Continuation on the thread's own frame stack. Frames live on
// the heap here, so a yield moves the frames between the continuation's entry
// and the yield into the continuation, and continuing moves them back. A yield
// across a native frame pins the continuation, as in HotSpot. So does a
// virtual thread's yield while holding a monitor it took: monitors belong to
// the carrier thread here, which a virtual thread may not resume on (as in
// JDK 21; HotSpot 24 and later move the monitor to the virtual thread).

import type { JObject } from "../runtime.ts";
import { Frame, NativeFrame, PendingThrow } from "../thread.ts";
import type { AnyFrame, JThread, NativeGen } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import type { Natives } from "./util.ts";

const C = "jdk/internal/vm/Continuation";
const CHUNK = "jdk/internal/vm/StackChunk";
// codes of Continuation.pinnedReason
const PINNED_CRITICAL_SECTION = 2, PINNED_NATIVE = 3, PINNED_MONITOR = 4;

interface Entry {
  cont: JObject;
  virtual: boolean;
  // monitors the thread held when the continuation was entered
  held: number;
}

interface State {
  // frames of yielded continuations, bottom first
  frozen: WeakMap<JObject, AnyFrame[]>;
  // enterSpecial's native frames: where each mounted continuation starts
  entries: WeakMap<NativeFrame, Entry>;
}

function state(vm: JVM): State {
  let s = vm.state.get("continuations") as State | undefined;
  if (!s) vm.state.set("continuations", (s = { frozen: new WeakMap(), entries: new WeakMap() }));
  return s;
}

// The continuation a native frame is the entry of, if it is one.
export function continuationEntry(vm: JVM, f: NativeFrame): Entry | undefined {
  return state(vm).entries.get(f);
}

// The frames of a yielded continuation, bottom first.
export function frozenFrames(vm: JVM, c: JObject): AnyFrame[] | undefined {
  return state(vm).frozen.get(c);
}

// Index in t.frames of the innermost mounted continuation's entry frame.
function innermost(t: JThread): number {
  const entries = state(t.vm).entries;
  for (let i = t.frames.length - 2; i >= 0; i--) {
    const f = t.frames[i];
    if (f instanceof NativeFrame && entries.has(f)) return i;
  }
  return -1;
}

// 0, or why the frames above entry e cannot be moved.
function pinned(t: JThread, e: number): number {
  if (t.pins > 0) return PINNED_CRITICAL_SECTION;
  for (let i = e + 1; i < t.frames.length - 1; i++) if (!(t.frames[i] instanceof Frame)) return PINNED_NATIVE;
  const entry = state(t.vm).entries.get(t.frames[e] as NativeFrame)!;
  return entry.virtual && t.held > entry.held ? PINNED_MONITOR : 0;
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
    s.entries.set(t.top as NativeFrame, { cont: c, virtual: isVirtual === 1, held: t.held });
    if (!isContinue) {
      const enter = t.vm.loadBoot(C)!.methodMap.get("enter(Ljdk/internal/vm/Continuation;Z)V")!;
      yield t.call(enter, c, 0);
      return;
    }
    const frozen = s.frozen.get(c);
    if (!frozen) throw new PendingThrow("java/lang/IllegalStateException", "Continuation has no frames");
    s.frozen.delete(c);
    setChunk(t, c, false);
    t.frames.push(...frozen);
    // yield0 is at its invokestatic of doYield, which returns 0 when it continues
    const top = t.top as Frame;
    top.stack[top.sp++] = 0;
    top.pc += 3;
    yield { kind: "resume" };
  },
  // Its own frame stays on top, so its result goes to enterSpecial, which then
  // returns to Continuation.run as if the continuation had finished.
  [`${C}.doYield()I`]: function* (t): NativeGen {
    const e = innermost(t);
    if (e < 0) throw new PendingThrow("java/lang/IllegalStateException", "Not in a continuation");
    const why = pinned(t, e);
    if (why) return why;
    const cont = state(t.vm).entries.get(t.frames[e] as NativeFrame)!.cont;
    state(t.vm).frozen.set(cont, t.frames.splice(e + 1, t.frames.length - e - 2));
    setChunk(t, cont, true);
    return 0;
  },
  [`${C}.pin()V`]: (t) => void t.pins++,
  [`${C}.unpin()V`]: (t) => {
    if (t.pins === 0) throw new PendingThrow("java/lang/IllegalStateException", "Not pinned");
    t.pins--;
  },
  // no virtual thread blocks on a monitor while unmounted, so there is never one to unblock
  "java/lang/VirtualThread.takeVirtualThreadListToUnblock()Ljava/lang/VirtualThread;": function* (t): NativeGen {
    yield t.block(new Promise(() => {}));
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
