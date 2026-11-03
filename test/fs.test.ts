import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend } from "../src/fs.ts";

test("renaming a file onto a directory leaves both intact", () => {
  const fs = new MemoryBackend();
  fs.mkdir("/dir");
  fs.write("/file", new Uint8Array([1]));
  fs.write("/dir/child", new Uint8Array([2]));

  assert.equal(fs.rename("/file", "/dir"), false);
  assert.deepEqual(fs.read("/file"), new Uint8Array([1]));
  assert.equal(fs.stat("/dir")?.dir, true);
  assert.deepEqual(fs.list("/dir"), ["child"]);

  fs.write("/other", new Uint8Array([3]));
  assert.equal(fs.rename("/file", "/other"), true);
  assert.deepEqual(fs.read("/other"), new Uint8Array([1]));
});
