// jdk.internal.misc (Unsafe, VM, CDS, Signal), system properties and other
// low-level natives.

import {
  ARRAY_BASE_OFFSET, INITIALIZED, JArray, JClass, JMethod, JObject, STATIC_OFFSET_BASE,
} from "../runtime.ts";
import { JThread, JavaThrow, PendingThrow, STATUS_PARKED, STATUS_PARKED_TIMED, STATUS_RUNNABLE } from "../thread.ts";
import type { NativeGen } from "../thread.ts";
import { annotationTypes } from "./invoke.ts";
import { interruptibleWait } from "./lang.ts";
import { nestHostOf } from "./reflect.ts";
import { javaFrames, jstr, nonNull, u8 } from "./util.ts";
import type { Natives } from "./util.ts";

const REF_SCALE = 4;
const WIDTH: Record<string, number> = { Z: 1, B: 1, S: 2, C: 2, I: 4, J: 8, F: 4, D: 8 };

export function indexScale(c: JClass): number {
  const p = c.component!.prim;
  return p ? WIDTH[p] : REF_SCALE;
}

function view(a: JArray): DataView {
  const ta = a.a as Int8Array;
  return new DataView(ta.buffer, ta.byteOffset, ta.byteLength);
}

function dvRead(dv: DataView, p: number, k: string): any {
  switch (k) {
    case "Z": return dv.getInt8(p) !== 0 ? 1 : 0;
    case "B": return dv.getInt8(p);
    case "S": return dv.getInt16(p, true);
    case "C": return dv.getUint16(p, true);
    case "I": return dv.getInt32(p, true);
    case "J": return dv.getBigInt64(p, true);
    case "F": return dv.getFloat32(p, true);
    case "D": return dv.getFloat64(p, true);
  }
  throw new Error(`bad kind ${k}`);
}

function dvWrite(dv: DataView, p: number, k: string, v: any) {
  switch (k) {
    case "Z": case "B": dv.setInt8(p, v); return;
    case "S": case "C": dv.setInt16(p, v, true); return;
    case "I": dv.setInt32(p, v, true); return;
    case "J": dv.setBigInt64(p, v, true); return;
    case "F": dv.setFloat32(p, v, true); return;
    case "D": dv.setFloat64(p, v, true); return;
  }
  throw new Error(`bad kind ${k}`);
}

function sameKind(elem: string, k: string) {
  return elem === k || (elem === "Z" && k === "B") || (elem === "B" && k === "Z");
}

export function unsafeGet(t: JThread, o: JObject | null, offset: bigint, k: string): any {
  const off = Number(offset);
  if (o === null) {
    if (k === "L") throw new Error("reference read from native memory");
    return dvRead(t.vm.mem.dv, off, k);
  }
  if (o instanceof JArray) {
    const elem = o.cls.component!.prim ?? "L";
    if (elem === "L") return o.a[(off - ARRAY_BASE_OFFSET) / REF_SCALE];
    if (sameKind(elem, k)) return o.a[(off - ARRAY_BASE_OFFSET) / WIDTH[elem]];
    return dvRead(view(o), off - ARRAY_BASE_OFFSET, k);
  }
  if (off >= STATIC_OFFSET_BASE && o.x instanceof JClass) return o.x.statics[off - STATIC_OFFSET_BASE];
  return o.f[off];
}

export function unsafePut(t: JThread, o: JObject | null, offset: bigint, k: string, v: any) {
  const off = Number(offset);
  if (o === null) {
    dvWrite(t.vm.mem.dv, off, k, v);
    return;
  }
  if (o instanceof JArray) {
    const elem = o.cls.component!.prim ?? "L";
    if (elem === "L") o.a[(off - ARRAY_BASE_OFFSET) / REF_SCALE] = v;
    else if (sameKind(elem, k)) (o.a as any)[(off - ARRAY_BASE_OFFSET) / WIDTH[elem]] = v;
    else dvWrite(view(o), off - ARRAY_BASE_OFFSET, k, v);
    return;
  }
  if (off >= STATIC_OFFSET_BASE && o.x instanceof JClass) o.x.statics[off - STATIC_OFFSET_BASE] = v;
  else o.f[off] = v;
}

function cas(t: JThread, o: JObject | null, off: bigint, k: string, expect: any, v: any): any {
  const cur = unsafeGet(t, o, off, k);
  if (cur === expect) unsafePut(t, o, off, k, v);
  return cur;
}

// A byte view of base+offset for bulk memory operations.
function bytesAt(t: JThread, base: JObject | null, offset: bigint): [Uint8Array, number] {
  if (base === null) return [t.vm.mem.u8, Number(offset)];
  const ta = (base as JArray).a as Int8Array;
  return [new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength), Number(offset) - ARRAY_BASE_OFFSET];
}

export function fieldOf(t: JThread, field: JObject) {
  const vm = t.vm;
  const c = vm.classOf(vm.getField(field, "java/lang/reflect/Field", "clazz"));
  return c.fields[vm.getField(field, "java/lang/reflect/Field", "slot")];
}

const KINDS: [string, string][] = [
  ["Int", "I"], ["Reference", "L"], ["Boolean", "Z"], ["Byte", "B"], ["Short", "S"], ["Char", "C"],
  ["Long", "J"], ["Float", "F"], ["Double", "D"],
];

const unsafe: Natives = {};
const U = "jdk/internal/misc/Unsafe.";
for (const [name, k] of KINDS) {
  const desc = k === "L" ? "Ljava/lang/Object;" : k;
  for (const suffix of ["", "Volatile"]) {
    unsafe[`${U}get${name}${suffix}(Ljava/lang/Object;J)${desc}`] = (t, [, o, off]) => unsafeGet(t, o, off, k);
    unsafe[`${U}put${name}${suffix}(Ljava/lang/Object;J${desc})V`] = (t, [, o, off, v]) => unsafePut(t, o, off, k, v);
  }
}
for (const [name, k, desc] of [["Int", "I", "I"], ["Long", "J", "J"], ["Reference", "L", "Ljava/lang/Object;"]]) {
  unsafe[`${U}compareAndSet${name}(Ljava/lang/Object;J${desc}${desc})Z`] =
    (t, [, o, off, e, v]) => cas(t, o, off, k, e, v) === e;
  unsafe[`${U}compareAndExchange${name}(Ljava/lang/Object;J${desc}${desc})${desc}`] =
    (t, [, o, off, e, v]) => cas(t, o, off, k, e, v);
}

// Java methods of Unsafe that pack sub-word CAS into an aligned int; with
// slot-based field offsets that would hit the neighbouring field.
export const intrinsics: Natives = {
  [`${U}compareAndExchangeByte(Ljava/lang/Object;JBB)B`]: (t, [, o, off, e, v]) => cas(t, o, off, "B", e, v),
  [`${U}compareAndExchangeShort(Ljava/lang/Object;JSS)S`]: (t, [, o, off, e, v]) => cas(t, o, off, "S", e, v),
};

function* park(t: JThread, absolute: boolean, time: bigint): NativeGen {
  if (t.parkPermit) {
    t.parkPermit = false;
    return;
  }
  if (t.interrupted) return;
  let ms: number | null = null;
  if (absolute) ms = Number(time) - Date.now();
  else if (time > 0n) ms = Number(time) / 1e6;
  if (ms !== null && ms <= 0) return;
  t.vm.state.set(`parked:${t.id}`, true);
  setStatus(t, ms === null ? STATUS_PARKED : STATUS_PARKED_TIMED);
  yield t.block(interruptibleWait(t, ms));
  t.vm.state.delete(`parked:${t.id}`);
  setStatus(t, STATUS_RUNNABLE);
  t.parkPermit = false;
}

function setStatus(t: JThread, s: number) {
  if (!t.obj) return;
  const holder = t.vm.getField(t.obj, "java/lang/Thread", "holder");
  if (holder) t.vm.setField(holder, "java/lang/Thread$FieldHolder", "threadStatus", s);
}

Object.assign(unsafe, {
  [`${U}park(ZJ)V`]: (t: JThread, [, abs, time]: any[]) => park(t, abs === 1, time),
  [`${U}unpark(Ljava/lang/Object;)V`]: (t: JThread, [, obj]: any[]) => {
    const jt = obj?.x as JThread | undefined;
    if (!(jt instanceof JThread)) return;
    jt.parkPermit = true;
    if (t.vm.state.get(`parked:${jt.id}`)) jt.wake?.();
  },
  [`${U}fullFence()V`]: () => undefined,
  [`${U}allocateMemory0(J)J`]: (t: JThread, [, n]: any[]) => BigInt(t.vm.mem.malloc(Number(n))),
  [`${U}reallocateMemory0(JJ)J`]: (t: JThread, [, a, n]: any[]) => BigInt(t.vm.mem.realloc(Number(a), Number(n))),
  [`${U}freeMemory0(J)V`]: (t: JThread, [, a]: any[]) => t.vm.mem.freeBlock(Number(a)),
  [`${U}setMemory0(Ljava/lang/Object;JJB)V`]: (t: JThread, [, o, off, n, b]: any[]) => {
    const [bytes, p] = bytesAt(t, o, off);
    bytes.fill(b & 0xff, p, p + Number(n));
  },
  [`${U}copyMemory0(Ljava/lang/Object;JLjava/lang/Object;JJ)V`]: (t: JThread, [, so, soff, d, doff, n]: any[]) => {
    const [src, sp] = bytesAt(t, so, soff);
    const [dst, dp] = bytesAt(t, d, doff);
    dst.set(src.subarray(sp, sp + Number(n)), dp);
  },
  [`${U}copySwapMemory0(Ljava/lang/Object;JLjava/lang/Object;JJJ)V`]: (t: JThread, [, so, soff, d, doff, n, size]: any[]) => {
    const [src, sp] = bytesAt(t, so, soff);
    const [dst, dp] = bytesAt(t, d, doff);
    const e = Number(size), len = Number(n);
    const tmp = src.slice(sp, sp + len);
    for (let i = 0; i < len; i += e) for (let j = 0; j < e; j++) dst[dp + i + j] = tmp[i + e - 1 - j];
  },
  [`${U}objectFieldOffset0(Ljava/lang/reflect/Field;)J`]: (t: JThread, [, f]: any[]) => BigInt(fieldOf(t, f).slot),
  [`${U}objectFieldOffset1(Ljava/lang/Class;Ljava/lang/String;)J`]: (t: JThread, [, c, name]: any[]) => {
    const n = t.vm.jsString(name);
    const f = t.vm.classOf(c).findField(n);
    if (!f || f.isStatic) throw new PendingThrow("java/lang/InternalError", n);
    return BigInt(f.slot);
  },
  [`${U}staticFieldOffset0(Ljava/lang/reflect/Field;)J`]: (t: JThread, [, f]: any[]) => BigInt(STATIC_OFFSET_BASE + fieldOf(t, f).slot),
  [`${U}staticFieldBase0(Ljava/lang/reflect/Field;)Ljava/lang/Object;`]: (t: JThread, [, f]: any[]) => t.vm.mirror(fieldOf(t, f).cls),
  [`${U}shouldBeInitialized0(Ljava/lang/Class;)Z`]: (t: JThread, [, c]: any[]) => t.vm.classOf(c).state !== INITIALIZED,
  [`${U}ensureClassInitialized0(Ljava/lang/Class;)V`]: (t: JThread, [, c]: any[]) => t.vm.initGen(t, t.vm.classOf(c)),
  [`${U}arrayBaseOffset0(Ljava/lang/Class;)I`]: () => ARRAY_BASE_OFFSET,
  [`${U}arrayIndexScale0(Ljava/lang/Class;)I`]: (t: JThread, [, c]: any[]) => indexScale(t.vm.classOf(c)),
  [`${U}getLoadAverage0([DI)I`]: () => -1,
  [`${U}getUncompressedObject(J)Ljava/lang/Object;`]: () => null,
  [`${U}throwException(Ljava/lang/Throwable;)V`]: (_t: JThread, [, e]: any[]) => { throw new JavaThrow(nonNull(e)); },
  [`${U}allocateInstance(Ljava/lang/Class;)Ljava/lang/Object;`]: function* (t: JThread, [, m]: any[]): NativeGen {
    const c = t.vm.classOf(m);
    if (c.isInterface || c.access & 0x0400 || c.prim || c.component) {
      throw new PendingThrow("java/lang/InstantiationException", c.javaName);
    }
    if (c.state !== INITIALIZED) yield* t.vm.initGen(t, c);
    return t.vm.newObject(c);
  },
  [`${U}defineClass0(Ljava/lang/String;[BIILjava/lang/ClassLoader;Ljava/security/ProtectionDomain;)Ljava/lang/Class;`]:
    function* (t: JThread, [, name, b, off, len, loader, pd]: any[]): NativeGen {
      const bytes = u8(b, off, len).slice();
      const c = yield* t.vm.defineClassGen(t, loader, bytes, name ? jstr(t, name)!.replace(/\./g, "/") : null, pd);
      return t.vm.mirror(c);
    },
  [`${U}writeback0(J)V`]: () => undefined,
  [`${U}writebackPreSync0()V`]: () => undefined,
  [`${U}writebackPostSync0()V`]: () => undefined,
});

const SIGNALS: Record<string, number> = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15 };

function platformProperties(t: JThread): (string | null)[] {
  const p = t.vm.props;
  const cwd = t.vm.opts.cwd ?? "/";
  return [
    null, "en", null, null, // display country, language, script, variant
    "/", // file.separator
    null, "en", null, null, // format country, language, script, variant
    null, null, null, // ftp
    null, null, null, // http
    null, null, // https
    p.get("java.io.tmpdir") ?? "/tmp",
    "\n",
    "UTF-8", // native.encoding
    "javascript", "Linux", "6.0",
    ":",
    null, null, null, // socks
    "UTF-8", "UTF-8", "UTF-8", // stderr, stdin, stdout encoding
    null, "64", "little", null, "UnicodeLittle",
    "UTF-8", // sun.jnu.encoding
    "unknown",
    cwd, p.get("user.home") ?? "/files", p.get("user.name") ?? "user",
  ];
}

function vmProperties(t: JThread): string[] {
  const vm = t.vm;
  const props = new Map<string, string>([
    ["java.home", vm.opts.javaHome],
    ["java.class.path", (vm.opts.classpath ?? []).join(":")],
    ["java.library.path", ""],
    ["sun.boot.library.path", `${vm.opts.javaHome}/lib`],
    ["java.vm.specification.name", "Java Virtual Machine Specification"],
    ["java.vm.specification.vendor", "Oracle Corporation"],
    ["java.vm.specification.version", "25"],
    ["java.vm.name", "java-web"],
    ["java.vm.vendor", "java-web"],
    ["java.vm.version", "25"],
    ["java.vm.info", "interpreted mode"],
    ["jdk.debug", "release"],
    ["sun.java.launcher", "SUN_STANDARD"],
    ["sun.nio.MaxDirectMemorySize", "-1"],
    ["sun.nio.PageAlignDirectMemory", "false"],
    // the ABI java.lang.foreign lays out calls for; there is no native one here
    ["jdk.internal.foreign.CABI", "SYS_V"],
    // text layout through the JNI shaper; the default one calls HarfBuzz through java.lang.foreign
    ["sun.font.layout.ffm", "false"],
  ]);
  for (const [k, v] of vm.props) props.set(k, v);
  return [...props].flat();
}

// The Linux x64 JDK's lib/*.so, by the names System.loadLibrary takes
const jdkLibraries = new Set([
  "attach", "awt", "awt_headless", "awt_xawt", "dt_socket", "extnet", "fontmanager", "freetype", "instrument", "j2gss",
  "j2pcsc", "j2pkcs11", "jaas", "java", "javajpeg", "jawt", "jdwp", "jimage", "jli", "jsig", "jsound", "jsvml", "lcms",
  "management", "management_agent", "management_ext", "mlib_image", "net", "nio", "prefs", "rmi", "saproc", "sctp",
  "simdsort", "splashscreen", "syslookup", "verify", "zip",
]);

// The frames HotSpot ignores (Method::is_ignored_by_security_stack_walk):
// Method.invoke, method accessors, and compiled lambda forms. Other hidden
// classes count: reflection calls a caller-sensitive method through an
// invoker injected into the caller's package.
const lambdaForms = new WeakMap<JMethod, boolean>();
function isLambdaForm(m: JMethod): boolean {
  let f = lambdaForms.get(m);
  if (f === undefined) {
    f = annotationTypes(m.cls, m.attrs.get("RuntimeVisibleAnnotations")).includes("Ljava/lang/invoke/LambdaForm$Compiled;");
    lambdaForms.set(m, f);
  }
  return f;
}

function callerClass(t: JThread): JObject | null {
  const accessor = t.vm.loadBoot("jdk/internal/reflect/MethodAccessorImpl");
  let skip = 1;
  for (const { m } of javaFrames(t)) {
    if (skip > 0) { skip--; continue; }
    if (isLambdaForm(m)) continue;
    if (m.cls.name === "java/lang/reflect/Method" && m.name === "invoke") continue;
    if (accessor && m.cls.isSubclassOf(accessor)) continue;
    return t.vm.mirror(m.cls);
  }
  return null;
}

// Perf counters get a plain heap buffer nobody else reads.
function* perfBuffer(t: JThread, size: number): NativeGen {
  const bb = t.vm.loadBoot("java/nio/ByteBuffer")!;
  if (bb.state !== INITIALIZED) yield* t.vm.initGen(t, bb);
  return yield t.call(bb.methodMap.get("allocate(I)Ljava/nio/ByteBuffer;")!, size);
}

// The boot image as the JDK's jimage reader sees it. The image holds only
// non-class resources and sits at lib/resources.jimage, not lib/modules,
// because a lib/modules file makes the JDK and javac use image mode instead of
// the exploded modules/ tree. The path the reader asks for stays unopened.
function* nativeImageMap(t: JThread, path: string | null): NativeGen {
  const vm = t.vm;
  if (path !== `${vm.opts.javaHome}/lib/modules`) return null;
  const data = vm.fs.read(`${vm.opts.javaHome}/lib/resources.jimage`);
  if (!data) return null;
  const addr = vm.mem.malloc(data.length);
  vm.mem.u8.set(data, addr);
  const dbb = vm.loadBoot("java/nio/DirectByteBuffer")!;
  if (dbb.state !== INITIALIZED) yield* vm.initGen(t, dbb);
  const buf = vm.newObject(dbb);
  yield t.call(dbb.methodMap.get("<init>(JJ)V")!, buf, BigInt(addr), BigInt(data.length));
  return buf;
}

// Nanoseconds since the epoch, finer than Date.now(). The performance clock
// does not follow changes to the system clock, so it is used only while the
// two agree.
function wallNanos(): bigint {
  const ms = Date.now();
  const t = performance.timeOrigin + performance.now();
  if (Math.abs(t - ms) > 2) return BigInt(ms) * 1_000_000n;
  const whole = Math.floor(t);
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((t - whole) * 1e6));
}

let nextStub = 0x1000n;
function stubId(): bigint {
  return (nextStub += 16n);
}

export const natives: Natives = {
  ...unsafe,
  "jdk/internal/vm/ForeignLinkerSupport.isSupported0()Z": () => 1,
  // java.lang.foreign: handles to native code can be made but not called
  // (MethodHandle.linkToNative throws), so stubs are only distinct ids
  "jdk/internal/foreign/abi/NativeEntryPoint.makeDowncallStub(Ljava/lang/invoke/MethodType;Ljdk/internal/foreign/abi/ABIDescriptor;[Ljdk/internal/foreign/abi/VMStorage;[Ljdk/internal/foreign/abi/VMStorage;ZIZ)J": () => stubId(),
  "jdk/internal/foreign/abi/NativeEntryPoint.freeDowncallStub0(J)Z": () => 1,
  "jdk/internal/foreign/abi/NativeEntryPoint.registerNatives()V": () => undefined,
  "jdk/internal/foreign/abi/UpcallLinker.makeUpcallStub(Ljava/lang/invoke/MethodHandle;Ljdk/internal/foreign/abi/ABIDescriptor;Ljdk/internal/foreign/abi/UpcallLinker$CallRegs;ZJ)J": () => stubId(),
  "jdk/internal/foreign/abi/UpcallLinker.registerNatives()V": () => undefined,
  "jdk/internal/foreign/abi/UpcallStubs.freeUpcallStub0(J)Z": () => 1,
  "jdk/internal/foreign/abi/UpcallStubs.registerNatives()V": () => undefined,
  // no native library can be opened
  "jdk/internal/loader/RawNativeLibraries.load0(Ljdk/internal/loader/RawNativeLibraries$RawNativeLibraryImpl;Ljava/lang/String;)Z": () => 0,
  "jdk/internal/loader/RawNativeLibraries.unload0(Ljava/lang/String;J)V": () => undefined,
  "jdk/internal/perf/Perf.createLong(Ljava/lang/String;IIJ)Ljava/nio/ByteBuffer;": (t) => perfBuffer(t, 8),
  "jdk/internal/perf/Perf.createByteArray(Ljava/lang/String;II[BI)Ljava/nio/ByteBuffer;": (t, [, , , , , max]) => perfBuffer(t, max),
  "jdk/internal/jimage/NativeImageBuffer.getNativeMap(Ljava/lang/String;)Ljava/nio/ByteBuffer;": (t, [path]) => nativeImageMap(t, jstr(t, path)),
  "jdk/internal/perf/Perf.highResCounter()J": () => BigInt(Math.round(performance.now() * 1e6)),
  "jdk/internal/perf/Perf.highResFrequency()J": () => 1_000_000_000n,
  "jdk/internal/misc/VM.initialize()V": () => undefined,
  "jdk/internal/misc/PreviewFeatures.isPreviewEnabled()Z": (t) => (t.vm.opts.enablePreview ? 1 : 0),
  "jdk/internal/misc/VM.latestUserDefinedLoader0()Ljava/lang/ClassLoader;": (t) => {
    for (const { m } of javaFrames(t)) if (m.cls.loader) return m.cls.loader;
    return null;
  },
  "jdk/internal/misc/VM.getuid()J": () => 1000n,
  "jdk/internal/misc/VM.geteuid()J": () => 1000n,
  "jdk/internal/misc/VM.getgid()J": () => 1000n,
  "jdk/internal/misc/VM.getegid()J": () => 1000n,
  "jdk/internal/misc/VM.getNanoTimeAdjustment(J)J": (_t, [offset]) => {
    // whole seconds within 2^32 of the offset, as HotSpot checks
    const now = wallNanos();
    const diff = BigInt.asIntN(64, now / 1_000_000_000n - offset);
    return diff >= 1n << 32n || diff <= -(1n << 32n) ? -1n : diff * 1_000_000_000n + now % 1_000_000_000n;
  },
  "jdk/internal/misc/VM.getRuntimeArguments()[Ljava/lang/String;": (t) => t.vm.newObjectArray("java/lang/String", []),

  "jdk/internal/misc/CDS.getCDSConfigStatus()I": () => 0,
  "jdk/internal/misc/CDS.logLambdaFormInvoker(Ljava/lang/String;)V": () => undefined,
  "jdk/internal/misc/CDS.initializeFromArchive(Ljava/lang/Class;)V": () => undefined,
  "jdk/internal/misc/CDS.defineArchivedModules(Ljava/lang/ClassLoader;Ljava/lang/ClassLoader;)V": () => undefined,
  "jdk/internal/misc/CDS.getRandomSeedForDumping()J": () => 0n,
  "jdk/internal/misc/CDS.dumpClassList(Ljava/lang/String;)V": () => undefined,
  "jdk/internal/misc/CDS.dumpDynamicArchive(Ljava/lang/String;)V": () => undefined,
  "jdk/internal/misc/CDS.needsClassInitBarrier0(Ljava/lang/Class;)Z": () => 0,

  "jdk/internal/misc/Signal.findSignal0(Ljava/lang/String;)I": (t, [n]) => SIGNALS[t.vm.jsString(n)] ?? -1,
  "jdk/internal/misc/Signal.handle0(IJ)J": () => 0n,
  "jdk/internal/misc/Signal.raise0(I)V": () => undefined,

  "jdk/internal/util/SystemProps$Raw.platformProperties()[Ljava/lang/String;": (t) =>
    t.vm.newObjectArray("java/lang/String", platformProperties(t).map((s) => (s === null ? null : t.vm.str(s)))),
  "jdk/internal/util/SystemProps$Raw.vmProperties()[Ljava/lang/String;": (t) =>
    t.vm.newObjectArray("java/lang/String", vmProperties(t).map((s) => t.vm.str(s))),

  "jdk/internal/reflect/Reflection.getCallerClass()Ljava/lang/Class;": (t) => callerClass(t),
  "jdk/internal/reflect/Reflection.getClassAccessFlags(Ljava/lang/Class;)I": (t, [c]) => t.vm.classOf(c).access & 0x7fff,
  "jdk/internal/reflect/Reflection.areNestMates(Ljava/lang/Class;Ljava/lang/Class;)Z": function* (t, [a, b]): NativeGen {
    return (yield* nestHostOf(t, t.vm.classOf(a))) === (yield* nestHostOf(t, t.vm.classOf(b)));
  },

  "jdk/internal/loader/BootLoader.getSystemPackageNames()[Ljava/lang/String;": (t) =>
    t.vm.newObjectArray("java/lang/String", [...t.vm.bootPackages.keys()].map((p) => t.vm.str(p))),
  "jdk/internal/loader/BootLoader.getSystemPackageLocation(Ljava/lang/String;)Ljava/lang/String;": (t, [n]) => {
    const mod = t.vm.bootPackages.get(t.vm.jsString(n));
    return mod ? t.vm.str(`jrt:/${mod}`) : null;
  },
  "jdk/internal/loader/BootLoader.setBootLoaderUnnamedModule0(Ljava/lang/Module;)V": (t, [m]) => {
    t.vm.bootUnnamedModule = m;
  },
  // JDK libraries are built in; the search finds a page's name.js on the library path
  "jdk/internal/loader/NativeLibraries.findBuiltinLib(Ljava/lang/String;)Ljava/lang/String;": (t, [n]) =>
    jdkLibraries.has(t.vm.jsString(n).replace(/^lib(.*)\.so$/, "$1")) ? n : null,
  "jdk/internal/loader/NativeLibraries.load(Ljdk/internal/loader/NativeLibraries$NativeLibraryImpl;Ljava/lang/String;ZZ)Z":
    function* (t, [impl, name]): NativeGen {
      const path = t.vm.jsString(name);
      if (path.endsWith(".js")) {
        const load = t.vm.opts.loadNativeLibrary;
        if (!load) return 0;
        const e = yield t.block(load(path).then(() => null, (e: unknown) => e ?? "failed"));
        if (e !== null) throw new PendingThrow("java/lang/UnsatisfiedLinkError", `${path}: ${e instanceof Error ? e.message : e}`);
      }
      t.vm.setField(impl, "jdk/internal/loader/NativeLibraries$NativeLibraryImpl", "handle", 1n);
      return 1;
    },
  "jdk/internal/loader/NativeLibraries.unload(Ljava/lang/String;ZJ)V": () => undefined,
  "jdk/internal/loader/NativeLibrary.findEntry0(JLjava/lang/String;)J": () => 0n,

  "jdk/internal/misc/ScopedMemoryAccess.closeScope0(Ljdk/internal/foreign/MemorySessionImpl;Ljdk/internal/misc/ScopedMemoryAccess$ScopedAccessError;)V":
    () => undefined,

  // names and values in turn, as the C environ gives them
  "java/lang/ProcessEnvironment.environ()[[B": (t) => {
    const enc = new TextEncoder();
    const bytes = (s: string) => new JArray(t.vm.primArrayClass("B"), new Int8Array(enc.encode(s).buffer));
    return t.vm.newObjectArray("[B", Object.entries(t.vm.opts.env ?? {}).flatMap(([k, v]) => [bytes(k), bytes(v)]));
  },
  "java/lang/ProcessImpl.init()V": () => undefined,
  // HotSpot's message when the OS has no way to start a process (ENOSYS)
  "java/lang/ProcessImpl.forkAndExec(I[B[B[BI[BI[B[IZ)I": () => {
    throw new PendingThrow("java/io/IOException", "error=38, Function not implemented");
  },
  "java/lang/ProcessHandleImpl.initNative()V": () => undefined,
  "java/lang/ProcessHandleImpl.getCurrentPid0()J": () => 42n,
  "java/lang/ProcessHandleImpl.isAlive0(J)J": () => -1n,
  "java/lang/ProcessHandleImpl.parent0(JJ)J": () => -1n,
  "java/io/Console.ttyStatus()I": () => 0,
};
