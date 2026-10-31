import { utf8 } from "../classfile.ts";
import type { JClass, JMethod, JObject, NativeFn } from "../runtime.ts";
import { JArray } from "../runtime.ts";
import { NativeFrame, PendingThrow } from "../thread.ts";
import type { AnyFrame, JThread } from "../thread.ts";
import { continuationEntry } from "./continuation.ts";

export type Natives = Record<string, NativeFn>;

export function u16(b: Uint8Array, p: number) {
  return (b[p] << 8) | b[p + 1];
}

export function sourceFile(c: JClass): string | null {
  const raw = c.cf?.attrs.get("SourceFile");
  return raw ? utf8(c.cf!.cp, u16(raw, 0)) : null;
}

export function nonNull<T>(o: T | null): T {
  if (o === null) throw new PendingThrow("java/lang/NullPointerException");
  return o;
}

export function bytesOf(a: JArray): Int8Array {
  return a.a as Int8Array;
}

export function u8(a: JArray, off = 0, len?: number): Uint8Array {
  const b = a.a as Int8Array;
  return new Uint8Array(b.buffer, b.byteOffset + off, len ?? b.length - off);
}

export function jstr(t: JThread, o: JObject | null): string | null {
  return o === null ? null : t.vm.jsString(o);
}

// Frames of the current thread from the top, skipping VM-internal ones. As
// in HotSpot, a continuation's entry is not shown, and a mounted virtual
// thread's stack ends at its continuation. frames are t's own, or a yielded
// continuation's.
export function* javaFrames(t: JThread, frames: AnyFrame[] = t.frames): Generator<{ m: JMethod; pc: number }> {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i] as any;
    if (f instanceof NativeFrame) {
      const entry = continuationEntry(t.vm, f);
      if (entry?.virtual && t.mounted && frames === t.frames) return;
      if (entry) continue;
    }
    if (f.code) yield { m: f.m, pc: f.pc };
    else if (f.m) yield { m: f.m, pc: -2 };
  }
}
