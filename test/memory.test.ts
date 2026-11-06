import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeMemory } from "../src/memory.ts";

test("mapped allocations are page aligned and reusable", () => {
  const mem = new NativeMemory();
  mem.malloc(32);
  const page = mem.malloc(128, 4096);
  assert.equal(page % 4096, 0);
  mem.freeBlock(page);
  assert.equal(mem.malloc(128, 4096), page);
});

test("releases a large top allocation and preserves live blocks", () => {
  const mem = new NativeMemory();
  const first = mem.malloc(32);
  mem.u8[first] = 123;
  const middle = mem.malloc(32);
  const large = mem.malloc(16 << 20, 4096);
  mem.freeBlock(middle);
  mem.freeBlock(large);
  assert.equal(mem.buf.byteLength, 1 << 20);
  assert.equal(mem.u8[first], 123);
  assert.equal(mem.malloc(32), middle);
});

test("a failed allocation leaves memory usable", () => {
  const mem = new NativeMemory();
  const addr = mem.malloc(32);
  assert.throws(() => mem.malloc(512 << 20));
  assert.equal(mem.malloc(32), addr + 32);
});

test("freeing blocks in any order lowers top over adjacent free blocks", () => {
  const mem = new NativeMemory();
  const a = mem.malloc(64);
  const b = mem.malloc(64);
  const c = mem.malloc(64);
  mem.freeBlock(b);
  mem.freeBlock(a);
  mem.freeBlock(c);
  assert.equal(mem.malloc(64), a);
});

test("small frees keep the buffer", () => {
  const mem = new NativeMemory(4 << 20);
  const buf = mem.buf;
  mem.freeBlock(mem.malloc(32));
  assert.equal(mem.buf, buf);
});

test("a restored memory lowers top over free blocks", () => {
  const mem = new NativeMemory();
  const a = mem.malloc(64);
  const b = mem.malloc(64);
  const c = mem.malloc(64);
  mem.freeBlock(b);
  const state = mem as any;
  const copy = new NativeMemory();
  copy.restore(state.u8.slice(0, state.top), state.top, new Map(state.sizes), new Map([...state.free].map(([k, v]) => [k, [...v]])));
  copy.freeBlock(c);
  copy.freeBlock(a);
  assert.equal(copy.malloc(64), a);
  assert.equal(copy.malloc(64), b);
});

test("freeing many same-sized blocks then the top merges them all", () => {
  const mem = new NativeMemory();
  const blocks = Array.from({ length: 20000 }, () => mem.malloc(32));
  const top = mem.malloc(32);
  for (let i = blocks.length - 1; i >= 0; i--) mem.freeBlock(blocks[i]);
  mem.freeBlock(top);
  assert.equal(mem.malloc(32), blocks[0]);
  assert.equal(mem.malloc(32), blocks[1]);
});

test("reused free blocks keep the merge index consistent", () => {
  const mem = new NativeMemory();
  const [a, b, c, d] = [mem.malloc(32), mem.malloc(32), mem.malloc(32), mem.malloc(32)];
  mem.freeBlock(a);
  mem.freeBlock(b);
  mem.freeBlock(c);
  assert.equal(mem.malloc(32), a);
  mem.freeBlock(d);
  assert.equal(mem.malloc(32), b);
  mem.freeBlock(a);
  assert.equal(mem.malloc(32), a);
});
