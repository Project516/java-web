// Array loops HotSpot replaces with intrinsics: mismatch, hash code and ASCII
// scanning. The Java versions read longs through Unsafe, which are BigInts here.

import type { JArray } from "../runtime.ts";
import { bytesAt } from "./misc.ts";
import type { Natives } from "./util.ts";

const AS = "jdk/internal/util/ArraysSupport.";
const T_BOOLEAN = 4, T_CHAR = 5;

// Byte index of the first difference in [0, n), or -1.
function firstDiff(a: Uint8Array, ap: number, b: Uint8Array, bp: number, n: number): number {
  let i = 0;
  while (i + 4 <= n && a[ap + i] === b[bp + i] && a[ap + i + 1] === b[bp + i + 1] &&
    a[ap + i + 2] === b[bp + i + 2] && a[ap + i + 3] === b[bp + i + 3]) i += 4;
  for (; i < n; i++) if (a[ap + i] !== b[bp + i]) return i;
  return -1;
}

// Same results as ArraysSupport.vectorizedMismatch: the index of the first
// differing element within the whole 8-byte words and the 4-byte tail word,
// else the complement of the elements left for the caller's loop.
function vectorizedMismatch(a: Uint8Array, ap: number, b: Uint8Array, bp: number, length: number, scale: number): number {
  const words = (length >> (3 - scale)) << 3;
  const d = firstDiff(a, ap, b, bp, words);
  if (d >= 0) return d >> scale;
  let tail = length - (words >> scale);
  if (scale < 2) {
    const wordTail = 1 << (2 - scale);
    if (tail >= wordTail) {
      const t = firstDiff(a, ap + words, b, bp + words, 4);
      if (t >= 0) return (words + t) >> scale;
      tail -= wordTail;
    }
  }
  return ~tail;
}

// ArraysSupport.vectorizedHashCode; a byte[] with T_CHAR holds UTF-16 little-endian.
function hashCode(h: number, array: JArray, from: number, len: number, type: number): number {
  const v = array.a as Int8Array | Uint16Array | Int16Array | Int32Array;
  const end = from + len;
  if (type === T_CHAR && v instanceof Int8Array) {
    for (let i = from; i < end; i++) h = (Math.imul(31, h) + ((v[i << 1] & 0xff) | ((v[(i << 1) + 1] & 0xff) << 8))) | 0;
  } else if (type === T_BOOLEAN) {
    for (let i = from; i < end; i++) h = (Math.imul(31, h) + (v[i] & 0xff)) | 0;
  } else {
    for (let i = from; i < end; i++) h = (Math.imul(31, h) + v[i]) | 0;
  }
  return h;
}

export const intrinsics: Natives = {
  [`${AS}vectorizedMismatch(Ljava/lang/Object;JLjava/lang/Object;JII)I`]: (t, [a, aOff, b, bOff, length, scale]) => {
    const [x, xp] = bytesAt(t, a, aOff);
    const [y, yp] = bytesAt(t, b, bOff);
    return vectorizedMismatch(x, xp, y, yp, length, scale);
  },
  [`${AS}vectorizedHashCode(Ljava/lang/Object;IIII)I`]: (_t, [array, from, len, init, type]) =>
    hashCode(init, array, from, len, type),
  "java/lang/StringCoding.countPositives([BII)I": (_t, [ba, off, len]) => {
    const v = (ba as JArray).a as Int8Array;
    for (let i = off; i < off + len; i++) if (v[i] < 0) return i - off;
    return len;
  },
};
