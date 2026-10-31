// VM side of library mode: the Java objects handed to JS, calls from JS
// into Java, and the conversion of values both ways.
//
// Values cross as "wire" values, the same in a Worker message and in
// process: numbers, strings, booleans, bigints and null as themselves;
// primitive Java arrays as typed arrays (copies); reference arrays as JS
// arrays; boxed numbers as JS primitives; any other object as a Handle.
// bridge.ts is the JS side.

import { ACC_PUBLIC, ACC_SYNTHETIC, ACC_VARARGS, INITIALIZED, JArray, JObject, newArrayData } from "./runtime.ts";
import type { JClass, JField, JMethod } from "./runtime.ts";
import { JavaThrow } from "./thread.ts";
import type { JThread, NativeGen, Request } from "./thread.ts";
import type { JVM } from "./jvm.ts";

// A Java object the page holds. The VM keeps the object until the page
// releases as many references as it was handed.
export interface Handle {
  $java: number;
  cls: string;
  // every superclass and interface, sent the first time a class is handed out
  supers?: string[];
  // set for throwables: "java.io.IOException: message"
  msg?: string;
}

// A field read the VM does itself, so `a.y = b.x` needs no round trip.
// The target is an object handle id, a class name, or another field read
// that gives the object (`a.x.z`).
export interface FieldRef {
  $get: [number | string | FieldRef, string];
}

export type LibraryRequest =
  | { op: "class"; cls: string }
  | { op: "static"; cls: string; method: string; args: unknown[] }
  | { op: "new"; cls: string; args: unknown[] }
  | { op: "call"; obj: number; method: string; args: unknown[] }
  | { op: "getStatic"; cls: string; field: string }
  | { op: "setStatic"; cls: string; field: string; value: unknown }
  | { op: "get"; obj: number; field: string }
  | { op: "set"; obj: number; field: string; value: unknown };

export interface LibraryReply {
  value: unknown;
  // typed array arguments Java changed, by argument index
  back?: [number, ArrayBufferView][];
}

// A request that failed; throwable is the Handle of a Java exception.
export class LibraryError extends Error {
  throwable?: unknown;
}

interface Pending {
  req: LibraryRequest;
  resolve: (r: LibraryReply) => void;
  reject: (e: Error) => void;
}

// A thread that can run calls: the library's main thread while idle, or a
// thread waiting in a native.
interface Server {
  call: Pending | null;
  wake: (() => void) | null;
}

const BOXES = new Set([
  "java/lang/Boolean", "java/lang/Byte", "java/lang/Short", "java/lang/Character",
  "java/lang/Integer", "java/lang/Long", "java/lang/Float", "java/lang/Double",
]);
const OBJECT_LIKE = new Set(["Ljava/lang/Object;", "Ljava/lang/Comparable;", "Ljava/io/Serializable;"]);

function typedElem(v: ArrayBufferView): string | undefined {
  if (v instanceof Int8Array) return "B";
  if (v instanceof Uint8Array) return "Z";
  if (v instanceof Uint16Array) return "C";
  if (v instanceof Int16Array) return "S";
  if (v instanceof Int32Array) return "I";
  if (v instanceof BigInt64Array) return "J";
  if (v instanceof Float32Array) return "F";
  if (v instanceof Float64Array) return "D";
  return undefined;
}

const superNames = new WeakMap<JClass, Set<string>>();

function namesOf(c: JClass): Set<string> {
  let s = superNames.get(c);
  if (!s) {
    s = new Set();
    for (const x of c.allSupers()) s.add(x.name);
    superNames.set(c, s);
  }
  return s;
}

// How well a JS value fits a parameter type, for choosing between overloads:
// higher is closer, -1 does not convert.
export function fit(desc: string, v: unknown): number {
  const ref = desc[0] === "L" || desc[0] === "[";
  if (v === null || v === undefined) return ref ? 1 : -1;
  switch (typeof v) {
    case "string":
      if (desc === "Ljava/lang/String;") return 2;
      if (desc === "Ljava/lang/CharSequence;" || (desc === "C" && v.length === 1)) return 1;
      return OBJECT_LIKE.has(desc) ? 0 : -1;
    case "boolean":
      return desc === "Z" ? 2 : desc === "Ljava/lang/Boolean;" ? 1 : OBJECT_LIKE.has(desc) ? 0 : -1;
    case "bigint":
      return desc === "J" ? 2 : desc === "Ljava/lang/Long;" || desc === "Ljava/lang/Number;" ? 1 : OBJECT_LIKE.has(desc) ? 0 : -1;
    case "number": {
      const whole = Number.isInteger(v);
      if (!whole && desc === "D") return 2;
      if (whole && desc === "I") return 3;
      if (whole && desc === "J") return 2;
      if (desc.length === 1 && "DFSBC".includes(desc)) return whole || desc === "F" ? 1 : -1;
      if (desc === "Ljava/lang/Double;" || desc === "Ljava/lang/Float;" || desc === "Ljava/lang/Number;") return 1;
      if (whole && /^Ljava\/lang\/(Integer|Long|Short|Byte);$/.test(desc)) return 1;
      return OBJECT_LIKE.has(desc) ? 0 : -1;
    }
    case "object":
      if (v instanceof JObject) {
        if (desc[0] !== "L") return -1;
        const name = desc.slice(1, -1);
        if (v.cls.name === name) return 3;
        if (name === "java/lang/Object") return 1;
        return namesOf(v.cls).has(name) ? 2 : -1;
      }
      if (ArrayBuffer.isView(v)) {
        if (desc[0] === "[") {
          const elem = typedElem(v);
          return desc === "[" + elem ? 3 : elem === "Z" && desc === "[B" ? 1 : -1;
        }
        return desc === "Ljava/lang/Object;" || desc === "Ljava/lang/Cloneable;" || desc === "Ljava/io/Serializable;" ? 1 : -1;
      }
      if (Array.isArray(v)) {
        if (desc === "Ljava/lang/Object;") return 0;
        if (desc[0] !== "[") return -1;
        const comp = desc.slice(1);
        for (const x of v) if (fit(comp, x) < 0) return -1;
        return comp === "Ljava/lang/Object;" ? 1 : 2;
      }
      return -1;
    default: return -1;
  }
}

function describe(a: unknown): string {
  if (a === null) return "null";
  if (a instanceof JObject) return a.cls.javaName;
  if (ArrayBuffer.isView(a)) return a.constructor.name;
  if (Array.isArray(a)) return "array";
  return typeof a;
}

function primValue(desc: string, v: any): any {
  switch (desc[0]) {
    case "Z": return v ? 1 : 0;
    case "J": return typeof v === "bigint" ? BigInt.asIntN(64, v) : BigInt(Math.trunc(Number(v) || 0));
    case "F": return Math.fround(Number(v));
    case "D": return Number(v);
    case "B": return (Number(v) << 24) >> 24;
    case "S": return (Number(v) << 16) >> 16;
    case "C": return (typeof v === "string" ? v.charCodeAt(0) : Number(v)) & 0xffff;
    default: return Number(v) | 0;
  }
}

const BOX_OF: Record<string, [string, string]> = {
  "Ljava/lang/Integer;": ["java/lang/Integer", "I"], "Ljava/lang/Short;": ["java/lang/Short", "S"],
  "Ljava/lang/Byte;": ["java/lang/Byte", "B"], "Ljava/lang/Long;": ["java/lang/Long", "J"],
  "Ljava/lang/Float;": ["java/lang/Float", "F"], "Ljava/lang/Double;": ["java/lang/Double", "D"],
};

export class Library {
  readonly vm: JVM;
  private ids = new Map<JObject, number>();
  private table = new Map<number, { obj: JObject; refs: number }>();
  private nextId = 1;
  private sent = new Set<JClass>();
  private loader: JObject | null = null;
  private queue: Pending[] = [];
  private idle: Server[] = [];
  // calls running Java code, not counting those blocked in a native
  private busy = 0;
  private depth = new Map<JThread, number>();
  private inflight = new Set<Pending>();
  private closed = false;

  constructor(vm: JVM) {
    this.vm = vm;
  }

  // ---- handles -------------------------------------------------------------

  handle(obj: JObject): Handle {
    let id = this.ids.get(obj);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(obj, id);
      this.table.set(id, { obj, refs: 0 });
    }
    this.table.get(id)!.refs++;
    const h: Handle = { $java: id, cls: obj.cls.javaName };
    if (!this.sent.has(obj.cls)) {
      this.sent.add(obj.cls);
      h.supers = [...obj.cls.allSupers()].map((c) => c.javaName);
    }
    if (this.vm.isInstance(obj, "java/lang/Throwable")) h.msg = this.vm.describeThrowable(obj);
    return h;
  }

  private object(id: number): JObject {
    const e = this.table.get(id);
    if (!e) throw new Error("that Java object was released");
    return e.obj;
  }

  // The page dropped proxies: each [id, n] gives back n references.
  release(ids: [number, number][]) {
    for (const [id, n] of ids) {
      const e = this.table.get(id);
      if (!e) continue;
      e.refs -= n;
      if (e.refs <= 0) {
        this.table.delete(id);
        this.ids.delete(e.obj);
      }
    }
  }

  get handleCount() {
    return this.table.size;
  }

  // ---- values --------------------------------------------------------------

  // A Java value as a wire value; onObject turns the objects that are not
  // strings, boxes or arrays into whatever the caller needs.
  private convert(v: JObject | null, onObject: (o: JObject) => unknown): unknown {
    if (v === null) return null;
    if (v instanceof JArray) {
      const d = v.a;
      if (Array.isArray(d)) return d.map((e) => this.convert(e, onObject));
      if (v.cls.component!.prim === "Z") return new Uint8Array(d.buffer, d.byteOffset, d.length).slice();
      return (d as Int8Array).slice();
    }
    const n = v.cls.name;
    if (n === "java/lang/String") return this.vm.jsString(v);
    if (BOXES.has(n)) {
      const x = this.vm.getField(v, n, "value");
      return n === "java/lang/Boolean" ? x !== 0 : typeof x === "bigint" ? Number(x) : x;
    }
    return onObject(v);
  }

  toWire(desc: string, v: any): unknown {
    switch (desc[0]) {
      case "V": return undefined;
      case "Z": return v !== 0;
      case "J": return Number(v);
      case "L": case "[": return this.convert(v, (o) => this.handle(o));
      default: return v;
    }
  }

  // Wire arguments with handles looked up and field references read.
  *resolve(t: JThread, v: unknown): Generator<Request, unknown> {
    if (v === null || typeof v !== "object" || ArrayBuffer.isView(v)) return v;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) out.push(yield* this.resolve(t, x));
      return out;
    }
    if ("$java" in v) return this.object((v as Handle).$java);
    if ("$get" in v) {
      const [target, name] = (v as FieldRef).$get;
      const [raw, desc] = yield* this.readField(t, target, name);
      return desc[0] === "L" || desc[0] === "[" ? this.convert(raw, (o) => o) : this.toWire(desc, raw);
    }
    return v;
  }

  private *box(t: JThread, name: string, prim: string, v: unknown): Generator<Request, JObject> {
    const c = this.vm.loadBootOrFail(name);
    if (c.state !== INITIALIZED) yield* this.vm.initGen(t, c);
    const key = prim === "Z" ? "valueOf(Z)" : `valueOf(${prim})`;
    return yield t.call(c.methodMap.get(`${key}L${name};`)!, primValue(prim, v));
  }

  // A resolved wire value as a Java value of the type desc.
  *toJava(t: JThread, desc: string, v: any, loader: JObject | null): Generator<Request, any> {
    if (desc[0] !== "L" && desc[0] !== "[") return desc[0] === "V" ? undefined : primValue(desc, v);
    if (v === null || v === undefined) return null;
    if (v instanceof JObject) return v;
    if (typeof v === "string") return this.vm.str(v);
    if (typeof v === "boolean") return yield* this.box(t, "java/lang/Boolean", "Z", v);
    if (typeof v === "bigint") return yield* this.box(t, "java/lang/Long", "J", v);
    if (typeof v === "number") {
      const [name, prim] = BOX_OF[desc] ?? BOX_OF[v === (v | 0) ? "Ljava/lang/Integer;" : Number.isSafeInteger(v) ? "Ljava/lang/Long;" : "Ljava/lang/Double;"];
      return yield* this.box(t, name, prim, v);
    }
    if (ArrayBuffer.isView(v)) {
      const elem = desc[0] === "[" ? desc[1] : typedElem(v)!;
      const a = newArrayData(elem, (v as Uint8Array).length);
      (a as unknown as Uint8Array).set(v as Uint8Array);
      return new JArray(this.vm.primArrayClass(elem), a);
    }
    if (Array.isArray(v)) return yield* this.toJavaArray(t, desc[0] === "[" ? desc : "[Ljava/lang/Object;", v, loader);
    throw new Error(`cannot convert ${describe(v)} to ${desc}`);
  }

  private *toJavaArray(t: JThread, desc: string, vals: unknown[], loader: JObject | null): Generator<Request, JArray> {
    const comp = desc.slice(1);
    if (comp[0] !== "L" && comp[0] !== "[") {
      const a = newArrayData(comp, vals.length);
      for (let i = 0; i < vals.length; i++) (a as any)[i] = primValue(comp, vals[i]);
      return new JArray(this.vm.primArrayClass(comp), a);
    }
    const items: (JObject | null)[] = [];
    for (const x of vals) items.push(yield* this.toJava(t, comp, x, loader));
    const cc: JClass = yield* this.vm.loadClassGen(t, loader, comp[0] === "L" ? comp.slice(1, -1) : comp);
    return new JArray(this.vm.arrayOf(cc), items);
  }

  // ---- running requests ----------------------------------------------------

  request(req: LibraryRequest): Promise<LibraryReply> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("the VM has exited"));
      this.queue.push({ req, resolve, reject });
      this.dispatch();
    });
  }

  // The VM halted: nothing will run the queued calls.
  close() {
    this.closed = true;
    const err = new Error("the VM has exited");
    for (const p of [...this.queue, ...this.inflight]) p.reject(err);
    this.queue = [];
    this.inflight.clear();
    this.table.clear();
    this.ids.clear();
  }

  // Calls run one at a time, in order. A thread waiting in a native serves
  // them too, so a native can call back into Java.
  private dispatch() {
    while (this.busy === 0 && this.queue.length > 0 && this.idle.length > 0) {
      const s = this.idle.shift()!;
      s.call = this.queue.shift()!;
      this.busy++;
      s.wake?.();
    }
  }

  // The body of the library's main thread.
  *loop(t: JThread): NativeGen {
    const me: Server = { call: null, wake: null };
    for (;;) {
      this.idle.push(me);
      this.dispatch();
      while (!me.call) yield t.block(new Promise<void>((r) => (me.wake = r)));
      const call = me.call;
      me.call = null;
      yield* this.serve(t, call);
    }
  }

  // Waits for a promise inside a native, running calls meanwhile.
  *pump<R>(t: JThread, p: Promise<R>): Generator<Request, R, any> {
    let outcome: { v: R } | { e: unknown } | null = null;
    const me: Server = { call: null, wake: null };
    p.then((v) => { outcome = { v }; me.wake?.(); }, (e) => { outcome = { e }; me.wake?.(); });
    const serving = (this.depth.get(t) ?? 0) > 0;
    if (serving) this.busy--;
    try {
      for (;;) {
        this.idle.push(me);
        this.dispatch();
        while (!me.call && !outcome) yield t.block(new Promise<void>((r) => (me.wake = r)));
        if (!me.call) {
          this.idle.splice(this.idle.indexOf(me), 1);
          break;
        }
        const call = me.call;
        me.call = null;
        yield* this.serve(t, call);
      }
    } finally {
      if (serving) this.busy++;
    }
    const done = outcome as unknown as { v: R } | { e: unknown };
    if ("e" in done) throw done.e;
    return done.v;
  }

  private *serve(t: JThread, call: Pending): NativeGen {
    this.inflight.add(call);
    this.depth.set(t, (this.depth.get(t) ?? 0) + 1);
    try {
      call.resolve(yield* this.run(t, call.req));
    } catch (e) {
      call.reject(this.failure(e));
    } finally {
      this.depth.set(t, this.depth.get(t)! - 1);
      this.inflight.delete(call);
      this.busy--;
      this.dispatch();
    }
  }

  private failure(e: unknown): Error {
    if (e instanceof JavaThrow) {
      const err = new LibraryError(this.vm.describeThrowable(e.obj));
      err.throwable = this.handle(e.obj);
      return err;
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  private *systemLoader(t: JThread): Generator<Request, JObject> {
    if (!this.loader) {
      const cl = this.vm.loadBootOrFail("java/lang/ClassLoader");
      this.loader = yield t.call(cl.methodMap.get("getSystemClassLoader()Ljava/lang/ClassLoader;")!);
    }
    return this.loader!;
  }

  private *loadClass(t: JThread, name: string): Generator<Request, JClass> {
    const loader = yield* this.systemLoader(t);
    const cls: JClass = yield* this.vm.loadClassGen(t, loader, name.replace(/\./g, "/"), true);
    if (cls.state !== INITIALIZED) yield* this.vm.initGen(t, cls);
    return cls;
  }

  private *run(t: JThread, req: LibraryRequest): Generator<Request, LibraryReply> {
    switch (req.op) {
      case "class":
        yield* this.loadClass(t, req.cls);
        return { value: undefined };
      case "static": {
        const cls = yield* this.loadClass(t, req.cls);
        return yield* this.invoke(t, "static method", cls, req.method, null, req.args);
      }
      case "new": {
        const cls = yield* this.loadClass(t, req.cls);
        if (cls.isInterface || cls.access & 0x0400) throw new Error(`${cls.javaName} is abstract and cannot be created`);
        const obj = this.vm.newObject(cls);
        yield* this.invoke(t, "constructor", cls, "<init>", obj, req.args);
        return { value: this.handle(obj) };
      }
      case "call": {
        const obj = this.object(req.obj);
        return yield* this.invoke(t, "method", obj.cls, req.method, obj, req.args);
      }
      case "getStatic": case "get": {
        const [raw, desc] = yield* this.readField(t, req.op === "get" ? req.obj : req.cls, req.field);
        return { value: this.toWire(desc, raw) };
      }
      case "setStatic": case "set": {
        const { f, obj } = yield* this.field(t, req.op === "set" ? req.obj : req.cls, req.field);
        const value = yield* this.toJava(t, f.desc, yield* this.resolve(t, req.value), f.cls.loader);
        if (obj) obj.f[f.slot] = value;
        else f.cls.statics[f.slot] = value;
        return { value: undefined };
      }
    }
  }

  // The public field of an object or a static field of a class.
  private *field(t: JThread, target: number | string | FieldRef, name: string): Generator<Request, { f: JField; obj: JObject | null }> {
    let obj: JObject | null = null;
    if (typeof target === "number") obj = this.object(target);
    else if (typeof target === "object") {
      const [owner, ownerField] = target.$get;
      const [raw] = yield* this.readField(t, owner, ownerField);
      if (!(raw instanceof JObject)) throw new Error(`${ownerField} is not a Java object`);
      obj = raw;
    }
    const cls = obj ? obj.cls : yield* this.loadClass(t, target as string);
    const f = cls.findField(name);
    if (!f || f.isStatic === !!obj || !(f.access & ACC_PUBLIC)) throw new Error(`no ${obj ? "" : "static "}field ${name} in ${cls.javaName}`);
    if (!obj && f.cls.state !== INITIALIZED) yield* this.vm.initGen(t, f.cls);
    return { f, obj };
  }

  // A field's Java value and descriptor.
  private *readField(t: JThread, target: number | string | FieldRef, name: string): Generator<Request, [any, string]> {
    const { f, obj } = yield* this.field(t, target, name);
    return [obj ? obj.f[f.slot] : f.cls.statics[f.slot], f.desc];
  }

  private methodsOf(cls: JClass, name: string, isStatic: boolean): JMethod[] {
    const seen = new Set<string>();
    const out: JMethod[] = [];
    const classes: Iterable<JClass> = isStatic ? chain(cls) : cls.allSupers();
    for (const c of classes) {
      for (const m of c.methods) {
        if (m.name !== name || m.isStatic !== isStatic || m.access & ACC_SYNTHETIC || seen.has(m.key)) continue;
        if (!isStatic && !(m.access & ACC_PUBLIC)) continue;
        seen.add(m.key);
        out.push(m);
      }
      if (name === "<init>") break;
    }
    return out;
  }

  // The best overload for the arguments: exact arity first, then varargs.
  private pick(cands: JMethod[], args: unknown[]): { m: JMethod; varargs: boolean } | null {
    let best: JMethod | null = null;
    let bestScore = -1;
    for (const m of cands) {
      if (m.params.length !== args.length) continue;
      let score = 0;
      for (let i = 0; i < args.length && score >= 0; i++) {
        const f = fit(m.params[i], args[i]);
        score = f < 0 ? -1 : score + f;
      }
      if (score > bestScore) [best, bestScore] = [m, score];
    }
    if (best) return { m: best, varargs: false };
    for (const m of cands) {
      const n = m.params.length - 1;
      if (!(m.access & ACC_VARARGS) || args.length < n) continue;
      let score = 0;
      for (let i = 0; i < args.length && score >= 0; i++) {
        const f = fit(i < n ? m.params[i] : m.params[n].slice(1), args[i]);
        score = f < 0 ? -1 : score + f;
      }
      if (score > bestScore) [best, bestScore] = [m, score];
    }
    return best ? { m: best, varargs: true } : null;
  }

  private *invoke(t: JThread, kind: string, cls: JClass, name: string, recv: JObject | null, wireArgs: unknown[]): Generator<Request, LibraryReply> {
    const args = (yield* this.resolve(t, wireArgs)) as unknown[];
    const isCtor = name === "<init>";
    const sel = this.pick(this.methodsOf(cls, name, recv === null), args);
    if (!sel) throw new Error(`no ${kind}${isCtor ? "" : " " + name} in ${cls.javaName} takes (${args.map(describe).join(", ")})`);
    const { m, varargs } = sel;
    const fixed = varargs ? m.params.length - 1 : m.params.length;
    const javaArgs: any[] = [];
    for (let i = 0; i < fixed; i++) javaArgs.push(yield* this.toJava(t, m.params[i], args[i], m.cls.loader));
    if (varargs) javaArgs.push(yield* this.toJavaArray(t, m.params[fixed], args.slice(fixed), m.cls.loader));
    let target = m;
    if (recv && !isCtor) target = recv.cls.selectMethod(m.key) ?? m;
    const r: any = yield recv ? t.call(target, recv, ...javaArgs) : t.call(target, ...javaArgs);
    const reply: LibraryReply = { value: isCtor ? undefined : this.toWire(m.ret, r) };
    for (let i = 0; i < fixed; i++) {
      const orig = args[i];
      if (!ArrayBuffer.isView(orig) || !(javaArgs[i] instanceof JArray)) continue;
      const now = (javaArgs[i] as JArray).a as Int8Array;
      const was = orig as unknown as ArrayLike<number>;
      let changed = false;
      for (let j = 0; j < now.length && !changed; j++) changed = now[j] !== was[j];
      if (changed) (reply.back ??= []).push([i, this.convert(javaArgs[i], (o) => o) as ArrayBufferView]);
    }
    return reply;
  }
}

function* chain(c: JClass): Generator<JClass> {
  for (let x: JClass | null = c; x; x = x.superclass) yield x;
}
