// The DEFLATE encoder behind java.util.zip.Deflater: every output must inflate
// with node:zlib and with the VM's own Inflate, and sizes must stay near zlib's.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { Deflate } from "../src/deflate.ts";
import { Inflate } from "../src/inflate.ts";

const NO_FLUSH = 0, SYNC = 2, FULL = 3, FINISH = 4;

function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

function random(n: number, seed: number): Uint8Array {
  const r = prng(seed), b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = r();
  return b;
}

// words from a small vocabulary: compresses like text
function words(n: number, seed: number): Uint8Array {
  const r = prng(seed);
  const vocab = Array.from({ length: 300 }, () => Array.from({ length: 2 + (r() % 9) }, () => 97 + (r() % 26)));
  const b = new Uint8Array(n);
  for (let i = 0; i < n;) {
    for (const c of vocab[(r() % 300) % (1 + (r() % 300))]) if (i < n) b[i++] = c;
    if (i < n) b[i++] = 32;
  }
  return b;
}

// short runs and repeats at many distances
function patterned(n: number, seed: number): Uint8Array {
  const r = prng(seed), b = new Uint8Array(n);
  for (let i = 0; i < n;) {
    if (i > 8 && r() % 3) {
      const len = 3 + (r() % 300), dist = 1 + (r() % Math.min(i, 40000));
      for (let k = 0; k < len && i < n; k++, i++) b[i] = b[i - dist];
    } else b[i++] = r() % 7 ? r() % 16 : r();
  }
  return b;
}

const srcDir = join(import.meta.dirname, "..", "src");
const source = Buffer.concat(readdirSync(srcDir).filter((f) => f.endsWith(".ts")).sort().map((f) => readFileSync(join(srcDir, f))));

const corpora: Record<string, Uint8Array> = {
  empty: new Uint8Array(0),
  one: Uint8Array.of(65),
  zeros: new Uint8Array(200000),
  random: random(150000, 1),
  words: words(250000, 2),
  patterned: patterned(200000, 3),
  source: source.subarray(0, 400000),
  mixed: Buffer.concat([words(70000, 4), random(40000, 5), new Uint8Array(70000), patterned(50000, 6)]),
};

// as Deflater.deflate is driven: input stays put until it is consumed
function drive(d: Deflate, input: Uint8Array, flush: number, outSize: number, parts: Uint8Array[]) {
  const out = new Uint8Array(outSize);
  let off = 0;
  for (;;) {
    const [read, written] = d.run(input.subarray(off), out, flush, 0);
    off += read;
    if (written) parts.push(out.slice(0, written));
    if (flush === FINISH ? d.finished : off === input.length && written < outSize) return;
  }
}

function compress(data: Uint8Array, level: number, strategy = 0, nowrap = false, chunk = data.length || 1, outSize = 4096): Buffer {
  const d = new Deflate(level, strategy, nowrap);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += chunk) drive(d, data.subarray(at, at + chunk), NO_FLUSH, outSize, parts);
  drive(d, new Uint8Array(0), FINISH, outSize, parts);
  return Buffer.concat(parts);
}

function vmInflate(z: Uint8Array, nowrap: boolean, dict?: Uint8Array): Buffer {
  const inf = new Inflate(nowrap);
  if (dict && nowrap) inf.setDictionary(dict);
  const out: Buffer[] = [];
  const buf = new Uint8Array(65536);
  for (let guard = 0; !inf.finished; guard++) {
    assert.ok(guard < 100000, "inflate stuck");
    const [read, written] = inf.run(z, buf, 0, buf.length);
    if (inf.needDict) assert.ok(inf.setDictionary(dict!));
    out.push(Buffer.from(buf.subarray(0, written)));
    assert.ok(read > 0 || written > 0 || inf.finished || inf.needDict);
    z = z.subarray(read);
  }
  return Buffer.concat(out);
}

function check(z: Buffer, data: Uint8Array, nowrap: boolean) {
  const node = nowrap ? zlib.inflateRawSync(z) : zlib.inflateSync(z);
  assert.ok(Buffer.from(data).equals(node), "node:zlib output differs");
  assert.ok(Buffer.from(data).equals(vmInflate(z, nowrap)), "Inflate output differs");
}

test("every level and strategy round-trips", () => {
  for (const [name, data] of Object.entries(corpora)) {
    for (let level = 0; level <= 9; level++) {
      for (const strategy of [0, 1, 2]) {
        if (strategy && level % 3) continue;
        const nowrap = (level + strategy) % 2 === 1;
        const z = compress(data, level, strategy, nowrap);
        try {
          check(z, data, nowrap);
        } catch (e) {
          throw new Error(`${name} level ${level} strategy ${strategy} nowrap ${nowrap}: ${(e as Error).message}`);
        }
      }
    }
  }
});

test("level -1 is level 6 and the header names the level", () => {
  const data = corpora.words;
  assert.deepEqual(compress(data, -1), compress(data, 6));
  const header = (level: number, strategy = 0) => [...compress(Uint8Array.of(1, 2, 3), level, strategy).subarray(0, 2)];
  assert.deepEqual(header(0), [0x78, 0x01]);
  assert.deepEqual(header(1), [0x78, 0x01]);
  assert.deepEqual(header(2), [0x78, 0x5e]);
  assert.deepEqual(header(5), [0x78, 0x5e]);
  assert.deepEqual(header(6), [0x78, 0x9c]);
  assert.deepEqual(header(9), [0x78, 0xda]);
  assert.deepEqual(header(9, 2), [0x78, 0x01]);
});

test("small output buffers and tiny input chunks", () => {
  for (const level of [0, 1, 4, 9]) {
    for (const [chunk, outSize] of [[1, 1], [7, 3], [1000, 1], [4099, 17], [70000, 65536]]) {
      const data = corpora.mixed.subarray(0, 30000);
      check(compress(data, level, 0, false, chunk, outSize), data, false);
    }
  }
});

test("input larger than the window slides it", () => {
  const data = corpora.words;
  for (const level of [1, 3, 6, 9]) check(compress(data, level, 0, true, 65536 + 17), data, true);
});

test("sync flush ends on a byte boundary with an empty stored block", () => {
  for (const level of [0, 1, 6, 9]) {
    const d = new Deflate(level, 0, true);
    const parts: Uint8Array[] = [];
    const data = corpora.patterned;
    for (let at = 0; at < 60000; at += 5000) {
      drive(d, data.subarray(at, at + 5000), SYNC, 300, parts);
      const sofar = Buffer.concat(parts);
      assert.deepEqual([...sofar.subarray(-4)], [0, 0, 0xff, 0xff]);
      // everything fed so far can be decoded without the rest of the stream
      const got = zlib.inflateRawSync(sofar, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      assert.ok(Buffer.from(data.subarray(0, at + 5000)).equals(got), `level ${level} at ${at}`);
    }
    drive(d, new Uint8Array(0), FINISH, 300, parts);
    check(Buffer.concat(parts), data.subarray(0, 60000), true);
  }
});

test("a repeated flush with no input adds nothing", () => {
  const d = new Deflate(6, 0, false);
  const parts: Uint8Array[] = [];
  drive(d, corpora.words.subarray(0, 1000), SYNC, 64, parts);
  const out = new Uint8Array(64);
  assert.equal(d.run(new Uint8Array(0), out, SYNC, 0)[1], 0);
});

test("full flush resets the match history", () => {
  for (const level of [1, 6, 9]) {
    const a = corpora.words.subarray(0, 20000);
    const d = new Deflate(level, 0, true);
    const first: Uint8Array[] = [], second: Uint8Array[] = [];
    drive(d, a, FULL, 1000, first);
    drive(d, a, NO_FLUSH, 1000, second);
    drive(d, new Uint8Array(0), FINISH, 1000, second);
    // the same data again would match the first copy if history were kept
    const tail = Buffer.concat(second);
    assert.ok(Buffer.from(a).equals(zlib.inflateRawSync(tail)), `level ${level}: second part stands alone`);
    check(Buffer.concat([...first, ...second]), Buffer.concat([a, a]), true);
  }
});

test("a preset dictionary is used and named in the header", () => {
  const dict = corpora.words.subarray(0, 20000);
  const data = corpora.words.subarray(5000, 15000);
  for (const level of [1, 6, 9]) {
    for (const nowrap of [false, true]) {
      const d = new Deflate(level, 0, nowrap);
      assert.ok(d.setDictionary(dict));
      const parts: Uint8Array[] = [];
      drive(d, data, NO_FLUSH, 4096, parts);
      drive(d, new Uint8Array(0), FINISH, 4096, parts);
      const z = Buffer.concat(parts);
      const plain = compress(data, level, 0, nowrap).length;
      assert.ok(z.length < plain / 4, `level ${level}: ${z.length} vs ${plain}`);
      const node = nowrap ? zlib.inflateRawSync(z, { dictionary: dict }) : zlib.inflateSync(z, { dictionary: dict });
      assert.ok(Buffer.from(data).equals(node));
      assert.ok(Buffer.from(data).equals(vmInflate(z, nowrap, dict)));
      if (!nowrap) assert.equal(z.readUInt32BE(2) >>> 0, adler(dict));
    }
  }
});

function adler(d: Uint8Array): number {
  let s1 = 1, s2 = 0;
  for (const b of d) {
    s1 = (s1 + b) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

test("a dictionary is refused once a zlib stream has started", () => {
  const d = new Deflate(6, 0, false);
  assert.ok(d.setDictionary(Uint8Array.of(1, 2, 3)));
  d.run(Uint8Array.of(1, 2, 3), new Uint8Array(100), NO_FLUSH, 0);
  assert.equal(d.setDictionary(Uint8Array.of(1, 2, 3)), false);
});

// Huffman-only takes one byte at a time, so its symbols can be pending when a dictionary arrives.
test("a raw dictionary set after input keeps the symbols already taken", () => {
  const dict = corpora.words.subarray(0, 5000);
  const head = corpora.words.subarray(20000, 90000);
  const tail = corpora.words.subarray(1000, 9000);
  for (let level = 1; level <= 9; level++) {
    for (const n of [1, 300, 5000, 70000]) {
      const d = new Deflate(level, 2, true);
      const parts: Uint8Array[] = [];
      drive(d, head.subarray(0, n), NO_FLUSH, 4096, parts);
      assert.ok(d.setDictionary(dict), `level ${level} n ${n}`);
      drive(d, tail, NO_FLUSH, 4096, parts);
      drive(d, new Uint8Array(0), FINISH, 4096, parts);
      const z = Buffer.concat(parts);
      const want = Buffer.concat([head.subarray(0, n), tail]);
      assert.ok(want.equals(zlib.inflateRawSync(z, { dictionary: dict })), `level ${level} n ${n}`);
      assert.ok(want.equals(vmInflate(z, true, dict)), `Inflate: level ${level} n ${n}`);
    }
  }
});

// HotSpot's zlib drops stored input held at this point; its length varies with the output buffer, so this keeps it.
test("a raw dictionary set at level 0 keeps stored input not yet in a block", () => {
  const head = corpora.words.subarray(0, 70000);
  const tail = corpora.words.subarray(1000, 9000);
  const d = new Deflate(0, 0, true);
  const parts: Uint8Array[] = [];
  drive(d, head, NO_FLUSH, 4096, parts);
  assert.ok(d.setDictionary(corpora.words.subarray(0, 5000)));
  drive(d, tail, NO_FLUSH, 4096, parts);
  drive(d, new Uint8Array(0), FINISH, 4096, parts);
  const want = Buffer.concat([head, tail]);
  assert.ok(want.equals(zlib.inflateRawSync(Buffer.concat(parts))));
});

test("changing level and strategy mid-stream", () => {
  const data = corpora.mixed;
  const steps: [number, number][] = [[1, 0], [9, 0], [0, 0], [6, 1], [4, 2], [3, 0], [6, 0]];
  for (const outSize of [16, 4096]) {
    const d = new Deflate(6, 0, false);
    const parts: Uint8Array[] = [];
    const out = new Uint8Array(outSize);
    const size = Math.floor(data.length / steps.length);
    steps.forEach(([level, strategy], i) => {
      let input = data.subarray(i * size, i === steps.length - 1 ? data.length : (i + 1) * size);
      const params = 1 | (strategy << 1) | (level << 3);
      let first = true;
      // as Deflater: params go with each call until one reports it is done
      for (;;) {
        const [read, written, retry] = d.run(input, out, NO_FLUSH, first ? params : 0);
        input = input.subarray(read);
        if (written) parts.push(out.slice(0, written));
        if (retry) {
          first = true;
          continue;
        }
        first = false;
        const [r, w] = d.run(input, out, NO_FLUSH, 0);
        input = input.subarray(r);
        if (w) parts.push(out.slice(0, w));
        if (input.length === 0 && w < outSize) break;
      }
    });
    drive(d, new Uint8Array(0), FINISH, outSize, parts);
    check(Buffer.concat(parts), data, false);
  }
});

test("compressed size is near zlib's", () => {
  for (const name of ["words", "source", "patterned", "mixed"]) {
    const data = corpora[name];
    for (const [level, slack] of [[1, 1.25], [6, 1.1], [9, 1.1]] as const) {
      const ours = compress(data, level).length;
      const theirs = zlib.deflateSync(data, { level }).length;
      assert.ok(ours <= theirs * slack, `${name} level ${level}: ${ours} vs zlib ${theirs}`);
    }
    assert.ok(compress(data, 9).length <= compress(data, 1).length);
  }
  const stored = compress(corpora.random, 6);
  assert.ok(stored.length <= corpora.random.length + 5 * Math.ceil(corpora.random.length / 16383) + 12, `incompressible data costs a few bytes: ${stored.length}`);
  assert.ok(compress(corpora.zeros, 6).length < 400);
  assert.ok(compress(corpora.words, 6, 2).length < corpora.words.length, "huffman only still codes");
});
