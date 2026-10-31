// StackWalker (StackStreamFactory) and Thread.getStackTrace for other threads.

import type { JArray, JMethod, JObject } from "../runtime.ts";
import type { JThread, NativeGen } from "../thread.ts";
import { frozenFrames } from "./continuation.ts";
import { fillElement } from "./lang.ts";
import { annotationTypes, isCallerSensitive, resolvedMethodName } from "./invoke.ts";
import { javaFrames } from "./util.ts";
import type { Natives } from "./util.ts";

const CLASS_INFO_ONLY = 0x2, SHOW_HIDDEN_FRAMES = 0x20;
const IS_METHOD = 0x10000, IS_CONSTRUCTOR = 0x20000, CALLER_SENSITIVE = 0x100000, HIDDEN_MEMBER = 0x400000;
const SFI = "java/lang/StackFrameInfo", CFI = "java/lang/ClassFrameInfo";
const ASW = "java/lang/StackStreamFactory$AbstractStackWalker";

interface Frame { m: JMethod; pc: number }
interface Walk { frames: Frame[]; pos: number }

let nextAnchor = 1n;

function walks(t: JThread): Map<bigint, Walk> {
  let w = t.vm.state.get("stackwalks");
  if (!w) t.vm.state.set("stackwalks", (w = new Map()));
  return w;
}

// Frames left out of stack traces and walks unless hidden frames are asked for:
// hidden classes and methods marked @Hidden, as on HotSpot.
const hiddenMethods = new WeakMap<JMethod, boolean>();
export function isHidden(m: JMethod): boolean {
  let h = hiddenMethods.get(m);
  if (h === undefined) {
    h = m.cls.hidden || annotationTypes(m.cls, m.attrs.get("RuntimeVisibleAnnotations")).includes("Ljdk/internal/vm/annotation/Hidden;");
    hiddenMethods.set(m, h);
  }
  return h;
}

function flagsOf(m: JMethod): number {
  let f = (m.access & 0xffff) | (m.name === "<init>" ? IS_CONSTRUCTOR : IS_METHOD);
  if (isCallerSensitive(m)) f |= CALLER_SENSITIVE;
  if (isHidden(m)) f |= HIDDEN_MEMBER;
  return f;
}

function isWalkerImpl(m: JMethod): boolean {
  const c = m.cls;
  return c.name === "java/lang/StackWalker" || c.name === ASW || c.superclass?.name === ASW;
}

// Fills frames[start, end) from the walk; returns the number filled.
function fill(t: JThread, mode: number, w: Walk, frames: JArray, start: number, end: number): number {
  const vm = t.vm;
  let n = 0;
  for (let i = start; i < end && w.pos < w.frames.length; i++) {
    const { m, pc } = w.frames[w.pos++];
    const o = frames.a[i] as JObject;
    const flags = vm.getField(o, CFI, "flags") | flagsOf(m);
    vm.setField(o, CFI, "flags", flags);
    if (mode & CLASS_INFO_ONLY) vm.setField(o, CFI, "classOrMemberName", vm.mirror(m.cls));
    else {
      vm.setField(o, CFI, "classOrMemberName", resolvedMethodName(t, m));
      vm.setField(o, SFI, "bci", pc < 0 ? -1 : pc);
    }
    n++;
  }
  return n;
}

function methodOfInfo(t: JThread, sfi: JObject): JMethod {
  return (t.vm.getField(sfi, CFI, "classOrMemberName") as JObject).x as JMethod;
}

export const natives: Natives = {
  "java/lang/StackStreamFactory.checkStackWalkModes()Z": () => 1,
  "java/lang/StackStreamFactory$AbstractStackWalker.callStackWalk(IILjdk/internal/vm/ContinuationScope;Ljdk/internal/vm/Continuation;II[Ljava/lang/Object;)Ljava/lang/Object;":
    function* (t, [self, mode, skip, , cont, bufSize, start, frames]): NativeGen {
      // a continuation is walked while it is not mounted, as Continuation.getStackTrace does
      let list: Frame[] = [...javaFrames(t, cont ? frozenFrames(t.vm, cont) ?? [] : t.frames)];
      let i = 0;
      while (i < list.length && isWalkerImpl(list[i].m)) i++;
      list = list.slice(i + skip);
      if (!(mode & SHOW_HIDDEN_FRAMES)) list = list.filter((f) => !isHidden(f.m));
      const anchor = nextAnchor++;
      const w: Walk = { frames: list, pos: 0 };
      walks(t).set(anchor, w);
      try {
        const n = fill(t, mode, w, frames, start, bufSize);
        const doStackWalk = t.vm.loadBoot(ASW)!.methodMap.get("doStackWalk(JIIII)Ljava/lang/Object;")!;
        return yield t.call(doStackWalk, self, anchor, skip, n, start, start + n);
      } finally {
        walks(t).delete(anchor);
      }
    },
  "java/lang/StackStreamFactory$AbstractStackWalker.fetchStackFrames(IJIII[Ljava/lang/Object;)I":
    (t, [, mode, anchor, , bufSize, start, frames]) => {
      const w = walks(t).get(anchor);
      return w ? fill(t, mode, w, frames, start, bufSize) : 0;
    },
  "java/lang/StackStreamFactory$AbstractStackWalker.setContinuation(J[Ljava/lang/Object;Ljdk/internal/vm/Continuation;)V": () => undefined,
  "java/lang/StackFrameInfo.expandStackFrameInfo()V": (t, [sfi]) => {
    const m = methodOfInfo(t, sfi);
    t.vm.setField(sfi, SFI, "name", t.vm.intern(m.name));
    t.vm.setField(sfi, SFI, "type", t.vm.intern(m.desc));
  },
  "java/lang/StackTraceElement.initStackTraceElement(Ljava/lang/StackTraceElement;Ljava/lang/StackFrameInfo;)V": (t, [ste, sfi]) => {
    const m = methodOfInfo(t, sfi);
    const bci = t.vm.getField(sfi, SFI, "bci");
    fillElement(t, ste, m.cls, m.name, m.isNative ? -2 : bci, m);
  },
  // only called for other threads; their frames are not changing while we look
  "java/lang/Thread.getStackTrace0()Ljava/lang/Object;": (t, [thread]) => stackOf(t, thread),
  // a thread that is not running gets an empty trace
  "java/lang/Thread.dumpThreads([Ljava/lang/Thread;)[[Ljava/lang/StackTraceElement;": (t, [threads]) =>
    t.vm.newObjectArray("[Ljava/lang/StackTraceElement;", (threads.a as JObject[]).map((o) =>
      stackOf(t, o) ?? t.vm.newObjectArray("java/lang/StackTraceElement", []))),
};

function stackOf(t: JThread, thread: JObject): JObject | null {
  const target = thread.x as JThread | undefined;
  if (!target) return null;
  const ste = t.vm.loadBoot("java/lang/StackTraceElement")!;
  const items = [...javaFrames(target)].filter((f) => !isHidden(f.m)).map(({ m, pc }) => {
    const e = t.vm.newObject(ste);
    fillElement(t, e, m.cls, m.name, pc, m);
    return e;
  });
  return t.vm.newObjectArray("java/lang/StackTraceElement", items);
}
