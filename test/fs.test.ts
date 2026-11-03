import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend, VFS } from "../src/fs.ts";

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

test("host path resolution leaves other mounts and memory paths lexical", () => {
  const fs = new VFS();
  const host = new MemoryBackend();
  let hostCalls = 0;
  Object.assign(host, { resolvePath: () => { hostCalls++; return "/target/file"; } });
  fs.mount("/", host);
  fs.mount("/jdk", new MemoryBackend());
  assert.equal(fs.resolvePath("/jdk/dir/../file"), "/jdk/file");
  assert.equal(hostCalls, 0);
  assert.equal(fs.resolvePath("/work/link/../file"), "/target/file");
  assert.equal(hostCalls, 1);

  const memory = new VFS();
  memory.mount("/files", new MemoryBackend());
  assert.equal(memory.resolvePath("/files/dir/../file"), "/files/file");
});
