// java.util.zip natives: Inflater, Deflater, CRC32, Adler32.

import { DataFormatError, Inflate } from "../inflate.ts";
import type { JArray } from "../runtime.ts";
import { JThread, PendingThrow } from "../thread.ts";
import { u8 } from "./util.ts";
import type { Natives } from "./util.ts";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(crc: number, b: Uint8Array): number {
  let c = ~crc;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
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

const BLOCK = 65535;

// Deflate with stored blocks only: valid output, no compression yet. As in
// zlib, input is taken only while output drains, so memory stays bounded.
class Deflate {
  private readonly wrap: boolean;
  private headerDone = false;
  // input not yet in a block, and output waiting for room
  private held = new Uint8Array(BLOCK);
  private heldLen = 0;
  private pending = new Uint8Array(BLOCK + 32);
  private pendPos = 0;
  private pendLen = 0;
  private adler = 1;
  private dictId: number | null = null;
  private lastFlush = 0;
  private ended = false;
  constructor(nowrap: boolean) {
    this.wrap = !nowrap;
  }
  get finished() { return this.ended && this.pendPos === this.pendLen; }
  get checksum() { return this.headerDone || this.dictId === null ? this.adler : this.dictId; }
  reset() {
    this.headerDone = this.ended = false;
    this.heldLen = this.pendPos = this.pendLen = this.lastFlush = 0;
    this.adler = 1;
    this.dictId = null;
  }
  // the header names the dictionary; compression would also use it
  setDictionary(d: Uint8Array) {
    if (this.wrap && !this.headerDone) this.dictId = adler32(1, d) >>> 0;
  }
  private put(...bytes: number[]) {
    for (const b of bytes) this.pending[this.pendLen++] = b;
  }
  private block(last: boolean) {
    const n = this.heldLen;
    this.put(last ? 1 : 0, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff);
    this.pending.set(this.held.subarray(0, n), this.pendLen);
    this.pendLen += n;
    this.heldLen = 0;
  }
  private be32(v: number) {
    this.put(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  private drain(output: Uint8Array, at: number): number {
    const n = Math.min(output.length - at, this.pendLen - this.pendPos);
    output.set(this.pending.subarray(this.pendPos, this.pendPos + n), at);
    this.pendPos += n;
    if (this.pendPos === this.pendLen) this.pendPos = this.pendLen = 0;
    return n;
  }
  // flush: 0 none, 2 sync, 3 full, 4 finish. Returns [read, written].
  run(input: Uint8Array, output: Uint8Array, flush: number): [number, number] {
    let read = 0, written = this.drain(output, 0);
    if (this.pendLen) {
      this.lastFlush = -1;
      return [0, written];
    }
    // a repeated flush with no new input adds nothing, so flush loops end
    if (input.length === 0 && flush <= this.lastFlush && flush !== 4) return [0, written];
    this.lastFlush = flush;
    let flushed = false;
    for (;;) {
      written += this.drain(output, written);
      if (this.pendLen || this.ended) return [read, written];
      if (!this.headerDone) {
        this.headerDone = true;
        if (this.wrap) {
          if (this.dictId === null) this.put(0x78, 0x01);
          else {
            this.put(0x78, 0x20);
            this.be32(this.dictId);
          }
        }
        continue;
      }
      if (read < input.length) {
        const n = Math.min(BLOCK - this.heldLen, input.length - read);
        const chunk = input.subarray(read, read + n);
        this.held.set(chunk, this.heldLen);
        if (this.wrap) this.adler = adler32(this.adler, chunk);
        this.heldLen += n;
        read += n;
        if (this.heldLen === BLOCK) this.block(false);
        continue;
      }
      if (flushed || (flush !== 2 && flush !== 3 && flush !== 4)) return [read, written];
      flushed = true;
      if (flush === 4) {
        this.block(true);
        if (this.wrap) this.be32(this.adler >>> 0);
        this.ended = true;
      } else {
        if (this.heldLen) this.block(false);
        this.block(false);
      }
    }
  }
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

function deflate(t: JThread, addr: bigint, input: Uint8Array, output: Uint8Array, flush: number): bigint {
  const z = deflater(t, addr);
  const [read, written] = z.run(input, output, flush);
  return result(read, written, z.finished, false);
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

  [`${D}init(IIZ)J`]: (t, [, , nowrap]) => {
    const id = nextStream++;
    streams(t).set(id, new Deflate(nowrap === 1));
    return id;
  },
  [`${D}deflateBytesBytes(J[BII[BIIII)J`]: (t, [, addr, ib, io, il, ob, oo, ol, flush]) =>
    deflate(t, addr, u8(ib, io, il), u8(ob, oo, ol), flush),
  [`${D}deflateBytesBuffer(J[BIIJIII)J`]: (t, [, addr, ib, io, il, oa, ol, flush]) =>
    deflate(t, addr, u8(ib, io, il), mem(t, oa, ol), flush),
  [`${D}deflateBufferBytes(JJI[BIIII)J`]: (t, [, addr, ia, il, ob, oo, ol, flush]) =>
    deflate(t, addr, mem(t, ia, il), u8(ob, oo, ol), flush),
  [`${D}deflateBufferBuffer(JJIJIII)J`]: (t, [, addr, ia, il, oa, ol, flush]) =>
    deflate(t, addr, mem(t, ia, il), mem(t, oa, ol), flush),
  [`${D}setDictionary(J[BII)V`]: (t, [addr, b, off, len]) => deflater(t, addr).setDictionary(u8(b, off, len)),
  [`${D}setDictionaryBuffer(JJI)V`]: (t, [addr, a, len]) => deflater(t, addr).setDictionary(mem(t, a, len)),
  [`${D}getAdler(J)I`]: (t, [addr]) => deflater(t, addr).checksum | 0,
  [`${D}reset(J)V`]: (t, [addr]) => deflater(t, addr).reset(),
  [`${D}end(J)V`]: (t, [addr]) => void streams(t).delete(addr),

  "java/util/zip/CRC32.update(II)I": (_t, [crc, b]) => crc32(crc, Uint8Array.of(b)),
  "java/util/zip/CRC32.updateBytes0(I[BII)I": (_t, [crc, b, off, len]) => crc32(crc, u8(b as JArray, off, len)),
  "java/util/zip/CRC32.updateByteBuffer0(IJII)I": (t, [crc, addr, off, len]) => crc32(crc, mem(t, addr + BigInt(off), len)),
  "java/util/zip/Adler32.update(II)I": (_t, [a, b]) => adler32(a, Uint8Array.of(b)),
  "java/util/zip/Adler32.updateBytes(I[BII)I": (_t, [a, b, off, len]) => adler32(a, u8(b as JArray, off, len)),
  "java/util/zip/Adler32.updateByteBuffer(IJII)I": (t, [a, addr, off, len]) => adler32(a, mem(t, addr + BigInt(off), len)),
};
