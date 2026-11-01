// java.io natives over the VFS: file descriptors, streams, RandomAccessFile
// and UnixFileSystem.

import { JArray, JObject } from "../runtime.ts";
import { JThread, PendingThrow } from "../thread.ts";
import type { NativeGen } from "../thread.ts";
import { normalize } from "../fs.ts";
import type { VFS } from "../fs.ts";
import { closeSockFd } from "../sockets.ts";
import { nonNull, u8 } from "./util.ts";
import type { Natives } from "./util.ts";

// A file's bytes, shared by every descriptor open on it, as an inode is.
interface Contents {
  data: Uint8Array;
  size: number;
  dirty: boolean;
}

export class OpenFile {
  // "" once the file is unlinked: it lives until closed, but no path reaches it
  path: string;
  pos = 0;
  writable: boolean;
  contents: Contents;
  constructor(path: string, data: Uint8Array, writable: boolean, contents?: Contents) {
    this.path = path;
    this.contents = contents ?? { data, size: data.length, dirty: false };
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
    dst.set(this.data.subarray(this.pos, this.pos + n), off);
    this.pos += n;
    return n;
  }

  write(src: Uint8Array) {
    // past the end, the gap reads as zeros (the buffer may hold bytes from before a truncation)
    if (this.pos > this.size) this.data.fill(0, this.size, Math.min(this.pos, this.data.length));
    const end = this.pos + src.length;
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
    if (n > this.data.length) {
      const next = new Uint8Array(n);
      next.set(this.data.subarray(0, this.size));
      this.data = next;
    } else if (n > this.size) this.data.fill(0, this.size, n);
    this.size = n;
    if (this.pos > n) this.pos = n;
    this.dirty = true;
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

// rmdir fails on a path ending in "." or "..": "." stays the working directory
export function endsInDot(p: string): boolean {
  const last = p.replace(/\/+$/, "").split("/").pop();
  return last === "." || last === "..";
}

export function resolvePath(t: JThread, p: string): string {
  return normalize(p.startsWith("/") ? p : `${t.vm.opts.cwd ?? "/"}/${p}`);
}

function notFound(path: string, why = "No such file or directory"): never {
  throw new PendingThrow("java/io/FileNotFoundException", `${path} (${why})`);
}

// Opens a path and returns its descriptor number.
export function openFile(t: JThread, path: string, write: boolean, truncate: boolean, append: boolean): number {
  const fs = t.vm.fs;
  const abs = resolvePath(t, path);
  syncPath(t, abs);
  const st = fs.stat(abs);
  if (st?.dir) notFound(path, "Is a directory");
  const shared = st ? [...table(t).files.values()].find((o) => o.path === abs && o.constructor === OpenFile)?.contents : undefined;
  if (st?.device || (st && !shared && !write && st.size >= LAZY_MIN && fs.canReadRange(abs))) {
    const tab = table(t);
    tab.files.set(tab.next, st.device ? new DeviceFile(abs) : new LazyFile(abs, st.size, fs));
    return tab.next++;
  }
  if (write && fs.denied(abs)) notFound(path, "Permission denied");
  let data: Uint8Array;
  if (!st) {
    if (!write) notFound(path);
    if (!fs.write(abs, new Uint8Array(0))) notFound(path, fs.writable(abs) ? "No such file or directory" : "Read-only file system");
    data = new Uint8Array(0);
  } else {
    if (write && !fs.writable(abs)) notFound(path, "Read-only file system");
    if (shared) data = shared.data;
    else if (truncate) data = new Uint8Array(0);
    else data = fs.read(abs) ?? notFound(path, "Operation not supported");
  }
  const f = new OpenFile(abs, data, write, shared);
  if (truncate && st) f.setLength(0);
  if (append) f.pos = f.size;
  const tab = table(t);
  const fd = tab.next++;
  tab.files.set(fd, f);
  return fd;
}

// Writes reach the file system when a file is closed. Another open or a stat
// of the same path sees them at once on a real OS, so write them out first.
export function syncPath(t: JThread, abs: string) {
  for (const f of table(t).files.values()) if (f.path === abs) flush(t, f);
}

// Pending writes go out first, so closing the file later does not change the time again.
export function setMtime(t: JThread, abs: string, ms: number): boolean {
  syncPath(t, abs);
  return t.vm.fs.setMtime(abs, ms);
}

export function fileOf(t: JThread, fd: number): OpenFile {
  const f = table(t).files.get(fd);
  if (!f) throw new PendingThrow("java/io/IOException", "Stream Closed");
  return f;
}

export function flush(t: JThread, f: OpenFile) {
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
  }
}

export function newFd(t: JThread): number {
  return table(t).next++;
}

export function closeFd(t: JThread, fd: number) {
  if (closeSockFd(t.vm.state, t.vm.net, fd)) return;
  const tab = table(t);
  const f = tab.files.get(fd);
  if (f) {
    flush(t, f);
    tab.files.delete(fd);
    if (f.writable && f.path) t.vm.opts.fileClosed?.(f.path);
  }
}

// Open files follow their inode: a rename moves their path, an unlink drops it.
export function renamePath(t: JThread, from: string, to: string): boolean {
  const files = [...table(t).files.values()];
  const under = (f: OpenFile, p: string) => f.path === p || f.path.startsWith(p + "/");
  const open = files.filter((f) => under(f, from));
  for (const f of open) flush(t, f);
  if (!t.vm.fs.rename(from, to)) return false;
  // a file the rename replaced stays open, unlinked
  for (const f of files) if (!open.includes(f) && under(f, to)) f.path = "";
  for (const f of open) f.path = to + f.path.slice(from.length);
  return true;
}

export function removePath(t: JThread, abs: string): boolean {
  if (!t.vm.fs.remove(abs)) return false;
  for (const f of table(t).files.values()) if (f.path === abs) f.path = "";
  return true;
}

function fdOf(t: JThread, stream: JObject, owner: string): number {
  const fdObj = t.vm.getField(stream, owner, "fd") as JObject;
  return t.vm.getField(fdObj, "java/io/FileDescriptor", "fd");
}

function setFd(t: JThread, stream: JObject, owner: string, fd: number) {
  const fdObj = t.vm.getField(stream, owner, "fd") as JObject;
  t.vm.setField(fdObj, "java/io/FileDescriptor", "fd", fd);
}

function writeOut(t: JThread, fd: number, bytes: Uint8Array) {
  if (fd === 1) t.vm.opts.stdout(bytes.slice());
  else if (fd === 2) t.vm.opts.stderr(bytes.slice());
  else {
    const f = fileOf(t, fd);
    if (!f.writable) throw new PendingThrow("java/io/IOException", "Bad file descriptor");
    f.write(bytes);
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

const FOS = "java/io/FileOutputStream", FIS = "java/io/FileInputStream", RAF = "java/io/RandomAccessFile";
const UFS = "java/io/UnixFileSystem";

export const natives: Natives = {
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
    if (f) flush(t, f);
  },
  "java/io/FileDescriptor.close0()V": (t, [fdObj]) => {
    const fd = t.vm.getField(fdObj, "java/io/FileDescriptor", "fd");
    if (fd > 2) closeFd(t, fd);
    t.vm.setField(fdObj, "java/io/FileDescriptor", "fd", -1);
  },

  [`${FOS}.open0(Ljava/lang/String;Z)V`]: (t, [self, path, append]) =>
    setFd(t, self, FOS, openFile(t, t.vm.jsString(path), true, !append, append === 1)),
  [`${FOS}.writeBytes([BIIZ)V`]: (t, [self, b, off, len]) => {
    const a = nonNull<JArray>(b);
    if (off < 0 || len < 0 || off + len > a.a.length) throw new PendingThrow("java/lang/IndexOutOfBoundsException");
    writeOut(t, fdOf(t, self, FOS), u8(a, off, len));
  },
  [`${FOS}.write(IZ)V`]: (t, [self, b]) => writeOut(t, fdOf(t, self, FOS), Uint8Array.of(b & 0xff)),

  [`${FIS}.open0(Ljava/lang/String;)V`]: (t, [self, path]) => setFd(t, self, FIS, openFile(t, t.vm.jsString(path), false, false, false)),
  [`${FIS}.readBytes([BII)I`]: (t, [self, b, off, len]) => {
    const a = nonNull<JArray>(b);
    if (off < 0 || len < 0 || off + len > a.a.length) throw new PendingThrow("java/lang/IndexOutOfBoundsException");
    if (len === 0) return 0;
    const fd = fdOf(t, self, FIS);
    if (fd === 0) return readStdin(t, u8(a), off, len);
    return fileOf(t, fd).read(u8(a), off, len);
  },
  [`${FIS}.read0()I`]: function* (t, [self]): NativeGen {
    const fd = fdOf(t, self, FIS);
    const one = new Uint8Array(1);
    const n = fd === 0 ? yield* readStdin(t, one, 0, 1) : fileOf(t, fd).read(one, 0, 1);
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
    const f = fileOf(t, fd);
    return Math.min(Math.max(0, f.size - f.pos), 0x7fffffff);
  },
  [`${FIS}.isRegularFile0(Ljava/io/FileDescriptor;)Z`]: (t, [, fdObj]) => t.vm.getField(fdObj, "java/io/FileDescriptor", "fd") > 2,

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
  [`${RAF}.write0(I)V`]: (t, [self, b]) => fileOf(t, fdOf(t, self, RAF)).write(Uint8Array.of(b & 0xff)),
  [`${RAF}.writeBytes0([BII)V`]: (t, [self, b, off, len]) => {
    const a = nonNull<JArray>(b);
    if (off < 0 || len < 0 || off + len > a.a.length) throw new PendingThrow("java/lang/IndexOutOfBoundsException");
    fileOf(t, fdOf(t, self, RAF)).write(u8(a, off, len));
  },
  [`${RAF}.getFilePointer()J`]: (t, [self]) => BigInt(fileOf(t, fdOf(t, self, RAF)).pos),
  [`${RAF}.seek0(J)V`]: (t, [self, pos]) => { fileOf(t, fdOf(t, self, RAF)).pos = Number(pos); },
  [`${RAF}.length0()J`]: (t, [self]) => BigInt(fileOf(t, fdOf(t, self, RAF)).size),
  [`${RAF}.setLength0(J)V`]: (t, [self, n]) => {
    const f = fileOf(t, fdOf(t, self, RAF));
    if (!f.writable) throw new PendingThrow("java/io/IOException", "Invalid argument");
    f.setLength(Number(n));
  },

  [`${UFS}.canonicalize0(Ljava/lang/String;)Ljava/lang/String;`]: (t, [, p]) => t.vm.str(resolvePath(t, t.vm.jsString(p))),
  [`${UFS}.getBooleanAttributes0(Ljava/io/File;)I`]: (t, [, f]) => attrs(t, f),
  [`${UFS}.checkAccess0(Ljava/io/File;I)Z`]: (t, [, f, access]) => {
    const abs = resolvePath(t, pathOf(t, f));
    return !!t.vm.fs.stat(abs) && t.vm.fs.access(abs, access);
  },
  [`${UFS}.getLastModifiedTime0(Ljava/io/File;)J`]: (t, [, f]) => BigInt(Math.floor(t.vm.fs.stat(resolvePath(t, pathOf(t, f)))?.mtime ?? 0)),
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
    const abs = resolvePath(t, t.vm.jsString(p));
    if (t.vm.fs.stat(abs)) return 0;
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
  [`${UFS}.setLastModifiedTime0(Ljava/io/File;J)Z`]: (t, [, f, ms]) => setMtime(t, resolvePath(t, pathOf(t, f)), Number(ms)),
  [`${UFS}.setReadOnly0(Ljava/io/File;)Z`]: (t, [, f]) => chmod(t, f, (m) => m & ~0o222),
  [`${UFS}.getSpace0(Ljava/io/File;I)J`]: () => 0n,
  [`${UFS}.getNameMax0(Ljava/lang/String;)J`]: () => 255n,
};
