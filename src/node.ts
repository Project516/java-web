// Node entry: java-web [-cp path] [-Dk=v] [--debug] Main [args] | -jar app.jar [args]

import { isAssertionFlag, parseAssertions } from "./assertions.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VFS } from "./fs.ts";
import type { Backend, Stat } from "./fs.ts";
import { Bridge, nativeTable } from "./bridge.ts";
import { JVM, LM_CLASS, LM_JAR } from "./jvm.ts";
import { hostNatives } from "./hostnatives.ts";
import { ImageBackend } from "./image.ts";
import { NodeNet } from "./net-node.ts";
import { PendingThrow } from "./thread.ts";
import { setMaxHeap } from "./runtime.ts";
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
  stat(p: string): Stat | null {
    if (!this.writable && this.stats.has(p)) return this.stats.get(p)!;
    let st: Stat | null = null;
    try {
      const s = fs.statSync(this.host(p));
      st = { dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    } catch {
      st = null;
    }
    if (!this.writable) this.stats.set(p, st);
    return st;
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
  write(p: string, data: Uint8Array) {
    try {
      fs.writeFileSync(this.host(p), data);
      return true;
    } catch {
      return false;
    }
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
  chmod(p: string, f: (mode: number) => number) {
    try {
      fs.chmodSync(this.host(p), f(fs.statSync(this.host(p)).mode & 0o7777));
      return true;
    } catch {
      return false;
    }
  }
  access(p: string, mode: number) {
    try {
      fs.accessSync(this.host(p), mode);
      return true;
    } catch {
      return false;
    }
  }
  setMtime(p: string, ms: number) {
    try {
      fs.utimesSync(this.host(p), fs.statSync(this.host(p)).atime, ms / 1000);
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
      if (fs.statSync(this.host(p)).isDirectory()) fs.rmdirSync(this.host(p));
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
  // an exploded JDK image instead of build/jdk (or, for dist/node.js, the packaged one)
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

function nodeVm(o: NodeRunOptions): JVM {
  exposeGc();
  const vfs = new VFS();
  vfs.mount("/", new NodeBackend("/", true));
  // built as dist/node.js, it reads the packaged image next to it
  const packaged = !o.jdk && fs.existsSync(path.join(here, "boot.pack"));
  const jdk = o.jdk ?? defaultJdk;
  if (!packaged && !fs.existsSync(path.join(jdk, "lib", "packages.txt"))) {
    throw new Error(`no JDK image at ${jdk}: run \`pnpm jdk\` in a checkout, or keep dist/node.js next to boot.pack and jdk/`);
  }
  vfs.mount("/jdk", packaged ? new ImageBackend(here, o.localeData) : new NodeBackend(jdk));
  if (!o.localeData) vfs.hide("/jdk/modules/jdk.localedata");
  const toVfs = (p: string) => path.resolve(p);
  const classpath = o.jar ? [toVfs(o.jar)] : o.classpath.map(toVfs);
  const natives = o.natives ?? {};
  const bridge = new Bridge({
    call: (_, req) => vm.library.request(req),
    release: (_, ids) => vm.library.release(ids),
  });
  const vm: JVM = new JVM({
    fs: vfs,
    javaHome: "/jdk",
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
  });
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

export function runNode(o: NodeRunOptions): Promise<number> {
  const vm = nodeVm(o);
  return o.jar ? vm.run(LM_JAR, path.resolve(o.jar), o.args ?? []) : vm.run(LM_CLASS, o.mainClass!, o.args ?? []);
}

// A VM in library mode. libraryOf(vm) is its `lib`, as cheerpjRunLibrary
// returns it in the browser; vm.halt stops it.
export async function startLibrary(o: NodeRunOptions): Promise<JVM> {
  const vm = nodeVm(o);
  await vm.startLibrary();
  return vm;
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

// a -Xmx size: bytes, or k, m or g
function heapSize(s: string): number {
  const unit = { k: 2 ** 10, m: 2 ** 20, g: 2 ** 30 }[s.slice(-1).toLowerCase()];
  return unit ? Number(s.slice(0, -1)) * unit : Number(s);
}

function main(argv: string[]) {
  const o: NodeRunOptions = { classpath: ["."], props: {} };
  let i = 0;
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
    else if (/^-Xmx\d+[kmg]?$/i.test(a)) setMaxHeap(heapSize(a.slice(4)));
    else if (/^(-X|--add-|-verbose|-server|-client)/.test(a)) continue;
    else if (a === "--jdk") o.jdk = argv[++i];
    else if (a === "--max-rss") o.maxRssMb = Number(argv[++i]);
    else if (a === "-jar") { o.jar = argv[++i]; i++; break; }
    else { o.mainClass = a; i++; break; }
  }
  o.args = argv.slice(i);
  if (!o.mainClass && !o.jar) {
    console.error("usage: java-web [-cp path] [-Dkey=value] Main [args] | -jar app.jar [args]");
    process.exit(2);
  }
  Promise.resolve().then(() => runNode(o)).then((code) => process.exit(code), (e) => {
    console.error(`java-web: ${(e as Error).message}`);
    process.exit(1);
  });
}

// run as a script, also through the symlink npm puts in node_modules/.bin
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
