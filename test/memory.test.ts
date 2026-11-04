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
