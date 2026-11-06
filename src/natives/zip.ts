// java.util.zip natives: Inflater, Deflater, CRC32, Adler32.

import { Deflate } from "../deflate.ts";
import { DataFormatError, Inflate } from "../inflate.ts";
import type { JArray } from "../runtime.ts";
import { JThread, PendingThrow } from "../thread.ts";
import { u8 } from "./util.ts";
import type { Natives } from "./util.ts";

// slicing-by-8: table k holds the CRC of a byte followed by k zero bytes
const CRC_TABLE = (() => {
  const t = new Int32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 8; k++) t[k * 256 + n] = c = t[c & 0xff] ^ (c >>> 8);
  }
  return t;
})();

export function crc32(crc: number, b: Uint8Array): number {
  const T = CRC_TABLE, n = b.length;
  let c = ~crc, i = 0;
  for (; i + 8 <= n; i += 8) {
    const x = c ^ (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
    c = T[1792 + (x & 0xff)] ^ T[1536 + ((x >>> 8) & 0xff)] ^ T[1280 + ((x >>> 16) & 0xff)] ^ T[1024 + (x >>> 24)] ^
      T[768 + b[i + 4]] ^ T[512 + b[i + 5]] ^ T[256 + b[i + 6]] ^ T[b[i + 7]];
  }
  for (; i < n; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c;
}

export function adler32(adler: number, b: Uint8Array): number {
  let s1 = adler & 0xffff, s2 = adler >>> 16;
  for (let i = 0; i < b.length;) {
    const end = Math.min(b.length, i + 3800);
    for (; i < end; i++) { s1 += b[i]; s2 += s1; }
    s1 %= 65521;
    s2 %= 65521;
  }
  return ((s2 << 16) | s1) | 0;
}

function streams(t: JThread): Map<bigint, Inflate | Deflate> {
  let m = t.vm.state.get("zstreams");
  if (!m) t.vm.state.set("zstreams", (m = new Map()));
  return m;
}

let nextStream = 1n;

function inflater(t: JThread, addr: bigint): Inflate {
  const s = streams(t).get(addr);
  if (!(s instanceof Inflate)) throw new PendingThrow("java/lang/NullPointerException", "Inflater has been closed");
  return s;
}

function deflater(t: JThread, addr: bigint): Deflate {
  const s = streams(t).get(addr);
  if (!(s instanceof Deflate)) throw new PendingThrow("java/lang/NullPointerException", "Deflater has been closed");
  return s;
}

function result(read: number, written: number, finished: boolean, flag: boolean): bigint {
  let r = BigInt(read) | (BigInt(written) << 31n);
  if (finished) r |= 1n << 62n;
  if (flag) r |= 1n << 63n;
  return BigInt.asIntN(64, r);
}

function inflate(t: JThread, addr: bigint, input: Uint8Array, output: Uint8Array, off: number, len: number): bigint {
  const z = inflater(t, addr);
  try {
    const [read, written] = z.run(input, output, off, len);
    return result(read, written, z.finished, z.needDict);
  } catch (e) {
    if (e instanceof DataFormatError) throw new PendingThrow("java/util/zip/DataFormatException", e.message);
    throw e;
  }
}

function setInflateDictionary(t: JThread, addr: bigint, d: Uint8Array) {
  if (!inflater(t, addr).setDictionary(d)) throw new PendingThrow("java/lang/IllegalArgumentException");
}

function deflate(t: JThread, addr: bigint, input: Uint8Array, output: Uint8Array, flush: number, params: number): bigint {
  const z = deflater(t, addr);
  const [read, written, retry] = z.run(input, output, flush, params);
  return result(read, written, z.finished, retry);
}

function setDeflateDictionary(t: JThread, addr: bigint, d: Uint8Array) {
  if (!deflater(t, addr).setDictionary(d)) throw new PendingThrow("java/lang/IllegalArgumentException");
}

function mem(t: JThread, addr: bigint, len: number) {
  return t.vm.mem.u8.subarray(Number(addr), Number(addr) + len);
}

const I = "java/util/zip/Inflater.", D = "java/util/zip/Deflater.";

export const natives: Natives = {
  [`${I}init(Z)J`]: (t, [nowrap]) => {
    const id = nextStream++;
    streams(t).set(id, new Inflate(nowrap === 1));
    return id;
  },
  [`${I}inflateBytesBytes(J[BII[BII)J`]: (t, [, addr, ib, io, il, ob, oo, ol]) =>
    inflate(t, addr, u8(ib, io, il), u8(ob), oo, ol),
  [`${I}inflateBytesBuffer(J[BIIJI)J`]: (t, [, addr, ib, io, il, oa, ol]) =>
    inflate(t, addr, u8(ib, io, il), mem(t, oa, ol), 0, ol),
  [`${I}inflateBufferBytes(JJI[BII)J`]: (t, [, addr, ia, il, ob, oo, ol]) =>
    inflate(t, addr, mem(t, ia, il).slice(), u8(ob), oo, ol),
  [`${I}inflateBufferBuffer(JJIJI)J`]: (t, [, addr, ia, il, oa, ol]) =>
    inflate(t, addr, mem(t, ia, il).slice(), mem(t, oa, ol), 0, ol),
  [`${I}setDictionary(J[BII)V`]: (t, [addr, b, off, len]) => setInflateDictionary(t, addr, u8(b, off, len)),
  [`${I}setDictionaryBuffer(JJI)V`]: (t, [addr, a, len]) => setInflateDictionary(t, addr, mem(t, a, len)),
  [`${I}getAdler(J)I`]: (t, [addr]) => inflater(t, addr).adler | 0,
  [`${I}reset(J)V`]: (t, [addr]) => inflater(t, addr).reset(),
  [`${I}end(J)V`]: (t, [addr]) => void streams(t).delete(addr),

  [`${D}init(IIZ)J`]: (t, [level, strategy, nowrap]) => {
    if (level < -1 || level > 9 || strategy < 0 || strategy > 2) throw new PendingThrow("java/lang/IllegalArgumentException");
    const id = nextStream++;
    streams(t).set(id, new Deflate(level, strategy, nowrap === 1));
    return id;
  },
  [`${D}deflateBytesBytes(J[BII[BIIII)J`]: (t, [, addr, ib, io, il, ob, oo, ol, flush, params]) =>
    deflate(t, addr, u8(ib, io, il), u8(ob, oo, ol), flush, params),
  [`${D}deflateBytesBuffer(J[BIIJIII)J`]: (t, [, addr, ib, io, il, oa, ol, flush, params]) =>
    deflate(t, addr, u8(ib, io, il), mem(t, oa, ol), flush, params),
  [`${D}deflateBufferBytes(JJI[BIIII)J`]: (t, [, addr, ia, il, ob, oo, ol, flush, params]) =>
    deflate(t, addr, mem(t, ia, il), u8(ob, oo, ol), flush, params),
  [`${D}deflateBufferBuffer(JJIJIII)J`]: (t, [, addr, ia, il, oa, ol, flush, params]) =>
    deflate(t, addr, mem(t, ia, il), mem(t, oa, ol), flush, params),
  [`${D}setDictionary(J[BII)V`]: (t, [addr, b, off, len]) => setDeflateDictionary(t, addr, u8(b, off, len)),
  [`${D}setDictionaryBuffer(JJI)V`]: (t, [addr, a, len]) => setDeflateDictionary(t, addr, mem(t, a, len)),
  [`${D}getAdler(J)I`]: (t, [addr]) => deflater(t, addr).checksum | 0,
  [`${D}reset(J)V`]: (t, [addr]) => deflater(t, addr).reset(),
  [`${D}end(J)V`]: (t, [addr]) => void streams(t).delete(addr),

  "java/util/zip/CRC32.update(II)I": (_t, [crc, b]) => ~(CRC_TABLE[(~crc ^ b) & 0xff] ^ (~crc >>> 8)),
  "java/util/zip/CRC32.updateBytes0(I[BII)I": (_t, [crc, b, off, len]) => crc32(crc, u8(b as JArray, off, len)),
  "java/util/zip/CRC32.updateByteBuffer0(IJII)I": (t, [crc, addr, off, len]) => crc32(crc, mem(t, addr + BigInt(off), len)),
  "java/util/zip/Adler32.update(II)I": (_t, [a, b]) => adler32(a, Uint8Array.of(b)),
  "java/util/zip/Adler32.updateBytes(I[BII)I": (_t, [a, b, off, len]) => adler32(a, u8(b as JArray, off, len)),
  "java/util/zip/Adler32.updateByteBuffer(IJII)I": (t, [a, addr, off, len]) => adler32(a, mem(t, addr + BigInt(off), len)),
};
