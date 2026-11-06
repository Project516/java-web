import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 as zlibCrc32, deflateRawSync, deflateSync } from "node:zlib";
import { DataFormatError, Inflate } from "../src/inflate.ts";
import { adler32, crc32 } from "../src/natives/zip.ts";

// xorshift, so every run sees the same data
function rng(seed: number) {
  let x = seed;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

// text-like bytes with long and short repeats, and some noise
function sample(n: number, seed: number): Uint8Array {
  const r = rng(seed), out = new Uint8Array(n);
  const words = ["alpha", "beta", "gamma", "delta", "java", "class", "zip", "entry", "\n"];
  let i = 0;
  while (i < n) {
    const k = r() % 10;
    if (k < 6) for (const c of words[r() % words.length]) { if (i < n) out[i++] = c.charCodeAt(0); }
    else if (k < 8 && i > 300) { const d = 1 + (r() % 300), l = 3 + (r() % 258); for (let j = 0; j < l && i < n; j++, i++) out[i] = out[i - d]; }
    else out[i++] = r() & 0xff;
  }
  return out;
}

// Feeds compressed in pieces of random sizes into outputs of random sizes, as Java's Inflater does.
function inflateStream(z: Inflate, compressed: Uint8Array, seed: number, maxIn: number, maxOut: number): Uint8Array {
  const r = rng(seed), parts: Uint8Array[] = [];
  let pos = 0, idle = 0;
  while (!z.finished) {
    const inLen = Math.min(compressed.length - pos, 1 + (r() % maxIn));
    const out = new Uint8Array(1 + (r() % maxOut));
    const [read, written] = z.run(compressed.subarray(pos, pos + inLen), out, 0, out.length);
    pos += read;
    parts.push(out.subarray(0, written));
    idle = read || written ? 0 : idle + 1;
    assert.ok(idle < 1000, "inflate stalled");
    if (pos >= compressed.length && !read && !written) break;
  }
  assert.ok(z.finished, "stream not finished");
  return Buffer.concat(parts);
}

test("crc32 matches zlib at every length around the word size and across splits", () => {
  const data = sample(70000, 1);
  for (const n of [0, 1, 7, 8, 9, 15, 16, 17, 1000, 65537]) {
    const b = data.subarray(0, n);
    assert.equal(crc32(0, b) >>> 0, zlibCrc32(b));
    const half = n >> 1;
    assert.equal(crc32(crc32(0, b.subarray(0, half)), b.subarray(half)) >>> 0, zlibCrc32(b));
  }
});

test("adler32 matches the checksum zlib writes", () => {
  const data = sample(20000, 2);
  const z = deflateSync(data);
  const stored = new DataView(z.buffer, z.byteOffset + z.length - 4, 4).getUint32(0);
  assert.equal(adler32(1, data) >>> 0, stored);
});

test("inflate matches zlib for any split of input and output", () => {
  for (const [size, seed] of [[0, 3], [1, 4], [100, 5], [5000, 6], [70000, 7], [300000, 8]]) {
    const data = sample(size, seed);
    for (const level of [0, 1, 6, 9]) {
      for (const wrap of [true, false]) {
        const packed = wrap ? deflateSync(data, { level }) : deflateRawSync(data, { level });
        for (const [maxIn, maxOut] of [[1, 1000], [7, 3], [100, 100], [10000, 70000], [1 << 20, 1 << 20]]) {
          if (maxOut < 10 && size > 5000) continue;
          const got = inflateStream(new Inflate(!wrap), packed, seed + level, maxIn, maxOut);
          assert.ok(Buffer.from(got).equals(data), `size ${size} level ${level} wrap ${wrap} in ${maxIn} out ${maxOut}`);
        }
      }
    }
  }
});

test("inflate keeps the window across calls and rejects a bad checksum", () => {
  const data = sample(100000, 9);
  const packed = deflateSync(data);
  const z = new Inflate(false);
  const got = inflateStream(z, packed, 10, 4000, 500);
  assert.ok(Buffer.from(got).equals(data));
  assert.equal(z.adler, adler32(1, data) >>> 0);
  const bad = Buffer.from(packed);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => inflateStream(new Inflate(false), bad, 11, 5000, 5000), DataFormatError);
});

test("inflate stops at the end of the stream and leaves the bytes after it", () => {
  const data = sample(3000, 12);
  const packed = deflateRawSync(data);
  const tail = Uint8Array.of(1, 2, 3, 4, 5);
  const input = Buffer.concat([packed, tail]);
  const z = new Inflate(true);
  const out = new Uint8Array(4000);
  const [read, written] = z.run(input, out, 0, out.length);
  assert.ok(z.finished);
  assert.equal(written, data.length);
  assert.equal(read, packed.length);
});

test("inflate sees the end of the stream when the output fills on the last byte", () => {
  for (const wrap of [true, false]) {
    for (const size of [1, 10, 5000]) {
      const data = sample(size, 13);
      const packed = wrap ? deflateSync(data) : deflateRawSync(data);
      const z = new Inflate(!wrap);
      const out = new Uint8Array(size);
      const [read, written] = z.run(packed, out, 0, size);
      assert.equal(written, size);
      assert.equal(read, packed.length);
      assert.ok(z.finished, `size ${size} wrap ${wrap}`);
    }
  }
});
