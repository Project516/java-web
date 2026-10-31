// Virtual file system the Java side sees. Paths are absolute and use "/".

export interface Stat {
  dir: boolean;
  size: number;
  mtime: number;
  // a character device; it streams and is never read whole
  device?: boolean;
}

// The same in every mount layout, so SecureRandom and the like work in the
// browser too. Host devices are never touched.
export const DEVICES = new Set(["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"]);

export interface Backend {
  readonly writable: boolean;
  stat(path: string): Stat | null;
  read(path: string): Uint8Array | null;
  // bytes [off, off + len) of a file, for backends that can read part of one
  readRange?(path: string, off: number, len: number): Uint8Array | null;
  list(path: string): string[] | null;
  write?(path: string, data: Uint8Array): boolean;
  mkdir?(path: string): boolean;
  remove?(path: string): boolean;
  rename?(from: string, to: string): boolean;
  // sets the modification time, in milliseconds since the epoch
  setMtime?(path: string, ms: number): boolean;
  // whether the host refuses to write the file, or to create it when it is missing
  denied?(path: string): boolean;
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
  private mounts: { prefix: string; backend: Backend }[] = [];
  private hidden: string[] = [];

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
    if (s) return s;
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

  // Whether part of a file can be read without reading all of it.
  canReadRange(path: string): boolean {
    const r = this.resolve(path);
    return !!r && !!r[0].readRange;
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

  mkdir(path: string): boolean {
    const r = this.resolve(path);
    return !!r && r[0].writable && !!r[0].mkdir?.(r[1]);
  }

  remove(path: string): boolean {
    const r = this.resolve(path);
    return !!r && r[0].writable && !!r[0].remove?.(r[1]);
  }

  rename(from: string, to: string): boolean {
    const a = this.resolve(from), b = this.resolve(to);
    if (!a || !b || a[0] !== b[0] || !a[0].writable) return false;
    return !!a[0].rename?.(a[1], b[1]);
  }

  writable(path: string): boolean {
    const r = this.resolve(path);
    return !!r && r[0].writable;
  }

  setMtime(path: string, ms: number): boolean {
    const r = this.resolve(path);
    return !!r && r[0].writable && !!r[0].setMtime?.(r[1], ms);
  }

  denied(path: string): boolean {
    const r = this.resolve(path);
    return !!r && r[0].writable && !!r[0].denied?.(r[1]);
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
    if (!f || !this.dirs.has(parentOf(to))) return false;
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
