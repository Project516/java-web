// Runtime data structures: classes, fields, methods, objects, arrays.
//
// Value representation: int, short, byte, char and boolean are JS numbers,
// float and double are numbers, long is a bigint, references are JObject or
// null. Long and double take two stack and local slots like in the JVMS; the
// second slot holds undefined.

import type { ClassFile, Code, Member } from "./classfile.ts";
import { PendingThrow } from "./thread.ts";
import type { JThread } from "./thread.ts";

export const ACC_PUBLIC = 0x0001;
export const ACC_PRIVATE = 0x0002;
export const ACC_PROTECTED = 0x0004;
export const ACC_STATIC = 0x0008;
export const ACC_FINAL = 0x0010;
export const ACC_SYNCHRONIZED = 0x0020;
export const ACC_SUPER = 0x0020;
export const ACC_VOLATILE = 0x0040;
export const ACC_BRIDGE = 0x0040;
export const ACC_VARARGS = 0x0080;
export const ACC_NATIVE = 0x0100;
export const ACC_INTERFACE = 0x0200;
export const ACC_ABSTRACT = 0x0400;
export const ACC_SYNTHETIC = 0x1000;
export const ACC_ANNOTATION = 0x2000;
export const ACC_ENUM = 0x4000;

export const LOADED = 0, LINKED = 1, INITIALIZING = 2, INITIALIZED = 3, ERRONEOUS = 4;

// Offsets Unsafe hands out for static fields start here, so they never
// collide with instance field slots of java.lang.Class itself.
export const STATIC_OFFSET_BASE = 1 << 20;
export const ARRAY_BASE_OFFSET = 16;

export function parseMethodDesc(desc: string): { params: string[]; ret: string } {
  const params: string[] = [];
  let i = 1;
  while (desc[i] !== ")") {
    const start = i;
    while (desc[i] === "[") i++;
    if (desc[i] === "L") i = desc.indexOf(";", i);
    i++;
    params.push(desc.slice(start, i));
  }
  return { params, ret: desc.slice(i + 1) };
}

export function isWide(desc: string) {
  return desc === "J" || desc === "D";
}

export function defaultValue(desc: string): unknown {
  switch (desc[0]) {
    case "J": return 0n;
    case "L": case "[": return null;
    default: return 0;
  }
}

export class JField {
  readonly cls: JClass;
  readonly name: string;
  readonly desc: string;
  readonly access: number;
  readonly attrs: Map<string, Uint8Array>;
  readonly wide: boolean;
  slot = -1;
  index = 0;
  constructor(cls: JClass, m: Member) {
    this.cls = cls;
    this.name = m.name;
    this.desc = m.desc;
    this.access = m.access;
    this.attrs = m.attrs;
    this.wide = isWide(m.desc);
  }
  get isStatic() { return (this.access & ACC_STATIC) !== 0; }
}

export type NativeFn = (t: JThread, args: any[]) => any;

// A linked invokedynamic or polymorphic call: the method to call, and the
// extra trailing argument it takes when it is a Java invoker.
export interface CallSite {
  m: JMethod;
  appendix?: JObject | null;
}

export class JMethod {
  readonly cls: JClass;
  readonly name: string;
  readonly desc: string;
  readonly key: string;
  readonly access: number;
  readonly attrs: Map<string, Uint8Array>;
  readonly code: Code | null;
  readonly params: string[];
  readonly ret: string;
  // slots taken by arguments, including the receiver
  readonly argSlots: number;
  index = 0;
  native: NativeFn | null = null;
  // MethodHandle.invoke and friends: the call site supplies the descriptor
  polymorphic = false;
  // a Java method whose body is a JS native
  intrinsic = false;
  // linked invoker of a polymorphic call site
  link: CallSite | null = null;
  // JIT state: compiled code, hotness counter, fallbacks to the interpreter
  jit: ((t: JThread, f: any) => number) | null = null;
  hot = 0;
  fallbacks = 0;
  recompiles = 0;
  noJit = false;
  // per-pc inline caches for the interpreter
  cache: any[] | null = null;
  constructor(cls: JClass, m: Member) {
    this.cls = cls;
    this.name = m.name;
    this.desc = m.desc;
    this.key = m.name + m.desc;
    this.access = m.access;
    this.attrs = m.attrs;
    this.code = m.code;
    this.isStatic = (m.access & ACC_STATIC) !== 0;
    this.isNative = (m.access & ACC_NATIVE) !== 0;
    this.isAbstract = (m.access & ACC_ABSTRACT) !== 0;
    this.isPrivate = (m.access & ACC_PRIVATE) !== 0;
    this.isSynchronized = (m.access & ACC_SYNCHRONIZED) !== 0;
    const { params, ret } = parseMethodDesc(m.desc);
    this.params = params;
    this.ret = ret;
    let slots = this.isStatic ? 0 : 1;
    for (const p of params) slots += isWide(p) ? 2 : 1;
    this.argSlots = slots;
  }
  // flags as fields: these are read on every call
  readonly isStatic: boolean;
  readonly isNative: boolean;
  readonly isAbstract: boolean;
  readonly isPrivate: boolean;
  readonly isSynchronized: boolean;
  toString() { return `${this.cls.name}.${this.name}${this.desc}`; }
  lineAt(pc: number): number {
    const lines = this.code?.lines;
    if (!lines) return -1;
    let line = -1;
    for (let i = 0; i < lines.length && lines[i] <= pc; i += 2) line = lines[i + 1];
    return line;
  }
}

export class JObject {
  cls: JClass;
  f: any[];
  mon: Monitor | null = null;
  hash = 0;
  // VM-side data: the JClass of a Class mirror, the JThread of a Thread, ...
  x: any = undefined;
  constructor(cls: JClass, f: any[]) {
    this.cls = cls;
    this.f = f;
  }
}

export type ArrayData =
  | Int8Array | Uint16Array | Int16Array | Int32Array | Float32Array | Float64Array
  | BigInt64Array | (JObject | null)[];

export class JArray extends JObject {
  a: ArrayData;
  constructor(cls: JClass, a: ArrayData) {
    super(cls, EMPTY);
    this.a = a;
  }
}

const EMPTY: any[] = [];

export class Monitor {
  owner: JThread | null = null;
  count = 0;
  // threads blocked entering the monitor
  entry: (() => void)[] = [];
  // threads in wait(), woken by notify
  waiters: { t: JThread; wake: () => void }[] = [];
}

export class JClass {
  readonly name: string;
  readonly loader: JObject | null;
  readonly cf: ClassFile | null;
  superclass: JClass | null = null;
  interfaces: JClass[] = [];
  access: number;
  fields: JField[] = [];
  methods: JMethod[] = [];
  methodMap = new Map<string, JMethod>();
  instanceSlots = 0;
  template: any[] = [];
  statics: any[] = [];
  state = LOADED;
  initThread: JThread | null = null;
  initError: JObject | null = null;
  initWaiters: (() => void)[] = [];
  mirror: JObject | null = null;
  // arrays
  component: JClass | null = null;
  arrayClass: JClass | null = null;
  // descriptor char for primitive classes
  prim: string | null = null;
  hidden = false;
  // members the VM added to a class it spun, which reflection does not show
  vmMembers: Set<JField | JMethod> | null = null;
  nestHost: JClass | null = null;
  // virtual dispatch cache, name+desc -> method
  vcache = new Map<string, JMethod | null>();
  // resolved constant pool entries: classes, fields, methods
  rcp: any[] = [];
  // values of ldc constants, by constant pool index
  ldc: any[] = [];
  private supers: Set<JClass> | null = null;
  constructor(name: string, loader: JObject | null, cf: ClassFile | null, access: number) {
    this.name = name;
    this.loader = loader;
    this.cf = cf;
    this.access = access;
  }

  get isInterface() { return (this.access & ACC_INTERFACE) !== 0; }
  get isArray() { return this.name[0] === "["; }
  get isPrimitive() { return this.prim !== null; }
  get javaName() {
    if (this.prim) return primName(this.prim);
    // hidden classes keep the "/0x..." suffix: Foo$$Lambda/0x01
    const base = this.hidden ? this.cf!.name : this.name;
    return base.replace(/\//g, ".") + this.name.slice(base.length);
  }
  get packageName() {
    const n = this.cf?.name ?? this.name;
    const i = n.lastIndexOf("/");
    return i < 0 ? "" : n.slice(0, i);
  }
  // descriptor of this class as a field type
  get desc() { return this.prim ?? (this.isArray ? this.name : `L${this.name};`); }

  toString() { return this.name; }

  // all superclasses and superinterfaces, including this class
  allSupers(): Set<JClass> {
    if (this.supers) return this.supers;
    const s = new Set<JClass>([this]);
    if (this.superclass) for (const c of this.superclass.allSupers()) s.add(c);
    for (const i of this.interfaces) for (const c of i.allSupers()) s.add(c);
    this.supers = s;
    return s;
  }

  isSubclassOf(other: JClass): boolean {
    for (let c: JClass | null = this; c; c = c.superclass) if (c === other) return true;
    return false;
  }

  // JVMS checkcast / instanceof semantics
  isAssignableTo(t: JClass): boolean {
    if (this === t) return true;
    if (this.prim || t.prim) return false;
    if (this.component) {
      if (t.component) {
        const a = this.component, b = t.component;
        if (a.prim || b.prim) return a === b;
        return a.isAssignableTo(b);
      }
      return t.name === "java/lang/Object" || t.name === "java/lang/Cloneable" || t.name === "java/io/Serializable";
    }
    return this.allSupers().has(t);
  }

  findField(name: string, desc?: string): JField | null {
    for (const f of this.fields) if (f.name === name && (desc === undefined || f.desc === desc)) return f;
    for (const i of this.interfaces) {
      const f = i.findField(name, desc);
      if (f) return f;
    }
    return this.superclass ? this.superclass.findField(name, desc) : null;
  }

  declaredMethod(key: string): JMethod | undefined {
    return this.methodMap.get(key);
  }

  // JVMS 5.4.3.3 method resolution: class chain first, then interfaces
  findMethod(key: string): JMethod | null {
    for (let c: JClass | null = this; c; c = c.superclass) {
      const m = c.methodMap.get(key);
      if (m) return m;
    }
    return this.findInterfaceMethod(key);
  }

  findInterfaceMethod(key: string): JMethod | null {
    let fallback: JMethod | null = null;
    for (const c of this.allSupers()) {
      if (!c.isInterface) continue;
      const m = c.methodMap.get(key);
      if (!m || m.isPrivate || m.isStatic) continue;
      if (!m.isAbstract) return m;
      fallback ??= m;
    }
    if (this.isInterface) {
      const m = this.methodMap.get(key);
      if (m) return m;
    }
    return fallback;
  }

  // JVMS 5.4.6 method selection for invokevirtual / invokeinterface
  selectMethod(key: string): JMethod | null {
    let m = this.vcache.get(key);
    if (m !== undefined) return m;
    m = null;
    for (let c: JClass | null = this; c; c = c.superclass) {
      const d = c.methodMap.get(key);
      if (d && !d.isStatic && !(d.isPrivate && c !== this)) { m = d; break; }
    }
    if (!m || m.isAbstract) {
      const d = this.maximallySpecific(key);
      if (d) m = d;
    }
    this.vcache.set(key, m);
    return m;
  }

  private maximallySpecific(key: string): JMethod | null {
    const found: JMethod[] = [];
    for (const c of this.allSupers()) {
      if (!c.isInterface) continue;
      const m = c.methodMap.get(key);
      if (m && !m.isAbstract && !m.isStatic && !m.isPrivate) found.push(m);
    }
    const best = found.filter((m) => !found.some((o) => o !== m && o.cls.allSupers().has(m.cls)));
    return best[0] ?? null;
  }
}

export function primName(c: string) {
  switch (c) {
    case "Z": return "boolean";
    case "B": return "byte";
    case "C": return "char";
    case "S": return "short";
    case "I": return "int";
    case "J": return "long";
    case "F": return "float";
    case "D": return "double";
    case "V": return "void";
  }
  throw new Error(`not a primitive: ${c}`);
}

// Reported by Runtime.maxMemory; no array may be bigger. -Xmx lowers it; the
// total of live objects is not counted.
export let MAX_HEAP = 1 << 30;
export function setMaxHeap(bytes: number) {
  MAX_HEAP = Math.min(bytes, 1 << 30);
}
const ELEM_SIZE: Record<string, number> = { Z: 1, B: 1, C: 2, S: 2, I: 4, F: 4, J: 8, D: 8, L: 4 };

// V8 gives a typed array over 64 bytes its own malloc'd store, about ten
// times slower than a view. Mid-sized arrays are views into shared slabs;
// a slab lives while any of its arrays does, so the range stays small.
const SLAB = 16 << 10, SLAB_MIN = 65, SLAB_MAX = 2048;
let slab = new ArrayBuffer(SLAB), slabTop = 0;

function store(bytes: number): [ArrayBuffer, number] | null {
  if (bytes < SLAB_MIN || bytes > SLAB_MAX) return null;
  if (slabTop + bytes > SLAB) {
    slab = new ArrayBuffer(SLAB);
    slabTop = 0;
  }
  const off = slabTop;
  slabTop = (off + bytes + 7) & ~7;
  return [slab, off];
}

export function newArrayData(elem: string, n: number): ArrayData {
  const bytes = n * ELEM_SIZE[elem];
  if (bytes > MAX_HEAP) throw new PendingThrow("java/lang/OutOfMemoryError", "Java heap space");
  const at = elem === "L" ? null : store(bytes);
  try {
    switch (elem) {
      case "Z": case "B": return at ? new Int8Array(at[0], at[1], n) : new Int8Array(n);
      case "C": return at ? new Uint16Array(at[0], at[1], n) : new Uint16Array(n);
      case "S": return at ? new Int16Array(at[0], at[1], n) : new Int16Array(n);
      case "I": return at ? new Int32Array(at[0], at[1], n) : new Int32Array(n);
      case "J": return at ? new BigInt64Array(at[0], at[1], n) : new BigInt64Array(n);
      case "F": return at ? new Float32Array(at[0], at[1], n) : new Float32Array(n);
      case "D": return at ? new Float64Array(at[0], at[1], n) : new Float64Array(n);
      default: return new Array(n).fill(null);
    }
  } catch (e) {
    // the JS engine's own size limits, below MAX_HEAP for object arrays
    if (e instanceof RangeError) throw new PendingThrow("java/lang/OutOfMemoryError", "Java heap space");
    throw e;
  }
}
