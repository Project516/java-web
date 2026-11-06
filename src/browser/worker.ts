// Web Worker that hosts the JVM. Each run gets a fresh VM sharing the
// file system: /str lasts for the page, /files is also kept in IndexedDB.
// A library VM stays up and serves calls until the page goes away.

import { MemoryBackend, VFS } from "../fs.ts";
import { JVM, SnapshotError } from "../jvm.ts";
import { MAX_HEAP, resetAllocationCheck, setAllocationCheck, setMaxHeap, trackArrays } from "../runtime.ts";
import { HttpBackend, parsePack } from "./http.ts";
import { dropSnapshot, dropWarmSnapshot, loadSnapshot, loadWarmSnapshot, persist, saveSnapshot, saveWarmSnapshot } from "./idb.ts";
import type { SnapshotImage, WarmSnapshotImage } from "../snapshot.ts";
import type { LibraryError, LibraryReply } from "../library.ts";
import type { NativeReply } from "../bridge.ts";
import type { FromWorker, InitMessage, ToWorker } from "./protocol.ts";

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as any).postMessage(m, transfer);

let vfs: VFS | null = null;
let config: InitMessage | null = null;
const strFiles = new MemoryBackend();
const userFiles = new MemoryBackend();
const stdin: (Uint8Array | null)[] = [];
let stdinWaiter: ((d: Uint8Array | null) => void) | null = null;
let running = Promise.resolve();
const pendingNatives = new Map<number, { resolve: (v: NativeReply) => void; reject: (e: Error) => void }>();
const pendingLibraries = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
let nextNative = 1;
// VMs the page can send library requests to: running ones and library ones
const vms = new Map<number, JVM>();

function reply(id: number, p: Promise<LibraryReply>) {
  p.then((r) => post({ type: "reply", id, value: r.value, back: r.back }))
    .catch((err: LibraryError) => post({ type: "reply", id, error: String(err?.message ?? err), throwable: err?.throwable }));
}

// Page natives run on the main thread; arguments and results are copies.
function pageNative(vm: number, name: string) {
  return (args: unknown[]) => new Promise<NativeReply>((resolve, reject) => {
    const id = nextNative++;
    pendingNatives.set(id, { resolve, reject });
    post({ type: "native", id, vm, name, args });
  });
}

// Reads a response, reporting progress to the page. The length of a
// compressed body is the compressed size, so the count stops at it. With no
// length, total is 0 until the last report.
async function readBody(res: Response, report: boolean): Promise<ArrayBuffer> {
  if (!report || !res.body) return res.arrayBuffer();
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    done += r.value.length;
    post({ type: "progress", done: total ? Math.min(done, total) : done, total });
  }
  post({ type: "progress", done: total || done, total: total || done });
  const all = new Uint8Array(done);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all.buffer;
}

async function init(m: InitMessage) {
  config = m;
  if (m.maxHeap) {
    setMaxHeap(m.maxHeap);
    if (typeof FinalizationRegistry !== "undefined") setAllocationCheck(MAX_HEAP, trackArrays(), { lazy: true });
  }
  const res = await fetch(new URL("boot.pack", m.runtime));
  if (!res.ok) throw new Error(`cannot load ${res.url}: ${res.status}`);
  const [pack] = await Promise.all([readBody(res, m.progress).then(parsePack), persist(userFiles)]);
  userFiles.putDir("/downloads");
  userFiles.putDir("/uploads");
  vfs = new VFS();
  vfs.mount("/", new MemoryBackend());
  vfs.mount("/jdk", new HttpBackend(new URL("jdk/", m.runtime).href, pack));
  vfs.mount("/app", new HttpBackend(m.app));
  vfs.mount("/files", userFiles);
  vfs.mount("/str", strFiles);
  vfs.mount("/tmp", new MemoryBackend());
  post({ type: "ready" });
}

function readStdin(): Promise<Uint8Array | null> {
  if (stdin.length > 0) return Promise.resolve(stdin.shift()!);
  return new Promise((r) => (stdinWaiter = r));
}

function loadNativeLibrary(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = nextNative++;
    pendingLibraries.set(id, { resolve, reject });
    const bytes = path.startsWith("/app/") ? undefined : vfs!.read(path)?.slice();
    if (!path.startsWith("/app/") && !bytes) return reject(new Error("cannot read the file"));
    post({ type: "loadLibrary", id, path, bytes });
  });
}

const DOWNLOADS = "/files/downloads/";

function fileClosed(path: string) {
  if (!path.startsWith(DOWNLOADS)) return;
  const data = vfs!.read(path);
  if (data) post({ type: "download", name: path.slice(path.lastIndexOf("/") + 1), data: data.slice() });
}

// set by the build: the VM code and JDK image a snapshot is valid for
declare const JAVA_WEB_BUILD: string;

// Boot snapshots of this page's VMs, the most recently used last, also kept
// in IndexedDB for later loads. A VM changes the image it restores, so each
// gets a copy.
const snapshots = new Map<string, SnapshotImage>();
const warmSnapshots = new Map<string, WarmSnapshotImage>();
const droppedWarmSnapshots = new Set<string>();
const keep = (image: SnapshotImage) => {
  snapshots.delete(image.key);
  snapshots.set(image.key, image);
  for (const k of [...snapshots.keys()].slice(0, -4)) snapshots.delete(k);
};
// the IndexedDB delete is async, so a retry could still read a dropped one
const dropped = new Set<string>();
const snapshotCache = {
  build: JAVA_WEB_BUILD,
  load: async (key: string) => {
    if (dropped.has(key)) return null;
    const image = snapshots.get(key) ?? await loadSnapshot(key);
    if (!image) return null;
    keep(image);
    return structuredClone(image);
  },
  wants: () => true,
  save: (image: SnapshotImage) => {
    dropped.delete(image.key);
    const copy = structuredClone(image);
    keep(copy);
    saveSnapshot(copy);
  },
  drop: (key: string) => {
    snapshots.delete(key);
    dropped.add(key);
    dropSnapshot(key);
  },
};

const warmSnapshotCache = {
  load: async (key: string) => {
    if (droppedWarmSnapshots.has(key)) return null;
    const image = warmSnapshots.get(key) ?? await loadWarmSnapshot(key);
    if (!image) return null;
    warmSnapshots.delete(key);
    warmSnapshots.set(key, image);
    return structuredClone(image);
  },
  save: (image: WarmSnapshotImage) => {
    droppedWarmSnapshots.delete(image.warmKey);
    warmSnapshots.delete(image.warmKey);
    warmSnapshots.set(image.warmKey, structuredClone(image));
    for (const k of [...warmSnapshots.keys()].slice(0, -2)) warmSnapshots.delete(k);
    saveWarmSnapshot(image);
  },
  drop: (key: string) => {
    warmSnapshots.delete(key);
    droppedWarmSnapshots.add(key);
    dropWarmSnapshot(key);
  },
};

// A snapshot that cannot be restored is dropped, and a second VM boots.
function retried<T>(start: () => Promise<T>): Promise<T> {
  return start().catch((e) => {
    if (!(e instanceof SnapshotError)) throw e;
    console.warn(`java-web: ${e.message}`);
    return start();
  });
}

function newVm(classpath: string[], vmId: number, library = false): JVM {
  return new JVM({
    snapshots: snapshotCache,
    ...(library && config!.warmSnapshot ? { warmSnapshot: true, warmSnapshots: warmSnapshotCache } : {}),
    fs: vfs!,
    javaHome: "/jdk",
    classpath,
    // javaProperties can set user.dir, which is then the working directory
    cwd: config!.props["user.dir"] ?? "/files",
    // System.loadLibrary would warn about native access, but its libraries are the page's JS modules
    localeData: config!.localeData,
    props: { "java.io.tmpdir": "/tmp", "user.home": "/files", "jdk.module.enable.native.access.0": "ALL-UNNAMED", ...config!.props },
    stdout: (data) => post({ type: "out", fd: 1, data }, [data.buffer as ArrayBuffer]),
    stderr: (data) => post({ type: "out", fd: 2, data }, [data.buffer as ArrayBuffer]),
    stdin: readStdin,
    hostName: config!.hostName,
    debug: config!.debug,
    afterBoot: resetAllocationCheck,
    env: config!.env,
    loadNativeLibrary,
    fileClosed,
    fetch: (input, init) => fetch(input, init),
    hostNatives: ([short, long]) => {
      const names = config!.natives;
      if (names.includes(long)) return pageNative(vmId, long);
      if (names.includes(short)) return pageNative(vmId, short);
      return null;
    },
  });
}

function run(id: number, mode: number, what: string, classpath: string[], args: string[]) {
  return retried(() => {
    const vm = newVm(classpath, id);
    vms.set(id, vm);
    return vm.run(mode, what, args);
  }).then((code) => {
    vms.delete(id);
    post({ type: "exit", id, code });
  });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "init":
      init(m).catch((err) => post({ type: "error", message: String(err?.message ?? err) }));
      break;
    case "run":
      running = running.then(() => run(m.id, m.mode, m.what, m.classpath, m.args))
        .catch((err) => post({ type: "error", message: String(err?.message ?? err) }));
      break;
    case "file":
      (m.path.startsWith("/files/") ? userFiles : strFiles).put(m.path.replace(/^\/(files|str)/, ""), m.data);
      break;
    case "removeFile":
      (m.path.startsWith("/files/") ? userFiles : strFiles).remove(m.path.replace(/^\/(files|str)/, ""));
      break;
    case "libraryLoaded": {
      const p = pendingLibraries.get(m.id);
      pendingLibraries.delete(m.id);
      if (m.error !== undefined) p?.reject(new Error(m.error));
      else {
        for (const n of m.names ?? []) if (!config!.natives.includes(n)) config!.natives.push(n);
        p?.resolve();
      }
      break;
    }
    case "nativeResult": {
      const p = pendingNatives.get(m.id);
      pendingNatives.delete(m.id);
      if (m.error !== undefined) p?.reject(new Error(m.error));
      else p?.resolve({ value: m.value, back: m.back });
      break;
    }
    case "library": {
      reply(m.id, retried(() => {
        const vm = newVm(m.classpath, m.lib, true);
        vms.set(m.lib, vm);
        return vm.startLibrary();
      }).then(() => ({ value: undefined })));
      break;
    }
    case "call": {
      const vm = vms.get(m.lib);
      reply(m.id, vm ? vm.library.request(m.req) : Promise.reject(new Error("that VM has exited")));
      break;
    }
    case "release":
      vms.get(m.lib)?.library.release(m.ids);
      break;
    case "readFile": {
      const data = vfs?.read(m.path);
      reply(m.id, data ? Promise.resolve({ value: data.slice() }) : Promise.reject(new Error(`cannot read ${m.path}`)));
      break;
    }
    case "stdin":
      if (stdinWaiter) {
        const w = stdinWaiter;
        stdinWaiter = null;
        w(m.data);
      } else stdin.push(m.data);
      break;
  }
};
