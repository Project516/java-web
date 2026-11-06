// Virtual file system the Java side sees. Paths are absolute and use "/".

import { sha256Bytes } from "./natives/crypto.ts";

export interface Space {
  bsize: bigint;
  blocks: bigint;
  bfree: bigint;
  bavail: bigint;
}

export interface Stat {
  dir: boolean;
  size: number;
  mtime: number;
  // the modification time in nanoseconds, when it was set with more precision
  // than mtime keeps
  mtimeNs?: bigint;
  // permission and special bits, when the backend can report them
  mode?: number;
  // a character device; it streams and is never read whole
  device?: boolean;
  // lstat of a symbolic link: the length of its target, which is also its size
  link?: number;
  // the host's inode number and link count, so hard links and links to a file share a key
  ino?: number;
  nlink?: number;
}

// The same in every mount layout, so SecureRandom and the like work in the
// browser too. Host devices are never touched.
export const DEVICES = new Set(["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"]);

// Errors carry an errno name in `code`, as Node's do.
export interface FileHandle {
  size(): number;
  ino(): number;
  read(dst: Uint8Array, off: number, len: number, pos: number): number;
  write(src: Uint8Array, pos: number): void;
  truncate(size: number): void;
  close(): void;
}

export interface Backend {
  readonly writable: boolean;
  openFile?(path: string, write: boolean, truncate: boolean, readable: boolean): FileHandle;
  // A host backend can follow symlinks before resolving parent components.
  resolvePath?(path: string): string | null;
  stat(path: string): Stat | null;
  read(path: string): Uint8Array | null;
  // bytes [off, off + len) of a file, for backends that can read part of one
  readRange?(path: string, off: number, len: number): Uint8Array | null;
  canReadRange?(path: string): boolean;
  list(path: string): string[] | null;
  write?(path: string, data: Uint8Array): boolean;
  // the errno code (such as "ENOSPC") of the last failed write to path
  writeError?(path: string): string | undefined;
  mkdir?(path: string): boolean;
  remove?(path: string): boolean;
  rename?(from: string, to: string): boolean;
  // the file system holding path: block size and block counts, as statvfs gives them
  space?(path: string): Space | null;
  // sets the modification time, in milliseconds since the epoch
  setMtime?(path: string, ms: number, noFollow?: boolean): boolean;
  // whether the host refuses to write the file, or to create it when it is missing
  denied?(path: string): boolean;
  // sets the permission bits to f(current bits)
  chmod?(path: string, f: (mode: number) => number): boolean;
  chmodError?(path: string): string | undefined;
  // whether the host allows reading (4) and executing (1), as access(2)
  access?(path: string, mode: number): boolean;
  // symbolic and hard links, for a host that has them; failures return the errno code
  lstat?(path: string): Stat | null;
  readlink?(path: string): { target: string } | { code: string };
  symlink?(target: string, path: string): string | undefined;
  link?(existing: string, path: string): string | undefined;
  // the path with every link resolved, where the missing tail stays as written
  realpath?(path: string): string | null;
}

export interface WarmTrace {
  reads: [string, string][];
  missing: string[];
  lists: [string, string[] | null][];
}

const TRACE_LIMIT = 128 << 10;

function digest(data: Uint8Array): string {
  return sha256Bytes(data);
}

export function normalize(path: string): string {
  if (path.length > 1 && path[0] === "/" && !path.endsWith("/") && !path.endsWith("/.") && !path.endsWith("/..") &&
    !path.includes("//") && !path.includes("/./") && !path.includes("/../")) return path;
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export class VFS {
  // path -> the time a VM set, and the mtime the backend reported right after
  private setTimes = new Map<string, { ms: number; ns: bigint }>();
  private mounts: { prefix: string; backend: Backend }[] = [];
  private hidden: string[] = [];
  private warmTrace: WarmTrace | null = null;
  private warmTraceSize = 0;
  private warmTraceTooLarge = false;
  // paths the VM itself changed while tracing: saved as they are at save time
  private warmChanged: Set<string> | null = null;

  beginWarmTrace(): boolean {
    if (this.warmTrace) return false;
    this.warmTrace = { reads: [], missing: [], lists: [] };
    this.warmChanged = new Set();
    this.warmTraceSize = 0;
    this.warmTraceTooLarge = false;
    return true;
  }

  endWarmTrace(): WarmTrace | null {
    const trace = this.warmTraceTooLarge ? null : this.warmTrace;
    this.warmTrace = null;
    this.warmChanged = null;
    this.warmTraceTooLarge = false;
    return trace;
  }

  // What the traced paths hold now. A later start checks against this, so a
  // file the warm-up wrote itself (javac's output) does not count as changed.
  peekWarmTrace(): WarmTrace | null {
    if (!this.warmTrace || this.warmTraceTooLarge) return null;
    const changed = this.warmChanged!;
    const touched = (p: string) => changed.has(p) || [...changed].some((c) => c.startsWith(p === "/" ? "/" : p + "/"));
    const trace: WarmTrace = { reads: [], missing: [], lists: [] };
    const tracing = this.warmTrace;
    this.warmTrace = null;
    try {
      for (const [p, hash] of tracing.reads) {
        if (!changed.has(p)) trace.reads.push([p, hash]);
        else {
          const now = this.read(p);
          if (now) trace.reads.push([p, digest(now)]);
          else trace.missing.push(p);
        }
      }
      for (const p of tracing.missing) {
        const now = changed.has(p) ? this.read(p) : null;
        if (now) trace.reads.push([p, digest(now)]);
        // a directory the warm-up made itself needs no check
        else if (!changed.has(p) || !this.stat(p)) trace.missing.push(p);
      }
      for (const [p, names] of tracing.lists) trace.lists.push([p, touched(p) ? this.list(p) : names]);
    } finally {
      this.warmTrace = tracing;
    }
    return trace;
  }

  recordWarmFile(path: string) {
    if (!this.warmTrace || path === "/jdk" || path.startsWith("/jdk/")) return;
    if (!this.read(path)) this.warmTraceTooLarge = true;
  }

  private traceMissing(path: string) {
    if (!this.warmTrace || this.warmTraceTooLarge) return;
    path = normalize(path);
    if (path === "/jdk" || path.startsWith("/jdk/")) return;
    if (this.warmTrace.missing.includes(path)) return;
    this.warmTraceSize += path.length;
    if (this.warmTraceSize > TRACE_LIMIT) this.warmTraceTooLarge = true;
    this.warmTrace.missing.push(path);
  }

  private traceRead(path: string, data: Uint8Array | null) {
    if (!this.warmTrace || this.warmTraceTooLarge) return;
    path = normalize(path);
    if (!data) return this.traceMissing(path);
    if (path === "/jdk" || path.startsWith("/jdk/")) return;
    const reads = this.warmTrace.reads;
    const old = reads.find(([p]) => p === path);
    const hash = digest(data);
    // a file that changed while the warm-up ran cannot be checked later
    if (old) {
      if (old[1] !== hash) this.warmTraceTooLarge = true;
      return;
    }
    this.warmTraceSize += path.length + hash.length;
    if (this.warmTraceSize > TRACE_LIMIT) { this.warmTraceTooLarge = true; return; }
    reads.push([path, hash]);
  }

  validateWarmTrace(trace: WarmTrace): boolean {
    return this.warmTraceMismatch(trace) === null;
  }

  warmTraceMismatch(trace: WarmTrace): string | null {
    for (const [path, hash] of trace.reads) {
      if (this.warmTraceDigest(path) !== hash) return `file changed: ${path}`;
    }
    for (const path of trace.missing) if (this.stat(path) !== null) return `path appeared: ${path}`;
    for (const [path, names] of trace.lists) {
      const now = this.list(path);
      if (now === null ? names !== null : names === null || now.length !== names.length || now.some((n, i) => n !== names[i])) return `directory changed: ${path}`;
    }
    return null;
  }

  private warmTraceDigest(path: string): string | null {
    const data = this.read(path);
    return data ? digest(data) : null;
  }

  private watchers = new Set<(path: string, event: "create" | "modify" | "delete") => void>();

  watchChanges(watcher: (path: string, event: "create" | "modify" | "delete") => void): () => void {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  private changed(path: string, event: "create" | "modify" | "delete") {
    this.changedNormalized(normalize(path), event);
  }

  private changedNormalized(path: string, event: "create" | "modify" | "delete") {
    for (const watcher of this.watchers) watcher(path, event);
    this.warmChanged?.add(path);
  }

  resolvePath(path: string): string {
    const normalized = normalize(path);
    if (!path.includes("/..")) return normalized;
    const r = this.resolve(normalized);
    if (!r?.[0].resolvePath) return normalized;
    const prefix = r[1] === "/" && normalized !== "/" ? normalized : normalized.slice(0, normalized.length - r[1].length);
    const raw = prefix === "" ? path : path.startsWith(prefix + "/") ? path.slice(prefix.length) : r[1];
    const resolved = r[0].resolvePath(raw);
    return resolved === null ? normalized : normalize(prefix + resolved);
  }

  mount(prefix: string, backend: Backend) {
    prefix = normalize(prefix);
    this.mounts.push({ prefix, backend });
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  // Leaves a tree out, as if it were not there.
  hide(path: string) {
    this.hidden.push(normalize(path));
  }

  private isHidden(path: string): boolean {
    return this.hidden.some((h) => path === h || path.startsWith(h + "/"));
  }

  private resolve(path: string): [Backend, string] | null {
    path = normalize(path);
    if (this.hidden.length && this.isHidden(path)) return null;
    for (const { prefix, backend } of this.mounts) {
      if (prefix === "/") return [backend, path];
      if (path === prefix) return [backend, "/"];
      if (path.startsWith(prefix + "/")) return [backend, path.slice(prefix.length)];
    }
    return null;
  }

  // mount points directly under path show up as directories
  private mountsUnder(path: string): string[] {
    const p = normalize(path);
    const names: string[] = [];
    for (const { prefix } of this.mounts) {
      if (prefix === p || prefix === "/") continue;
      const parent = prefix.slice(0, prefix.lastIndexOf("/")) || "/";
      if (parent === p) names.push(prefix.slice(prefix.lastIndexOf("/") + 1));
    }
    return names;
  }

  stat(path: string): Stat | null {
    const n = normalize(path);
    if (DEVICES.has(n)) return { dir: false, size: 0, mtime: 0, device: true };
    if (n === "/dev") return { dir: true, size: 0, mtime: 0 };
    if (this.hidden.length && this.isHidden(n)) return null;
    const r = this.resolve(path);
    const s = r ? r[0].stat(r[1]) : null;
    if (s) {
      const set = this.setTimes.get(n);
      if (set?.ms === s.mtime) return { ...s, mtimeNs: set.ns };
      if (set) this.setTimes.delete(n);
      return s;
    }
    if (normalize(path) === "/" || this.mountsUnder(path).length > 0 || this.isMountPoint(path)) {
      return { dir: true, size: 0, mtime: 0 };
    }
    this.traceMissing(n);
    return null;
  }

  private isMountPoint(path: string) {
    const p = normalize(path);
    return this.mounts.some((m) => m.prefix === p);
  }

  read(path: string): Uint8Array | null {
    if (DEVICES.has(normalize(path))) return null;
    const r = this.resolve(path);
    const data = r ? r[0].read(r[1]) : null;
    this.traceRead(path, data);
    return data;
  }

  canOpenFile(path: string, write: boolean): boolean {
    const r = this.resolve(path);
    return !!r && (!write || r[0].writable) && !!r[0].openFile;
  }

  openFile(path: string, write: boolean, truncate: boolean, readable: boolean): FileHandle | undefined {
    const r = this.resolve(path);
    if (!r || ((write || truncate) && !r[0].writable) || !r[0].openFile) return undefined;
    const h = r[0].openFile(r[1], write, truncate, readable);
    // writes through the handle are changes watchers see, as writes through VFS.write are
    const changed = normalize(path);
    return {
      size: () => h.size(),
      ino: () => h.ino(),
      read: (dst, off, len, pos) => h.read(dst, off, len, pos),
      close: () => h.close(),
      write: (src, pos) => { h.write(src, pos); this.changedNormalized(changed, "modify"); },
      truncate: (size) => { h.truncate(size); this.changedNormalized(changed, "modify"); },
    };
  }

  // Whether part of a file can be read without reading all of it.
  canReadRange(path: string): boolean {
    const r = this.resolve(path);
    return !!r && !!r[0].readRange && (r[0].canReadRange?.(r[1]) ?? true);
  }

  readRange(path: string, off: number, len: number): Uint8Array | null {
    const r = this.resolve(path);
    const data = r?.[0].readRange?.(r[1], off, len) ?? null;
    if (this.warmTrace && !path.startsWith("/jdk/") && !this.warmTrace.reads.some(([p]) => p === normalize(path))) this.traceRead(path, r?.[0].read(r[1]) ?? null);
    return data;
  }

  list(path: string): string[] | null {
    const r = this.resolve(path);
    const own = r ? r[0].list(r[1]) : null;
    const extra = this.mountsUnder(path);
    if (!own && extra.length === 0) {
      const absent = this.stat(path)?.dir ? [] : null;
      this.traceList(path, absent);
      return absent;
    }
    const names = [...new Set([...(own ?? []), ...extra])];
    if (!this.hidden.length) {
      this.traceList(path, names);
      return names;
    }
    const dir = normalize(path);
    const visible = names.filter((name) => !this.isHidden(dir === "/" ? `/${name}` : `${dir}/${name}`));
    this.traceList(path, visible);
    return visible;
  }

  private traceList(path: string, names: string[] | null) {
    if (!this.warmTrace || this.warmTraceTooLarge) return;
    path = normalize(path);
    if (path === "/jdk" || path.startsWith("/jdk/")) return;
    if (this.warmTrace.lists.some(([p]) => p === path)) return;
    this.warmTraceSize += path.length + (names?.reduce((n, x) => n + x.length, 0) ?? 0);
    if (this.warmTraceSize > TRACE_LIMIT) { this.warmTraceTooLarge = true; return; }
    this.warmTrace.lists.push([path, names?.slice() ?? null]);
  }

  write(path: string, data: Uint8Array): boolean {
    const r = this.resolve(path);
    if (!r || !r[0].writable) return false;
    const exists = !!r[0].stat(r[1]);
    if (!r[0].write?.(r[1], data)) return false;
    this.changed(path, exists ? "modify" : "create");
    return true;
  }

  writeError(path: string): string | undefined {
    const r = this.resolve(path);
    return r?.[0].writeError?.(r[1]);
  }

  mkdir(path: string): boolean {
    const r = this.resolve(path);
    if (!r || !r[0].writable || !r[0].mkdir?.(r[1])) return false;
    this.changed(path, "create");
    return true;
  }

  remove(path: string): boolean {
    const r = this.resolve(path);
    if (!r || !r[0].writable || !r[0].remove?.(r[1])) return false;
    this.setTimes.delete(normalize(path));
    this.changed(path, "delete");
    return true;
  }

  rename(from: string, to: string): boolean {
    const a = this.resolve(from), b = this.resolve(to);
    if (!a || !b || a[0] !== b[0] || !a[0].writable || !a[0].rename?.(a[1], b[1])) return false;
    this.changed(from, "delete");
    this.changed(to, "create");
    // set times move with the files, which keep their times
    const src = normalize(from), dst = normalize(to);
    const under = (p: string, root: string) => p === root || p.startsWith(root + "/");
    const moved = [...this.setTimes].filter(([p]) => under(p, src));
    for (const p of [...this.setTimes.keys()]) if (under(p, src) || under(p, dst)) this.setTimes.delete(p);
    for (const [p, set] of moved) this.setTimes.set(dst + p.slice(src.length), set);
    return true;
  }

  writable(path: string): boolean {
    const r = this.resolve(path);
    return !!r && r[0].writable;
  }

  // like stat, but a symbolic link reports itself
  lstat(path: string): Stat | null {
    const r = this.resolve(path);
    return (r && r[0].lstat?.(r[1])) || this.stat(path);
  }

  readlink(path: string): { target: string } | { code: string } {
    const r = this.resolve(path);
    return r?.[0].readlink?.(r[1]) ?? { code: this.stat(path) ? "EINVAL" : "ENOENT" };
  }

  // undefined on success, else the errno code; ENOSYS where the backend has no links
  symlink(target: string, path: string): string | undefined {
    const r = this.resolve(path);
    if (!r || !r[0].writable || !r[0].symlink) return "ENOSYS";
    const code = r[0].symlink(target, r[1]);
    if (!code) this.changed(path, "create");
    return code;
  }

  link(existing: string, path: string): string | undefined {
    const a = this.resolve(existing), b = this.resolve(path);
    if (!a || !b || a[0] !== b[0] || !b[0].writable || !b[0].link) return "ENOSYS";
    const code = b[0].link(a[1], b[1]);
    if (!code) this.changed(path, "create");
    return code;
  }

  realpath(path: string): string | null {
    const r = this.resolve(path);
    if (!r?.[0].realpath) return null;
    const real = r[0].realpath(r[1]);
    if (real === null) return null;
    const n = normalize(path);
    // a mount point itself maps to "/" in its backend
    const base = n.slice(0, n.length - (r[1] === "/" ? 0 : r[1].length));
    return normalize(base + real);
  }

  // A file system without its own figures reports 4 KB blocks and no space,
  // as Linux does for virtual file systems such as /proc.
  space(path: string): Space {
    const r = this.resolve(path);
    return (r && r[0].space?.(r[1])) ?? { bsize: 4096n, blocks: 0n, bfree: 0n, bavail: 0n };
  }

  // ns, when given, is the exact time asked for. Hosts keep times as floating
  // point seconds or milliseconds, which lose nanoseconds, so stat reports ns
  // for as long as the file keeps the time this set.
  setMtime(path: string, ms: number, ns?: bigint, noFollow = false): boolean {
    const r = this.resolve(path);
    if (!r || !r[0].writable || !r[0].setMtime?.(r[1], ms, noFollow)) return false;
    this.changed(path, "modify");
    if (noFollow) return true;
    const n = normalize(path);
    const st = ns === undefined ? null : r[0].stat(r[1]);
    // only a time the host kept, give or take its rounding; a host can clamp it
    if (st && Math.abs(st.mtime - ms) < 1) this.setTimes.set(n, { ms: st.mtime, ns: ns! });
    else this.setTimes.delete(n);
    return true;
  }

  denied(path: string): boolean {
    const r = this.resolve(path);
    return !!r && r[0].writable && !!r[0].denied?.(r[1]);
  }

  // undefined when the backend has no permission bits
  chmod(path: string, f: (mode: number) => number): boolean | undefined {
    if (DEVICES.has(normalize(path))) return false;
    const r = this.resolve(path);
    if (!r || !r[0].chmod) return undefined;
    return r[0].writable && r[0].chmod(r[1], f);
  }

  chmodError(path: string): string | undefined {
    const r = this.resolve(path);
    return r?.[0].chmodError?.(r[1]);
  }

  // access(2) on an existing path: mode is 4 read, 2 write, 1 execute
  access(path: string, mode: number): boolean {
    if (DEVICES.has(normalize(path))) return true;
    const r = this.resolve(path);
    if (!r) return false;
    if (mode & 2 && (!r[0].writable || r[0].denied?.(r[1]))) return false;
    return !(mode & 5) || (r[0].access?.(r[1], mode & 5) ?? true);
  }
}

// Writable in-memory tree, for /tmp, /files and strings added by the page.
export interface MemoryEntry {
  data: Uint8Array;
  mtime: number;
}

export class MemoryBackend implements Backend {
  readonly writable = true;
  private files = new Map<string, MemoryEntry>();
  private dirs = new Set<string>(["/"]);
  // told about every change: a file entry, "dir" for a new directory, null when removed
  onChange: ((path: string, entry: MemoryEntry | "dir" | null) => void) | null = null;

  private changed(path: string, entry: MemoryEntry | "dir" | null) {
    this.onChange?.(path, entry);
  }

  stat(path: string): Stat | null {
    const f = this.files.get(path);
    if (f) return { dir: false, size: f.data.length, mtime: f.mtime };
    return this.dirs.has(path) ? { dir: true, size: 0, mtime: 0 } : null;
  }

  read(path: string) {
    return this.files.get(path)?.data ?? null;
  }

  list(path: string): string[] | null {
    if (!this.dirs.has(path)) return null;
    const prefix = path === "/" ? "/" : path + "/";
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p.startsWith(prefix) && p !== path) names.add(p.slice(prefix.length).split("/")[0]);
    }
    return [...names];
  }

  write(path: string, data: Uint8Array) {
    if (!this.dirs.has(parentOf(path)) || this.dirs.has(path)) return false;
    const entry = { data, mtime: Date.now() };
    this.files.set(path, entry);
    this.changed(path, entry);
    return true;
  }

  mkdir(path: string) {
    if (this.stat(path) || !this.dirs.has(parentOf(path))) return false;
    this.dirs.add(path);
    this.changed(path, "dir");
    return true;
  }

  remove(path: string) {
    const ok = this.files.delete(path) ||
      (path !== "/" && this.dirs.has(path) && this.list(path)!.length === 0 && this.dirs.delete(path));
    if (ok) this.changed(path, null);
    return ok;
  }

  rename(from: string, to: string) {
    const f = this.files.get(from);
    if (!f || this.dirs.has(to) || !this.dirs.has(parentOf(to))) return false;
    this.files.delete(from);
    this.files.set(to, f);
    this.changed(from, null);
    this.changed(to, f);
    return true;
  }

  // directories keep no time
  setMtime(path: string, ms: number) {
    const f = this.files.get(path);
    if (!f) return this.dirs.has(path);
    const entry = { data: f.data, mtime: ms };
    this.files.set(path, entry);
    this.changed(path, entry);
    return true;
  }

  // creates parent directories as needed
  put(path: string, data: Uint8Array, mtime = Date.now()) {
    path = normalize(path);
    const parts = path.split("/").slice(1, -1);
    let dir = "";
    for (const p of parts) {
      dir += "/" + p;
      if (!this.dirs.has(dir)) {
        this.dirs.add(dir);
        this.changed(dir, "dir");
      }
    }
    const entry = { data, mtime };
    this.files.set(path, entry);
    this.changed(path, entry);
  }

  // adds a directory and its parents
  putDir(path: string) {
    let dir = "";
    for (const p of normalize(path).split("/").slice(1)) {
      dir += "/" + p;
      if (!this.dirs.has(dir)) {
        this.dirs.add(dir);
        this.changed(dir, "dir");
      }
    }
  }
}

function parentOf(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
