// Node entry: java-web [-cp path] [-Dk=v] [--debug] Main [args] | -jar app.jar [args]

import { isAssertionFlag, parseAssertions } from "./assertions.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deserialize, serialize, setFlagsFromString } from "node:v8";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VFS } from "./fs.ts";
import type { Backend, Stat } from "./fs.ts";
import { Bridge, nativeTable } from "./bridge.ts";
import { JVM, LM_CLASS, LM_JAR, SnapshotError } from "./jvm.ts";
import type { SnapshotImage, WarmSnapshotImage } from "./snapshot.ts";
import { hostNatives } from "./hostnatives.ts";
import { ImageBackend, imageFd } from "./image.ts";
import { NodeNet } from "./net-node.ts";
import { processNatives } from "./process-node.ts";
import { PendingThrow } from "./thread.ts";
import { heapSize } from "./heapsize.ts";
import { clearAllocationCheck, hasMaxHeap, MAX_HEAP, resetAllocationCheck, setAllocationCheck, setMaxHeap } from "./runtime.ts";
import type { NetBackend } from "./sockets.ts";

// A host directory exposed read-only (or writable) inside the VFS.
const MAX_FILE = 512 << 20;

export class NodeBackend implements Backend {
  readonly root: string;
  readonly writable: boolean;
  constructor(root: string, writable = false) {
    this.root = path.resolve(root);
    this.writable = writable;
  }
  // read-only trees, like the JDK image, do not change while a VM runs
  private stats = new Map<string, Stat | null>();
  private lists = new Map<string, string[] | null>();
  // p is a normalized VFS path
  private host(p: string) {
    return this.root === "/" ? p : this.root + p;
  }
  openFile(p: string, write: boolean, truncate: boolean, readable: boolean) {
    const flags = write ? (readable ? fs.constants.O_RDWR : fs.constants.O_WRONLY) | fs.constants.O_CREAT | (truncate ? fs.constants.O_TRUNC : 0) : fs.constants.O_RDONLY;
    let fd: number;
    try {
      const host = this.host(p);
      const stat = fs.statSync(host, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) throw Object.assign(new Error("Not a regular file"), { code: "EOPNOTSUPP" });
      fd = fs.openSync(host, flags | fs.constants.O_NONBLOCK, 0o666);
      if (!fs.fstatSync(fd).isFile()) {
        fs.closeSync(fd);
        throw Object.assign(new Error("Not a regular file"), { code: "EOPNOTSUPP" });
      }
    }
    catch (e) {
      this.writeFailure = [p, (e as NodeJS.ErrnoException).code ?? "EIO"];
      throw e;
    }
    return {
      size: () => fs.fstatSync(fd).size,
      read: (dst: Uint8Array, off: number, len: number, pos: number) => fs.readSync(fd, dst, off, len, pos),
      write: (src: Uint8Array, pos: number) => {
        let n = 0;
        while (n < src.length) n += fs.writeSync(fd, src, n, src.length - n, pos + n);
      },
      truncate: (size: number) => fs.ftruncateSync(fd, size),
      close: () => fs.closeSync(fd),
    };
  }
  resolvePath(p: string): string | null {
    if (this.root !== "/") return null;
    try {
      const name = path.basename(p);
      if (name === "." || name === "..") return fs.realpathSync.native(p);
      return fs.realpathSync.native(path.dirname(p)) + "/" + name;
    } catch {
      return null;
    }
  }
  stat(p: string): Stat | null {
    if (!this.writable && this.stats.has(p)) return this.stats.get(p)!;
    let st: Stat | null = null;
    try {
      const s = fs.statSync(this.host(p));
      st = { dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs, mode: s.mode & 0o7777, ino: s.ino, nlink: s.nlink };
    } catch {
      st = null;
    }
    if (!this.writable) this.stats.set(p, st);
    return st;
  }
  lstat(p: string): Stat | null {
    try {
      const s = fs.lstatSync(this.host(p));
      if (!s.isSymbolicLink()) return null;
      return { dir: false, size: s.size, mtime: s.mtimeMs, mode: s.mode & 0o7777, link: s.size, ino: s.ino, nlink: s.nlink };
    } catch {
      return null;
    }
  }
  readlink(p: string) {
    try {
      return { target: fs.readlinkSync(this.host(p)) };
    } catch (e) {
      return { code: (e as NodeJS.ErrnoException).code ?? "EIO" };
    }
  }
  symlink(target: string, p: string) {
    try {
      fs.symlinkSync(target, this.host(p));
    } catch (e) {
      return (e as NodeJS.ErrnoException).code ?? "EIO";
    }
  }
  link(existing: string, p: string) {
    try {
      fs.linkSync(this.host(existing), this.host(p));
    } catch (e) {
      return (e as NodeJS.ErrnoException).code ?? "EIO";
    }
  }
  realpath(p: string) {
    const host = this.host(p);
    const rest: string[] = [];
    for (let dir = host; ; dir = path.dirname(dir)) {
      try {
        const real = fs.realpathSync.native(dir);
        const full = path.join(real, ...rest);
        return this.root === "/" ? full : full.startsWith(this.root) ? full.slice(this.root.length) || "/" : null;
      } catch (e) {
        if (dir === path.dirname(dir) || (e as NodeJS.ErrnoException).code === "EACCES") return null;
        rest.unshift(path.basename(dir));
      }
    }
  }
  // Only regular files: readFileSync on a device or pipe can grow without end.
  read(p: string) {
    try {
      const s = fs.statSync(this.host(p));
      if (!s.isFile() || s.size > MAX_FILE) return null;
      return new Uint8Array(fs.readFileSync(this.host(p)));
    } catch {
      return null;
    }
  }
  // Other open files keep their buffered contents even if the host removes them.
  canReadRange(p: string) { return !this.writable && p === "/lib/modules"; }
  // this VM's descriptor of the JDK image
  private imageFd: number | undefined;
  readRange(p: string, off: number, len: number): Uint8Array | null {
    const image = p === "/lib/modules" && !this.writable;
    try {
      const fd = image ? (this.imageFd ??= imageFd(this.host(p))) : fs.openSync(this.host(p), "r");
      try {
        if (!image && !fs.fstatSync(fd).isFile()) return null;
        const out = new Uint8Array(len);
        let n = 0;
        while (n < len) {
          const got = fs.readSync(fd, out, n, len - n, off + n);
          if (!got) break;
          n += got;
        }
        return out.subarray(0, n);
      } finally {
        if (!image) fs.closeSync(fd);
      }
    } catch { return null; }
  }
  list(p: string) {
    if (!this.writable && this.lists.has(p)) return this.lists.get(p)!;
    let names: string[] | null;
    try {
      names = fs.readdirSync(this.host(p));
    } catch {
      names = null;
    }
    if (!this.writable) this.lists.set(p, names);
    return names;
  }
  // the host's reason for the last failed write, read right after it
  private writeFailure: [string, string] | null = null;
  write(p: string, data: Uint8Array) {
    try {
      fs.writeFileSync(this.host(p), data);
      this.writeFailure = null;
      return true;
    } catch (e) {
      this.writeFailure = [p, (e as NodeJS.ErrnoException).code ?? "EIO"];
      return false;
    }
  }
  writeError(p: string) {
    return this.writeFailure?.[0] === p ? this.writeFailure[1] : undefined;
  }
  denied(p: string) {
    const host = this.host(p);
    try {
      fs.accessSync(fs.existsSync(host) ? host : path.dirname(host), fs.constants.W_OK);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EACCES" || (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  private chmodFailure: [string, string] | null = null;
  chmod(p: string, f: (mode: number) => number) {
    try {
      fs.chmodSync(this.host(p), f(fs.statSync(this.host(p)).mode & 0o7777));
      this.chmodFailure = null;
      return true;
    } catch (e) {
      this.chmodFailure = [p, (e as NodeJS.ErrnoException).code ?? "EIO"];
      return false;
    }
  }
  chmodError(p: string) {
    return this.chmodFailure?.[0] === p ? this.chmodFailure[1] : undefined;
  }
  access(p: string, mode: number) {
    try {
      fs.accessSync(this.host(p), mode);
      return true;
    } catch {
      return false;
    }
  }
  space(p: string) {
    try {
      const s = fs.statfsSync(this.host(p), { bigint: true });
      return { bsize: s.bsize, blocks: s.blocks, bfree: s.bfree, bavail: s.bavail };
    } catch {
      return null;
    }
  }
  setMtime(p: string, ms: number, noFollow = false) {
    try {
      if (noFollow) fs.lutimesSync(this.host(p), fs.lstatSync(this.host(p)).atime, ms / 1000);
      else fs.utimesSync(this.host(p), fs.statSync(this.host(p)).atime, ms / 1000);
      return true;
    } catch {
      return false;
    }
  }
  mkdir(p: string) {
    try {
      fs.mkdirSync(this.host(p));
      return true;
    } catch {
      return false;
    }
  }
  // like unlink or rmdir: a directory must be empty
  remove(p: string) {
    try {
      if (fs.lstatSync(this.host(p)).isDirectory()) fs.rmdirSync(this.host(p));
      else fs.rmSync(this.host(p));
      return true;
    } catch {
      return false;
    }
  }
  rename(a: string, b: string) {
    try {
      fs.renameSync(this.host(a), this.host(b));
      return true;
    } catch {
      return false;
    }
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultJdk = path.join(here, "..", "build", "jdk");

export interface NodeRunOptions {
  classpath: string[];
  mainClass?: string;
  jar?: string;
  args?: string[];
  props?: Record<string, string>;
  // a JDK image instead of build/jdk (or, for dist/node.js, the packaged one)
  jdk?: string;
  debug?: boolean;
  stdout?: (b: Uint8Array) => void;
  stderr?: (b: Uint8Array) => void;
  // fixed stdin contents instead of the process stdin
  input?: Uint8Array;
  // native methods in JS as in CheerpJ: Java_pkg_Class_method(lib, ...args)
  natives?: Record<string, (lib: object, ...args: any[]) => unknown>;
  // -ea, -da:pkg..., -esa and the like
  assertions?: string[];
  // the process exits when its resident memory goes past this
  maxRssMb?: number;
  enablePreview?: boolean;
  // what InetAddress.getLocalHost() reports instead of the host's name
  hostName?: string;
  // what System.getenv() returns instead of the host's environment
  env?: Record<string, string>;
  // load jdk.localedata, the formats and names of locales other than English
  localeData?: boolean;
  // sockets and name lookup; host sockets by default
  net?: NetBackend;
  // loopback sockets whose http: requests go to this fetch, instead of host sockets
  fetch?: typeof fetch;
  // where boot snapshots are kept, or null for none; by default
  // JAVA_WEB_SNAPSHOT_DIR (empty for none), else java-web/snapshots in the user's cache
  snapshotDir?: string | null;
  // save and restore the library VM after its first idle call
  warmSnapshot?: boolean;
}

function fixedInput(data: Uint8Array) {
  let done = false;
  return async () => {
    if (done) return null;
    done = true;
    return data;
  };
}

const bridges = new WeakMap<object, Bridge>();

// The host file system is the VFS root, with the JDK image mounted at /jdk.
// System.gc() calls globalThis.gc, which node defines only under --expose-gc
function exposeGc() {
  const g = globalThis as { gc?: unknown };
  if (typeof g.gc === "function") return;
  // V8 aborts on a flag change once flags are frozen
  if (/(^|\s)--freeze-flags-after-init\b/.test([...process.execArgv, process.env.NODE_OPTIONS ?? ""].join(" "))) return;
  setFlagsFromString("--expose-gc");
  // absent when --expose-gc-as gave it another name
  const gc = runInNewContext("typeof gc === 'function' ? gc : undefined");
  if (gc) g.gc = gc;
}

// Once the reader goes away (a closed pipe), writes fail with an IOException as
// on HotSpot; without a listener, node exits on the stream's error event.
const broken = new Set<NodeJS.WriteStream>();
function hostOut(s: NodeJS.WriteStream) {
  if (!s.listeners("error").includes(onOutError)) s.on("error", onOutError);
  return (b: Uint8Array) => {
    if (broken.has(s)) throw new PendingThrow("java/io/IOException", "Broken pipe");
    s.write(b);
  };
}
function onOutError(this: NodeJS.WriteStream) {
  broken.add(this);
}

function defaultSnapshotDir(): string | null {
  const env = process.env.JAVA_WEB_SNAPSHOT_DIR;
  if (env !== undefined) return env || null;
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "java-web", "snapshots");
}

const KEEP_SNAPSHOTS = 16, KEEP_WARM_SNAPSHOTS = 2, KEEP_MARKERS = 256;

// set by the build of dist/node.js: names its code and image
declare const JAVA_WEB_BUILD: string;

// What a snapshot is valid for: the VM code and the java.home image. The
// packaged image is part of the build's ID; any other image needs the digest
// scripts/build-jdk.sh writes, and gets no snapshots without one.
function buildId(vfs: VFS, packaged: boolean): string | null {
  if (packaged) return typeof JAVA_WEB_BUILD === "string" ? JAVA_WEB_BUILD : null;
  const image = vfs.read("/jdk/lib/image.sha256");
  if (!image) return null;
  const h = createHash("sha256").update(image);
  if (typeof JAVA_WEB_BUILD === "string") return h.update(JAVA_WEB_BUILD).digest("hex");
  // unbundled, this file runs as src/node.ts, next to the rest of the VM's sources
  const src = path.dirname(fileURLToPath(import.meta.url));
  for (const f of fs.readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).sort()) {
    h.update(f).update(fs.readFileSync(path.join(src, f)));
  }
  return h.digest("hex");
}

// Boot snapshots kept in dir, one file per key. A key's snapshot is taken the
// second time it boots, so one-off setups leave only an empty marker.
function snapshotCache(dir: string, build: string) {
  const name = (key: string) => path.join(dir, createHash("sha256").update(key).digest("hex").slice(0, 32));
  const file = (key: string) => name(key) + ".snap";
  const warmFile = (key: string) => name(key) + ".warm";
  // keeps the most recently used of each kind
  const prune = (ext: string, keep: number) => {
    const old = fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f))
      .map((f) => ({ f, t: fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
      .sort((a, b) => b.t - a.t).slice(keep);
    for (const { f } of old) fs.rmSync(f, { force: true });
  };
  return {
    build,
    load: (key: string) => {
      try {
        const image = deserialize(fs.readFileSync(file(key)));
        const now = new Date();
        fs.utimesSync(file(key), now, now);
        return image;
      } catch {
        return null;
      }
    },
    wants: (key: string) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(name(key) + ".seen", "", { flag: "wx" });
        prune(".seen", KEEP_MARKERS);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EEXIST";
      }
    },
    drop: (key: string) => fs.rmSync(file(key), { force: true }),
    loadWarm: (key: string) => {
      try {
        const image = deserialize(fs.readFileSync(warmFile(key)));
        const now = new Date();
        fs.utimesSync(warmFile(key), now, now);
        return image as WarmSnapshotImage;
      } catch { return null; }
    },
    dropWarm: (key: string) => fs.rmSync(warmFile(key), { force: true }),
    saveWarm: (image: WarmSnapshotImage) => {
      const target = warmFile(image.warmKey), tmp = `${target}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, serialize(image));
        fs.renameSync(tmp, target);
      } finally { fs.rmSync(tmp, { force: true }); }
      prune(".warm", KEEP_WARM_SNAPSHOTS);
    },
    save: (image: SnapshotImage) => {
      const tmp = `${file(image.key)}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, serialize(image));
        fs.renameSync(tmp, file(image.key));
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      prune(".snap", KEEP_SNAPSHOTS);
    },
  };
}

function nodeVm(o: NodeRunOptions): JVM {
  exposeGc();
  const vfs = new VFS();
  vfs.mount("/", new NodeBackend("/", true));
  // built as dist/node.js, it reads the packaged image next to it
  const packaged = !o.jdk && fs.existsSync(path.join(here, "boot.pack"));
  const jdk = path.resolve(o.jdk ?? defaultJdk);
  if (!packaged && !fs.existsSync(path.join(jdk, "lib", "packages.txt"))) {
    throw new Error(`no JDK image at ${jdk}: run \`pnpm jdk\` in a checkout, or keep dist/node.js next to boot.pack and jdk/`);
  }
  vfs.mount("/jdk", packaged ? new ImageBackend(here) : new NodeBackend(jdk));
  const toVfs = (p: string) => path.resolve(p);
  const classpath = o.jar ? [toVfs(o.jar)] : o.classpath.map(toVfs);
  const natives = o.natives ?? {};
  if (hasMaxHeap()) {
    const gc = (globalThis as { gc?: () => void }).gc;
    setAllocationCheck(MAX_HEAP, () => {
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    }, { gc });
  } else clearAllocationCheck();
  const bridge = new Bridge({
    call: (_, req) => vm.library.request(req),
    release: (_, ids) => vm.library.release(ids),
  });
  const snapDir = o.snapshotDir === undefined ? defaultSnapshotDir() : o.snapshotDir;
  const build = snapDir ? buildId(vfs, packaged) : null;
  const cache = snapDir && build ? snapshotCache(snapDir, build) : null;
  const vm: JVM = new JVM({
    ...(cache ? { snapshots: cache } : {}),
    ...(o.warmSnapshot && cache ? { warmSnapshot: true, warmSnapshots: {
      load: cache.loadWarm, save: cache.saveWarm, drop: cache.dropWarm,
    } } : {}),
    fs: vfs,
    javaHome: "/jdk",
    localeData: o.localeData,
    classpath,
    props: { "java.io.tmpdir": os.tmpdir(), "user.home": os.homedir(), "user.name": os.userInfo().username, ...o.props },
    cwd: toVfs(process.cwd()),
    debug: o.debug,
    assertions: o.assertions && parseAssertions(o.assertions),
    enablePreview: o.enablePreview,
    net: o.net ?? (o.fetch ? undefined : new NodeNet()),
    fetch: o.fetch,
    hostName: o.hostName,
    env: o.env ?? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    hostNatives: hostNatives(natives, bridge),
    // System.loadLibrary("name") imports <java.library.path>/name.js
    loadNativeLibrary: async (p) => {
      const mod = await import(pathToFileURL(p).href);
      Object.assign(natives, nativeTable(mod));
    },
    stdout: o.stdout ?? hostOut(process.stdout),
    stderr: o.stderr ?? hostOut(process.stderr),
    stdin: o.input ? fixedInput(o.input) : () => new Promise((resolve) => {
      const onData = (d: Buffer) => { cleanup(); resolve(new Uint8Array(d)); };
      const onEnd = () => { cleanup(); resolve(null); };
      const cleanup = () => { process.stdin.off("data", onData); process.stdin.off("end", onEnd); process.stdin.pause(); };
      process.stdin.on("data", onData);
      process.stdin.on("end", onEnd);
      process.stdin.resume();
    }),
    afterBoot: resetAllocationCheck,
  });
  vm.registerNatives(processNatives(fileURLToPath(import.meta.url), jdk, packaged, o.input === undefined));
  bridges.set(vm, bridge);
  // A runaway must not take the machine down; per-site caps catch most.
  const maxRss = (o.maxRssMb ?? 2048) * 2 ** 20;
  const watch = setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss <= maxRss) return;
    process.stderr.write(`java-web: ${Math.round(rss / 2 ** 20)} MB resident, over the ${maxRss / 2 ** 20} MB limit; exiting\n`);
    process.exit(137);
  }, 200);
  watch.unref();
  vm.exited.finally(() => clearInterval(watch));
  return vm;
}

// A snapshot that cannot be restored is dropped, and a second VM boots.
function retried<T>(start: () => Promise<T>): Promise<T> {
  return start().catch((e) => {
    if (!(e instanceof SnapshotError)) throw e;
    process.stderr.write(`java-web: ${e.message}\n`);
    return start();
  });
}

export function runNode(o: NodeRunOptions): Promise<number> {
  return retried(() => {
    const vm = nodeVm(o);
    return o.jar ? vm.run(LM_JAR, path.resolve(o.jar), o.args ?? []) : vm.run(LM_CLASS, o.mainClass!, o.args ?? []);
  });
}

// A VM in library mode. libraryOf(vm) is its `lib`, as cheerpjRunLibrary
// returns it in the browser; vm.halt stops it.
export function startLibrary(o: NodeRunOptions): Promise<JVM> {
  return retried(async () => {
    const vm = nodeVm(o);
    await vm.startLibrary();
    return vm;
  });
}

export function libraryOf(vm: object): any {
  return bridges.get(vm)!.root(0);
}

// Module options become the jdk.module.* properties ModuleBootstrap reads,
// numbered from 0 for the repeatable ones, as HotSpot's launcher does.
const MODULE_PROPS: Record<string, [string, boolean]> = {
  "--add-exports": ["jdk.module.addexports", true], "--add-opens": ["jdk.module.addopens", true],
  "--add-reads": ["jdk.module.addreads", true], "--add-modules": ["jdk.module.addmods", true],
  "--patch-module": ["jdk.module.patch", true], "--enable-native-access": ["jdk.module.enable.native.access", true],
  "--limit-modules": ["jdk.module.limitmods", false], "--module-path": ["jdk.module.path", false], "-p": ["jdk.module.path", false],
};

export function moduleFlag(o: NodeRunOptions, arg: string, next: string | undefined): boolean {
  const eq = arg.indexOf("=");
  const name = eq < 0 ? arg : arg.slice(0, eq);
  const spec = MODULE_PROPS[name];
  if (!spec) return false;
  const value = eq < 0 ? next ?? "" : arg.slice(eq + 1);
  const props = (o.props ??= {});
  if (!spec[1]) props[spec[0]] = value;
  else {
    let n = 0;
    while (`${spec[0]}.${n}` in props) n++;
    props[`${spec[0]}.${n}`] = value;
  }
  return true;
}

// the java-web command, which dist/cli.js runs
export function main(argv: string[]) {
  const o: NodeRunOptions = { classpath: ["."], props: {} };
  let i = 0;
  const javaChild = argv[0] === "--java-child";
  if (javaChild) i++;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-cp" || a === "-classpath" || a === "--class-path") o.classpath = argv[++i].split(":");
    else if (a.startsWith("-D")) {
      const eq = a.indexOf("=");
      o.props![a.slice(2, eq < 0 ? undefined : eq)] = eq < 0 ? "" : a.slice(eq + 1);
    } else if (a === "--debug") o.debug = true;
    // HotSpot options with no meaning here; module flags take a value
    else if (moduleFlag(o, a, argv[i + 1])) i += a.includes("=") ? 0 : 1;
    else if (isAssertionFlag(a)) (o.assertions ??= []).push(a);
    else if (a === "--enable-preview") o.enablePreview = true;
    else if (a === "--locale-data") o.localeData = true;
    else if (a.startsWith("-Xmx")) {
      // x64 HotSpot refuses to start below 2 MB and rounds up to 2 MB steps
      const n = /^-Xmx\d+[kmg]?$/i.test(a) ? heapSize(a.slice(4)) : 0;
      if (n < 2 ** 21) {
        console.error(n === 0 ? `Invalid maximum heap size: ${a}\nError: Could not create the Java Virtual Machine.\nError: A fatal exception has occurred. Program will exit.`
          : "Error occurred during initialization of VM\nToo small maximum heap");
        process.exit(1);
      }
      setMaxHeap(Math.ceil(n / 2 ** 21) * 2 ** 21);
    }
    else if (a === "--jdk") o.jdk = argv[++i];
    else if (a === "-jar") { o.jar = argv[++i]; i++; break; }
    else if (/^(-X|--add-|-verbose|-server|-client)/.test(a)) continue;
    else if (javaChild && a.startsWith("-")) {
      console.error(`Unrecognized option: ${a}\nError: Could not create the Java Virtual Machine.\nError: A fatal exception has occurred. Program will exit.`);
      process.exit(1);
    }
    else if (a === "--max-rss") o.maxRssMb = Number(argv[++i]);
    else { o.mainClass = a; i++; break; }
  }
  o.args = argv.slice(i);
  if (!o.mainClass && !o.jar) {
    console.error("usage: java-web [-cp path] [-Dkey=value] Main [args] | -jar app.jar [args]");
    process.exit(2);
  }
  // Collecting first: node's exit teardown can deadlock while it frees very
  // large array buffers (seen on x64 CI runners with a few hundred MB left).
  Promise.resolve().then(() => runNode(o)).then((code) => (globalThis.gc?.(), process.exit(code)), (e) => {
    console.error(`java-web: ${(e as Error).message}`);
    process.exit(1);
  });
}

// run as a script, also through the symlink npm puts in node_modules/.bin
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
