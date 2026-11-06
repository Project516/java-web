// java.io natives over the VFS: file descriptors, streams, RandomAccessFile
// and UnixFileSystem.

import { JArray, JObject } from "../runtime.ts";
import { JThread, PendingThrow } from "../thread.ts";
import type { NativeGen } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import type { FileHandle, Stat, VFS } from "../fs.ts";
import { closeSockFd, socksOf } from "../sockets.ts";
import { nonNull, u8 } from "./util.ts";
import type { Natives } from "./util.ts";

export interface ProcessPipe {
  read(dst: Uint8Array, off: number, len: number): Promise<number>;
  write(bytes: Uint8Array): Promise<string | null>;
  available(): number;
  close(): void;
}

function pipes(t: JThread): Map<number, ProcessPipe> {
  let map = t.vm.state.get("processPipes") as Map<number, ProcessPipe> | undefined;
  if (!map) t.vm.state.set("processPipes", (map = new Map()));
  return map;
}

export function addProcessPipe(t: JThread, pipe: ProcessPipe): number {
  const fd = newFd(t);
  pipes(t).set(fd, pipe);
  return fd;
}

export function processPipe(t: JThread, fd: number): ProcessPipe | undefined {
  return (t.vm.state.get("processPipes") as Map<number, ProcessPipe> | undefined)?.get(fd);
}

// A file's bytes, shared by every descriptor open on it, as an inode is.
// Small files live in data; past STREAM_MIN the file is read and written on
// the host through one handle instead, so its size does not cost memory.
// size is kept here in both cases: changes made outside the VM are not seen.
interface Contents {
  data: Uint8Array;
  size: number;
  dirty: boolean;
  refs: number;
  host?: FileHandle;
  hostWritable?: boolean;
  hostReadable?: boolean;
}

// Opens a file's host handle when it outgrows memory. Kept apart from the
// contents, which a boot snapshot saves.
const hostOpeners = new WeakMap<Contents, (path: string) => FileHandle | undefined>();
const closesHosts = new WeakSet<JVM>();

// A snapshot cannot hold a host handle, nor the opener a file may still need.
export function streams(f: OpenFile): boolean {
  return f instanceof DirectoryFile || !!f.contents.host || hostOpeners.has(f.contents);
}

// Host handles of files the program leaves open close when its VM exits.
function closeHostsOnExit(vm: JVM) {
  if (closesHosts.has(vm)) return;
  closesHosts.add(vm);
  vm.exited.then(() => {
    const tab = vm.state.get("fds") as FdTable | undefined;
    for (const f of tab?.files.values() ?? []) {
      f.contents.host?.close();
      f.contents.host = undefined;
    }
  });
}

// Bigger files stream to the host where the backend can: small ones stay in
// memory, where many small reads and writes cost no system call each.
const STREAM_MIN = 4 << 20;

function hostCall<T>(call: () => T): T {
  try { return call(); }
  catch (e) {
    if (e instanceof PendingThrow) throw e;
    const code = (e as { code?: string }).code ?? "EIO";
    throw new PendingThrow("java/io/IOException", ERRNO[code] ?? "Input/output error");
  }
}

export class OpenFile {
  // "" once the file is unlinked: it lives until closed, but no path reaches it
  path: string;
  pos = 0;
  append = false;
  writable: boolean;
  contents: Contents;
  ino?: number;
  detached?: { path: string; stat: Stat; writable: boolean };
  constructor(path: string, data: Uint8Array, writable: boolean, contents?: Contents) {
    this.path = path;
    this.contents = contents ?? { data, size: data.length, dirty: false, refs: 0 };
    this.contents.refs++;
    this.writable = writable;
  }

  get data() { return this.contents.data; }
  set data(d: Uint8Array) { this.contents.data = d; }
  get size() { return this.contents.size; }
  set size(n: number) { this.contents.size = n; }
  get dirty() { return this.contents.dirty; }
  set dirty(d: boolean) { this.contents.dirty = d; }

  read(dst: Uint8Array, off: number, len: number): number {
    if (this.pos >= this.size) return -1;
    const n = Math.min(len, this.size - this.pos);
    const host = this.contents.host;
    if (host && n) {
      const got = hostCall(() => host.read(dst, off, n, this.pos));
      this.pos += got;
      return got || -1;
    }
    dst.set(this.data.subarray(this.pos, this.pos + n), off);
    this.pos += n;
    return n;
  }

  write(src: Uint8Array, atPosition = false) {
    if (this.append && !atPosition) this.pos = this.size;
    const host = this.contents.host;
    if (host) {
      hostCall(() => host.write(src, this.pos));
      this.pos += src.length;
      if (this.pos > this.size) this.size = this.pos;
      return;
    }
    const end = this.pos + src.length;
    if (end >= STREAM_MIN && this.stream()) return this.write(src, atPosition);
    // past the end, the gap reads as zeros (the buffer may hold bytes from before a truncation)
    if (this.pos > this.size) this.data.fill(0, this.size, Math.min(this.pos, this.data.length));
    if (end > this.data.length) {
      const next = new Uint8Array(Math.max(end, this.data.length * 2, 64));
      next.set(this.data.subarray(0, this.size));
      this.data = next;
    }
    this.data.set(src, this.pos);
    this.pos = end;
    if (end > this.size) this.size = end;
    this.dirty = true;
  }

  setLength(n: number) {
    const host = this.contents.host;
    if (host) {
      hostCall(() => host.truncate(n));
      this.size = n;
      if (this.pos > n) this.pos = n;
      return;
    }
    if (n >= STREAM_MIN && this.stream()) return this.setLength(n);
    if (n > this.data.length) {
      const next = new Uint8Array(n);
      next.set(this.data.subarray(0, this.size));
      this.data = next;
    } else if (n > this.size) this.data.fill(0, this.size, n);
    this.size = n;
    if (this.pos > n) this.pos = n;
    this.dirty = true;
  }

  // Moves the bytes to the host file; on failure they stay in memory and the
  // flush that writes them out reports the error.
  private stream(): boolean {
    const c = this.contents;
    const open = hostOpeners.get(c);
    if (!open || !this.path) return false;
    let host: FileHandle | undefined;
    try {
      host = open(this.path);
      if (!host) throw new Error("no host file");
      host.write(c.data.subarray(0, c.size), 0);
      host.truncate(c.size);
    } catch {
      host?.close();
      hostOpeners.delete(c);
      return false;
    }
    c.host = host;
    c.hostWritable = true;
    c.data = new Uint8Array(0);
    c.dirty = false;
    return true;
  }

  // a mapping keeps the file open after its descriptor closes
  retain() { this.contents.refs++; }
  release() {
    if (--this.contents.refs === 0 && this.contents.host) {
      this.contents.host.close();
      this.contents.host = undefined;
    }
  }
  close() { this.release(); }
}

// A read-only directory descriptor can be opened, but cannot be read as bytes.
class DirectoryFile extends OpenFile {
  constructor(path: string, size: number) {
    super(path, new Uint8Array(0), false);
    this.size = size;
  }

  override read(): number {
    throw new PendingThrow("java/io/IOException", "Is a directory");
  }

  override write(): void {
    throw new PendingThrow("java/io/IOException", "Is a directory");
  }

  override setLength(): void {
    throw new PendingThrow("java/io/IOException", "Is a directory");
  }
}

// Reads and writes a character device as a stream.
class DeviceFile extends OpenFile {
  constructor(path: string) {
    super(path, new Uint8Array(0), true);
  }

  override read(dst: Uint8Array, off: number, len: number): number {
    if (this.path === "/dev/null") return -1;
    const out = dst.subarray(off, off + len);
    if (this.path === "/dev/zero") out.fill(0);
    else for (let i = 0; i < out.length; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536) as Uint8Array<ArrayBuffer>);
    return out.length;
  }

  override write(_src: Uint8Array) {}

  override setLength(_n: number) {}
}

// A large read-only file read in parts on demand, e.g. a jar over HTTP.
class LazyFile extends OpenFile {
  private readonly vfs: VFS;
  constructor(path: string, size: number, vfs: VFS) {
    super(path, new Uint8Array(0), false);
    this.size = size;
    this.vfs = vfs;
  }

  override read(dst: Uint8Array, off: number, len: number): number {
    if (this.pos >= this.size) return -1;
    const n = Math.min(len, this.size - this.pos);
    const data = this.vfs.readRange(this.path, this.pos, n);
    if (!data || data.length < n) throw new PendingThrow("java/io/IOException", `cannot read ${this.path}`);
    dst.set(data.subarray(0, n), off);
    this.pos += n;
    return n;
  }
}

export function reopenSnapshotFile(path: string, size: number, pos: number, vfs: VFS): OpenFile {
  const file = vfs.canReadRange(path) ? new LazyFile(path, size, vfs) : new OpenFile(path, vfs.read(path) ?? new Uint8Array(), false);
  file.pos = pos;
  return file;
}

// Read-only files at least this big are read in parts where the backend can.
const LAZY_MIN = 256 << 10;

interface FdTable {
  next: number;
  files: Map<number, OpenFile>;
}

function table(t: JThread): FdTable {
  let tab = t.vm.state.get("fds") as FdTable | undefined;
  if (!tab) t.vm.state.set("fds", (tab = { next: 3, files: new Map() }));
  return tab;
}

export function fileInode(t: JThread, path: string, st: Stat | null = t.vm.fs.stat(path)): number {
  if (st?.ino !== undefined) return st.ino;
  let inodes = t.vm.state.get("inodes") as Map<string, number> | undefined;
  if (!inodes) t.vm.state.set("inodes", (inodes = new Map()));
  const ino = inodes.get(path);
  if (ino === undefined) {
    const next = (t.vm.state.get("inodeNext") as number | undefined) ?? 2;
    inodes.set(path, next);
    t.vm.state.set("inodeNext", next + 1);
    return next;
  }
  return ino;
}

// rmdir fails on a path ending in "." or "..": "." stays the working directory
export function endsInDot(p: string): boolean {
  const last = p.replace(/\/+$/, "").split("/").pop();
  return last === "." || last === "..";
}

export function resolvePath(t: JThread, p: string): string {
  return t.vm.fs.resolvePath(p.startsWith("/") ? p : `${t.vm.opts.cwd ?? "/"}/${p}`);
}

function notFound(path: string, why = "No such file or directory"): never {
  throw new PendingThrow("java/io/FileNotFoundException", `${path} (${why})`);
}

// Opens a path and returns its descriptor number.
export function openFile(t: JThread, path: string, write: boolean, truncate: boolean, append: boolean, readable = true, allowDirectory = false): number {
  const fs = t.vm.fs;
  const abs = resolvePath(t, path);
  syncPath(t, abs);
  const st = fs.stat(abs);
  if (st?.dir) {
    if (!allowDirectory || write) notFound(path, "Is a directory");
    const tab = table(t);
    tab.files.set(tab.next, new DirectoryFile(abs, st.size));
    return tab.next++;
  }
  const shared = st ? [...table(t).files.values()].find((o) => o.path === abs && o.constructor === OpenFile)?.contents : undefined;
  if (st?.device || (st && !shared && !write && st.size >= LAZY_MIN && fs.canReadRange(abs))) {
    const tab = table(t);
    tab.files.set(tab.next, st.device ? new DeviceFile(abs) : new LazyFile(abs, st.size, fs));
    return tab.next++;
  }
  if (write && fs.denied(abs)) notFound(path, "Permission denied");
  // a file too big to hold, or one that may be written but not read, goes through a host handle
  if (st && !shared && !truncate && (st.size >= STREAM_MIN || (write && !fs.access(abs, 4))) && fs.canOpenFile(abs, write)) {
    const host = openHost(fs, abs, write, readable);
    if (host) {
      closeHostsOnExit(t.vm);
      const f = new OpenFile(abs, new Uint8Array(0), write, { data: new Uint8Array(0), size: host.size(), dirty: false, refs: 0, host, hostWritable: write, hostReadable: readable });
      if (append) { f.pos = f.size; f.append = true; }
      const tab = table(t);
      tab.files.set(tab.next, f);
      return tab.next++;
    }
  }
  let data: Uint8Array;
  if (!st) {
    if (!write) notFound(path);
    if (!fs.write(abs, new Uint8Array(0))) {
      notFound(path, ERRNO[fs.writeError(abs) ?? ""] ?? (fs.writable(abs) ? "No such file or directory" : "Read-only file system"));
    }
    data = new Uint8Array(0);
  } else {
    if (write && !fs.writable(abs)) notFound(path, "Read-only file system");
    if (shared) data = shared.data;
    else if (truncate) data = new Uint8Array(0);
    else data = fs.read(abs) ?? notFound(path, "Operation not supported");
  }
  // a descriptor joining a host handle that lacks its access reopens it with both
  if (shared?.host && ((write && !shared.hostWritable) || (readable && !shared.hostReadable))) {
    const w = write || !!shared.hostWritable, r = readable || !!shared.hostReadable;
    const host = openHost(fs, abs, w, r) ?? notFound(path, "Permission denied");
    shared.host.close();
    Object.assign(shared, { host, hostWritable: w, hostReadable: r });
  }
  const f = new OpenFile(abs, data, write, shared);
  // only a writer can grow a file, so read-only files never hold an opener
  if (write && !hostOpeners.has(f.contents) && fs.canOpenFile(abs, true)) {
    const vm = t.vm;
    const c = f.contents;
    hostOpeners.set(c, (current) => {
      closeHostsOnExit(vm);
      // descriptors already sharing the contents may read through the handle
      const host = openHost(fs, current, write, true);
      c.hostReadable = !!host;
      return host ?? openHost(fs, current, write, false);
    });
  }
  if (truncate && st) f.setLength(0);
  if (append) { f.pos = f.size; f.append = true; }
  const tab = table(t);
  const fd = tab.next++;
  tab.files.set(fd, f);
  return fd;
}

function openHost(fs: VFS, abs: string, write: boolean, readable: boolean): FileHandle | undefined {
  try { return fs.openFile(abs, write, false, readable); }
  catch { return undefined; }
}

// Writes reach the file system when a file is closed. Another open or a stat
// of the same path sees them at once on a real OS, so write them out first.
export function syncPath(t: JThread, abs: string) {
  for (const f of table(t).files.values()) if (f.path === abs) flush(t, f);
}

// Pending writes go out first, so closing the file later does not change the time again.
export function setMtime(t: JThread, abs: string, ms: number, ns?: bigint, noFollow = false): boolean {
  syncPath(t, abs);
  return t.vm.fs.setMtime(abs, ms, ns, noFollow);
}

// write(2) on a descriptor opened read-only fails with EBADF.
function writableFile(t: JThread, fd: number): OpenFile {
  const f = fileOf(t, fd);
  if (!f.writable) throw new PendingThrow("java/io/IOException", "Bad file descriptor");
  return f;
}

export function fileOf(t: JThread, fd: number): OpenFile {
  const f = table(t).files.get(fd);
  if (!f) throw new PendingThrow("java/io/IOException", "Stream Closed");
  return f;
}

// Writes the file's buffered bytes; false if the host refused them.
export function flush(t: JThread, f: OpenFile): boolean {
  if (f.dirty && f.writable && f.path) {
    const data = f.data.slice(0, f.size);
    let ok = t.vm.fs.write(f.path, data);
    // an open file keeps its write access when the file's mode changes, as an fd does
    let mode = 0;
    if (!ok && t.vm.fs.chmod(f.path, (m) => (mode = m) | 0o200)) {
      ok = t.vm.fs.write(f.path, data);
      t.vm.fs.chmod(f.path, () => mode);
    }
    if (ok) f.dirty = false;
    return ok;
  }
  return true;
}

const ERRNO: Record<string, string> = {
  ENOSPC: "No space left on device", EFBIG: "File too large", EDQUOT: "Disk quota exceeded",
  EACCES: "Permission denied", EPERM: "Operation not permitted", EROFS: "Read-only file system",
  ENOENT: "No such file or directory", ENAMETOOLONG: "File name too long", ENOTDIR: "Not a directory",
  EIO: "Input/output error", ELOOP: "Too many levels of symbolic links", EOPNOTSUPP: "Operation not supported",
};

// Where Java learns of a write that failed: HotSpot reports it from write(),
// java-web, which buffers, from the flush, sync or close that writes it out.
export function flushOrThrow(t: JThread, f: OpenFile) {
  if (!flush(t, f)) throw writeFailed(t, f.path);
}

export function writeFailed(t: JThread, path: string): PendingThrow {
  return new PendingThrow("java/io/IOException", ERRNO[t.vm.fs.writeError(path) ?? ""] ?? "Input/output error");
}

// Descriptors the program holds, with the three standard streams.
export function openFdCount(vm: JVM): number {
  const files = (vm.state.get("fds") as FdTable | undefined)?.files.size ?? 0;
  const pipeCount = (vm.state.get("processPipes") as Map<number, unknown> | undefined)?.size ?? 0;
  return 3 + files + pipeCount + socksOf(vm.state).size;
}

export function newFd(t: JThread): number {
  return table(t).next++;
}

export function closeFd(t: JThread, fd: number) {
  if (closeSockFd(t.vm.state, t.vm.net, fd)) return;
  const pipe = processPipe(t, fd);
  if (pipe) {
    pipes(t).delete(fd);
    pipe.close();
    return;
  }
  const tab = table(t);
  const f = tab.files.get(fd);
  if (f) {
    const ok = flush(t, f);
    tab.files.delete(fd);
    f.close();
    if (f.writable && f.path) t.vm.opts.fileClosed?.(f.path);
    // the descriptor is closed either way, as with close(2)
    if (!ok) throw writeFailed(t, f.path);
  }
}

// Open files follow their inode: a rename moves their path, an unlink drops it.
export function renamePath(t: JThread, from: string, to: string): boolean {
  const files = [...table(t).files.values()];
  const under = (f: OpenFile, p: string) => f.path === p || f.path.startsWith(p + "/");
  const open = files.filter((f) => under(f, from));
  const replaced = files.filter((f) => !open.includes(f) && under(f, to));
  for (const f of replaced) detachFile(t, f);
  for (const f of open) flush(t, f);
  if (!t.vm.fs.rename(from, to)) {
    for (const f of replaced) f.detached = undefined;
    return false;
  }
  // a file the rename replaced stays open, unlinked
  for (const f of replaced) f.path = "";
  for (const f of open) f.path = to + f.path.slice(from.length);
  const inodes = t.vm.state.get("inodes") as Map<string, number> | undefined;
  if (inodes) {
    const moved = [...inodes].filter(([p]) => p === from || p.startsWith(from + "/"));
    for (const p of inodes.keys()) if (p === to || p.startsWith(to + "/")) inodes.delete(p);
    for (const [p] of moved) inodes.delete(p);
    for (const [p, ino] of moved) inodes.set(to + p.slice(from.length), ino);
  }
  return true;
}

export function removePath(t: JThread, abs: string): boolean {
  const open = [...table(t).files.values()].filter((f) => f.path === abs);
  for (const f of open) detachFile(t, f);
  if (!t.vm.fs.remove(abs)) {
    for (const f of open) f.detached = undefined;
    return false;
  }
  for (const f of open) f.path = "";
  t.vm.state.get("inodes")?.delete(abs);
  return true;
}

function detachFile(t: JThread, f: OpenFile) {
  const stat = t.vm.fs.stat(f.path);
  f.ino ??= fileInode(t, f.path, stat);
  if (stat) f.detached = { path: f.path, stat, writable: t.vm.fs.writable(f.path) };
}

function fdOf(t: JThread, stream: JObject, owner: string): number {
  const fdObj = t.vm.getField(stream, owner, "fd") as JObject;
  return t.vm.getField(fdObj, "java/io/FileDescriptor", "fd");
}

function setFd(t: JThread, stream: JObject, owner: string, fd: number) {
  const fdObj = t.vm.getField(stream, owner, "fd") as JObject;
  t.vm.setField(fdObj, "java/io/FileDescriptor", "fd", fd);
}

function* readProcessPipe(t: JThread, pipe: ProcessPipe, dst: Uint8Array, off: number, len: number): NativeGen {
  return yield t.block(pipe.read(dst, off, len));
}

function* writeProcessPipe(t: JThread, pipe: ProcessPipe, bytes: Uint8Array): NativeGen {
  const error: string | null = yield t.block(pipe.write(bytes));
  if (error) throw new PendingThrow("java/io/IOException", error);
}

function writeOut(t: JThread, fd: number, bytes: Uint8Array) {
  if (fd === 1) t.vm.opts.stdout(bytes.slice());
  else if (fd === 2) t.vm.opts.stderr(bytes.slice());
  else if (processPipe(t, fd)) return writeProcessPipe(t, processPipe(t, fd)!, bytes);
  else {
    writableFile(t, fd).write(bytes);
  }
}

// stdin, buffered between reads
interface Stdin {
  buf: Uint8Array;
  eof: boolean;
}

function* readStdin(t: JThread, dst: Uint8Array, off: number, len: number): NativeGen {
  let s = t.vm.state.get("stdin") as Stdin | undefined;
  if (!s) t.vm.state.set("stdin", (s = { buf: new Uint8Array(0), eof: !t.vm.opts.stdin }));
  while (s.buf.length === 0 && !s.eof) {
    const chunk: Uint8Array | null = yield t.block(t.vm.opts.stdin!());
    if (chunk === null) s.eof = true;
    else s.buf = chunk;
  }
  if (s.buf.length === 0) return -1;
  const n = Math.min(len, s.buf.length);
  dst.set(s.buf.subarray(0, n), off);
  s.buf = s.buf.subarray(n);
  return n;
}

function attrs(t: JThread, file: JObject): number {
  const st = t.vm.fs.stat(resolvePath(t, pathOf(t, file)));
  if (!st) return 0;
  return 1 | (st.dir ? 4 : st.device ? 0 : 2);
}

// a backend without permission bits takes any change to an existing file
function chmod(t: JThread, file: JObject, f: (mode: number) => number): boolean {
  return t.vm.fs.chmod(resolvePath(t, pathOf(t, file)), f) ?? attrs(t, file) !== 0;
}

function pathOf(t: JThread, file: JObject): string {
  return t.vm.jsString(t.vm.getField(file, "java/io/File", "path"));
}

// java.util.prefs lock files: fcntl locks, which only this VM's threads can
// contend for here. path -> readers, or -1 while one writer holds it.
interface PrefsLock { path: string; shared: boolean }
function prefsLocks(t: JThread) {
  let s = t.vm.state.get("prefsLocks") as { held: Map<string, number>; fds: Map<number, PrefsLock> } | undefined;
  if (!s) t.vm.state.set("prefsLocks", (s = { held: new Map(), fds: new Map() }));
  return s;
}
// Linux errno numbers of the codes Node reports by name
const ERRNO_NUMBER: Record<string, number> = {
  EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EAGAIN: 11, ENOMEM: 12, EACCES: 13, ENOTDIR: 20, EINVAL: 22, ENFILE: 23,
  EMFILE: 24, ENOSPC: 28, EROFS: 30, ENAMETOOLONG: 36, ELOOP: 40, ENOTSUP: 95, EOPNOTSUPP: 95, EDQUOT: 122,
};

function intPair(t: JThread, a: number, b: number): JArray {
  const arr = t.vm.newArray(t.vm.primClass("I"), 2);
  (arr.a as Int32Array).set([a, b]);
  return arr;
}

const FOS = "java/io/FileOutputStream", FIS = "java/io/FileInputStream", RAF = "java/io/RandomAccessFile";
const UFS = "java/io/UnixFileSystem";

export const natives: Natives = {
  // the errno of chmod(2), or 0
  "java/util/prefs/FileSystemPreferences.chmod(Ljava/lang/String;I)I": (t, [name, mode]) => {
    const abs = resolvePath(t, t.vm.jsString(name));
    if (!t.vm.fs.stat(abs)) return ERRNO_NUMBER.ENOENT;
    const ok = t.vm.fs.chmod(abs, (m) => (m & ~0o7777) | (mode & 0o7777));
    return ok === false ? ERRNO_NUMBER[t.vm.fs.chmodError(abs) ?? "EIO"] ?? ERRNO_NUMBER.EIO : 0;
  },
  // [fd, errno]; fd 0 when the file could not be opened or locked
  "java/util/prefs/FileSystemPreferences.lockFile0(Ljava/lang/String;IZ)[I": (t, [name, mode, shared]) => {
    const abs = resolvePath(t, t.vm.jsString(name));
    let fd: number;
    try {
      fd = openFile(t, abs, !shared, false, false);
    } catch {
      return intPair(t, 0, t.vm.fs.stat(abs) ? ERRNO_NUMBER.EACCES : ERRNO_NUMBER.ENOENT);
    }
    // the requested mode, as HotSpot's fchmod gives it; a failure is ignored there too
    if (!shared) t.vm.fs.chmod(abs, (m) => (m & ~0o7777) | (mode & 0o7777));
    const { held, fds } = prefsLocks(t);
    const now = held.get(abs) ?? 0;
    if (shared ? now < 0 : now !== 0) {
      closeFd(t, fd);
      return intPair(t, 0, ERRNO_NUMBER.EAGAIN);
    }
    held.set(abs, shared ? now + 1 : -1);
    fds.set(fd, { path: abs, shared: !!shared });
    return intPair(t, fd, 0);
  },
  "java/util/prefs/FileSystemPreferences.unlockFile0(I)I": (t, [fd]) => {
    const { held, fds } = prefsLocks(t);
    const lock = fds.get(fd);
    if (lock) {
      fds.delete(fd);
      const now = held.get(lock.path) ?? 0;
      if (lock.shared && now > 1) held.set(lock.path, now - 1);
      else held.delete(lock.path);
    }
    try {
      closeFd(t, fd);
    } catch {
      return ERRNO_NUMBER.EIO;
    }
    return 0;
  },
  // serialization: the default serialVersionUID depends on whether the class
  // itself declares a static initializer
  "java/io/ObjectStreamClass.initNative()V": () => undefined,
  "java/io/ObjectStreamClass.hasStaticInitializer(Ljava/lang/Class;)Z": (t, [c]) =>
    t.vm.classOf(c).methodMap.has("<clinit>()V") ? 1 : 0,
  "java/io/FileDescriptor.getHandle(I)J": () => -1n,
  "java/io/FileDescriptor.getAppend(I)Z": () => 0,
  "java/io/FileDescriptor.sync0()V": (t, [fdObj]) => {
    const fd = t.vm.getField(fdObj, "java/io/FileDescriptor", "fd");
    const f = table(t).files.get(fd);
    if (f) flushOrThrow(t, f);
  },
  "java/io/FileDescriptor.close0()V": (t, [fdObj]) => {
    const fd = t.vm.getField(fdObj, "java/io/FileDescriptor", "fd");
    // closed even when close reports a failed write
    t.vm.setField(fdObj, "java/io/FileDescriptor", "fd", -1);
    if (fd > 2) closeFd(t, fd);
  },

  [`${FOS}.open0(Ljava/lang/String;Z)V`]: (t, [self, path, append]) =>
    setFd(t, self, FOS, openFile(t, t.vm.jsString(path), true, !append, append === 1, false)),
  [`${FOS}.writeBytes([BIIZ)V`]: (t, [self, b, off, len]) => {
    const a = nonNull<JArray>(b);
    if (off < 0 || len < 0 || off + len > a.a.length) throw new PendingThrow("java/lang/IndexOutOfBoundsException");
    return writeOut(t, fdOf(t, self, FOS), u8(a, off, len));
  },
  [`${FOS}.write(IZ)V`]: (t, [self, b]) => writeOut(t, fdOf(t, self, FOS), Uint8Array.of(b & 0xff)),

  [`${FIS}.open0(Ljava/lang/String;)V`]: (t, [self, path]) => setFd(t, self, FIS, openFile(t, t.vm.jsString(path), false, false, false)),
  [`${FIS}.readBytes([BII)I`]: (t, [self, b, off, len]) => {
    const a = nonNull<JArray>(b);
    if (off < 0 || len < 0 || off + len > a.a.length) throw new PendingThrow("java/lang/IndexOutOfBoundsException");
    if (len === 0) return 0;
    const fd = fdOf(t, self, FIS);
    if (fd === 0) return readStdin(t, u8(a), off, len);
    const pipe = processPipe(t, fd);
    if (pipe) return readProcessPipe(t, pipe, u8(a), off, len);
    return fileOf(t, fd).read(u8(a), off, len);
  },
  [`${FIS}.read0()I`]: function* (t, [self]): NativeGen {
    const fd = fdOf(t, self, FIS);
    const one = new Uint8Array(1);
    const pipe = processPipe(t, fd);
    const n = fd === 0 ? yield* readStdin(t, one, 0, 1) : pipe ? yield t.block(pipe.read(one, 0, 1)) : fileOf(t, fd).read(one, 0, 1);
    return n <= 0 ? -1 : one[0];
  },
  [`${FIS}.length0()J`]: (t, [self]) => BigInt(fileOf(t, fdOf(t, self, FIS)).size),
  [`${FIS}.position0()J`]: (t, [self]) => BigInt(fileOf(t, fdOf(t, self, FIS)).pos),
  // lseek: the position may go past the end of the file, but not before its start
  [`${FIS}.skip0(J)J`]: (t, [self, n]) => {
    const f = fileOf(t, fdOf(t, self, FIS));
    if (f.pos + Number(n) < 0) throw new PendingThrow("java/io/IOException", "Invalid argument");
    f.pos += Number(n);
    return n;
  },
  [`${FIS}.available0()I`]: (t, [self]) => {
    const fd = fdOf(t, self, FIS);
    if (fd === 0) return (t.vm.state.get("stdin") as Stdin | undefined)?.buf.length ?? 0;
    const pipe = processPipe(t, fd);
    if (pipe) return pipe.available();
    const f = fileOf(t, fd);
    return Math.min(Math.max(0, f.size - f.pos), 0x7fffffff);
  },
  [`${FIS}.isRegularFile0(Ljava/io/FileDescriptor;)Z`]: (t, [, fdObj]) => t.vm.getField(fdObj, "java/io/FileDescriptor", "fd") > 2 && !processPipe(t, t.vm.getField(fdObj, "java/io/FileDescriptor", "fd")),

  [`${RAF}.open0(Ljava/lang/String;I)V`]: (t, [self, path, mode]) =>
    setFd(t, self, RAF, openFile(t, t.vm.jsString(path), (mode & 2) !== 0, false, false)),
  [`${RAF}.read0()I`]: (t, [self]) => {
    const one = new Uint8Array(1);
    return fileOf(t, fdOf(t, self, RAF)).read(one, 0, 1) <= 0 ? -1 : one[0];
  },
  [`${RAF}.readBytes0([BII)I`]: (t, [self, b, off, len]) => {
    const a = nonNull<JArray>(b);
    if (off < 0 || len < 0 || off + len > a.a.length) throw new PendingThrow("java/lang/IndexOutOfBoundsException");
    return len === 0 ? 0 : fileOf(t, fdOf(t, self, RAF)).read(u8(a), off, len);
  },
  [`${RAF}.write0(I)V`]: (t, [self, b]) => writableFile(t, fdOf(t, self, RAF)).write(Uint8Array.of(b & 0xff)),
  [`${RAF}.writeBytes0([BII)V`]: (t, [self, b, off, len]) => {
    const a = nonNull<JArray>(b);
    if (off < 0 || len < 0 || off + len > a.a.length) throw new PendingThrow("java/lang/IndexOutOfBoundsException");
    writableFile(t, fdOf(t, self, RAF)).write(u8(a, off, len));
  },
  [`${RAF}.getFilePointer()J`]: (t, [self]) => BigInt(fileOf(t, fdOf(t, self, RAF)).pos),
  [`${RAF}.seek0(J)V`]: (t, [self, pos]) => { fileOf(t, fdOf(t, self, RAF)).pos = Number(pos); },
  [`${RAF}.length0()J`]: (t, [self]) => BigInt(fileOf(t, fdOf(t, self, RAF)).size),
  [`${RAF}.setLength0(J)V`]: (t, [self, n]) => {
    const f = fileOf(t, fdOf(t, self, RAF));
    if (!f.writable) throw new PendingThrow("java/io/IOException", "Invalid argument");
    f.setLength(Number(n));
  },

  [`${UFS}.canonicalize0(Ljava/lang/String;)Ljava/lang/String;`]: (t, [, p]) => {
    const abs = resolvePath(t, t.vm.jsString(p));
    return t.vm.str(t.vm.fs.realpath(abs) ?? abs);
  },
  [`${UFS}.getBooleanAttributes0(Ljava/io/File;)I`]: (t, [, f]) => attrs(t, f),
  [`${UFS}.checkAccess0(Ljava/io/File;I)Z`]: (t, [, f, access]) => {
    const abs = resolvePath(t, pathOf(t, f));
    return !!t.vm.fs.stat(abs) && t.vm.fs.access(abs, access);
  },
  [`${UFS}.getLastModifiedTime0(Ljava/io/File;)J`]: (t, [, f]) => {
    const st = t.vm.fs.stat(resolvePath(t, pathOf(t, f)));
    if (st?.mtimeNs === undefined) return BigInt(Math.floor(st?.mtime ?? 0));
    // down, as HotSpot divides a negative time
    const ms = st.mtimeNs / 1_000_000n;
    return st.mtimeNs < 0n && ms * 1_000_000n !== st.mtimeNs ? ms - 1n : ms;
  },
  [`${UFS}.getLength0(Ljava/io/File;)J`]: (t, [, f]) => {
    const abs = resolvePath(t, pathOf(t, f));
    syncPath(t, abs);
    return BigInt(t.vm.fs.stat(abs)?.size ?? 0);
  },
  [`${UFS}.setPermission0(Ljava/io/File;IZZ)Z`]: (t, [, f, access, enable, ownerOnly]) => {
    const bits = ownerOnly ? access << 6 : access * 0o111;
    return chmod(t, f, (m) => (enable ? m | bits : m & ~bits));
  },
  [`${UFS}.createFileExclusively0(Ljava/lang/String;)Z`]: (t, [, p]) => {
    if (t.vm.jsString(p) === "") throw new PendingThrow("java/io/IOException", "No such file or directory");
    const abs = resolvePath(t, t.vm.jsString(p));
    if (t.vm.fs.lstat(abs)) return 0;
    if (t.vm.fs.denied(abs)) throw new PendingThrow("java/io/IOException", "Permission denied");
    if (!t.vm.fs.write(abs, new Uint8Array(0))) throw new PendingThrow("java/io/IOException", "No such file or directory");
    return 1;
  },
  [`${UFS}.delete0(Ljava/io/File;)Z`]: (t, [, f]) => !endsInDot(pathOf(t, f)) && removePath(t, resolvePath(t, pathOf(t, f))),
  [`${UFS}.list0(Ljava/io/File;)[Ljava/lang/String;`]: (t, [, f]) => {
    const names = t.vm.fs.list(resolvePath(t, pathOf(t, f)));
    return names ? t.vm.newObjectArray("java/lang/String", names.map((n) => t.vm.str(n))) : null;
  },
  [`${UFS}.createDirectory0(Ljava/io/File;)Z`]: (t, [, f]) => t.vm.fs.mkdir(resolvePath(t, pathOf(t, f))),
  [`${UFS}.rename0(Ljava/io/File;Ljava/io/File;)Z`]: (t, [, a, b]) =>
    renamePath(t, resolvePath(t, pathOf(t, a)), resolvePath(t, pathOf(t, b))),
  [`${UFS}.setLastModifiedTime0(Ljava/io/File;J)Z`]: (t, [, f, ms]) => setMtime(t, resolvePath(t, pathOf(t, f)), Number(ms), BigInt(ms) * 1_000_000n),
  [`${UFS}.setReadOnly0(Ljava/io/File;)Z`]: (t, [, f]) => chmod(t, f, (m) => m & ~0o222),
  // SPACE_TOTAL, SPACE_FREE or SPACE_USABLE of the file system holding f; 0 if f is missing
  [`${UFS}.getSpace0(Ljava/io/File;I)J`]: (t, [, f, kind]) => {
    const abs = resolvePath(t, pathOf(t, f));
    if (!t.vm.fs.stat(abs)) return 0n;
    const s = t.vm.fs.space(abs);
    return s.bsize * (kind === 0 ? s.blocks : kind === 1 ? s.bfree : s.bavail);
  },
  [`${UFS}.getNameMax0(Ljava/lang/String;)J`]: () => 255n,
};
