import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBackend, VFS } from "../src/fs.ts";
import type { Backend } from "../src/fs.ts";
import { natives } from "../src/natives/nio.ts";
import { PendingThrow } from "../src/thread.ts";
import type { JThread } from "../src/thread.ts";
import { NodeBackend } from "../src/node.ts";
import { NativeMemory } from "../src/memory.ts";
import { OpenFile } from "../src/natives/io.ts";

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

test("a sparse host file streams before allocating its gap", async () => {
  const { openFile, fileOf, closeFd } = await import("../src/natives/io.ts");
  const dir = mkdtempSync(join(tmpdir(), "java-web-sparse-"));
  const fs = new VFS();
  let largestWrite = 0;
  const backend = new NodeBackend(dir, true);
  const open = backend.openFile.bind(backend);
  backend.openFile = (...args) => {
    const handle = open(...args);
    const write = handle.write;
    handle.write = (src, pos) => { largestWrite = Math.max(largestWrite, src.length); write(src, pos); };
    return handle;
  };
  fs.mount("/", backend);
  const t = { vm: { fs, opts: {}, state: new Map(), exited: new Promise(() => {}) } } as unknown as JThread;
  try {
    const fd = openFile(t, "/file", true, false, false);
    const f = fileOf(t, fd);
    f.pos = 16 << 20;
    f.write(new Uint8Array([42]));
    assert.equal(f.data.length, 0);
    assert.ok(largestWrite < 1024, `host write was ${largestWrite} bytes`);
    assert.equal(f.size, (16 << 20) + 1);
    closeFd(t, fd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("a large file on a read-only host mount uses a handle", async () => {
  const { openFile, fileOf, closeFd } = await import("../src/natives/io.ts");
  const dir = mkdtempSync(join(tmpdir(), "java-web-readonly-"));
  const fs = new VFS();
  writeFileSync(join(dir, "file"), new Uint8Array([42]));
  truncateSync(join(dir, "file"), 6 << 20);
  fs.mount("/", new NodeBackend(dir));
  const t = { vm: { fs, opts: {}, state: new Map(), exited: new Promise(() => {}) } } as unknown as JThread;
  try {
    const fd = openFile(t, "/file", false, false, false);
    const f = fileOf(t, fd);
    assert.equal(f.data.length, 0);
    const byte = new Uint8Array(1);
    assert.equal(f.read(byte, 0, 1), 1);
    assert.equal(byte[0], 42);
    closeFd(t, fd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an open host file keeps its inode when its path is deleted and recreated", async () => {
  const { openFile, fileOf, closeFd, removePath } = await import("../src/natives/io.ts");
  const dir = mkdtempSync(join(tmpdir(), "java-web-pin-"));
  const fs = new VFS();
  fs.mount("/", new NodeBackend(dir, true));
  const t = { vm: { fs, opts: {}, state: new Map(), exited: new Promise(() => {}) } } as unknown as JThread;
  try {
    writeFileSync(join(dir, "file"), "old");
    const fd = openFile(t, "/file", true, false, false);
    const f = fileOf(t, fd);
    let replacement = -1;
    try {
      assert.ok(f.contents.pin);
      const original = fs.stat("/file")!.ino;
      assert.equal(removePath(t, "/file"), true);
      replacement = openFile(t, "/file", true, false, false);
      assert.notEqual(fs.stat("/file")!.ino, original);
      assert.equal(f.ino, original);
    } finally {
      if (replacement >= 0) closeFd(t, replacement);
      closeFd(t, fd);
    }
    assert.equal(f.contents.pin, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a host file for writing does not create a missing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "java-web-nocreate-"));
  try {
    assert.throws(() => new NodeBackend(dir, true).openFile("/missing", true, false, false), { code: "ENOENT" });
    assert.equal(existsSync(join(dir, "missing")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a path that reaches a different inode does not share the open file's contents", async () => {
  const { openFile, fileOf, closeFd } = await import("../src/natives/io.ts");
  const dir = mkdtempSync(join(tmpdir(), "java-web-share-"));
  const fs = new VFS();
  fs.mount("/", new NodeBackend(dir, true));
  const t = { vm: { fs, opts: {}, state: new Map(), exited: new Promise(() => {}) } } as unknown as JThread;
  try {
    writeFileSync(join(dir, "target"), "old");
    symlinkSync("target", join(dir, "link"));
    const first = openFile(t, "/link", false, false, false);
    renameSync(join(dir, "target"), join(dir, "moved"));
    writeFileSync(join(dir, "target"), "new");
    const second = openFile(t, "/link", false, false, false);
    const bytes = new Uint8Array(3);
    assert.equal(fileOf(t, second).read(bytes, 0, 3), 3);
    assert.equal(new TextDecoder().decode(bytes), "new");
    assert.equal(readFileSync(join(dir, "moved"), "utf8"), "old");
    closeFd(t, second);
    closeFd(t, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("map0 of a region that does not fit throws OutOfMemoryError for FileChannelImpl to wrap", () => {
  const backend = memory();
  const t = thread(backend);
  const vm = t.vm as any;
  vm.mem = new NativeMemory();
  vm.state.set("fds", { files: new Map([[3, new OpenFile("/file", new Uint8Array(1), false)]]) });
  vm.getField = () => 3;
  assert.throws(() => natives["sun/nio/ch/UnixFileDispatcherImpl.map0(Ljava/io/FileDescriptor;IJJZ)J"](t, [{}, 0, 0n, 600n << 20n]), (e) => {
    assert.ok(e instanceof PendingThrow);
    assert.equal(e.cls, "java/lang/OutOfMemoryError");
    assert.equal(e.msg, "Map failed");
    return true;
  });
});
