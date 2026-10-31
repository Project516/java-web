// Core reflection: Class metadata, Field/Method/Constructor objects,
// invoke0/newInstance0 and ConstantPool.

import { Reader, Tag, className, utf8 } from "../classfile.ts";
import {
  ACC_STATIC, ACC_FINAL, INITIALIZED, JArray, JClass, JField, JMethod, JObject, newArrayData,
} from "../runtime.ts";
import { Frame, JThread, JavaThrow, PendingThrow } from "../thread.ts";
import { annotationTypes } from "./invoke.ts";
import type { NativeGen } from "../thread.ts";
import { u16 } from "./util.ts";
import type { Natives } from "./util.ts";

const FIELD_MODIFIERS = 0x50df;
const METHOD_MODIFIERS = 0x1dff;

function attrString(c: JClass, attrs: Map<string, Uint8Array>, name: string): string | null {
  const raw = attrs.get(name);
  return raw ? utf8(c.cf!.cp, u16(raw, 0)) : null;
}

function rawBytes(t: JThread, attrs: Map<string, Uint8Array> | undefined, name: string): JArray | null {
  const raw = attrs?.get(name);
  if (!raw) return null;
  const a = t.vm.newArray(t.vm.primClass("B"), raw.length);
  (a.a as Int8Array).set(new Int8Array(raw.buffer, raw.byteOffset, raw.length));
  return a;
}

// The Class for a field descriptor, loading through c's loader.
export function* typeOf(t: JThread, c: JClass, desc: string): NativeGen {
  const vm = t.vm;
  let dims = 0;
  while (desc[dims] === "[") dims++;
  let e: JClass;
  if (desc[dims] === "L") e = yield* vm.loadClassGen(t, c.loader, desc.slice(dims + 1, -1));
  else e = vm.primClass(desc[dims]);
  for (let i = 0; i < dims; i++) e = vm.arrayOf(e);
  return e;
}

function* mirrors(t: JThread, c: JClass, descs: string[]): NativeGen {
  const out: JObject[] = [];
  for (const d of descs) out.push(t.vm.mirror(yield* typeOf(t, c, d)));
  return t.vm.newObjectArray("java/lang/Class", out);
}

function* exceptionTypes(t: JThread, m: JMethod): NativeGen {
  const raw = m.attrs.get("Exceptions");
  const out: JObject[] = [];
  if (raw) {
    const n = u16(raw, 0);
    for (let i = 0; i < n; i++) {
      const name = className(m.cls.cf!.cp, u16(raw, 2 + i * 2));
      out.push(t.vm.mirror(yield* t.vm.loadClassGen(t, m.cls.loader, name)));
    }
  }
  return t.vm.newObjectArray("java/lang/Class", out);
}

function* initialized(t: JThread, name: string): NativeGen {
  const c = t.vm.loadBoot(name)!;
  if (c.state !== INITIALIZED) yield* t.vm.initGen(t, c);
  return c;
}

export function* fieldObject(t: JThread, f: JField): NativeGen {
  const vm = t.vm;
  const F = "java/lang/reflect/Field";
  const o = vm.newObject(yield* initialized(t, F));
  const c = f.cls;
  vm.setField(o, F, "clazz", vm.mirror(c));
  vm.setField(o, F, "slot", f.index);
  vm.setField(o, F, "name", vm.intern(f.name));
  vm.setField(o, F, "type", vm.mirror(yield* typeOf(t, c, f.desc)));
  vm.setField(o, F, "modifiers", f.access & FIELD_MODIFIERS);
  const isRecord = c.superclass?.name === "java/lang/Record";
  vm.setField(o, F, "trustedFinal", (f.access & ACC_FINAL) && ((f.access & ACC_STATIC) || isRecord || c.hidden) ? 1 : 0);
  const sig = attrString(c, f.attrs, "Signature");
  vm.setField(o, F, "signature", sig ? vm.intern(sig) : null);
  vm.setField(o, F, "annotations", rawBytes(t, f.attrs, "RuntimeVisibleAnnotations"));
  return o;
}

export function* methodObject(t: JThread, m: JMethod): NativeGen {
  const vm = t.vm;
  const c = m.cls;
  const isCtor = m.name === "<init>";
  const M = isCtor ? "java/lang/reflect/Constructor" : "java/lang/reflect/Method";
  const o = vm.newObject(yield* initialized(t, M));
  vm.setField(o, M, "clazz", vm.mirror(c));
  vm.setField(o, M, "slot", m.index);
  vm.setField(o, M, "parameterTypes", yield* mirrors(t, c, m.params));
  vm.setField(o, M, "exceptionTypes", yield* exceptionTypes(t, m));
  vm.setField(o, M, "modifiers", m.access & METHOD_MODIFIERS);
  const sig = attrString(c, m.attrs, "Signature");
  vm.setField(o, M, "signature", sig ? vm.intern(sig) : null);
  vm.setField(o, M, "annotations", rawBytes(t, m.attrs, "RuntimeVisibleAnnotations"));
  vm.setField(o, M, "parameterAnnotations", rawBytes(t, m.attrs, "RuntimeVisibleParameterAnnotations"));
  if (!isCtor) {
    vm.setField(o, M, "name", vm.intern(m.name));
    vm.setField(o, M, "returnType", vm.mirror(yield* typeOf(t, c, m.ret)));
    vm.setField(o, M, "annotationDefault", rawBytes(t, m.attrs, "AnnotationDefault"));
  }
  return o;
}

export function methodOf(t: JThread, o: JObject): JMethod {
  const vm = t.vm;
  const owner = o.cls.name;
  const c = vm.classOf(vm.getField(o, owner, "clazz"));
  return c.methods[vm.getField(o, owner, "slot")];
}

interface InnerEntry { inner: string; outer: string | null; name: string | null; flags: number }

function innerClasses(c: JClass): InnerEntry[] {
  const raw = c.cf?.attrs.get("InnerClasses");
  if (!raw) return [];
  const cp = c.cf!.cp;
  const out: InnerEntry[] = [];
  for (let i = 0, n = u16(raw, 0); i < n; i++) {
    const p = 2 + i * 8;
    const ii = u16(raw, p), oi = u16(raw, p + 2), ni = u16(raw, p + 4);
    out.push({
      inner: className(cp, ii),
      outer: oi ? className(cp, oi) : null,
      name: ni ? utf8(cp, ni) : null,
      flags: u16(raw, p + 6),
    });
  }
  return out;
}

// As HotSpot resolves it: the NestHost class when it loads, is in the same
// package and loader, and lists c in NestMembers; otherwise c itself.
export function* nestHostOf(t: JThread, c: JClass): NativeGen {
  if (c.nestHost) return c.nestHost;
  let host = c;
  const raw = c.cf?.attrs.get("NestHost");
  if (raw) {
    try {
      const h: JClass = yield* t.vm.loadClassGen(t, c.loader, className(c.cf!.cp, u16(raw, 0)));
      if (h.loader === c.loader && h.packageName === c.packageName && classList(h, "NestMembers").includes(c.name)) host = h;
    } catch {
      // a host that fails to load leaves c its own host
    }
  }
  return (c.nestHost = host);
}

function classList(c: JClass, attr: string): string[] {
  const raw = c.cf?.attrs.get(attr);
  if (!raw) return [];
  const out: string[] = [];
  for (let i = 0, n = u16(raw, 0); i < n; i++) out.push(className(c.cf!.cp, u16(raw, 2 + i * 2)));
  return out;
}

// ---- boxing ----------------------------------------------------------------

const BOXES: Record<string, string> = {
  Z: "java/lang/Boolean", B: "java/lang/Byte", C: "java/lang/Character", S: "java/lang/Short",
  I: "java/lang/Integer", J: "java/lang/Long", F: "java/lang/Float", D: "java/lang/Double",
};
const UNBOX: Record<string, string> = Object.fromEntries(Object.entries(BOXES).map(([k, v]) => [v, k]));
const WIDENS: Record<string, string> = { B: "SIJFD", S: "IJFD", C: "IJFD", I: "JFD", J: "FD", F: "D", Z: "", D: "" };

export function* box(t: JThread, desc: string, v: any): NativeGen {
  const name = BOXES[desc];
  if (!name) return v;
  const c = yield* initialized(t, name);
  return yield t.call(c.methodMap.get(`valueOf(${desc})L${name};`)!, v);
}

function convert(v: any, from: string, to: string): any {
  if (from === to) return v;
  if (from === "J") return to === "F" ? Math.fround(Number(v)) : Number(v);
  if (to === "J") return BigInt(v);
  if (to === "F") return Math.fround(v);
  return v;
}

// Unboxes or checks an argument for a parameter of type desc.
export function* unbox(t: JThread, c: JClass, desc: string, o: JObject | null): NativeGen {
  if (desc[0] === "L" || desc[0] === "[") {
    if (o === null) return null;
    const target: JClass = yield* typeOf(t, c, desc);
    if (!o.cls.isAssignableTo(target)) throw new PendingThrow("java/lang/IllegalArgumentException", "argument type mismatch");
    return o;
  }
  const from = o ? UNBOX[o.cls.name] : undefined;
  if (!from || (from !== desc && !WIDENS[from].includes(desc))) {
    throw new PendingThrow("java/lang/IllegalArgumentException", o === null ? "null value for primitive parameter" : "argument type mismatch");
  }
  return convert(t.vm.getField(o!, o!.cls.name, "value"), from, desc);
}

function* invokeReflect(t: JThread, m: JMethod, recv: JObject | null, args: JArray | null): NativeGen {
  const vm = t.vm;
  const given = (args?.a ?? []) as (JObject | null)[];
  if (given.length !== m.params.length) {
    throw new PendingThrow("java/lang/IllegalArgumentException", `wrong number of arguments: ${given.length} expected: ${m.params.length}`);
  }
  const call: any[] = [];
  let target = m;
  if (!m.isStatic) {
    if (recv === null) throw new PendingThrow("java/lang/NullPointerException");
    if (!recv.cls.isAssignableTo(m.cls)) throw new PendingThrow("java/lang/IllegalArgumentException", "object is not an instance of declaring class");
    if (!m.isPrivate && m.name !== "<init>") target = recv.cls.selectMethod(m.key) ?? m;
    call.push(recv);
  } else if (m.cls.state !== INITIALIZED) {
    yield* vm.initGen(t, m.cls);
  }
  for (let i = 0; i < m.params.length; i++) call.push(yield* unbox(t, m.cls, m.params[i], given[i]));
  let r: any;
  try {
    r = yield t.call(target, ...call);
  } catch (e) {
    if (!(e instanceof JavaThrow)) throw e;
    throw new JavaThrow(yield* vm.newThrowable(t, "java/lang/reflect/InvocationTargetException", null, e.obj));
  }
  if (m.ret === "V") return null;
  return yield* box(t, m.ret, r);
}

// NativeAccessor.invoke(Object, Object[], Class) puts the caller first in the
// arguments of a caller-sensitive adapter, which takes it last. HotSpot calls
// adapters through method handles unless jdk.reflect.useNativeAccessorOnly is
// set, which is when native accessors run.
function adapterArgs(t: JThread, m: JMethod, args: JArray | null): JArray | null {
  const c = t.top;
  if (!args || args.a.length < 2 || !(c instanceof Frame) || c.m.name !== "invoke" ||
    c.m.cls.name !== "jdk/internal/reflect/DirectMethodHandleAccessor$NativeAccessor" ||
    c.m.desc !== "(Ljava/lang/Object;[Ljava/lang/Object;Ljava/lang/Class;)Ljava/lang/Object;" ||
    !annotationTypes(m.cls, m.attrs.get("RuntimeInvisibleAnnotations")).includes("Ljdk/internal/reflect/CallerSensitiveAdapter;")) {
    return args;
  }
  const a = args.a as (JObject | null)[];
  return new JArray(args.cls, [...a.slice(1), a[0]]);
}

// ---- natives ---------------------------------------------------------------

const C = "java/lang/Class.";
const E = "java/lang/reflect/Executable.";
const CP = "jdk/internal/reflect/ConstantPool.";

function cpOf(t: JThread, o: JObject) {
  return t.vm.classOf(o).cf!.cp;
}

export const natives: Natives = {
  [`${C}getDeclaredFields0(Z)[Ljava/lang/reflect/Field;`]: function* (t, [m, publicOnly]): NativeGen {
    const c = t.vm.classOf(m);
    const out: JObject[] = [];
    for (const f of c.fields) if ((!publicOnly || f.access & 1) && !c.vmMembers?.has(f)) out.push(yield* fieldObject(t, f));
    return t.vm.newObjectArray("java/lang/reflect/Field", out);
  },
  [`${C}getDeclaredMethods0(Z)[Ljava/lang/reflect/Method;`]: function* (t, [m, publicOnly]): NativeGen {
    const c = t.vm.classOf(m);
    const out: JObject[] = [];
    for (const x of c.methods) {
      if (x.name[0] === "<" || (publicOnly && !(x.access & 1)) || c.vmMembers?.has(x)) continue;
      out.push(yield* methodObject(t, x));
    }
    return t.vm.newObjectArray("java/lang/reflect/Method", out);
  },
  [`${C}getDeclaredConstructors0(Z)[Ljava/lang/reflect/Constructor;`]: function* (t, [m, publicOnly]): NativeGen {
    const c = t.vm.classOf(m);
    const out: JObject[] = [];
    if (!c.isInterface && !c.prim && !c.component) {
      for (const x of c.methods) {
        if (x.name !== "<init>" || (publicOnly && !(x.access & 1))) continue;
        out.push(yield* methodObject(t, x));
      }
    }
    return t.vm.newObjectArray("java/lang/reflect/Constructor", out);
  },
  [`${C}getDeclaredClasses0()[Ljava/lang/Class;`]: function* (t, [m]): NativeGen {
    const c = t.vm.classOf(m);
    const out: JObject[] = [];
    for (const e of innerClasses(c)) {
      if (e.outer === c.name && e.inner !== c.name) out.push(t.vm.mirror(yield* t.vm.loadClassGen(t, c.loader, e.inner)));
    }
    return t.vm.newObjectArray("java/lang/Class", out);
  },
  [`${C}getDeclaringClass0()Ljava/lang/Class;`]: function* (t, [m]): NativeGen {
    const c = t.vm.classOf(m);
    const e = innerClasses(c).find((x) => x.inner === c.name);
    if (!e?.outer) return null;
    return t.vm.mirror(yield* t.vm.loadClassGen(t, c.loader, e.outer));
  },
  [`${C}getSimpleBinaryName0()Ljava/lang/String;`]: (t, [m]) => {
    const c = t.vm.classOf(m);
    const e = innerClasses(c).find((x) => x.inner === c.name);
    return e?.name ? t.vm.intern(e.name) : null;
  },
  [`${C}getEnclosingMethod0()[Ljava/lang/Object;`]: function* (t, [m]): NativeGen {
    const c = t.vm.classOf(m);
    const raw = c.cf?.attrs.get("EnclosingMethod");
    if (!raw) return null;
    const cp = c.cf!.cp;
    const outer = yield* t.vm.loadClassGen(t, c.loader, className(cp, u16(raw, 0)));
    const nat = u16(raw, 2);
    const e = nat ? cp[nat]! : null;
    return t.vm.newObjectArray("java/lang/Object", [
      t.vm.mirror(outer),
      e ? t.vm.intern(utf8(cp, e.a)) : null,
      e ? t.vm.intern(utf8(cp, e.b)) : null,
    ]);
  },
  [`${C}getNestHost0()Ljava/lang/Class;`]: function* (t, [m]): NativeGen {
    return t.vm.mirror(yield* nestHostOf(t, t.vm.classOf(m)));
  },
  [`${C}getNestMembers0()[Ljava/lang/Class;`]: function* (t, [m]): NativeGen {
    const c = t.vm.classOf(m);
    const out = [m];
    for (const n of classList(c, "NestMembers")) out.push(t.vm.mirror(yield* t.vm.loadClassGen(t, c.loader, n)));
    return t.vm.newObjectArray("java/lang/Class", out);
  },
  [`${C}getPermittedSubclasses0()[Ljava/lang/Class;`]: function* (t, [m]): NativeGen {
    const c = t.vm.classOf(m);
    if (!c.cf?.attrs.has("PermittedSubclasses")) return null;
    const out: JObject[] = [];
    for (const n of classList(c, "PermittedSubclasses")) out.push(t.vm.mirror(yield* t.vm.loadClassGen(t, c.loader, n)));
    return t.vm.newObjectArray("java/lang/Class", out);
  },
  [`${C}isRecord0()Z`]: (t, [m]) => {
    const c = t.vm.classOf(m);
    return c.superclass?.name === "java/lang/Record" && !!c.cf?.attrs.has("Record");
  },
  [`${C}getRecordComponents0()[Ljava/lang/reflect/RecordComponent;`]: function* (t, [m]): NativeGen {
    const vm = t.vm;
    const c = vm.classOf(m);
    const raw = c.cf?.attrs.get("Record");
    if (!raw) return null;
    const cp = c.cf!.cp;
    const R = "java/lang/reflect/RecordComponent";
    const rc = yield* initialized(t, R);
    const out: JObject[] = [];
    const r = new Reader(raw);
    for (let i = 0, n = r.u2(); i < n; i++) {
      const name = utf8(cp, r.u2()), desc = utf8(cp, r.u2());
      const attrs = new Map<string, Uint8Array>();
      for (let k = r.u2(); k > 0; k--) {
        const an = utf8(cp, r.u2());
        attrs.set(an, r.slice(r.u4()));
      }
      const o = vm.newObject(rc);
      vm.setField(o, R, "clazz", m);
      vm.setField(o, R, "name", vm.intern(name));
      vm.setField(o, R, "type", vm.mirror(yield* typeOf(t, c, desc)));
      const acc = c.methodMap.get(`${name}()${desc}`);
      vm.setField(o, R, "accessor", acc ? yield* methodObject(t, acc) : null);
      const sig = attrString(c, attrs, "Signature");
      vm.setField(o, R, "signature", sig ? vm.intern(sig) : null);
      vm.setField(o, R, "annotations", rawBytes(t, attrs, "RuntimeVisibleAnnotations"));
      vm.setField(o, R, "typeAnnotations", rawBytes(t, attrs, "RuntimeVisibleTypeAnnotations"));
      out.push(o);
    }
    return vm.newObjectArray(R, out);
  },
  [`${C}getGenericSignature0()Ljava/lang/String;`]: (t, [m]) => {
    const c = t.vm.classOf(m);
    const s = c.cf ? attrString(c, c.cf.attrs, "Signature") : null;
    return s ? t.vm.intern(s) : null;
  },
  [`${C}getRawAnnotations()[B`]: (t, [m]) => rawBytes(t, t.vm.classOf(m).cf?.attrs, "RuntimeVisibleAnnotations"),
  [`${C}getRawTypeAnnotations()[B`]: (t, [m]) => rawBytes(t, t.vm.classOf(m).cf?.attrs, "RuntimeVisibleTypeAnnotations"),
  [`${E}getTypeAnnotationBytes0()[B`]: (t, [e]) => rawBytes(t, methodOf(t, e).attrs, "RuntimeVisibleTypeAnnotations"),
  "java/lang/reflect/Field.getTypeAnnotationBytes0()[B": (t, [f]) => {
    const c = t.vm.classOf(t.vm.getField(f, "java/lang/reflect/Field", "clazz"));
    const field = c.fields[t.vm.getField(f, "java/lang/reflect/Field", "slot")];
    return rawBytes(t, field.attrs, "RuntimeVisibleTypeAnnotations");
  },
  [`${E}getParameters0()[Ljava/lang/reflect/Parameter;`]: function* (t, [e]): NativeGen {
    const vm = t.vm;
    const m = methodOf(t, e);
    const raw = m.attrs.get("MethodParameters");
    if (!raw) return null;
    const cp = m.cls.cf!.cp;
    const P = "java/lang/reflect/Parameter";
    const pc = yield* initialized(t, P);
    const out: JObject[] = [];
    for (let i = 0; i < raw[0]; i++) {
      const nameIndex = u16(raw, 1 + i * 4), flags = u16(raw, 3 + i * 4);
      if (nameIndex >= cp.length) throw new PendingThrow("java/lang/IllegalArgumentException", "Constant pool index out of bounds");
      if (nameIndex !== 0 && cp[nameIndex]?.tag !== Tag.Utf8) throw new PendingThrow("java/lang/IllegalArgumentException", "Wrong type at constant pool index");
      const p = vm.newObject(pc);
      const name = nameIndex ? vm.str(utf8(cp, nameIndex)) : null;
      yield t.call(pc.methodMap.get(`<init>(Ljava/lang/String;ILjava/lang/reflect/Executable;I)V`)!, p, name, flags, e, i);
      out.push(p);
    }
    return vm.newObjectArray(P, out);
  },
  [`${C}getConstantPool()Ljdk/internal/reflect/ConstantPool;`]: function* (t, [m]): NativeGen {
    const c = yield* initialized(t, "jdk/internal/reflect/ConstantPool");
    const o = t.vm.newObject(c);
    t.vm.setField(o, "jdk/internal/reflect/ConstantPool", "constantPoolOop", m);
    return o;
  },

  "jdk/internal/reflect/DirectMethodHandleAccessor$NativeAccessor.invoke0(Ljava/lang/reflect/Method;Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;":
    (t, [method, recv, args]) => {
      const m = methodOf(t, method);
      return invokeReflect(t, m, recv, adapterArgs(t, m, args));
    },
  "jdk/internal/reflect/DirectConstructorHandleAccessor$NativeAccessor.newInstance0(Ljava/lang/reflect/Constructor;[Ljava/lang/Object;)Ljava/lang/Object;":
    function* (t, [ctor, args]): NativeGen {
      const m = methodOf(t, ctor);
      if (m.cls.access & 0x0400) throw new PendingThrow("java/lang/InstantiationException", m.cls.javaName);
      if (m.cls.state !== INITIALIZED) yield* t.vm.initGen(t, m.cls);
      const o = t.vm.newObject(m.cls);
      yield* invokeReflect(t, m, o, args);
      return o;
    },

  "java/lang/reflect/Array.getLength(Ljava/lang/Object;)I": (_t, [a]) => {
    if (a === null) throw new PendingThrow("java/lang/NullPointerException");
    if (!(a instanceof JArray)) throw new PendingThrow("java/lang/IllegalArgumentException", "Argument is not an array");
    return a.a.length;
  },
  "java/lang/reflect/Array.newArray(Ljava/lang/Class;I)Ljava/lang/Object;": (t, [cm, n]) => {
    const c = t.vm.classOf(cm);
    if (c.prim === "V") throw new PendingThrow("java/lang/IllegalArgumentException");
    if (dims(c) >= 255) throw new PendingThrow("java/lang/IllegalArgumentException", "Array type exceeds 255 dimensions");
    if (n < 0) throw new PendingThrow("java/lang/NegativeArraySizeException", String(n));
    return new JArray(t.vm.arrayOf(c), newArrayData(c.prim ?? "L", n));
  },
  "java/lang/reflect/Array.multiNewArray(Ljava/lang/Class;[I)Ljava/lang/Object;": (t, [cm, dims]) => {
    let c = t.vm.classOf(cm);
    const counts = [...(dims.a as Int32Array)];
    if (counts.length === 0) throw new PendingThrow("java/lang/IllegalArgumentException", "Empty dimensions array");
    if (counts.length + arrayDims(c) > 255) throw new PendingThrow("java/lang/IllegalArgumentException", "Array type exceeds 255 dimensions");
    for (const n of counts) if (n < 0) throw new PendingThrow("java/lang/NegativeArraySizeException", String(n));
    for (let i = 0; i < counts.length; i++) c = t.vm.arrayOf(c);
    return t.vm.multiArray(c, counts);
  },
  "java/lang/reflect/Array.get(Ljava/lang/Object;I)Ljava/lang/Object;": function* (t, [a, i]): NativeGen {
    const arr = checkArray(a, i);
    const p = arr.cls.component!.prim;
    return p ? yield* box(t, p, arr.a[i]) : arr.a[i];
  },
  "java/lang/reflect/Array.set(Ljava/lang/Object;ILjava/lang/Object;)V": function* (t, [a, i, v]): NativeGen {
    const arr = checkArray(a, i);
    const comp = arr.cls.component!;
    if (comp.prim) (arr.a as any)[i] = yield* unbox(t, comp, comp.prim, v);
    else {
      if (v !== null && !v.cls.isAssignableTo(comp)) throw new PendingThrow("java/lang/IllegalArgumentException", "array element type mismatch");
      arr.a[i] = v;
    }
  },
};

function arrayDims(c: JClass) {
  let n = 0;
  for (let e: JClass | null = c; e?.component; e = e.component) n++;
  return n;
}
const dims = arrayDims;

function checkArray(a: JObject | null, i: number): JArray {
  if (a === null) throw new PendingThrow("java/lang/NullPointerException");
  if (!(a instanceof JArray)) throw new PendingThrow("java/lang/IllegalArgumentException", "Argument is not an array");
  if (i < 0 || i >= a.a.length) throw new PendingThrow("java/lang/ArrayIndexOutOfBoundsException", `Index ${i} out of bounds for length ${a.a.length}`);
  return a;
}

for (const [name, d] of Object.entries({ Boolean: "Z", Byte: "B", Char: "C", Short: "S", Int: "I", Long: "J", Float: "F", Double: "D" })) {
  natives[`java/lang/reflect/Array.get${name}(Ljava/lang/Object;I)${d}`] = (_t, [a, i]) => {
    const arr = checkArray(a, i);
    const p = arr.cls.component!.prim;
    if (!p || (p !== d && !WIDENS[p].includes(d))) throw new PendingThrow("java/lang/IllegalArgumentException", "Argument is not an array of the right type");
    return convert(arr.a[i], p, d);
  };
  natives[`java/lang/reflect/Array.set${name}(Ljava/lang/Object;I${d})V`] = (_t, [a, i, v]) => {
    const arr = checkArray(a, i);
    const p = arr.cls.component!.prim;
    if (!p || (p !== d && !WIDENS[d].includes(p))) throw new PendingThrow("java/lang/IllegalArgumentException", "argument type mismatch");
    (arr.a as any)[i] = convert(v, d, p);
  };
}

Object.assign(natives, {
  [`${CP}getSize0(Ljava/lang/Object;)I`]: (t: JThread, [, o]: any[]) => cpOf(t, o).length,
  [`${CP}getIntAt0(Ljava/lang/Object;I)I`]: (t: JThread, [, o, i]: any[]) => cpOf(t, o)[i]!.value,
  [`${CP}getLongAt0(Ljava/lang/Object;I)J`]: (t: JThread, [, o, i]: any[]) => cpOf(t, o)[i]!.value,
  [`${CP}getFloatAt0(Ljava/lang/Object;I)F`]: (t: JThread, [, o, i]: any[]) => cpOf(t, o)[i]!.value,
  [`${CP}getDoubleAt0(Ljava/lang/Object;I)D`]: (t: JThread, [, o, i]: any[]) => cpOf(t, o)[i]!.value,
  [`${CP}getUTF8At0(Ljava/lang/Object;I)Ljava/lang/String;`]: (t: JThread, [, o, i]: any[]) => t.vm.intern(utf8(cpOf(t, o), i)),
  [`${CP}getStringAt0(Ljava/lang/Object;I)Ljava/lang/String;`]: (t: JThread, [, o, i]: any[]) => t.vm.intern(utf8(cpOf(t, o), cpOf(t, o)[i]!.a)),
  [`${CP}getTagAt0(Ljava/lang/Object;I)B`]: (t: JThread, [, o, i]: any[]) => cpOf(t, o)[i]?.tag ?? 0,
  [`${CP}getClassAt0(Ljava/lang/Object;I)Ljava/lang/Class;`]: function* (t: JThread, [, o, i]: any[]): NativeGen {
    const c = t.vm.classOf(o);
    return t.vm.mirror(yield* t.vm.loadClassGen(t, c.loader, className(c.cf!.cp, i)));
  },
  [`${CP}getClassAtIfLoaded0(Ljava/lang/Object;I)Ljava/lang/Class;`]: (t: JThread, [, o, i]: any[]) => {
    const c = t.vm.classOf(o);
    const found = t.vm.findLoaded(c.loader, className(c.cf!.cp, i));
    return found ? t.vm.mirror(found) : null;
  },
  [`${CP}getMemberRefInfoAt0(Ljava/lang/Object;I)[Ljava/lang/String;`]: (t: JThread, [, o, i]: any[]) => {
    const cp = cpOf(t, o);
    const e = cp[i]!, nat = cp[e.b]!;
    return t.vm.newObjectArray("java/lang/String", [className(cp, e.a), utf8(cp, nat.a), utf8(cp, nat.b)].map((s) => t.vm.intern(s)));
  },
  [`${CP}getNameAndTypeRefInfoAt0(Ljava/lang/Object;I)[Ljava/lang/String;`]: (t: JThread, [, o, i]: any[]) => {
    const cp = cpOf(t, o);
    const e = cp[i]!;
    return t.vm.newObjectArray("java/lang/String", [utf8(cp, e.a), utf8(cp, e.b)].map((s) => t.vm.intern(s)));
  },
  [`${CP}getClassRefIndexAt0(Ljava/lang/Object;I)I`]: (t: JThread, [, o, i]: any[]) => cpOf(t, o)[i]!.a,
  [`${CP}getNameAndTypeRefIndexAt0(Ljava/lang/Object;I)I`]: (t: JThread, [, o, i]: any[]) => {
    return cpOf(t, o)[i]!.b;
  },
});
