// Virtual file system the Java side sees. Paths are absolute and use "/".

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
}

// The same in every mount layout, so SecureRandom and the like work in the
// browser too. Host devices are never touched.
export const DEVICES = new Set(["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"]);

export interface FileHandle {
  size(): number;
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
  setMtime?(path: string, ms: number): boolean;
  // whether the host refuses to write the file, or to create it when it is missing
  denied?(path: string): boolean;
  // sets the permission bits to f(current bits)
  chmod?(path: string, f: (mode: number) => number): boolean;
  chmodError?(path: string): string | undefined;
  // whether the host allows reading (4) and executing (1), as access(2)
  access?(path: string, mode: number): boolean;
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
    return null;
  }

  private isMountPoint(path: string) {
    const p = normalize(path);
    return this.mounts.some((m) => m.prefix === p);
  }

  read(path: string): Uint8Array | null {
    if (DEVICES.has(normalize(path))) return null;
    const r = this.resolve(path);
    return r ? r[0].read(r[1]) : null;
  }

  openFile(path: string, write: boolean, truncate: boolean, readable: boolean): FileHandle | undefined {
    const r = this.resolve(path);
    if (!r || !r[0].writable || !r[0].openFile) return undefined;
    return r[0].openFile(r[1], write, truncate, readable);
  }

  // Whether part of a file can be read without reading all of it.
  canReadRange(path: string): boolean {
    const r = this.resolve(path);
    return !!r && !!r[0].readRange && (r[0].canReadRange?.(r[1]) ?? true);
  }

  readRange(path: string, off: number, len: number): Uint8Array | null {
    const r = this.resolve(path);
    return r?.[0].readRange?.(r[1], off, len) ?? null;
  }

  list(path: string): string[] | null {
    const r = this.resolve(path);
    const own = r ? r[0].list(r[1]) : null;
    const extra = this.mountsUnder(path);
    if (!own && extra.length === 0) return this.stat(path)?.dir ? [] : null;
    const names = [...new Set([...(own ?? []), ...extra])];
    if (!this.hidden.length) return names;
    const dir = normalize(path);
    return names.filter((name) => !this.isHidden(dir === "/" ? `/${name}` : `${dir}/${name}`));
  }

  write(path: string, data: Uint8Array): boolean {
    const r = this.resolve(path);
    return !!r && r[0].writable && !!r[0].write?.(r[1], data);
  }

  writeError(path: string): string | undefined {
    const r = this.resolve(path);
    return r?.[0].writeError?.(r[1]);
  }

  mkdir(path: string): boolean {
    const r = this.resolve(path);
    return !!r && r[0].writable && !!r[0].mkdir?.(r[1]);
  }

  remove(path: string): boolean {
    const r = this.resolve(path);
    if (!r || !r[0].writable || !r[0].remove?.(r[1])) return false;
    this.setTimes.delete(normalize(path));
    return true;
  }

  rename(from: string, to: string): boolean {
    const a = this.resolve(from), b = this.resolve(to);
    if (!a || !b || a[0] !== b[0] || !a[0].writable || !a[0].rename?.(a[1], b[1])) return false;
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

  // A file system without its own figures reports 4 KB blocks and no space,
  // as Linux does for virtual file systems such as /proc.
  space(path: string): Space {
    const r = this.resolve(path);
    return (r && r[0].space?.(r[1])) ?? { bsize: 4096n, blocks: 0n, bfree: 0n, bavail: 0n };
  }

  // ns, when given, is the exact time asked for. Hosts keep times as floating
  // point seconds or milliseconds, which lose nanoseconds, so stat reports ns
  // for as long as the file keeps the time this set.
  setMtime(path: string, ms: number, ns?: bigint): boolean {
    const r = this.resolve(path);
    if (!r || !r[0].writable || !r[0].setMtime?.(r[1], ms)) return false;
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
