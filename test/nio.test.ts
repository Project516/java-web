import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBackend, VFS } from "../src/fs.ts";
import type { Backend } from "../src/fs.ts";
import { natives } from "../src/natives/nio.ts";
import { PendingThrow } from "../src/thread.ts";
import type { JThread } from "../src/thread.ts";
import { NodeBackend } from "../src/node.ts";

function thread(backend: Backend): JThread {
  const fs = new VFS();
  fs.mount("/", backend);
  return { vm: {
    fs, opts: {}, mem: { u8: new TextEncoder().encode("/file\0") },
    state: new Map([["fds", { files: new Map([[3, { path: "/file" }]]) }]]),
  } } as unknown as JThread;
}

function chmod(t: JThread, descriptor: boolean) {
  return descriptor
    ? natives["sun/nio/fs/UnixNativeDispatcher.fchmod0(II)V"](t, [3, 0o600])
    : natives["sun/nio/fs/UnixNativeDispatcher.chmod0(JI)V"](t, [0n, 0o600]);
}

function memory(): MemoryBackend {
  const backend = new MemoryBackend();
  backend.put("/file", new Uint8Array([1]));
  return backend;
}

test("NIO chmod preserves the no-op for virtual backends without permission bits", () => {
  const t = thread(memory());
  assert.doesNotThrow(() => chmod(t, false));
  assert.doesNotThrow(() => chmod(t, true));
});

test("NIO chmod preserves host errno on writable backends", () => {
  for (const [code, errno] of [["EPERM", 1], ["EACCES", 13], ["ELOOP", 40]] as const) {
    const backend = Object.assign(memory(), { chmod: () => false, chmodError: () => code });
    for (const descriptor of [false, true]) {
      assert.throws(() => chmod(thread(backend), descriptor), (e) => {
        assert.ok(e instanceof PendingThrow);
        assert.equal(e.cls, "sun/nio/fs/UnixException");
        assert.deepEqual(e.ctor?.args, [errno]);
        return true;
      });
    }
  }
});

test("NIO chmod reports a read-only backend as EROFS", () => {
  const backend = Object.assign(memory(), { writable: false, chmod: () => true });
  assert.throws(() => chmod(thread(backend), false), (e) => {
    assert.ok(e instanceof PendingThrow);
    assert.deepEqual(e.ctor?.args, [30]);
    return true;
  });
});

test("NodeBackend retains the errno from a failed chmod", () => {
  const dir = mkdtempSync(join(tmpdir(), "java-web-chmod-"));
  try {
    writeFileSync(join(dir, "file"), "data");
    const backend = new NodeBackend(dir, true);
    assert.equal(backend.chmod("/file/child", (mode) => mode), false);
    assert.equal(backend.chmodError("/file/child"), "ENOTDIR");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
