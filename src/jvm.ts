// The virtual machine: class loading, linking, initialization, constant
// pool resolution, strings, monitors and the thread scheduler.

import type { Assertions } from "./assertions.ts";
import { BadMagic, ClassFormatError, MAX_MAJOR, Tag, UnsupportedVersion, className, parseClass, utf8 } from "./classfile.ts";
import type { ClassFile } from "./classfile.ts";
import { deliver, raise, runThread } from "./interp.ts";
import { NativeMemory } from "./memory.ts";
import type { VFS } from "./fs.ts";
import {
  ACC_ABSTRACT, ACC_FINAL, ACC_INTERFACE, ACC_NATIVE, ACC_PRIVATE, ACC_PROTECTED, ACC_PUBLIC,
  ACC_STATIC, ACC_SUPER, ACC_VARARGS, ERRONEOUS, INITIALIZED, INITIALIZING, JArray, JClass, JField,
  JMethod, JObject, LINKED, Monitor, defaultValue, newArrayData,
} from "./runtime.ts";
import type { CallSite, NativeFn } from "./runtime.ts";
import {
  Frame, JThread, JavaThrow, NativeFrame, PendingThrow, RUNNABLE, STATUS_BLOCKED, STATUS_RUNNABLE, STATUS_TERMINATED,
  TERMINATED, WAITING,
} from "./thread.ts";
import type { NativeGen } from "./thread.ts";
import { intrinsics, natives as builtinNatives } from "./natives/index.ts";
import { invokePolymorphic, linkCallSite, resolveConstant } from "./indy.ts";
import { hostNative, jniNames } from "./hostnatives.ts";
import { Library } from "./library.ts";
import type { LibraryRequest } from "./library.ts";
import type { HostNative } from "./hostnatives.ts";
import { PROXY_HOST, PROXY_PORT } from "./http-proxy.ts";
import { LoopbackNet, addrKey, ipv4Literal } from "./sockets.ts";
import type { NetBackend } from "./sockets.ts";

// What the VM keeps per Java class loader: classes it is the initiating
// loader of, and package -> named Module for modules defined to it.
export interface LoaderData {
  classes: Map<string, JClass>;
  modules: Map<string, JObject>;
}

export interface JvmOptions {
  fs: VFS;
  // VFS path of java.home (the output of scripts/build-jdk.sh)
  javaHome: string;
  classpath?: string[];
  props?: Record<string, string>;
  stdout: (b: Uint8Array) => void;
  stderr: (b: Uint8Array) => void;
  // resolves to null at end of input
  stdin?: () => Promise<Uint8Array | null>;
  cwd?: string;
  // natives the embedder implements, looked up by JNI name (short or long)
  hostNatives?: (names: [string, string]) => HostNative | null;
  // imports the JS module at a VFS path for System.loadLibrary; rejects on failure
  loadNativeLibrary?: (path: string) => Promise<void>;
  // told when Java closes a file it wrote
  fileClosed?: (path: string) => void;
  // log VM internals to the host console
  debug?: boolean;
  assertions?: Assertions;
  // run class files that use this release's preview features
  enablePreview?: boolean;
  // sockets and name lookup; defaults to loopback sockets inside the VM
  net?: NetBackend;
  // what InetAddress.getLocalHost() reports
  hostName?: string;
  // what System.getenv() returns
  env?: Record<string, string>;
  // lets the default loopback sockets reach http: and https: URLs through a virtual proxy; also sets the proxy system properties and the TLS pass-through provider
  fetch?: typeof fetch;
}

// LauncherHelper launch modes
export const LM_CLASS = 1, LM_JAR = 2;

const YIELD = (() => {
  if (typeof setImmediate === "function") return (fn: () => void) => setImmediate(fn);
  const ch = new MessageChannel();
  const queue: (() => void)[] = [];
  ch.port1.onmessage = () => queue.shift()?.();
  return (fn: () => void) => {
    queue.push(fn);
    ch.port2.postMessage(0);
  };
})();

export class JVM {
  readonly opts: JvmOptions;
  readonly fs: VFS;
  readonly mem = new NativeMemory();
  readonly boot = new Map<string, JClass>();
  // package -> module, for boot classes
  readonly bootPackages = new Map<string, string>();
  // Module objects defined to the boot loader, by name
  readonly bootModules = new Map<string, JObject>();
  bootUnnamedModule: JObject | null = null;
  private natives = new Map<string, NativeFn>();
  private interned = new Map<string, JObject>();
  readonly prims = new Map<string, JClass>();
  private slots = new Map<string, number>();
  readonly threads = new Set<JThread>();
  private runQueue: JThread[] = [];
  private queued = new Set<JThread>();
  private scheduled = false;
  private hashSeed = 0x2545f491;
  private hiddenCount = 0;
  // for java.management: classes defined, threads started and the most alive at once
  classCount = 0;
  threadsStarted = 0;
  peakThreads = 0;
  exitCode: number | null = null;
  private exitResolve!: (code: number) => void;
  readonly exited: Promise<number>;
  readonly startTime = Date.now();
  // System properties from the embedder, merged into vmProperties
  readonly props: Map<string, string>;
  // per-VM state natives keep (open files, etc.)
  readonly state = new Map<string, any>();
  readonly net: NetBackend;
  // pending sleeps and timed waits, cancelled on halt
  readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(opts: JvmOptions) {
    this.opts = opts;
    this.fs = opts.fs;
    const extra = ipv4Literal(opts.hostName);
    this.net = opts.net ?? new LoopbackNet(extra, opts.fetch);
    this.props = new Map(Object.entries(opts.props ?? {}));
    if (this.net instanceof LoopbackNet && this.net.fetch) {
      const tunnel = !this.props.has("https.proxyHost");
      // each scheme keeps a proxy the page set for it
      for (const k of ["http", "https"]) {
        if (this.props.has(`${k}.proxyHost`)) continue;
        this.props.set(`${k}.proxyHost`, PROXY_HOST);
        this.props.set(`${k}.proxyPort`, String(PROXY_PORT));
      }
      // makes the javaweb.tls provider the first one, so https: skips TLS inside the proxy's tunnel
      if (tunnel && !this.props.has("java.security.properties")) this.props.set("java.security.properties", `${opts.javaHome}/conf/security/java-web-proxy.security`);
      // DefaultProxySelector's own default list, plus the VM's address
      if (extra && !this.props.has("http.nonProxyHosts")) this.props.set("http.nonProxyHosts", `localhost|127.*|[::1]|0.0.0.0|[::0]|${addrKey(extra)}`);
    }
    this.exited = new Promise((r) => (this.exitResolve = r));
    for (const [k, fn] of Object.entries(builtinNatives)) this.natives.set(k, fn);
    const index = this.fs.read(`${opts.javaHome}/lib/packages.txt`);
    if (!index) throw new Error(`no JDK at ${opts.javaHome}; run pnpm jdk`);
    // modules the file system hides are left out
    const present = new Map<string, boolean>();
    for (const line of new TextDecoder().decode(index).split("\n")) {
      const sp = line.indexOf(" ");
      if (sp <= 0) continue;
      const mod = line.slice(0, sp);
      let has = present.get(mod);
      if (has === undefined) present.set(mod, (has = this.fs.stat(`${opts.javaHome}/modules/${mod}`) !== null));
      if (has) this.bootPackages.set(line.slice(sp + 1), mod);
    }
  }

  debug(...msg: any[]) {
    if (this.opts.debug) console.error(`[jvm +${Date.now() - this.startTime}ms]`, ...msg);
  }

  registerNatives(table: Record<string, NativeFn>) {
    for (const [k, fn] of Object.entries(table)) this.natives.set(k, fn);
  }

  // ---- classes -------------------------------------------------------------

  loaderClasses(loader: JObject | null): Map<string, JClass> {
    return loader === null ? this.boot : this.loaderData(loader).classes;
  }

  loaderData(loader: JObject): LoaderData {
    return (loader.x ??= { classes: new Map(), modules: new Map() });
  }

  findLoaded(loader: JObject | null, name: string): JClass | undefined {
    return this.loaderClasses(loader).get(name);
  }

  // Loads a class with the boot loader. Returns null when it does not exist.
  loadBoot(name: string): JClass | null {
    const c = this.boot.get(name);
    if (c) return c;
    if (name[0] === "[") {
      const comp = this.componentFromDesc(name.slice(1), null);
      return comp ? this.arrayOf(comp) : null;
    }
    const i = name.lastIndexOf("/");
    const module = this.bootPackages.get(i < 0 ? "" : name.slice(0, i));
    if (!module) return null;
    const bytes = this.fs.read(`${this.opts.javaHome}/modules/${module}/${name}.class`);
    if (!bytes) return null;
    const cf = parseClass(bytes);
    const superclass = cf.superName ? this.loadBootOrFail(cf.superName) : null;
    const interfaces = cf.interfaces.map((n) => this.loadBootOrFail(n));
    return this.defineLinked(cf, null, superclass, interfaces);
  }

  loadBootOrFail(name: string): JClass {
    const c = this.loadBoot(name);
    if (!c) throw new PendingThrow("java/lang/NoClassDefFoundError", name);
    return c;
  }

  private componentFromDesc(desc: string, loader: JObject | null): JClass | null | undefined {
    if (desc[0] === "[") {
      const inner = this.componentFromDesc(desc.slice(1), loader);
      return inner ? this.arrayOf(inner) : inner;
    }
    if (desc[0] === "L") {
      const n = desc.slice(1, -1);
      return loader === null ? this.loadBoot(n) : this.findLoaded(loader, n);
    }
    return this.primClass(desc);
  }

  primClass(desc: string): JClass {
    let c = this.prims.get(desc);
    if (!c) {
      c = new JClass(desc, null, null, ACC_PUBLIC | ACC_FINAL | ACC_ABSTRACT);
      c.prim = desc;
      c.state = INITIALIZED;
      this.prims.set(desc, c);
    }
    return c;
  }

  primArrayClass(elem: string): JClass {
    return this.arrayOf(this.primClass(elem));
  }

  arrayOf(c: JClass): JClass {
    if (c.arrayClass) return c.arrayClass;
    const name = "[" + c.desc;
    const a = new JClass(name, c.loader, null, (c.access & (ACC_PUBLIC | ACC_PRIVATE | ACC_PROTECTED)) | ACC_FINAL | ACC_ABSTRACT);
    a.component = c;
    a.superclass = this.loadBoot("java/lang/Object");
    a.interfaces = [this.loadBoot("java/lang/Cloneable")!, this.loadBoot("java/io/Serializable")!];
    a.state = INITIALIZED;
    c.arrayClass = a;
    this.loaderClasses(c.loader).set(name, a);
    return a;
  }

  // Creates a runtime class from a parsed class file whose supertypes are loaded.
  defineLinked(cf: ClassFile, loader: JObject | null, superclass: JClass | null, interfaces: JClass[], hidden = false): JClass {
    const map = this.loaderClasses(loader);
    if (!hidden && map.has(cf.name)) {
      throw new PendingThrow("java/lang/LinkageError", `duplicate class definition: ${cf.name}`);
    }
    const name = hidden ? `${cf.name}/0x${(++this.hiddenCount).toString(16).padStart(16, "0")}` : cf.name;
    const c = new JClass(name, loader, cf, cf.access);
    this.classCount++;
    c.hidden = hidden;
    c.superclass = superclass;
    c.interfaces = interfaces;
    let slot = superclass ? superclass.instanceSlots : 0;
    const template = superclass ? superclass.template.slice() : [];
    for (const [i, fm] of cf.fields.entries()) {
      const f = new JField(c, fm);
      f.index = i;
      if (f.isStatic) {
        f.slot = c.statics.length;
        c.statics.push(defaultValue(f.desc));
      } else {
        f.slot = slot++;
        template.push(defaultValue(f.desc));
      }
      c.fields.push(f);
    }
    c.instanceSlots = slot;
    c.template = template;
    const poly = cf.name === "java/lang/invoke/MethodHandle" || cf.name === "java/lang/invoke/VarHandle";
    for (const [i, mm] of cf.methods.entries()) {
      const intrinsic = loader === null ? intrinsics[`${cf.name}.${mm.name}${mm.desc}`] : undefined;
      const m = new JMethod(c, intrinsic ? { ...mm, code: null, access: mm.access | ACC_NATIVE } : mm);
      if (intrinsic) {
        m.native = intrinsic;
        m.intrinsic = true;
      }
      m.index = i;
      if (poly && (m.access & (ACC_NATIVE | ACC_VARARGS)) === (ACC_NATIVE | ACC_VARARGS)) m.polymorphic = true;
      c.methods.push(m);
      c.methodMap.set(m.key, m);
    }
    c.state = LINKED;
    if (!hidden) map.set(cf.name, c);
    return c;
  }

  // Loads a class through a Java class loader (or the boot loader).
  // With keepCnfe, a ClassNotFoundException from the loader propagates as is.
  *loadClassGen(t: JThread, loader: JObject | null, name: string, keepCnfe = false): NativeGen {
    const found = this.findLoaded(loader, name);
    if (found) return found;
    if (name[0] === "[") {
      let i = 0;
      while (name[i] === "[") i++;
      let c: JClass;
      if (name[i] === "L") c = yield* this.loadClassGen(t, loader, name.slice(i + 1, -1), keepCnfe);
      else c = this.primClass(name[i]);
      for (; i > 0; i--) c = this.arrayOf(c);
      this.loaderClasses(loader).set(name, c);
      return c;
    }
    if (loader === null) return this.loadBootOrFail(name);
    let mirror: JObject | null;
    try {
      mirror = yield t.callVirtual(loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", this.str(name.replace(/\//g, ".")));
    } catch (e) {
      if (!keepCnfe && e instanceof JavaThrow && this.isInstance(e.obj, "java/lang/ClassNotFoundException")) {
        throw new PendingThrow("java/lang/NoClassDefFoundError", name);
      }
      throw e;
    }
    if (!mirror) throw new PendingThrow("java/lang/NoClassDefFoundError", name);
    const c = mirror.x as JClass;
    this.loaderClasses(loader).set(name, c);
    return c;
  }

  // Defines a class for a Java class loader (ClassLoader.defineClass1 and friends).
  *defineClassGen(t: JThread, loader: JObject | null, bytes: Uint8Array, expected: string | null, pd: JObject | null, hidden = false): NativeGen {
    let cf: ClassFile;
    try {
      cf = parseClass(bytes, this.opts.enablePreview);
    } catch (e) {
      throw classFileError(e, expected ?? "class");
    }
    // the name a hidden class is defined with wins over the one in its bytes
    if (hidden && expected && expected !== cf.name) cf = { ...cf, name: expected, renamedFrom: cf.name };
    if (expected && expected !== cf.name) {
      throw new PendingThrow("java/lang/NoClassDefFoundError", `${expected} (wrong name: ${cf.name})`);
    }
    const superclass: JClass | null = cf.superName ? yield* this.loadClassGen(t, loader, cf.superName) : null;
    const interfaces: JClass[] = [];
    for (const n of cf.interfaces) interfaces.push(yield* this.loadClassGen(t, loader, n));
    const c = this.defineLinked(cf, loader, superclass, interfaces, hidden);
    if (pd) this.setField(this.mirror(c), "java/lang/Class", "protectionDomain", pd);
    return c;
  }

  // Class reference from a constant pool. Undefined while a Java class
  // loader is still working; the caller re-executes its instruction.
  classRef(t: JThread, cls: JClass, idx: number): JClass | undefined {
    const name = className(cls.cf!.cp, idx);
    // hidden classes are not registered, so their self references resolve here
    const c = name === cls.cf!.name || name === cls.cf!.renamedFrom ? cls : this.resolveClass(t, cls.loader, name);
    if (c) cls.rcp[idx] = c;
    return c;
  }

  resolveClass(t: JThread, loader: JObject | null, name: string): JClass | undefined {
    const found = this.findLoaded(loader, name);
    if (found) return found;
    if (loader === null) return this.loadBootOrFail(name);
    if (name[0] === "[") {
      let i = 0;
      while (name[i] === "[") i++;
      if (name[i] !== "L") {
        let c = this.primClass(name[i]);
        for (; i > 0; i--) c = this.arrayOf(c);
        return c;
      }
    }
    t.pushNative(this.loadClassGen(t, loader, name), null, "V", true);
    return undefined;
  }

  cpClassName(cls: JClass, idx: number): string {
    return className(cls.cf!.cp, idx);
  }

  fieldRef(t: JThread, cls: JClass, idx: number): JField | undefined {
    const cp = cls.cf!.cp;
    const e = cp[idx]!;
    const owner = cls.rcp[e.a] ?? this.classRef(t, cls, e.a);
    if (!owner) return undefined;
    const nat = cp[e.b]!;
    const name = utf8(cp, nat.a);
    const f = owner.findField(name, utf8(cp, nat.b));
    if (!f) throw new PendingThrow("java/lang/NoSuchFieldError", name);
    cls.rcp[idx] = f;
    return f;
  }

  methodRef(t: JThread, cls: JClass, idx: number): JMethod | undefined {
    const cp = cls.cf!.cp;
    const e = cp[idx]!;
    const owner = cls.rcp[e.a] ?? this.classRef(t, cls, e.a);
    if (!owner) return undefined;
    const nat = cp[e.b]!;
    const name = utf8(cp, nat.a), desc = utf8(cp, nat.b);
    const m = this.resolveMethod(owner, name, desc);
    cls.rcp[idx] = m;
    return m;
  }

  resolveMethod(owner: JClass, name: string, desc: string): JMethod {
    let m = owner.findMethod(name + desc);
    if (!m && (owner.name === "java/lang/invoke/MethodHandle" || owner.name === "java/lang/invoke/VarHandle")) {
      const generic = owner.methods.find((x) => x.name === name && x.polymorphic);
      if (generic) {
        m = new JMethod(owner, { access: generic.access, name, desc, attrs: generic.attrs, code: null });
        m.polymorphic = true;
      }
    }
    if (!m) throw new PendingThrow("java/lang/NoSuchMethodError", `'${desc}' ${owner.javaName}.${name}`);
    return m;
  }

  // invokespecial method selection (JVMS 6.5)
  specialTarget(current: JClass, m: JMethod): JMethod {
    if (m.name === "<init>" || m.isPrivate) return m;
    const owner = m.cls;
    if (!owner.isInterface && owner !== current && current.isSubclassOf(owner)) {
      for (let c = current.superclass; c; c = c.superclass) {
        const d = c.methodMap.get(m.key);
        if (d && !d.isStatic) return d;
      }
    }
    if (m.isAbstract && owner.isInterface) return owner.selectMethod(m.key) ?? m;
    return m;
  }

  // ldc / ldc_w / ldc2_w
  constant(t: JThread, cls: JClass, idx: number): any {
    const cp = cls.cf!.cp;
    const e = cp[idx]!;
    let v: any;
    switch (e.tag) {
      case Tag.Integer: case Tag.Float: case Tag.Long: case Tag.Double: v = e.value; break;
      case Tag.String: v = this.intern(utf8(cp, e.a)); break;
      case Tag.Class: {
        const c = this.classRef(t, cls, idx);
        if (!c) return undefined;
        v = this.mirror(c);
        break;
      }
      case Tag.MethodType: case Tag.MethodHandle: case Tag.Dynamic:
        t.pushNative(this.resolveConstantGen(t, cls, idx), null, "V", true);
        return undefined;
      default:
        throw new PendingThrow("java/lang/InternalError", `bad ldc constant tag ${e.tag}`);
    }
    cls.ldc[idx] = v;
    return v;
  }

  private *resolveConstantGen(t: JThread, cls: JClass, idx: number): NativeGen {
    cls.ldc[idx] = yield* resolveConstant(this, t, cls, idx);
  }

  // invokedynamic: the linked target is a static method taking the call
  // site's arguments. Undefined while linking runs.
  callSite(t: JThread, f: Frame, idx: number): CallSite | undefined {
    const cache = f.m.cache ??= [];
    const pc = f.pc;
    const site = cache[pc];
    if (site !== undefined) return site;
    t.pushNative((function* (vm: JVM) {
      cache[pc] = yield* linkCallSite(vm, t, f.m.cls, idx);
    })(this), null, "V", true);
    return undefined;
  }

  invokePolymorphic(t: JThread, f: Frame, m: JMethod, _idx: number): boolean {
    return invokePolymorphic(this, t, f, m);
  }

  // ---- initialization ------------------------------------------------------

  // True when c may be used now. Otherwise initialization was pushed and
  // the caller re-executes its instruction.
  initialize(t: JThread, c: JClass): boolean {
    if (c.state === INITIALIZED) return true;
    if (c.state === INITIALIZING && c.initThread === t) return true;
    t.pushNative(this.initGen(t, c), null, "V", true);
    return false;
  }

  *initGen(t: JThread, c: JClass): NativeGen {
    for (;;) {
      if (c.state === INITIALIZED) return;
      if (c.state === ERRONEOUS) {
        const err = yield* this.newThrowable(t, "java/lang/NoClassDefFoundError", `Could not initialize class ${c.javaName}`);
        if (c.initError) yield t.callVirtual(err, "initCause", "(Ljava/lang/Throwable;)Ljava/lang/Throwable;", c.initError);
        throw new JavaThrow(err);
      }
      if (c.state === INITIALIZING) {
        if (c.initThread === t) return;
        yield t.block(new Promise<void>((r) => c.initWaiters.push(r)));
        continue;
      }
      break;
    }
    c.state = INITIALIZING;
    c.initThread = t;
    try {
      if (!c.isInterface && c.superclass && c.superclass.state !== INITIALIZED) yield* this.initGen(t, c.superclass);
      for (const i of c.interfaces) {
        if (i.state !== INITIALIZED && i.methods.some((m) => !m.isAbstract && !m.isStatic)) yield* this.initGen(t, i);
      }
      this.applyConstantValues(c);
      const clinit = c.methodMap.get("<clinit>()V");
      if (clinit) yield t.call(clinit);
    } catch (e) {
      c.state = ERRONEOUS;
      c.initThread = null;
      this.wakeInit(c);
      if (e instanceof JavaThrow) {
        // later attempts get this copy, not the original (as in HotSpot)
        const detail = this.getField(e.obj, "java/lang/Throwable", "detailMessage");
        const what = `Exception ${e.obj.cls.javaName}${detail ? ": " + this.jsString(detail) : ""}`;
        const copy = yield* this.newThrowable(t, "java/lang/ExceptionInInitializerError", `${what} [in thread "${t.name}"]`);
        try {
          this.setField(copy, "java/lang/Throwable", "stackTrace", yield t.callVirtual(e.obj, "getStackTrace", "()[Ljava/lang/StackTraceElement;"));
          this.setField(copy, "java/lang/Throwable", "backtrace", null);
        } catch (x) {
          if (!(x instanceof JavaThrow)) throw x;
        }
        c.initError = copy;
        if (this.isInstance(e.obj, "java/lang/Error")) throw e;
        throw new JavaThrow(yield* this.newThrowable(t, "java/lang/ExceptionInInitializerError", null, e.obj));
      }
      throw e;
    }
    c.state = INITIALIZED;
    c.initThread = null;
    this.wakeInit(c);
  }

  private wakeInit(c: JClass) {
    const w = c.initWaiters;
    c.initWaiters = [];
    for (const r of w) r();
  }

  private applyConstantValues(c: JClass) {
    const cp = c.cf?.cp;
    if (!cp) return;
    for (const f of c.fields) {
      if (!f.isStatic) continue;
      const raw = f.attrs.get("ConstantValue");
      if (!raw) continue;
      const e = cp[(raw[0] << 8) | raw[1]]!;
      c.statics[f.slot] = e.tag === Tag.String ? this.intern(utf8(cp, e.a)) : e.value;
    }
  }

  // ---- objects -------------------------------------------------------------

  newObject(c: JClass): JObject {
    return new JObject(c, c.template.slice());
  }

  newArray(component: JClass, n: number): JArray {
    return new JArray(this.arrayOf(component), newArrayData(component.prim ?? "L", n));
  }

  newObjectArray(componentName: string, items: (JObject | null)[]): JArray {
    const c = this.loadBootOrFail(componentName);
    return new JArray(this.arrayOf(c), items);
  }

  multiArray(c: JClass, counts: number[]): JArray {
    const [n, ...rest] = counts;
    const comp = c.component!;
    if (rest.length === 0) return new JArray(c, newArrayData(comp.prim ?? "L", n));
    const items = newArrayData("L", n) as JObject[];
    for (let i = 0; i < n; i++) items[i] = this.multiArray(comp, rest);
    return new JArray(c, items);
  }

  identityHash(o: JObject): number {
    if (o.hash === 0) {
      let x = this.hashSeed;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this.hashSeed = x;
      o.hash = (x & 0x7fffffff) || 1;
    }
    return o.hash;
  }

  isInstance(o: JObject, name: string): boolean {
    for (const c of o.cls.allSupers()) if (c.name === name) return true;
    return false;
  }

  mirror(c: JClass): JObject {
    if (c.mirror) return c.mirror;
    const o = this.newObject(this.loadBootOrFail("java/lang/Class"));
    o.x = c;
    c.mirror = o;
    this.setField(o, "java/lang/Class", "classLoader", c.loader);
    if (c.component) this.setField(o, "java/lang/Class", "componentType", this.mirror(c.component));
    this.setField(o, "java/lang/Class", "modifiers", this.classModifiers(c));
    this.setField(o, "java/lang/Class", "primitive", c.prim ? 1 : 0);
    this.setField(o, "java/lang/Class", "module", this.moduleOf(c));
    return o;
  }

  classOf(mirror: JObject): JClass {
    return mirror.x as JClass;
  }

  // Class.getModifiers: inner class flags win over the class access flags.
  classModifiers(c: JClass): number {
    if (c.component) {
      let e = c.component;
      while (e.component) e = e.component;
      return (this.classModifiers(e) & (ACC_PUBLIC | ACC_PRIVATE | ACC_PROTECTED)) | ACC_FINAL | ACC_ABSTRACT;
    }
    if (c.prim) return ACC_PUBLIC | ACC_FINAL | ACC_ABSTRACT;
    const inner = c.cf ? innerClassFlags(c.cf, c.name) : null;
    const flags = inner ?? c.access;
    return flags & ~ACC_SUPER & 0x7fff;
  }

  moduleOf(c: JClass): JObject | null {
    while (c.component) c = c.component;
    if (c.prim) return this.bootModules.get("java.base") ?? null;
    if (c.loader === null) {
      const mod = this.bootPackages.get(c.packageName);
      // a module not defined yet: defineModule0 sets it later, as HotSpot does
      if (mod) return this.bootModules.get(mod) ?? null;
      return this.bootUnnamedModule;
    }
    const named = this.loaderData(c.loader).modules.get(c.packageName);
    if (named) return named;
    return this.getField(c.loader, "java/lang/ClassLoader", "unnamedModule");
  }

  // ModuleEntry::should_show_version: the JDK's own modules show no version.
  // They are in the image's modules/ directory here, at jrt:/ on HotSpot.
  shownVersion(mod: JObject): string | null {
    const version = mod.x?.version as string | null | undefined;
    if (!version || !this.getField(mod, "java/lang/Module", "name")) return null;
    const image = `file://${this.opts.javaHome}/modules/`;
    const loc = (mod.x.location as string | null) ?? "";
    const jrt = loc.startsWith(image) ? `jrt:/${loc.slice(image.length)}` : loc;
    const loader = this.getField(mod, "java/lang/Module", "loader") as JObject | null;
    const platform = loader?.cls.name === "jdk/internal/loader/ClassLoaders$PlatformClassLoader";
    const builtin = !loader || platform || loader.cls.name === "jdk/internal/loader/ClassLoaders$AppClassLoader";
    if ((!loader || platform) && jrt.startsWith("jrt:/java.")) return null;
    if (builtin && jrt.startsWith("jrt:/jdk.") && version === this.bootModules.get("java.base")?.x?.version) return null;
    return version;
  }

  // SharedRuntime::generate_class_cast_message
  castMessage(from: JClass, to: JClass): string {
    const mod = (c: JClass) => this.moduleOf(c);
    const where = (c: JClass) => {
      const m = mod(c);
      const name = m && this.getField(m, "java/lang/Module", "name");
      const version = name && this.shownVersion(m);
      let b = c;
      while (b.component) b = b.component;
      const loader = b.loader && this.getField(b.loader, "java/lang/ClassLoader", "nameAndId");
      return `${name ? `module ${this.jsString(name)}${version ? `@${version}` : ""}` : "unnamed module"} of loader ${loader ? this.jsString(loader) : "'bootstrap'"}`;
    };
    const head = `class ${from.javaName} cannot be cast to class ${to.javaName}`;
    if (mod(from) === mod(to)) return `${head} (${from.javaName} and ${to.javaName} are in ${where(from)})`;
    return `${head} (${from.javaName} is in ${where(from)}; ${to.javaName} is in ${where(to)})`;
  }

  // ---- fields by name ------------------------------------------------------

  slotOf(owner: string, name: string): number {
    const key = owner + "." + name;
    let s = this.slots.get(key);
    if (s === undefined) {
      const c = this.loadBootOrFail(owner);
      const f = c.findField(name);
      if (!f) throw new Error(`no field ${key}`);
      s = f.slot;
      this.slots.set(key, s);
    }
    return s;
  }

  getField(o: JObject, owner: string, name: string): any {
    return o.f[this.slotOf(owner, name)];
  }

  setField(o: JObject, owner: string, name: string, v: any) {
    o.f[this.slotOf(owner, name)] = v;
  }

  getStatic(c: JClass, name: string): any {
    const f = c.findField(name);
    if (!f || !f.isStatic) throw new Error(`no static ${c.name}.${name}`);
    return f.cls.statics[f.slot];
  }

  setStatic(c: JClass, name: string, v: any) {
    const f = c.findField(name);
    if (!f || !f.isStatic) throw new Error(`no static ${c.name}.${name}`);
    f.cls.statics[f.slot] = v;
  }

  // ---- strings -------------------------------------------------------------

  str(s: string): JObject {
    const c = this.loadBootOrFail("java/lang/String");
    const o = this.newObject(c);
    let latin1 = true;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) { latin1 = false; break; }
    let bytes: Int8Array;
    if (latin1) {
      bytes = new Int8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    } else {
      bytes = new Int8Array(s.length * 2);
      const u16 = new Uint16Array(bytes.buffer);
      for (let i = 0; i < s.length; i++) u16[i] = s.charCodeAt(i);
    }
    o.f[this.slotOf("java/lang/String", "value")] = new JArray(this.primArrayClass("B"), bytes);
    o.f[this.slotOf("java/lang/String", "coder")] = latin1 ? 0 : 1;
    return o;
  }

  jsString(o: JObject): string {
    const bytes = (o.f[this.slotOf("java/lang/String", "value")] as JArray).a as Int8Array;
    const coder = o.f[this.slotOf("java/lang/String", "coder")];
    let units: ArrayLike<number>;
    if (coder === 0) units = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    else if (bytes.byteOffset % 2 === 0) units = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
    else units = new Uint16Array(bytes.slice().buffer);
    let s = "";
    for (let i = 0; i < units.length; i += 8192) {
      s += String.fromCharCode.apply(null, Array.prototype.slice.call(units, i, i + 8192));
    }
    return s;
  }

  intern(s: string): JObject {
    let o = this.interned.get(s);
    if (!o) {
      o = this.str(s);
      this.interned.set(s, o);
    }
    return o;
  }

  internObject(o: JObject): JObject {
    const s = this.jsString(o);
    const found = this.interned.get(s);
    if (found) return found;
    this.interned.set(s, o);
    return o;
  }

  // ---- exceptions ----------------------------------------------------------

  *newThrowable(t: JThread, name: string, msg: string | null, cause: JObject | null = null,
    ctor?: { desc: string; args: any[] }): NativeGen {
    const c = this.loadBootOrFail(name);
    if (c.state !== INITIALIZED) yield* this.initGen(t, c);
    const o = this.newObject(c);
    if (ctor) {
      yield t.call(c.methodMap.get(`<init>${ctor.desc}`)!, o, ...ctor.args);
    } else if (cause && c.methodMap.has("<init>(Ljava/lang/Throwable;)V") && msg === null) {
      yield t.call(c.methodMap.get("<init>(Ljava/lang/Throwable;)V")!, o, cause);
    } else if (msg === null) {
      yield t.call(c.methodMap.get("<init>()V")!, o);
    } else {
      yield t.call(c.methodMap.get("<init>(Ljava/lang/String;)V")!, o, this.str(msg));
    }
    return o;
  }

  // native: the native method throwing it, shown in its stack trace
  throwNew(t: JThread, name: string, msg: string | null, ctor?: { desc: string; args: any[] }, native: JMethod | null = null) {
    const vm = this;
    t.pushNative((function* () {
      throw new JavaThrow(yield* vm.newThrowable(t, name, msg, null, ctor));
    })(), native, "V", false);
  }

  internalError(t: JThread, e: unknown) {
    console.error("jvm: internal error in", t.name, e);
    this.dumpStack(t);
    this.throwNew(t, "java/lang/InternalError", e instanceof Error ? e.message : String(e));
  }

  dumpStack(t: JThread) {
    for (let i = t.frames.length - 1; i >= 0; i--) {
      const f = t.frames[i];
      if (f instanceof Frame) console.error(`    at ${f.m} pc=${f.pc} line=${f.m.lineAt(f.pc)}`);
      else console.error(`    at <native ${f.m ?? "vm"}>`);
    }
  }

  // ---- natives -------------------------------------------------------------

  bindNative(m: JMethod): NativeFn {
    const key = `${m.cls.name}.${m.name}${m.desc}`;
    let fn = this.natives.get(key) ?? this.natives.get(`${m.cls.name}.${m.name}`);
    if (!fn) {
      const host = this.opts.hostNatives?.(jniNames(m));
      if (host) fn = hostNative(m, host);
      else if (m.name === "registerNatives" || m.name === "initIDs") fn = () => undefined;
      else {
        this.debug("missing native", key);
        fn = () => {
          throw new PendingThrow("java/lang/UnsatisfiedLinkError", key);
        };
      }
    }
    m.native = fn;
    return fn;
  }

  // ---- monitors ------------------------------------------------------------

  // Takes o's monitor. On contention the thread is parked until the
  // monitor is released and false is returned; the caller retries.
  monitorEnter(t: JThread, o: JObject): boolean {
    if (this.tryMonitorEnter(t, o)) {
      if (t.blockedOnMonitor) {
        t.blockedOnMonitor = false;
        this.setThreadStatus(t, STATUS_RUNNABLE);
      }
      return true;
    }
    // Thread.getState() says BLOCKED while it waits, as on HotSpot
    if (!t.blockedOnMonitor) {
      t.blockedOnMonitor = true;
      this.setThreadStatus(t, STATUS_BLOCKED);
    }
    t.state = WAITING;
    o.mon!.entry.push(() => this.wake(t));
    return false;
  }

  setThreadStatus(t: JThread, status: number) {
    if (!t.obj) return;
    const holder = this.getField(t.obj, "java/lang/Thread", "holder");
    if (holder) this.setField(holder, "java/lang/Thread$FieldHolder", "threadStatus", status);
  }

  // Takes o's monitor if that needs no waiting.
  tryMonitorEnter(t: JThread, o: JObject): boolean {
    const mon = (o.mon ??= new Monitor());
    if (mon.owner === null) {
      mon.owner = t;
      mon.count = 1;
      t.held++;
      return true;
    }
    if (mon.owner === t) {
      mon.count++;
      t.held++;
      return true;
    }
    return false;
  }

  monitorExit(t: JThread, o: JObject) {
    const mon = o.mon;
    if (!mon || mon.owner !== t) throw new PendingThrow("java/lang/IllegalMonitorStateException");
    t.held--;
    if (--mon.count === 0) this.releaseMonitor(mon);
  }

  releaseMonitor(mon: Monitor) {
    mon.owner = null;
    mon.count = 0;
    const entry = mon.entry;
    mon.entry = [];
    for (const w of entry) w();
  }

  // ---- threads -------------------------------------------------------------

  startThread(t: JThread) {
    this.threads.add(t);
    this.threadsStarted++;
    let live = 0;
    for (const x of this.threads) if (x.state !== TERMINATED) live++;
    if (live > this.peakThreads) this.peakThreads = live;
    this.wake(t);
  }

  wake(t: JThread) {
    if (t.state === TERMINATED) return;
    t.state = RUNNABLE;
    if (!this.queued.has(t)) {
      this.queued.add(t);
      this.runQueue.push(t);
    }
    this.schedule();
  }

  private schedule() {
    if (this.scheduled || this.exitCode !== null) return;
    this.scheduled = true;
    YIELD(() => this.loop());
  }

  private loop() {
    this.scheduled = false;
    const end = performance.now() + 20;
    while (this.runQueue.length > 0 && this.exitCode === null) {
      const t = this.runQueue.shift()!;
      this.queued.delete(t);
      if (t.state !== RUNNABLE) continue;
      runThread(t, 20000);
      if (t.state === RUNNABLE && !this.queued.has(t)) {
        this.queued.add(t);
        this.runQueue.push(t);
      }
      if (performance.now() > end) break;
    }
    if (this.runQueue.length > 0) this.schedule();
  }

  nonDaemonAlive(except: JThread): boolean {
    for (const t of this.threads) if (t !== except && !t.daemon && t.state !== TERMINATED) return true;
    return false;
  }

  // Stops every thread and reports the exit code.
  halt(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.lib?.close();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const t of this.threads) {
      t.frames = [];
      t.state = TERMINATED;
    }
    this.exitResolve(code);
  }

  // Wraps a new Java thread object. The bottom frame runs Thread.run and the
  // VM side of thread exit.
  javaThread(obj: JObject): JThread {
    const t = new JThread(this);
    t.obj = obj;
    obj.x = t;
    const vm = this;
    const holder = this.getField(obj, "java/lang/Thread", "holder") as JObject;
    t.daemon = this.getField(holder, "java/lang/Thread$FieldHolder", "daemon") === 1;
    t.pushNative((function* () {
      try {
        yield t.callVirtual(obj, "run", "()V");
      } catch (e) {
        if (!(e instanceof JavaThrow)) throw e;
        try {
          yield t.callVirtual(obj, "dispatchUncaughtException", "(Ljava/lang/Throwable;)V", e.obj);
        } catch {
          // ignored like HotSpot does, after a report
        }
      }
      yield* vm.exitThread(t);
    })(), null, "V", false);
    return t;
  }

  *exitThread(t: JThread): NativeGen {
    const obj = t.obj!;
    try {
      yield t.callVirtual(obj, "exit", "()V");
    } catch {
      // Thread.exit failures are swallowed, see JavaThread::exit
    }
    // Thread.join waits on the thread object, checking isAlive() under its
    // monitor. Take the monitor first, as HotSpot's ensure_join does, so a
    // joiner between isAlive() and wait() cannot miss the wakeup.
    while (!this.tryMonitorEnter(t, obj)) yield t.block(new Promise<void>((r) => obj.mon!.entry.push(r)));
    const holder = this.getField(obj, "java/lang/Thread", "holder") as JObject;
    this.setField(holder, "java/lang/Thread$FieldHolder", "threadStatus", STATUS_TERMINATED);
    this.setField(obj, "java/lang/Thread", "eetop", 0n);
    this.notifyAll(obj);
    this.monitorExit(t, obj);
  }

  notifyAll(o: JObject) {
    const mon = o.mon;
    if (!mon) return;
    const w = mon.waiters;
    mon.waiters = [];
    for (const x of w) x.wake();
  }

  // ---- boot ----------------------------------------------------------------

  // Starts the VM and runs a main class (mode LM_CLASS) or jar (LM_JAR).
  // Resolves to the exit code.
  run(mode: number, what: string, args: string[]): Promise<number> {
    // as the java launcher sets it
    if (!this.props.has("sun.java.command")) this.props.set("sun.java.command", [what, ...args].join(" "));
    const t = new JThread(this);
    t.pushNative(this.mainGen(t, mode, what, args), null, "V", false);
    this.startThread(t);
    return this.exited;
  }

  // Starts the VM with no main class; Java can then be called through
  // library, one call at a time on the main thread, as in CheerpJ's library mode.
  startLibrary(): Promise<void> {
    const t = new JThread(this);
    const started = new Promise<void>((resolve, reject) => {
      t.pushNative(this.libraryGen(t, resolve, reject), null, "V", false);
    });
    this.startThread(t);
    return started;
  }

  private lib: Library | null = null;

  // Java objects and calls for library mode, and for natives that call back.
  get library(): Library {
    return (this.lib ??= new Library(this));
  }

  // Calls a static method by name, picking the overload that fits the
  // arguments; see Library. With a null method it only loads and
  // initializes the class.
  callStatic(className: string, method: string | null, args: unknown[]): Promise<unknown> {
    const req: LibraryRequest = method === null ? { op: "class", cls: className } : { op: "static", cls: className, method, args };
    return this.library.request(req).then((r) => r.value);
  }

  private *libraryGen(t: JThread, started: () => void, failed: (e: Error) => void): NativeGen {
    try {
      yield* this.bootGen(t);
    } catch (e) {
      failed(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    started();
    yield* this.library.loop(t);
  }

  // System.initPhase1 to 3, as HotSpot's Threads::create_vm runs them.
  private *bootGen(t: JThread): NativeGen {
    const boot = (n: string) => this.loadBootOrFail(n);
    const init = (n: string) => this.initGen(t, boot(n));
    try {
      yield* init("java/lang/String");
      yield* init("java/lang/System");
      yield* init("java/lang/Class");
      yield* init("java/lang/ThreadGroup");
      const tg = boot("java/lang/ThreadGroup");
      const system = this.newObject(tg);
      yield t.call(tg.methodMap.get("<init>()V")!, system);
      const mainGroup = this.newObject(tg);
      yield t.call(tg.methodMap.get("<init>(Ljava/lang/ThreadGroup;Ljava/lang/String;)V")!, mainGroup, system, this.str("main"));
      yield* init("java/lang/Thread");
      const thread = boot("java/lang/Thread");
      const obj = this.newObject(thread);
      t.obj = obj;
      obj.x = t;
      this.setField(obj, "java/lang/Thread", "eetop", 1n);
      yield t.call(thread.methodMap.get("<init>(Ljava/lang/ThreadGroup;Ljava/lang/String;)V")!, obj, mainGroup, this.str("main"));
      const holder = this.getField(obj, "java/lang/Thread", "holder") as JObject;
      this.setField(holder, "java/lang/Thread$FieldHolder", "threadStatus", STATUS_RUNNABLE);
      yield* init("java/lang/Module");
      yield* init("jdk/internal/misc/UnsafeConstants");
      const uc = boot("jdk/internal/misc/UnsafeConstants");
      this.setStatic(uc, "ADDRESS_SIZE0", 8);
      this.setStatic(uc, "PAGE_SIZE", 4096);
      this.setStatic(uc, "BIG_ENDIAN", 0);
      this.setStatic(uc, "UNALIGNED_ACCESS", 1);
      this.setStatic(uc, "DATA_CACHE_LINE_FLUSH_SIZE", 0);
      yield* init("java/lang/reflect/Method");
      yield* init("java/lang/ref/Finalizer");
      this.debug("initPhase1");
      yield t.call(boot("java/lang/System").methodMap.get("initPhase1()V")!);
      for (const n of [
        "java/lang/OutOfMemoryError", "java/lang/NullPointerException", "java/lang/ClassCastException",
        "java/lang/ArrayStoreException", "java/lang/ArithmeticException",
        "java/lang/ArrayIndexOutOfBoundsException", "java/lang/StackOverflowError",
        "java/lang/IllegalMonitorStateException", "java/lang/IllegalArgumentException",
        "java/lang/InternalError", "java/lang/invoke/MethodHandle", "java/lang/invoke/ResolvedMethodName",
        "java/lang/invoke/MemberName", "java/lang/invoke/MethodHandleNatives",
      ]) yield* init(n);
      this.debug("initPhase2");
      const rc = yield t.call(boot("java/lang/System").methodMap.get("initPhase2(ZZ)I")!, 1, 1);
      if (rc !== 0) throw new Error(`initPhase2 failed: ${rc}`);
      this.debug("initPhase3");
      yield t.call(boot("java/lang/System").methodMap.get("initPhase3()V")!);
      this.debug("vm started in", Date.now() - this.startTime, "ms");
    } catch (e) {
      if (e instanceof JavaThrow) {
        console.error("jvm: exception during startup:", this.describeThrowable(e.obj));
        this.dumpJavaStack(e.obj);
      }
      this.halt(1);
      throw e;
    }
  }

  private *mainGen(t: JThread, mode: number, what: string, args: string[]): NativeGen {
    const boot = (n: string) => this.loadBootOrFail(n);
    yield* this.bootGen(t);
    let code = 0;
    try {
      const helper = boot("sun/launcher/LauncherHelper");
      const mainMirror: JObject = yield t.call(
        helper.methodMap.get("checkAndLoadMain(ZILjava/lang/String;)Ljava/lang/Class;")!, 1, mode, this.str(what));
      const main = this.classOf(mainMirror);
      const isStatic = this.getStatic(helper, "isStaticMain") === 1;
      const noArgs = this.getStatic(helper, "noArgMain") === 1;
      const jargs = this.newObjectArray("java/lang/String", args.map((a) => this.str(a)));
      if (main.state !== INITIALIZED) yield* this.initGen(t, main);
      const key = noArgs ? "main()V" : "main([Ljava/lang/String;)V";
      if (isStatic) {
        const m = main.findMethod(key)!;
        yield noArgs ? t.call(m) : t.call(m, jargs);
      } else {
        const self = this.newObject(main);
        yield t.call(main.methodMap.get("<init>()V")!, self);
        const m = main.selectMethod(key)!;
        yield noArgs ? t.call(m, self) : t.call(m, self, jargs);
      }
    } catch (e) {
      if (!(e instanceof JavaThrow)) throw e;
      code = 1;
      try {
        yield t.callVirtual(t.obj!, "dispatchUncaughtException", "(Ljava/lang/Throwable;)V", e.obj);
      } catch {
        // nothing left to report to
      }
    }
    // DestroyJavaVM: wait for the other non-daemon threads, then shut down.
    while (this.nonDaemonAlive(t)) {
      yield t.block(new Promise<void>((r) => {
        const check = () => (this.nonDaemonAlive(t) ? setTimeout(check, 5) : r());
        check();
      }));
    }
    yield* this.exitThread(t);
    yield t.call(boot("java/lang/Shutdown").methodMap.get("shutdown()V")!);
    this.halt(code);
  }

  describeThrowable(o: JObject): string {
    const msg = this.getField(o, "java/lang/Throwable", "detailMessage");
    return o.cls.javaName + (msg ? ": " + this.jsString(msg) : "");
  }

  dumpJavaStack(o: JObject) {
    const bt = this.getField(o, "java/lang/Throwable", "backtrace");
    if (Array.isArray(bt)) {
      for (const { m, pc } of bt) console.error(`    at ${m.cls.javaName}.${m.name}(line ${m.lineAt(pc)})`);
    }
    const cause = this.getField(o, "java/lang/Throwable", "cause");
    if (cause && cause !== o) {
      console.error("  caused by:", this.describeThrowable(cause));
      this.dumpJavaStack(cause);
    }
  }
}

// ClassFileParser's errors, worded as HotSpot words them.
function classFileError(e: unknown, name: string): unknown {
  if (e instanceof BadMagic) return new PendingThrow("java/lang/ClassFormatError", `Incompatible magic value ${e.magic} in class file ${name}`);
  if (e instanceof ClassFormatError) return new PendingThrow("java/lang/ClassFormatError", e.message);
  if (!(e instanceof UnsupportedVersion)) return e;
  const { major, minor } = e;
  const v = `${major}.${minor}`;
  let msg: string;
  if (major > MAX_MAJOR) {
    msg = `${name} has been compiled by a more recent version of the Java Runtime (class file version ${v}), ` +
      `this version of the Java Runtime only recognizes class file versions up to ${MAX_MAJOR}.0`;
  } else if (major < 45) msg = `${name} (class file version ${v}) was compiled with an invalid major version`;
  else if (minor !== 0xffff) msg = `${name} (class file version ${v}) was compiled with an invalid non-zero minor version`;
  else if (major !== MAX_MAJOR) {
    msg = `${name} (class file version ${v}) was compiled with preview features that are unsupported. ` +
      `This version of the Java Runtime only recognizes preview features for class file version ${MAX_MAJOR}.65535`;
  } else msg = `Preview features are not enabled for ${name} (class file version ${v}). Try running with '--enable-preview'`;
  return new PendingThrow("java/lang/UnsupportedClassVersionError", msg);
}

function innerClassFlags(cf: ClassFile, name: string): number | null {
  const raw = cf.attrs.get("InnerClasses");
  if (!raw) return null;
  const n = (raw[0] << 8) | raw[1];
  for (let i = 0; i < n; i++) {
    const p = 2 + i * 8;
    const inner = (raw[p] << 8) | raw[p + 1];
    if (inner && className(cf.cp, inner) === name) return (raw[p + 6] << 8) | raw[p + 7];
  }
  return null;
}
