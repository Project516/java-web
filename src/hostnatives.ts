// Native methods implemented by the embedder, named as in JNI and CheerpJ:
// Java_<class>_<method>, optionally followed by __<argument signature>.
// Values convert as in library mode (see library.ts).

import { isThenable, messageOf } from "./bridge.ts";
import type { Bridge, NativeReply } from "./bridge.ts";
import { JArray } from "./runtime.ts";
import type { JMethod, NativeFn } from "./runtime.ts";
import { PendingThrow } from "./thread.ts";
import type { JThread, NativeGen } from "./thread.ts";

// errors from embedder code reach Java as RuntimeException
function hostError(e: unknown) {
  return new PendingThrow("java/lang/RuntimeException", messageOf(e));
}

export type HostNative = (args: unknown[]) => NativeReply | Promise<NativeReply>;

export function mangle(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === "/") out += "_";
    else if (ch === "_") out += "_1";
    else if (ch === ";") out += "_2";
    else if (ch === "[") out += "_3";
    else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) out += ch;
    else out += "_0" + c.toString(16).padStart(4, "0");
  }
  return out;
}

export function jniNames(m: JMethod): [string, string] {
  const short = `Java_${mangle(m.cls.name)}_${mangle(m.name)}`;
  return [short, `${short}__${mangle(m.desc.slice(1, m.desc.indexOf(")")))}`];
}

// Wraps an embedder function as a VM native. It gets the wire arguments
// ("this" first for instance methods), returns the wire result and the
// typed arguments it changed, and may be async. While it waits, the Java
// thread runs library calls.
export function hostNative(m: JMethod, fn: HostNative): NativeFn {
  const descs = m.isStatic ? m.params : ["Ljava/lang/Object;", ...m.params];
  return function* (t: JThread, args: any[]): NativeGen {
    const lib = t.vm.library;
    const wire = args.map((v, i) => lib.toWire(descs[i], v));
    let pending: NativeReply | Promise<NativeReply>;
    try {
      pending = fn(wire);
    } catch (e) {
      throw hostError(e);
    }
    const r: NativeReply = isThenable(pending) ? yield* lib.pump(t, Promise.resolve(pending).catch((e) => Promise.reject(hostError(e)))) : pending;
    const out = yield* lib.toJava(t, m.ret, yield* lib.resolve(t, r.value), m.cls.loader);
    r.back?.forEach((b, i) => {
      const dst = args[i];
      if (b && dst instanceof JArray && ArrayBuffer.isView(dst.a)) (dst.a as unknown as { set(from: ArrayLike<number | bigint>): void }).set(b as unknown as ArrayLike<number>);
    });
    return out;
  };
}

// Looks up CheerpJ-style natives, fn(lib, ...args), by long then short name.
export function hostNatives(table: Record<string, (lib: object, ...args: any[]) => unknown>, bridge: Bridge, vm = 0) {
  return ([short, long]: [string, string]): HostNative | null => {
    const fn = table[long] ?? table[short];
    return fn ? (wire) => bridge.native(vm, fn, wire) : null;
  };
}
