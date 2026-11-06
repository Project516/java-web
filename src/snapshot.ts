// Boot snapshots: the VM's state once System.initPhase3 has run, so a later
// start with the same options skips boot, as HotSpot's CDS archive lets it.
// Classes are defined again from the same bytes in the same order; Java
// objects, statics, resolved constants and VM tables come from the image; a
// thread blocked at the snapshot wakes as if spuriously.

import { parseClass } from "./classfile.ts";
import type { JVM } from "./jvm.ts";
import { platformProperties, vmProperties } from "./natives/misc.ts";
import { restorePending, restoreReference } from "./natives/ref.ts";
import { MAX_HEAP } from "./runtime.ts";
import type { WarmTrace } from "./fs.ts";
import { reopenSnapshotFile, OpenFile, streams } from "./natives/io.ts";
import { JArray, JClass, JField, JMethod, JObject, Monitor } from "./runtime.ts";
import { restoreJit } from "./jit.ts";
import { Frame, JThread, NativeFrame, STATUS_RUNNABLE } from "./thread.ts";
import type { NativeGen } from "./thread.ts";

// Bump when the layout of an image changes; images of another format are ignored.
export const SNAPSHOT_FORMAT = 2;

export interface SnapshotImage {
  format: number;
  key: string;
  table: unknown[];
  classes: ClassRec[];
  vm: VmRec;
  threads: ThreadRec[];
}

export interface WarmSnapshotImage extends SnapshotImage {
  warmKey: string;
  trace: WarmTrace;
}

interface ClassRec {
  kind: "prim" | "array" | "boot" | "bytes";
  name: string;
  desc?: string;
  component?: number;
  loader?: unknown;
  hidden?: boolean;
  bytes?: Uint8Array;
  cfName?: string;
  superclass?: number | null;
  interfaces?: number[];
  state: number;
  statics: unknown;
  mirror: unknown;
  initError: unknown;
  rcp: unknown;
  ldc: unknown;
  vmMembers: unknown;
  nestHost: unknown;
  links: [string, unknown][];
  caches: [string, unknown][];
  // generated JS and constants of compiled methods, in warm snapshots
  jit?: [string, string, unknown][];
}

interface VmRec {
  boot: unknown;
  bootPackages: unknown;
  bootModules: unknown;
  bootUnnamedModule: unknown;
  interned: unknown;
  hashSeed: number;
  classCount: number;
  state: [string, unknown][];
  pending: unknown;
  mem: { buf: Uint8Array; top: number; sizes: unknown; free: unknown };
}

interface ThreadRec {
  obj: unknown;
  daemon: boolean;
  parkPermit: boolean;
  held: number;
  pins: number;
  stackLimit: number;
  mounted: unknown;
  scopedValueCache: unknown;
  frames: unknown[];
}

// What boot depends on: the properties the VM gives Java and the options that
// change how boot classes run. A snapshot serves only a VM whose key is the
// same. sun.java.command names the main class, which boot does not use; it is
// set after boot.
export function snapshotKey(vm: JVM, build: string): string {
  // only whether there is one changes the boot
  const vmProps = vmProperties(vm);
  const i = vmProps.indexOf("sun.java.command");
  if (i >= 0 && i % 2 === 0) vmProps[i + 1] = "";
  const o = vm.opts;
  const modules = [...new Set(vm.bootPackages.values())].sort();
  return JSON.stringify([build, modules, platformProperties(vm), vmProps, o.assertions ?? null, !!o.enablePreview, MAX_HEAP]);
}

const WAIT0 = "java/lang/Object.wait0(J)V";
const REF_WAIT = "java/lang/ref/Reference.waitForReferencePendingList()V";
// vm.state entries rebuilt on demand rather than saved
const TRANSIENT = new Set(["stdin", "refs", "socks", "continuations"]);

// V8's serializer and deserializer recurse on nesting, so the image must stay
// shallow whatever the Java heap holds. Each object is written in place once,
// inside the first thing that refers to it, as far as NEST levels down; a deeper
// object, and any later reference to one, goes by its index in the table of
// named objects. A list of values holds primitives, typed arrays and objects
// written in place; its references are [position, index] pairs in a second list.
// An object with no objects inside it (a string, a class) adds one level
// wherever it is, so it is shared directly.
const NEST = 64;

interface Values {
  v: unknown[];
  r?: number[];
}

class Encoder {
  readonly table: unknown[] = [];
  private twins = new Map<unknown, any>();
  private named = new Map<unknown, number>();
  private leaves = new Set<unknown>();
  private classIndex = new Map<JClass, number>();
  private threadIndex = new Map<JThread, number>();

  constructor(classes: JClass[], threads: JThread[]) {
    classes.forEach((c, i) => this.classIndex.set(c, i));
    threads.forEach((t, i) => this.threadIndex.set(t, i));
  }

  cls(c: JClass, path: string): number {
    const i = this.classIndex.get(c);
    if (i === undefined) throw new Error(`snapshot: class ${c.name} was not recorded (${path})`);
    return i;
  }

  private work: (() => void)[] = [];
  private undo: { twins: unknown[]; table: number; work: number } | null = null;

  // enc, or null with nothing recorded when v cannot be saved
  tryEnc(v: any, path: string): any {
    const undo = (this.undo = { twins: [] as unknown[], table: this.table.length, work: this.work.length });
    try {
      return this.enc(v, path);
    } catch {
      this.work.length = undo.work;
      for (const k of undo.twins) {
        this.leaves.delete(this.twins.get(k));
        this.twins.delete(k);
      }
      for (const t of this.table.splice(undo.table)) this.named.delete(t);
      return null;
    } finally {
      this.undo = null;
    }
  }

  // The twin of v, or a reference to it if it has one already. Containers are
  // filled in by drain, so deep object graphs need no deep recursion.
  enc(v: any, path: string): any {
    const t = this.child(v, path, 0);
    while (this.work.length) this.work.pop()!();
    return t;
  }

  private name(t: unknown): number {
    let i = this.named.get(t);
    if (i === undefined) {
      i = this.table.length;
      this.table.push(t);
      this.named.set(t, i);
    }
    return i;
  }

  private child(v: any, path: string, depth: number): any {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return v;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
    const memo = this.twins.get(v);
    if (memo !== undefined) return this.leaves.has(memo) ? memo : { $: "R", i: this.name(memo) };
    const t = this.make(v, path, depth);
    return depth >= NEST && !this.leaves.has(t) ? { $: "R", i: this.name(t) } : t;
  }

  // src's elements as children at depth
  private values(src: ArrayLike<unknown>, path: string, depth: number): Values {
    const n = src.length;
    const v = new Array(n);
    let r: number[] | undefined;
    for (let i = 0; i < n; i++) {
      const x: any = src[i];
      if (x === null || (typeof x !== "object" && typeof x !== "function")) {
        if (x !== undefined || i in (src as object)) v[i] = x;
      } else if (ArrayBuffer.isView(x) || x instanceof ArrayBuffer) v[i] = x;
      else {
        const memo = this.twins.get(x);
        if (memo !== undefined) {
          if (this.leaves.has(memo)) v[i] = memo;
          else {
            (r ??= []).push(i, this.name(memo));
            v[i] = null;
          }
        } else {
          const t = this.make(x, path, depth);
          if (depth >= NEST && !this.leaves.has(t)) {
            (r ??= []).push(i, this.name(t));
            v[i] = null;
          } else v[i] = t;
        }
      }
    }
    return r ? { v, r } : { v };
  }

  private isLeaf(v: JObject): boolean {
    if (v.mon || v.x !== undefined) return false;
    const list = v instanceof JArray ? v.a : v.f;
    if (!Array.isArray(list)) return true;
    for (const e of list) if (e !== null && (typeof e === "function" || (typeof e === "object" && !ArrayBuffer.isView(e) && !(e instanceof ArrayBuffer)))) return false;
    return true;
  }

  private make(v: any, path: string, depth: number): any {
    if (typeof v === "function") throw new Error(`snapshot: cannot save function ${v.name || "(anonymous)"} in ${path}`);
    const next = depth + 1;
    let t: any;
    if (v instanceof JObject) {
      const array = v instanceof JArray;
      t = { $: array ? "A" : "O", c: this.cls(v.cls, path), h: v.hash };
      this.work.push(() => {
        if (array && !Array.isArray(v.a)) t.a = v.a;
        else {
          const { v: list, r } = this.values(array ? (v.a as unknown[]) : v.f, path, next);
          t[array ? "a" : "f"] = list;
          if (r) t.r = r;
        }
        if (v.mon) t.n = this.child(v.mon, path, next);
        if (v.x !== undefined) t.x = v.x instanceof WeakRef ? { $: "W", v: this.child(v.x.deref() ?? null, path, next) } : this.child(v.x, path, next);
      });
    } else if (v instanceof JClass) t = { $: "C", i: this.cls(v, path) };
    else if (v instanceof JMethod) t = { $: "M", c: this.cls(v.cls, path), k: v.key };
    else if (v instanceof JField) t = { $: "F", c: this.cls(v.cls, path), i: v.cls.fields.indexOf(v) };
    else if (v instanceof JThread) {
      const k = this.threadIndex.get(v);
      if (k === undefined) throw new Error(`snapshot: unknown thread in ${path}`);
      t = { $: "T", i: k };
    } else if (v instanceof Monitor) {
      if (v.entry.length) throw new Error(`snapshot: a thread is blocked entering a monitor in ${path}`);
      t = { $: "N", n: v.count };
      this.work.push(() => (t.o = this.child(v.owner, path, next)));
    } else if (v instanceof Map) {
      t = { $: "m" };
      this.work.push(() => {
        const flat: unknown[] = [];
        for (const [k, x] of v) flat.push(k, x);
        Object.assign(t, this.values(flat, path, next));
      });
    } else if (v instanceof Set) {
      t = { $: "s" };
      this.work.push(() => Object.assign(t, this.values([...v], path, next)));
    } else if (Array.isArray(v)) {
      t = { $: "L" };
      this.work.push(() => Object.assign(t, this.values(v, path, next)));
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error(`snapshot: cannot save ${v.constructor?.name} in ${path}`);
      t = { $: "P" };
      this.work.push(() => {
        const keys = Object.keys(v);
        const { v: list, r } = this.values(keys.map((k) => v[k]), path, next);
        const o: any = {};
        keys.forEach((k, j) => (o[k] = list[j]));
        t.v = o;
        if (r) t.r = r.map((x, j) => (j % 2 === 0 ? keys[x] : x));
      });
    }
    this.twins.set(v, t);
    this.undo?.twins.push(v);
    if (!(v instanceof JObject) ? v instanceof JClass || v instanceof JMethod || v instanceof JField || v instanceof JThread : this.isLeaf(v)) this.leaves.add(t);
    return t;
  }
}

class Decoder {
  private made = new Map<unknown, any>();
  private fills: any[] = [];
  readonly references: [JObject, unknown][] = [];

  readonly classes: JClass[];
  private threads: JThread[];
  private table: any[];

  constructor(table: any[], classes: JClass[], threads: JThread[]) {
    this.table = table;
    this.classes = classes;
    this.threads = threads;
  }

  // The value for x, a field of a record. Objects are made at once and filled
  // by flush. The image is changed in place, so a VM needs its own copy.
  dec(x: any): any {
    if (x === null || typeof x !== "object" || ArrayBuffer.isView(x) || x instanceof ArrayBuffer) return x;
    const v = x.$ === "R" ? this.table[x.i] : x;
    const memo = this.made.get(v);
    if (memo !== undefined) return memo;
    let o: any;
    switch (v.$) {
      case "O": case "A": {
        const cls = this.classes[v.c];
        if (!cls) throw new Error(`snapshot: object of class #${v.c} before its class`);
        o = v.$ === "A" ? new JArray(cls, v.a) : new JObject(cls, v.f);
        o.hash = v.h;
        break;
      }
      case "C": return this.classes[v.i];
      case "M": return this.classes[v.c].methodMap.get(v.k);
      case "F": return this.classes[v.c].fields[v.i];
      case "T": return this.threads[v.i];
      case "N":
        o = new Monitor();
        o.count = v.n;
        break;
      case "L": o = v.v; break;
      case "m": o = new Map(); break;
      case "s": o = new Set(); break;
      case "P": o = {}; break;
      default: throw new Error(`snapshot: unknown record ${JSON.stringify(v).slice(0, 80)}`);
    }
    this.made.set(v, o);
    this.fills.push(v);
    return o;
  }

  private fill(v: any) {
    const o = this.made.get(v);
    if (v.$ === "N") {
      o.owner = this.dec(v.o);
      return;
    }
    if (v.$ === "P") {
      for (const k of Object.keys(v.v)) o[k] = this.dec(v.v[k]);
      if (v.r) for (let k = 0; k < v.r.length; k += 2) o[v.r[k]] = this.dec(this.table[v.r[k + 1]]);
      return;
    }
    const list: unknown[] | undefined = v.$ === "O" ? v.f : v.$ === "A" ? (Array.isArray(v.a) ? v.a : undefined) : v.v;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const x: any = list[i];
        if (x !== null && typeof x === "object" && !ArrayBuffer.isView(x) && !(x instanceof ArrayBuffer)) list[i] = this.dec(x);
      }
      if (v.r) for (let k = 0; k < v.r.length; k += 2) list[v.r[k]] = this.dec(this.table[v.r[k + 1]]);
    }
    switch (v.$) {
      case "O": case "A":
        if (v.n) o.mon = this.dec(v.n);
        if (v.x !== undefined) {
          if (v.x?.$ === "W") this.references.push([o, v.x.v]);
          else o.x = this.dec(v.x);
        }
        break;
      case "m":
        for (let k = 0; k < list!.length; k += 2) o.set(list![k], list![k + 1]);
        break;
      case "s":
        for (const x of list!) o.add(x);
        break;
    }
  }

  // fills the objects decoded so far, and those their fields lead to
  flush() {
    while (this.fills.length) this.fill(this.fills.pop());
  }

  // dec, then flush, for a value used at once
  now(x: any): any {
    const o = this.dec(x);
    this.flush();
    return o;
  }
}

// The image of a VM whose boot just finished on main, which keeps running
// and is not saved itself.
export function dumpVM(vm: JVM, main: JThread, key: string, library = false): SnapshotImage {
  const classes = vm.created!;
  const others = [...vm.threads].filter((t) => t !== main);
  const e = new Encoder(classes, [main, ...others]);
  const classRecs = classes.map((c, i): ClassRec => {
    const p = `class ${c.name}`;
    const rec: ClassRec = {
      kind: c.prim ? "prim" : c.component ? "array" : c.bytes ? "bytes" : "boot",
      name: c.name,
      state: c.state,
      statics: e.enc(c.statics, `${p}.statics`),
      mirror: e.enc(c.mirror, `${p}.mirror`),
      initError: e.enc(c.initError, `${p}.initError`),
      rcp: e.enc(c.rcp, `${p}.rcp`),
      ldc: e.enc(c.ldc, `${p}.ldc`),
      vmMembers: e.enc(c.vmMembers, `${p}.vmMembers`),
      nestHost: e.enc(c.nestHost, `${p}.nestHost`),
      links: c.methods.filter((m) => m.link).map((m) => [m.key, e.enc(m.link, `${p}.${m.key}.link`)]),
      caches: c.methods.filter((m) => m.cache).map((m) => [m.key, e.enc(m.cache, `${p}.${m.key}.cache`)]),
    };
    if (library) {
      const jit: [string, string, unknown][] = [];
      for (const m of c.methods) {
        const code = m.jit && vm.jitCode.get(m);
        const consts = code && e.tryEnc(code.consts, `${p}.${m.key}.jit`);
        if (code && consts) jit.push([m.key, code.src, consts]);
      }
      if (jit.length) rec.jit = jit;
    }
    if (c.initThread || c.initWaiters.length) throw new Error(`snapshot: ${c.name} is being initialized`);
    if (rec.kind === "prim") rec.desc = c.prim!;
    else if (rec.kind === "array") rec.component = e.cls(c.component!, p);
    else if (rec.kind === "bytes") {
      rec.loader = e.enc(c.loader, `${p}.loader`);
      rec.hidden = c.hidden;
      rec.bytes = c.bytes;
      rec.cfName = c.cf!.name;
      rec.superclass = c.superclass ? e.cls(c.superclass, p) : null;
      rec.interfaces = c.interfaces.map((x) => e.cls(x, p));
    } else if (c.loader !== null || c.hidden) throw new Error(`snapshot: no bytes for ${c.name}`);
    if (i !== classes.indexOf(c)) throw new Error("snapshot: class recorded twice");
    return rec;
  });
  const s = vm.state;
  const refs = s.get("refs") as { pending: JObject[] } | undefined;
  const mem = vm.mem as any;
  const vmRec: VmRec = {
    boot: e.enc(vm.boot, "boot"),
    bootPackages: e.enc(vm.bootPackages, "bootPackages"),
    bootModules: e.enc(vm.bootModules, "bootModules"),
    bootUnnamedModule: e.enc(vm.bootUnnamedModule, "bootUnnamedModule"),
    interned: e.enc((vm as any).interned, "interned"),
    hashSeed: (vm as any).hashSeed,
    classCount: vm.classCount,
    state: [...s].filter(([k, x]) => {
      if (k === "socks" && x.socks.size) throw new Error("snapshot: a socket is open");
      if (k === "continuations" && x.busy) throw new Error("snapshot: a continuation is active");
      if (k === "fds" && [...x.files.values()].some(streams)) throw new Error("snapshot: a host file that streams is open");
      return !TRANSIENT.has(k) && !k.startsWith("parked:");
    }).map(([k, v]) => [k, k === "fds" ? snapshotFds(v) : e.enc(v, `state.${k}`)]),
    pending: e.enc(refs?.pending ?? [], "refs.pending"),
    mem: { buf: mem.u8.slice(0, mem.top), top: mem.top, sizes: e.enc(mem.sizes, "mem"), free: e.enc(mem.free, "mem") },
  };
  const threadRec = (t: JThread, isMain = false): ThreadRec => {
    const p = `thread ${t.name}`;
    const frames = t.frames.map((f, i) => {
      if (f instanceof Frame) {
        if (f.direct) throw new Error(`snapshot: direct frame in ${p}`);
        return { $: "Fr", m: e.enc(f.m, p), pc: f.pc, sp: f.sp, l: e.enc(f.locals, p), s: e.enc(f.stack, p), k: e.enc(f.lock, p), nl: f.needLock };
      }
      if (f.input !== undefined || f.thrown) throw new Error(`snapshot: native frame with a pending value in ${p}`);
      if (library && isMain && i === 0 && f.m === null) return { $: "library" };
      if (i === 0 && f.m === null) return { $: "body" };
      const key = f.m ? `${f.m.cls.name}.${f.m.key}` : "vm";
      if (key === REF_WAIT) return { $: "native", m: e.enc(f.m, p) };
      if (key === WAIT0) {
        const o = (t.frames[i - 1] as Frame).locals[0] as JObject;
        const w = o.mon?.waiters.find((x) => x.t === t);
        if (!w) throw new Error(`snapshot: ${p} in wait0 is not a waiter`);
        return { $: "rewait", m: e.enc(f.m, p), o: e.enc(o, p), n: w.count };
      }
      throw new Error(`snapshot: ${p} is blocked in ${key}`);
    });
    return {
      obj: e.enc(t.obj, p),
      daemon: t.daemon,
      parkPermit: t.parkPermit,
      held: t.held,
      pins: t.pins,
      stackLimit: t.stackLimit,
      mounted: e.enc(t.mounted, p),
      scopedValueCache: e.enc(t.scopedValueCache, p),
      frames,
    };
  };
  const threads = others.map((t) => threadRec(t));
  return { format: SNAPSHOT_FORMAT, key, table: e.table, classes: classRecs, vm: vmRec, threads: [library ? threadRec(main, true) : { obj: e.enc(main.obj, "main") } as ThreadRec, ...threads] };
}

function snapshotFds(value: unknown): unknown {
  const table = value as { next: number; files: Map<number, OpenFile> };
  const files: [number, { path: string; pos: number; size: number }][] = [];
  for (const [id, file] of table.files) {
    if (!(file instanceof OpenFile) || file.writable || file.dirty || file.path === "" || (file as any).host !== undefined || (file.contents as any).host !== undefined) {
      throw new Error("snapshot: a file is busy");
    }
    files.push([id, { path: file.path, pos: file.pos, size: file.size }]);
  }
  return { next: table.next, files };
}

// A waiter woken as if spuriously: takes its monitor back with the count it gave up.
function* rewait(t: JThread, o: JObject, count: number): NativeGen {
  const mon = o.mon!;
  t.waitingOn = o;
  while (mon.owner !== null) yield t.block(new Promise<void>((r) => mon.entry.push(r)));
  mon.owner = t;
  mon.count = count;
  t.waitingOn = null;
  t.vm.setThreadStatus(t, STATUS_RUNNABLE);
}

// Puts a VM built with the snapshot's options into its state after boot.
// main becomes the snapshot's main thread; the others are started.
export function restoreVM(vm: JVM, image: SnapshotImage, main: JThread) {
  const others = image.threads.slice(1).map(() => new JThread(vm));
  const threads = [main, ...others];
  const classes: JClass[] = [];
  const d = new Decoder(image.table as any[], classes, threads);
  for (const r of image.classes) {
    let c: JClass | null;
    if (r.kind === "prim") c = vm.primClass(r.desc!);
    else if (r.kind === "array") c = vm.arrayOf(classes[r.component!]);
    else if (r.kind === "boot") c = vm.loadBoot(r.name);
    else {
      let cf = parseClass(r.bytes!, vm.opts.enablePreview);
      if (cf.name !== r.cfName) cf = { ...cf, name: r.cfName!, renamedFrom: cf.name };
      const sup = r.superclass === null ? null : classes[r.superclass!];
      c = vm.defineLinked(cf, d.dec(r.loader), sup, r.interfaces!.map((i) => classes[i]), r.hidden);
      c.bytes = r.bytes;
    }
    if (!c || c.name !== r.name) throw new Error(`snapshot: ${r.name} came back as ${c?.name}`);
    classes.push(c);
  }
  d.flush();
  image.classes.forEach((r, i) => {
    const c = classes[i];
    c.state = r.state;
    c.statics = d.dec(r.statics);
    c.mirror = d.dec(r.mirror);
    c.initError = d.dec(r.initError);
    c.rcp = d.dec(r.rcp);
    c.ldc = d.dec(r.ldc);
    c.vmMembers = d.dec(r.vmMembers);
    c.nestHost = d.dec(r.nestHost);
    for (const [k, l] of r.links) c.methodMap.get(k)!.link = d.dec(l);
    for (const [k, cache] of r.caches ?? []) c.methodMap.get(k)!.cache = d.dec(cache);
    for (const [k, src, consts] of r.jit ?? []) {
      const m = c.methodMap.get(k);
      if (m) restoreJit(vm, m, { src, consts: d.dec(consts) });
    }
  });
  d.flush();
  const v = image.vm;
  const boot = d.now(v.boot) as Map<string, JClass>;
  vm.boot.clear();
  for (const [k, c] of boot) vm.boot.set(k, c);
  for (const [k, p] of d.now(v.bootPackages) as Map<string, string>) vm.bootPackages.set(k, p);
  for (const [k, m] of d.now(v.bootModules) as Map<string, JObject>) vm.bootModules.set(k, m);
  vm.bootUnnamedModule = d.dec(v.bootUnnamedModule);
  const interned = (vm as any).interned as Map<string, JObject>;
  for (const [k, s] of d.now(v.interned) as Map<string, JObject>) interned.set(k, s);
  (vm as any).hashSeed = v.hashSeed;
  vm.classCount = v.classCount;
  for (const [k, x] of v.state) {
    if (k === "fds") {
      const fds = x as { next: number; files: [number, { path: string; pos: number; size: number }][] };
      const files = new Map(fds.files.map(([id, f]) => [id, reopenSnapshotFile(f.path, f.size, f.pos, vm.fs)]));
      vm.state.set(k, { next: fds.next, files });
    } else vm.state.set(k, d.dec(x));
  }
  vm.mem.restore(v.mem.buf, v.mem.top, d.dec(v.mem.sizes), d.dec(v.mem.free));
  d.flush();

  const mainRec = image.threads[0];
  main.obj = d.dec(mainRec.obj);
  main.obj!.x = main;
  if (mainRec.frames) {
    for (const f of mainRec.frames as any[]) {
      if (f.$ === "library") {
        const gen = vm.library.loop(main);
        main.frames.push(new NativeFrame(gen, null, "V", false));
      } else throw new Error(`snapshot: unsupported main frame ${f.$}`);
    }
  }
  image.threads.slice(1).forEach((r, i) => {
    const t = others[i];
    t.obj = d.dec(r.obj);
    t.daemon = r.daemon;
    t.parkPermit = r.parkPermit;
    t.held = r.held;
    t.pins = r.pins;
    t.stackLimit = r.stackLimit;
    t.mounted = d.dec(r.mounted);
    t.scopedValueCache = d.dec(r.scopedValueCache);
    for (const f of r.frames as any[]) {
      if (f.$ === "Fr") {
        const fr = new Frame(d.dec(f.m));
        fr.locals = d.dec(f.l);
        fr.stack = d.dec(f.s);
        fr.pc = f.pc;
        fr.sp = f.sp;
        fr.lock = d.dec(f.k);
        fr.needLock = f.nl;
        t.frames.push(fr);
      } else if (f.$ === "body") {
        const gen = vm.threadBody(t, t.obj!, true);
        gen.next();
        t.frames.push(new NativeFrame(gen, null, "V", false));
      } else if (f.$ === "native") {
        const m = d.dec(f.m) as JMethod;
        t.frames.push(new NativeFrame(vm.bindNative(m)(t, []) as NativeGen, m, m.ret, false));
      } else {
        const m = d.dec(f.m) as JMethod;
        t.frames.push(new NativeFrame(rewait(t, d.dec(f.o), f.n), m, "V", false));
      }
    }
  });
  d.flush();
  restorePending(vm, d.now(v.pending));
  for (const [o, referent] of d.references) {
    const r = d.dec(referent);
    if (r) restoreReference(vm, o, r);
    else o.x = null;
  }
  d.flush();
  for (const t of others) vm.startThread(t);
}
