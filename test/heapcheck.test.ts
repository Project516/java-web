import assert from "node:assert/strict";
import { test } from "node:test";
import { clearAllocationCheck, JArray, resetAllocationCheck, sched, setAllocationCheck, trackArrays } from "../src/runtime.ts";
import type { JClass } from "../src/runtime.ts";
import { PendingThrow } from "../src/thread.ts";

const cls = {} as JClass;
const MB = 1 << 20;
const alloc = (mb: number) => new JArray(cls, new Int8Array(mb * MB));
const oom = (f: () => void) => assert.throws(f, (e: unknown) => e instanceof PendingThrow && e.cls === "java/lang/OutOfMemoryError");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a lazy check pauses the scheduler when over, and throws only after waiting", async () => {
  let used = 0;
  setAllocationCheck(8 * MB, () => used, { lazy: true });
  resetAllocationCheck();
  try {
    used = 100 * MB;
    alloc(5);
    assert.equal(sched.pause, true);
    assert.equal(sched.yieldNow, true);
    alloc(1);
    alloc(1);
    await wait(170);
    oom(() => alloc(1));
    used = 0;
    alloc(1);
    alloc(5);
  } finally {
    clearAllocationCheck();
  }
});

test("a lazy check recovers when the memory was freed meanwhile", async () => {
  let used = 0;
  setAllocationCheck(8 * MB, () => used, { lazy: true });
  resetAllocationCheck();
  try {
    used = 100 * MB;
    alloc(5);
    await wait(170);
    used = 0;
    alloc(1);
    used = 100 * MB;
    alloc(1);
    alloc(1);
  } finally {
    clearAllocationCheck();
  }
});

test("tracked arrays count live bytes of the large ones only", () => {
  const live = trackArrays();
  setAllocationCheck(64 * MB, live, { lazy: true });
  resetAllocationCheck();
  try {
    const before = live();
    const keep = [alloc(1), alloc(2)];
    new JArray(cls, new Int8Array(100));
    assert.equal(live() - before, 3 * MB);
    assert.equal(keep.length, 2);
  } finally {
    clearAllocationCheck();
  }
});
