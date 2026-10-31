// sun.nio.fs.UnixNativeDispatcher over the VFS. Paths arrive as C strings in
// native memory; failures throw UnixException(errno) like the real natives.

import type { JObject } from "../runtime.ts";
import { preCloseSock } from "../sockets.ts";
import { sockRead, sockReadv, sockWrite, sockWritev } from "./sockets.ts";
import { JThread, PendingThrow } from "../thread.ts";
import { closeFd, endsInDot, fileOf, flush, openFile, removePath, renamePath, resolvePath, setMtime, syncPath } from "./io.ts";
import type { OpenFile } from "./io.ts";
import type { Natives } from "./util.ts";

export const ENOENT = 2, EBADF = 9, EACCES = 13, EEXIST = 17, EXDEV = 18, ENOTDIR = 20, EISDIR = 21,
  EINVAL = 22, EROFS = 30, ENOTEMPTY = 39, ENOSYS = 38;

const MESSAGES: Record<number, string> = {
  [ENOENT]: "No such file or directory", [EBADF]: "Bad file descriptor", [EACCES]: "Permission denied",
  [EEXIST]: "File exists", [EXDEV]: "Invalid cross-device link", [ENOTDIR]: "Not a directory",
  [EISDIR]: "Is a directory", [EINVAL]: "Invalid argument", [EROFS]: "Read-only file system",
  [ENOTEMPTY]: "Directory not empty", [ENOSYS]: "Function not implemented",
};

// Linux open(2) flags
const O_ACCMODE = 3, O_CREAT = 0o100, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000;
const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFCHR = 0o020000;

export function unixError(errno: number): never {
  throw new PendingThrow("sun/nio/fs/UnixException", null, { desc: "(I)V", args: [errno] });
}

export function cstring(t: JThread, addr: bigint): string {
  const u8 = t.vm.mem.u8;
  let end = Number(addr);
  while (u8[end] !== 0) end++;
  return new TextDecoder().decode(u8.subarray(Number(addr), end));
}

function bytes(t: JThread, s: string): JObject {
  const b = new TextEncoder().encode(s);
  const a = t.vm.newArray(t.vm.primClass("B"), b.length);
  (a.a as Int8Array).set(new Int8Array(b.buffer, b.byteOffset, b.length));
  return a;
}

function path(t: JThread, addr: bigint) {
  return resolvePath(t, cstring(t, addr));
}

function fillAttrs(t: JThread, attrs: JObject, p: string): number {
  syncPath(t, p);
  const st = t.vm.fs.stat(p);
  if (!st) return ENOENT;
  const vm = t.vm, A = "sun/nio/fs/UnixFileAttributes";
  const writable = vm.fs.writable(p);
  const mode = st.device ? S_IFCHR | 0o666 : st.dir ? S_IFDIR | (writable ? 0o755 : 0o555) : S_IFREG | (writable ? 0o644 : 0o444);
  const sec = BigInt(Math.floor(st.mtime / 1000)), nsec = BigInt(Math.floor((st.mtime % 1000) * 1e6));
  vm.setField(attrs, A, "st_mode", mode);
  vm.setField(attrs, A, "st_ino", BigInt(inode(t, p)));
  vm.setField(attrs, A, "st_dev", 1n);
  vm.setField(attrs, A, "st_nlink", 1);
  vm.setField(attrs, A, "st_uid", 1000);
  vm.setField(attrs, A, "st_gid", 1000);
  vm.setField(attrs, A, "st_size", BigInt(st.size));
  for (const k of ["atime", "mtime", "ctime"]) {
    vm.setField(attrs, A, `st_${k}_sec`, sec);
    vm.setField(attrs, A, `st_${k}_nsec`, nsec);
  }
  return 0;
}

// open mount table handles: whether the one entry has been read
function mountTables(t: JThread): Map<number, boolean> {
  let m = t.vm.state.get("mntent") as Map<number, boolean> | undefined;
  if (!m) t.vm.state.set("mntent", (m = new Map()));
  return m;
}

// stable inode numbers so file keys compare equal for the same path
function inode(t: JThread, p: string): number {
  let m = t.vm.state.get("inodes") as Map<string, number> | undefined;
  if (!m) t.vm.state.set("inodes", (m = new Map()));
  let n = m.get(p);
  if (n === undefined) m.set(p, (n = m.size + 2));
  return n;
}

interface Dir { names: string[]; pos: number }

function dirs(t: JThread): Map<bigint, Dir> {
  let m = t.vm.state.get("dirs");
  if (!m) t.vm.state.set("dirs", (m = new Map()));
  return m;
}

let nextDir = 1n;

const N = "sun/nio/fs/UnixNativeDispatcher.";

export const natives: Natives = {
  [`${N}init()I`]: () => 0,
  [`${N}getcwd()[B`]: (t) => bytes(t, t.vm.opts.cwd ?? "/"),
  [`${N}strerror(I)[B`]: (t, [errno]) => bytes(t, MESSAGES[errno] ?? `errno ${errno}`),
  [`${N}stat0(JLsun/nio/fs/UnixFileAttributes;)I`]: (t, [p, attrs]) => fillAttrs(t, attrs, path(t, p)),
  [`${N}lstat0(JLsun/nio/fs/UnixFileAttributes;)V`]: (t, [p, attrs]) => {
    const err = fillAttrs(t, attrs, path(t, p));
    if (err) unixError(err);
  },
  [`${N}fstat0(ILsun/nio/fs/UnixFileAttributes;)V`]: (t, [fd, attrs]) => {
    const files = t.vm.state.get("fds")?.files;
    const f = files?.get(fd);
    if (!f) unixError(EBADF);
    fillAttrs(t, attrs, f.path);
  },
  [`${N}access0(JI)I`]: (t, [p, amode]) => {
    const abs = path(t, p);
    if (!t.vm.fs.stat(abs)) return ENOENT;
    return amode & 2 && (!t.vm.fs.writable(abs) || t.vm.fs.denied(abs)) ? EACCES : 0;
  },
  [`${N}open0(JII)I`]: (t, [p, flags]) => {
    const abs = path(t, p);
    const st = t.vm.fs.stat(abs);
    if ((flags & O_CREAT) && (flags & O_EXCL) && st) unixError(EEXIST);
    if (!st && !(flags & O_CREAT)) unixError(ENOENT);
    const write = (flags & O_ACCMODE) !== 0;
    if (st?.dir && write) unixError(EISDIR);
    if ((write || !st) && t.vm.fs.denied(abs)) unixError(EACCES);
    try {
      return openFile(t, abs, write, (flags & O_TRUNC) !== 0, (flags & O_APPEND) !== 0);
    } catch (e) {
      if (e instanceof PendingThrow) unixError(t.vm.fs.writable(abs) ? ENOENT : EROFS);
      throw e;
    }
  },
  [`${N}close0(I)V`]: (t, [fd]) => closeFd(t, fd),
  [`${N}dup(I)I`]: () => unixError(ENOSYS),
  [`${N}mkdir0(JI)V`]: (t, [p]) => {
    const abs = path(t, p);
    if (t.vm.fs.stat(abs)) unixError(EEXIST);
    if (!t.vm.fs.mkdir(abs)) unixError(t.vm.fs.writable(abs) ? ENOENT : EROFS);
  },
  [`${N}rmdir0(J)V`]: (t, [p]) => {
    if (endsInDot(cstring(t, p))) unixError(EINVAL);
    const abs = path(t, p);
    const st = t.vm.fs.stat(abs);
    if (!st) unixError(ENOENT);
    if (!st.dir) unixError(ENOTDIR);
    if (!removePath(t, abs)) unixError(ENOTEMPTY);
  },
  [`${N}unlink0(J)V`]: (t, [p]) => {
    const abs = path(t, p);
    const st = t.vm.fs.stat(abs);
    if (!st) unixError(ENOENT);
    if (st.dir) unixError(EISDIR);
    if (!removePath(t, abs)) unixError(EROFS);
  },
  [`${N}rename0(JJ)V`]: (t, [a, b]) => {
    if (!t.vm.fs.stat(path(t, a))) unixError(ENOENT);
    if (!renamePath(t, path(t, a), path(t, b))) unixError(EXDEV);
  },
  [`${N}realpath0(J)[B`]: (t, [p]) => {
    const abs = path(t, p);
    if (!t.vm.fs.stat(abs)) unixError(ENOENT);
    return bytes(t, abs);
  },
  [`${N}readlink0(J)[B`]: () => unixError(EINVAL),
  [`${N}symlink0(JJ)V`]: () => unixError(ENOSYS),
  [`${N}link0(JJ)V`]: () => unixError(ENOSYS),
  [`${N}chmod0(JI)V`]: () => undefined,
  [`${N}fchmod0(II)V`]: () => undefined,
  [`${N}chown0(JII)V`]: () => undefined,
  [`${N}lchown0(JII)V`]: () => undefined,
  [`${N}fchown0(III)V`]: () => undefined,
  // times in nanoseconds; only the modification time is kept
  [`${N}utimensat0(IJJJI)V`]: (t, [, p, , mtime]) => {
    const abs = path(t, p);
    if (!t.vm.fs.stat(abs)) unixError(ENOENT);
    if (!setMtime(t, abs, Number(mtime) / 1e6)) unixError(EROFS);
  },
  [`${N}futimens0(IJJ)V`]: (t, [fd, , mtime]) => {
    const f = fileOf(t, fd);
    if (!setMtime(t, f.path, Number(mtime) / 1e6)) unixError(EROFS);
  },
  [`${N}opendir0(J)J`]: (t, [p]) => {
    const abs = path(t, p);
    const st = t.vm.fs.stat(abs);
    if (!st) unixError(ENOENT);
    if (!st.dir) unixError(ENOTDIR);
    const id = nextDir++;
    dirs(t).set(id, { names: t.vm.fs.list(abs) ?? [], pos: 0 });
    return id;
  },
  [`${N}readdir0(J)[B`]: (t, [id]) => {
    const d = dirs(t).get(id);
    if (!d) unixError(EBADF);
    return d.pos < d.names.length ? bytes(t, d.names[d.pos++]) : null;
  },
  [`${N}closedir(J)V`]: (t, [id]) => void dirs(t).delete(id),
  [`${N}getpwuid(I)[B`]: (t) => bytes(t, t.vm.props.get("user.name") ?? "user"),
  [`${N}getgrgid(I)[B`]: (t) => bytes(t, t.vm.props.get("user.name") ?? "user"),
  [`${N}getpwnam0(J)I`]: () => 1000,
  [`${N}getgrnam0(J)I`]: () => 1000,
  [`${N}fchmodatNoFollowSupported0()Z`]: () => 0,
  [`${N}statvfs0(JLsun/nio/fs/UnixFileStoreAttributes;)V`]: () => undefined,
  [`${N}flistxattr(IJI)I`]: () => 0,
  [`${N}getlinelen(J)I`]: () => -1,
  [`${N}rewind(J)V`]: () => undefined,
  // The mount table has one file system at "/", since every file has st_dev 1.
  "sun/nio/fs/LinuxNativeDispatcher.setmntent0(JJ)J": (t) => {
    const open = mountTables(t);
    const id = Math.max(0, ...open.keys()) + 1;
    open.set(id, false);
    return BigInt(id);
  },
  "sun/nio/fs/LinuxNativeDispatcher.getmntent0(JLsun/nio/fs/UnixMountEntry;JI)I": (t, [fp, entry]) => {
    const open = mountTables(t);
    if (open.get(Number(fp)) !== false) return -1;
    open.set(Number(fp), true);
    const E = "sun/nio/fs/UnixMountEntry";
    for (const [k, v] of [["name", "java-web"], ["dir", "/"], ["fstype", "java-web"], ["opts", "rw"]]) t.vm.setField(entry, E, k, bytes(t, v));
    t.vm.setField(entry, E, "dev", 1n);
    return 0;
  },
  "sun/nio/fs/LinuxNativeDispatcher.endmntent(J)V": (t, [fp]) => void mountTables(t).delete(Number(fp)),
  "sun/nio/fs/LinuxNativeDispatcher.init()V": () => undefined,
  "sun/nio/fs/LinuxNativeDispatcher.posix_fadvise(IJJI)I": () => 0,
  "sun/nio/fs/LinuxNativeDispatcher.directCopy0(IIJ)I": (t, [dst, src]) => copyFd(t, dst, src),
  "sun/nio/fs/UnixFileSystem.bufferedCopy0(IIJIJ)V": (t, [dst, src]) => void copyFd(t, dst, src),
};

// ---- sun.nio.ch: file channels -------------------------------------------

// The rest of src to dst, from both positions, like copy_file_range.
function copyFd(t: JThread, dst: number, src: number): number {
  const files = t.vm.state.get("fds")?.files;
  const from = files?.get(src), to = files?.get(dst);
  if (!from || !to) unixError(EBADF);
  const buf = new Uint8Array(65536);
  for (let n; (n = from.read(buf, 0, buf.length)) > 0;) to.write(buf.subarray(0, n));
  return 0;
}

const FD = "java/io/FileDescriptor";
const UNSUPPORTED_CASE = -6;

function fdNum(t: JThread, fdObj: JObject): number {
  return t.vm.getField(fdObj, FD, "fd");
}

function chanFile(t: JThread, fdObj: JObject) {
  const f = t.vm.state.get("fds")?.files.get(fdNum(t, fdObj));
  if (!f) throw new PendingThrow("java/io/IOException", "Bad file descriptor");
  return f;
}

// FileChannelImpl.MAP_RW
const MAP_RW = 1;

interface Mapping {
  f: OpenFile;
  pos: number;
  len: number;
}

function mappings(t: JThread): Map<number, Mapping> {
  let m = t.vm.state.get("mappings") as Map<number, Mapping> | undefined;
  if (!m) t.vm.state.set("mappings", (m = new Map()));
  return m;
}

// Copies mapped bytes from addr on into the file, which stays the size it is.
function writeBack(t: JThread, m: Mapping, base: number, addr: number, len: number) {
  const at = m.pos + addr - base;
  const n = Math.min(len, m.f.size - at);
  if (n <= 0) return;
  const save = m.f.pos;
  m.f.pos = at;
  m.f.write(t.vm.mem.u8.slice(addr, addr + n));
  m.f.pos = save;
  flush(t, m.f);
}

function readAt(t: JThread, fdObj: JObject, addr: bigint, len: number, pos: number | null): number {
  const f = chanFile(t, fdObj);
  const save = f.pos;
  if (pos !== null) f.pos = pos;
  const n = f.read(t.vm.mem.u8, Number(addr), len);
  if (pos !== null) f.pos = save;
  return n;
}

function writeAt(t: JThread, fdObj: JObject, addr: bigint, len: number, pos: number | null): number {
  const fd = fdNum(t, fdObj);
  const data = t.vm.mem.u8.slice(Number(addr), Number(addr) + len);
  if (fd === 1 || fd === 2) {
    (fd === 1 ? t.vm.opts.stdout : t.vm.opts.stderr)(data);
    return len;
  }
  const f = chanFile(t, fdObj);
  const save = f.pos;
  if (pos !== null) f.pos = pos;
  f.write(data);
  if (pos !== null) f.pos = save;
  return len;
}

// iovec: { void *base; size_t len; } pairs of 64-bit words
function vector(t: JThread, addr: bigint, n: number, each: (base: bigint, len: number) => number): bigint {
  const dv = t.vm.mem.dv;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = Number(addr) + i * 16;
    const base = dv.getBigInt64(p, true), len = Number(dv.getBigInt64(p + 8, true));
    const r = each(base, len);
    if (r < 0) return total === 0 ? BigInt(r) : BigInt(total);
    total += r;
    if (r < len) break;
  }
  return BigInt(total);
}

const UFD = "sun/nio/ch/UnixFileDispatcherImpl.";

Object.assign(natives, {
  "sun/nio/ch/IOUtil.fdVal(Ljava/io/FileDescriptor;)I": (t: JThread, [fd]: any[]) => fdNum(t, fd),
  "sun/nio/ch/IOUtil.setfdVal(Ljava/io/FileDescriptor;I)V": (t: JThread, [fd, v]: any[]) => t.vm.setField(fd, FD, "fd", v),
  "sun/nio/ch/IOUtil.iovMax()I": () => 16,
  "sun/nio/ch/IOUtil.writevMax()J": () => 0x7fffffffn,
  "sun/nio/ch/IOUtil.fdLimit()I": () => 1024,
  "sun/nio/ch/IOUtil.randomBytes([B)Z": (_t: JThread, [b]: any[]) => {
    crypto.getRandomValues(b.a as Int8Array<ArrayBuffer>);
    return 1;
  },
  [`${UFD}read0(Ljava/io/FileDescriptor;JI)I`]: (t: JThread, [fd, addr, len]: any[]) => sockRead(t, fd, addr, len) ?? readAt(t, fd, addr, len, null),
  [`${UFD}pread0(Ljava/io/FileDescriptor;JIJ)I`]: (t: JThread, [fd, addr, len, pos]: any[]) => readAt(t, fd, addr, len, Number(pos)),
  [`${UFD}readv0(Ljava/io/FileDescriptor;JI)J`]: (t: JThread, [fd, addr, n]: any[]) =>
    sockReadv(t, fd, addr, n) ?? vector(t, addr, n, (base, len) => readAt(t, fd, base, len, null)),
  [`${UFD}write0(Ljava/io/FileDescriptor;JI)I`]: (t: JThread, [fd, addr, len]: any[]) => sockWrite(t, fd, addr, len) ?? writeAt(t, fd, addr, len, null),
  [`${UFD}pwrite0(Ljava/io/FileDescriptor;JIJ)I`]: (t: JThread, [fd, addr, len, pos]: any[]) => writeAt(t, fd, addr, len, Number(pos)),
  [`${UFD}writev0(Ljava/io/FileDescriptor;JI)J`]: (t: JThread, [fd, addr, n]: any[]) =>
    sockWritev(t, fd, addr, n) ?? vector(t, addr, n, (base, len) => writeAt(t, fd, base, len, null)),
  [`${UFD}force0(Ljava/io/FileDescriptor;Z)I`]: (t: JThread, [fd]: any[]) => {
    const f = chanFile(t, fd);
    flush(t, f);
    return 0;
  },
  [`${UFD}seek0(Ljava/io/FileDescriptor;J)J`]: (t: JThread, [fd, off]: any[]) => {
    const f = chanFile(t, fd);
    if (off >= 0n) f.pos = Number(off);
    return BigInt(f.pos);
  },
  [`${UFD}truncate0(Ljava/io/FileDescriptor;J)I`]: (t: JThread, [fd, size]: any[]) => {
    chanFile(t, fd).setLength(Number(size));
    return 0;
  },
  [`${UFD}size0(Ljava/io/FileDescriptor;)J`]: (t: JThread, [fd]: any[]) => BigInt(chanFile(t, fd).size),
  [`${UFD}available0(Ljava/io/FileDescriptor;)I`]: (t: JThread, [fd]: any[]) => {
    const f = chanFile(t, fd);
    return f.size - f.pos;
  },
  [`${UFD}isOther0(Ljava/io/FileDescriptor;)Z`]: () => 0,
  [`${UFD}lock0(Ljava/io/FileDescriptor;ZJJZ)I`]: () => 0,
  [`${UFD}release0(Ljava/io/FileDescriptor;JJ)V`]: () => undefined,
  [`${UFD}closeIntFD(I)V`]: (t: JThread, [fd]: any[]) => closeFd(t, fd),
  [`${UFD}allocationGranularity0()J`]: () => 4096n,
  // Mappings are copies. A read-write one is written back on force and unmap,
  // so the file ends up as with MAP_SHARED, but other descriptors see the
  // writes only then.
  [`${UFD}map0(Ljava/io/FileDescriptor;IJJZ)J`]: (t: JThread, [fd, prot, pos, len]: any[]) => {
    const f = chanFile(t, fd);
    const addr = t.vm.mem.malloc(Number(len));
    const save = f.pos;
    f.pos = Number(pos);
    const n = Math.min(f.size - Number(pos), Number(len));
    if (n > 0) f.read(t.vm.mem.u8, addr, n);
    f.pos = save;
    if (prot === MAP_RW) mappings(t).set(addr, { f, pos: Number(pos), len: Number(len) });
    return BigInt(addr);
  },
  [`${UFD}unmap0(JJ)I`]: (t: JThread, [addr]: any[]) => {
    const m = mappings(t).get(Number(addr));
    if (m) writeBack(t, m, Number(addr), Number(addr), m.len);
    mappings(t).delete(Number(addr));
    t.vm.mem.freeBlock(Number(addr));
    return 0;
  },
  // the range starts at a page boundary, which can be before a mapping here
  "java/nio/MappedMemoryUtils.force0(Ljava/io/FileDescriptor;JJ)V": (t: JThread, [, addr, len]: any[]) => {
    const from = Number(addr), to = from + Number(len);
    for (const [base, m] of mappings(t)) {
      const start = Math.max(from, base), end = Math.min(to, base + m.len);
      if (start < end) writeBack(t, m, base, start, end - start);
    }
  },
  "java/nio/MappedMemoryUtils.isLoaded0(JJJ)Z": () => 1,
  "java/nio/MappedMemoryUtils.load0(JJ)V": () => undefined,
  "java/nio/MappedMemoryUtils.unload0(JJ)V": () => undefined,
  [`${UFD}setDirect0(Ljava/io/FileDescriptor;)I`]: () => -1,
  "sun/nio/ch/FileDispatcherImpl.init0()V": () => undefined,
  "sun/nio/ch/FileDispatcherImpl.transferTo0(Ljava/io/FileDescriptor;JJLjava/io/FileDescriptor;Z)J": () => BigInt(UNSUPPORTED_CASE),
  "sun/nio/ch/FileDispatcherImpl.transferFrom0(Ljava/io/FileDescriptor;Ljava/io/FileDescriptor;JJZ)J": () => BigInt(UNSUPPORTED_CASE),
  "sun/nio/ch/NativeThread.init()V": () => undefined,
  "sun/nio/ch/NativeThread.supportPendingSignals0()Z": () => 0,
  "sun/nio/ch/FileKey.init(Ljava/io/FileDescriptor;[J)V": (t: JThread, [fd, info]: any[]) => {
    const f = chanFile(t, fd);
    info.a[0] = 1n;
    info.a[1] = BigInt(inode(t, f.path));
  },
  "sun/nio/ch/UnixDispatcher.init()V": () => undefined,
  "sun/nio/ch/UnixDispatcher.preClose0(Ljava/io/FileDescriptor;)V": (t: JThread, [fd]: any[]) => preCloseSock(t.vm.state, fdNum(t, fd)),
  "sun/nio/ch/UnixDispatcher.close0(Ljava/io/FileDescriptor;)V": (t: JThread, [fd]: any[]) => {
    closeFd(t, fdNum(t, fd));
    t.vm.setField(fd, FD, "fd", -1);
  },
});
