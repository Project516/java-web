// StringBuilder.append(String) and toString as natives: they are the hottest
// JDK calls in code built with -XDstringConcat=inline, and HotSpot's JIT
// collapses them. They follow AbstractStringBuilder.append,
// ensureCapacityNewCoder, newCapacity and String.<init>(AbstractStringBuilder,
// Void) of the pinned JDK, so buffer growth and string coders match.

import { JArray, MAX_HEAP, newArrayData } from "../runtime.ts";
import type { JClass, JObject } from "../runtime.ts";
import { PendingThrow } from "../thread.ts";
import type { JThread } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import type { Natives } from "./util.ts";

const ASB = "java/lang/AbstractStringBuilder", STR = "java/lang/String";
const SOFT_MAX = 0x7fffffff - 8;

let slotVm: JVM | null = null;
let strClass: JClass;
let sbValue = 0, sbCoder = 0, sbCount = 0, sbMaybeLatin1 = 0, strValue = 0, strCoder = 0;

function slots(vm: JVM) {
  if (slotVm === vm) return;
  sbValue = vm.slotOf(ASB, "value");
  sbCoder = vm.slotOf(ASB, "coder");
  sbCount = vm.slotOf(ASB, "count");
  sbMaybeLatin1 = vm.slotOf(ASB, "maybeLatin1");
  strValue = vm.slotOf(STR, "value");
  strCoder = vm.slotOf(STR, "coder");
  strClass = vm.loadBootOrFail(STR);
  slotVm = vm;
}

function newBytes(n: number): Int8Array {
  if (n > MAX_HEAP) throw new PendingThrow("java/lang/OutOfMemoryError", "Java heap space");
  return newArrayData("B", n) as Int8Array;
}

// AbstractStringBuilder.newCapacity(value, newCoder, minCapacity), in chars
function newCapacity(valueLength: number, newCoder: number, minCapacity: number): number {
  const minGrowth = (minCapacity << newCoder) - valueLength;
  let len = (valueLength + Math.max(minGrowth, valueLength + (2 << newCoder))) | 0;
  if (!(len > 0 && len <= SOFT_MAX)) {
    const min = (valueLength + minGrowth) | 0;
    if (min < 0) throw new PendingThrow("java/lang/OutOfMemoryError", "Required length exceeds implementation limit");
    len = min <= SOFT_MAX ? SOFT_MAX : min;
  }
  if (len === 0x7fffffff) throw new PendingThrow("java/lang/OutOfMemoryError", "Required length exceeds implementation limit");
  return len >> newCoder;
}

function inflate(src: Int8Array, srcLen: number, dst: Int8Array, dstChar: number) {
  for (let i = 0, j = dstChar * 2; i < srcLen; i++) {
    dst[j++] = src[i];
    dst[j++] = 0;
  }
}

function appendString(t: JThread, args: any[]): JObject {
  const self: JObject = args[0], str: JObject | null = args[1];
  const vm = t.vm;
  slots(vm);
  const s = str ?? vm.intern("null");
  const sBytes = (s.f[strValue] as JArray).a as Int8Array;
  const sCoder = s.f[strCoder] as number;
  const len = sBytes.length >> sCoder;
  const coder = self.f[sbCoder] as number;
  const count = self.f[sbCount] as number;
  let value = (self.f[sbValue] as JArray).a as Int8Array;
  const newCoder = coder | sCoder;
  const min = (count + len) | 0;
  const old = value.length >> coder;
  if (newCoder !== coder || min - old > 0) {
    const cap = min - old > 0 ? newCapacity(value.length, newCoder, min) : old;
    if (coder === newCoder) {
      if (cap > old) {
        const grown = newBytes(cap << newCoder);
        grown.set(value);
        value = grown;
      }
    } else {
      const buf = newBytes(cap << 1);
      inflate(value, count, buf, 0);
      value = buf;
    }
    self.f[sbValue] = new JArray((self.f[sbValue] as JArray).cls, value);
    self.f[sbCoder] = newCoder;
  }
  if (sCoder === newCoder) value.set(sBytes, count << newCoder);
  else inflate(sBytes, len, value, count);
  self.f[sbCount] = min;
  return self;
}

// String.<init>(AbstractStringBuilder, Void), the body of StringBuilder.toString
function stringFromBuilder(t: JThread, args: any[]) {
  const self: JObject = args[0], sb: JObject = args[1];
  slots(t.vm);
  const src = (sb.f[sbValue] as JArray).a as Int8Array;
  const count = sb.f[sbCount] as number;
  let coder = sb.f[sbCoder] as number;
  let value: Int8Array;
  if (coder === 1 && sb.f[sbMaybeLatin1]) {
    let i = 0;
    while (i < count && src[i * 2 + 1] === 0) i++;
    if (i === count) {
      value = newBytes(count);
      for (let j = 0; j < count; j++) value[j] = src[j * 2];
      coder = 0;
    } else value = copy(src, count << 1);
  } else value = copy(src, count << coder);
  fill(t.vm, self, value, coder);
}

function fill(vm: JVM, s: JObject, value: Int8Array, coder: number) {
  s.f[strValue] = new JArray(vm.primArrayClass("B"), value);
  s.f[strCoder] = coder;
}

function copy(src: Int8Array, n: number): Int8Array {
  const out = newBytes(n);
  out.set(n === src.length ? src : src.subarray(0, n));
  return out;
}

// The String that new StringBuilder().append(String)...toString() builds, for
// the JIT's fused form of that call chain. pc is where an OutOfMemoryError
// reports.
export function concatStrings(t: JThread, pc: number, parts: (JObject | null)[]): JObject {
  const vm = t.vm;
  slots(vm);
  const nul = parts.includes(null) ? vm.intern("null") : null;
  let chars = 0, coder = 0;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i] ?? nul!;
    const c = s.f[strCoder] as number;
    coder |= c;
    chars += (s.f[strValue] as JArray).a.length >> c;
  }
  let value: Int8Array;
  try {
    value = newBytes(chars * (coder + 1));
  } catch (e) {
    if (e instanceof PendingThrow) e.pc = pc;
    throw e;
  }
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i] ?? nul!;
    const bytes = (s.f[strValue] as JArray).a as Int8Array;
    const c = s.f[strCoder] as number;
    const len = bytes.length >> c;
    if (c === coder) value.set(bytes, at << coder);
    else inflate(bytes, len, value, at);
    at += len;
  }
  const str = vm.newObject(strClass);
  fill(vm, str, value, coder);
  return str;
}

export const intrinsics: Natives = {
  [`${ASB}.append(Ljava/lang/String;)L${ASB};`]: appendString,
  "java/lang/StringBuilder.append(Ljava/lang/String;)Ljava/lang/StringBuilder;": appendString,
  "java/lang/String.<init>(Ljava/lang/AbstractStringBuilder;Ljava/lang/Void;)V": stringFromBuilder,
};
