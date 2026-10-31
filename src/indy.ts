// invokedynamic, method handle constants and signature-polymorphic calls.
//
// The bootstraps javac emits (lambdas, string concatenation, record methods,
// pattern switches) are linked here by generating a small hidden class,
// the same thing the JDK bootstraps do with the ClassFile API, minus the
// cost of running that machinery in the interpreter.

import { Tag, className, utf8 } from "./classfile.ts";
import { ClassWriter } from "./classwriter.ts";
import type { Code } from "./classwriter.ts";
import {
  ACC_FINAL, ACC_PRIVATE, ACC_PUBLIC, ACC_STATIC, ACC_SUPER, ACC_SYNTHETIC, INITIALIZED, isWide, parseMethodDesc,
} from "./runtime.ts";
import type { CallSite, JClass, JMethod, JObject } from "./runtime.ts";
import { invoke } from "./interp.ts";
import { memberTarget } from "./natives/invoke.ts";
import { box, nestHostOf, typeOf } from "./natives/reflect.ts";
import { PendingThrow } from "./thread.ts";
import type { Frame, JThread, NativeGen } from "./thread.ts";
import type { JVM } from "./jvm.ts";
import { u16 } from "./natives/util.ts";

export const REF_getField = 1, REF_getStatic = 2, REF_putField = 3, REF_putStatic = 4,
  REF_invokeVirtual = 5, REF_invokeStatic = 6, REF_invokeSpecial = 7, REF_newInvokeSpecial = 8,
  REF_invokeInterface = 9;

export interface MethodHandleRef {
  kind: "mh";
  refKind: number;
  owner: string;
  name: string;
  desc: string;
  iface: boolean;
}

export type BsmArg =
  | { kind: "value"; tag: number; value: any }
  | { kind: "class"; name: string }
  | { kind: "mt"; desc: string }
  | MethodHandleRef
  | { kind: "condy"; index: number };

export function cpArg(cls: JClass, idx: number): BsmArg {
  const cp = cls.cf!.cp;
  const e = cp[idx]!;
  switch (e.tag) {
    case Tag.Integer: case Tag.Float: case Tag.Long: case Tag.Double: return { kind: "value", tag: e.tag, value: e.value };
    case Tag.String: return { kind: "value", tag: e.tag, value: utf8(cp, e.a) };
    case Tag.Class: return { kind: "class", name: className(cp, idx) };
    case Tag.MethodType: return { kind: "mt", desc: utf8(cp, e.a) };
    case Tag.MethodHandle: {
      const ref = cp[e.b]!, nat = cp[ref.b]!;
      return {
        kind: "mh", refKind: e.a, owner: className(cp, ref.a), name: utf8(cp, nat.a), desc: utf8(cp, nat.b),
        iface: ref.tag === Tag.InterfaceMethodref,
      };
    }
    case Tag.Dynamic: return { kind: "condy", index: idx };
  }
  throw new PendingThrow("java/lang/InternalError", `bad bootstrap argument tag ${e.tag}`);
}

function wordSize(descs: string[]) {
  let n = 0;
  for (const d of descs) n += isWide(d) ? 2 : 1;
  return n;
}

function internal(desc: string) {
  return desc[0] === "L" ? desc.slice(1, -1) : desc;
}

const WRAPPER: Record<string, string> = {
  Z: "java/lang/Boolean", B: "java/lang/Byte", C: "java/lang/Character", S: "java/lang/Short",
  I: "java/lang/Integer", J: "java/lang/Long", F: "java/lang/Float", D: "java/lang/Double",
};
const PRIM_OF: Record<string, string> = Object.fromEntries(Object.entries(WRAPPER).map(([p, w]) => [`L${w};`, p]));
const VALUE_METHOD: Record<string, string> = {
  Z: "booleanValue", B: "byteValue", C: "charValue", S: "shortValue", I: "intValue", J: "longValue",
  F: "floatValue", D: "doubleValue",
};

function isPrim(d: string) {
  return d.length === 1;
}

function widen(c: Code, from: string, to: string) {
  if (from === to) return;
  const f = from === "J" ? "J" : from === "F" ? "F" : from === "D" ? "D" : "I";
  const t = to === "J" ? "J" : to === "F" ? "F" : to === "D" ? "D" : "I";
  const ops: Record<string, number> = { IJ: 0x85, IF: 0x86, ID: 0x87, JF: 0x89, JD: 0x8a, FD: 0x8d };
  const op = ops[f + t];
  if (op) c.op(op);
}

// Converts the value on the stack from type `from` to `to` as
// LambdaMetafactory does; `hint` is the instantiated (more precise) type.
function convert(c: Code, from: string, hint: string, to: string) {
  if (from === to) return;
  if (isPrim(from) && isPrim(to)) return widen(c, from, to);
  if (isPrim(from)) {
    const w = WRAPPER[from];
    c.invokestatic(w, "valueOf", `(${from})L${w};`);
    return;
  }
  if (isPrim(to)) {
    const src = PRIM_OF[hint] ?? PRIM_OF[from];
    if (src) {
      const w = WRAPPER[src];
      c.checkcast(w).invokevirtual(w, VALUE_METHOD[src], `()${src}`);
      widen(c, src, to);
    } else if (to === "Z" || to === "C") {
      const w = WRAPPER[to];
      c.checkcast(w).invokevirtual(w, VALUE_METHOD[to], `()${to}`);
    } else {
      c.checkcast("java/lang/Number").invokevirtual("java/lang/Number", VALUE_METHOD[to], `()${to}`);
    }
    return;
  }
  if (to !== "Ljava/lang/Object;") c.checkcast(internal(to));
}

function emitInvoke(c: Code, mh: MethodHandleRef) {
  switch (mh.refKind) {
    case REF_invokeVirtual: c.invokevirtual(mh.owner, mh.name, mh.desc); break;
    case REF_invokeInterface: c.invokeinterface(mh.owner, mh.name, mh.desc); break;
    case REF_invokeStatic: c.invokestatic(mh.owner, mh.name, mh.desc, mh.iface); break;
    case REF_invokeSpecial: c.invokespecial(mh.owner, mh.name, mh.desc, mh.iface); break;
    case REF_newInvokeSpecial: c.invokespecial(mh.owner, "<init>", mh.desc); break;
    default: throw new PendingThrow("java/lang/invoke/LambdaConversionException", `unsupported method handle kind ${mh.refKind}`);
  }
}

function* defineHidden(vm: JVM, t: JThread, caller: JClass, w: ClassWriter): NativeGen {
  const c: JClass = yield* vm.defineClassGen(t, caller.loader, w.toBytes(), null, null, true);
  c.nestHost = yield* nestHostOf(t, caller);
  yield* vm.initGen(t, c);
  return c;
}

// ---- LambdaMetafactory -----------------------------------------------------

function* spinLambda(vm: JVM, t: JThread, caller: JClass, name: string, factoryDesc: string, args: BsmArg[], alt: boolean): NativeGen {
  const sam = args[0], impl = args[1], inst = args[2];
  if (sam.kind !== "mt" || impl.kind !== "mh" || inst.kind !== "mt") return null;
  const markers: string[] = [];
  const bridges: string[] = [];
  if (alt) {
    const flags = (args[3] as any).value as number;
    if (flags & 1) return null; // serializable lambdas take the general path
    let i = 4;
    if (flags & 2) {
      const n = (args[i++] as any).value as number;
      for (let k = 0; k < n; k++) markers.push((args[i++] as any).name);
    }
    if (flags & 4) {
      const n = (args[i++] as any).value as number;
      for (let k = 0; k < n; k++) bridges.push((args[i++] as any).desc);
    }
  }
  const { params: captured, ret } = parseMethodDesc(factoryDesc);
  const iface = internal(ret);
  const cname = `${caller.cf!.name}$$Lambda`;
  const w = new ClassWriter(ACC_FINAL | ACC_SUPER | ACC_SYNTHETIC, cname, "java/lang/Object", [iface, ...markers]);
  captured.forEach((d, i) => w.addField(ACC_PRIVATE | ACC_FINAL, `arg$${i + 1}`, d));

  const ctorDesc = `(${captured.join("")})V`;
  const ctor = w.addMethod(ACC_PRIVATE, "<init>", ctorDesc);
  ctor.maxStack = 3;
  ctor.op(0x2a).invokespecial("java/lang/Object", "<init>", "()V");
  let slot = 1;
  captured.forEach((d, i) => {
    ctor.op(0x2a).load(d, slot).putfield(cname, `arg$${i + 1}`, d);
    slot += isWide(d) ? 2 : 1;
  });
  ctor.op(0xb1);

  const factory = w.addMethod(ACC_STATIC, "get$Lambda", factoryDesc);
  factory.maxStack = 2 + wordSize(captured);
  if (captured.length === 0) {
    w.addField(ACC_PRIVATE | ACC_STATIC | ACC_FINAL, "INSTANCE", `L${cname};`);
    const clinit = w.addMethod(ACC_STATIC, "<clinit>", "()V");
    clinit.maxStack = 2;
    clinit.anew(cname).op(0x59).invokespecial(cname, "<init>", "()V").putstatic(cname, "INSTANCE", `L${cname};`).op(0xb1);
    factory.getstatic(cname, "INSTANCE", `L${cname};`).op(0xb0);
  } else {
    factory.anew(cname).op(0x59);
    slot = 0;
    for (const d of captured) {
      factory.load(d, slot);
      slot += isWide(d) ? 2 : 1;
    }
    factory.invokespecial(cname, "<init>", ctorDesc).op(0xb0);
  }

  const { params: implParams, ret: implRet } = parseMethodDesc(impl.desc);
  const receiver = impl.refKind === REF_invokeVirtual || impl.refKind === REF_invokeInterface || impl.refKind === REF_invokeSpecial;
  const targets = receiver ? [`L${impl.owner};`, ...implParams] : implParams;
  const retFrom = impl.refKind === REF_newInvokeSpecial ? `L${impl.owner};` : implRet;
  const instTypes = parseMethodDesc(inst.desc);
  for (const desc of [sam.desc, ...bridges]) {
    const { params, ret: samRet } = parseMethodDesc(desc);
    const m = w.addMethod(ACC_PUBLIC, name, desc);
    m.maxStack = 4 + 2 * (captured.length + params.length);
    if (impl.refKind === REF_newInvokeSpecial) m.anew(impl.owner).op(0x59);
    let ti = 0;
    captured.forEach((d, i) => {
      m.op(0x2a).getfield(cname, `arg$${i + 1}`, d);
      convert(m, d, d, targets[ti++]);
    });
    let s = 1;
    params.forEach((d, i) => {
      m.load(d, s);
      s += isWide(d) ? 2 : 1;
      convert(m, d, instTypes.params[i] ?? d, targets[ti++]);
    });
    emitInvoke(m, impl);
    if (samRet === "V") {
      if (retFrom !== "V") m.op(isWide(retFrom) ? 0x58 : 0x57);
    } else {
      convert(m, retFrom, retFrom, samRet);
    }
    m.ret(samRet);
  }
  const c: JClass = yield* defineHidden(vm, t, caller, w);
  // HotSpot's lambda classes have neither; its call sites build the instance
  const factoryMethod = c.methodMap.get("get$Lambda" + factoryDesc)!;
  c.vmMembers = new Set([factoryMethod, ...c.fields.filter((f) => f.name === "INSTANCE")]);
  return factoryMethod;
}

// ---- StringConcatFactory ---------------------------------------------------

function appendDesc(d: string) {
  switch (d) {
    case "Z": case "C": case "I": case "J": case "F": case "D": return `(${d})Ljava/lang/StringBuilder;`;
    case "B": case "S": return "(I)Ljava/lang/StringBuilder;";
    case "Ljava/lang/String;": return "(Ljava/lang/String;)Ljava/lang/StringBuilder;";
    default: return "(Ljava/lang/Object;)Ljava/lang/StringBuilder;";
  }
}

const SB = "java/lang/StringBuilder";

function* spinConcat(vm: JVM, t: JThread, caller: JClass, desc: string, args: BsmArg[], withRecipe: boolean): NativeGen {
  const { params } = parseMethodDesc(desc);
  const recipe = withRecipe ? ((args[0] as any).value as string) : "\u0001".repeat(params.length);
  const constants = withRecipe ? args.slice(1) : [];
  if (constants.some((a) => a.kind !== "value")) return null;
  const w = new ClassWriter(ACC_FINAL | ACC_SUPER | ACC_SYNTHETIC, `${caller.cf!.name}$$StringConcat`, "java/lang/Object");
  const m = w.addMethod(ACC_STATIC, "concat", desc);
  m.maxStack = 4;
  m.anew(SB).op(0x59).invokespecial(SB, "<init>", "()V");
  let lit = "", slot = 0, ai = 0, ci = 0;
  const flush = () => {
    if (lit) m.ldcString(lit).invokevirtual(SB, "append", appendDesc("Ljava/lang/String;"));
    lit = "";
  };
  for (const ch of recipe) {
    if (ch === "\u0001") {
      flush();
      const d = params[ai++];
      m.load(d, slot);
      slot += isWide(d) ? 2 : 1;
      m.invokevirtual(SB, "append", appendDesc(d));
    } else if (ch === "\u0002") {
      const k = constants[ci++] as { kind: "value"; tag: number; value: any };
      lit += k.tag === Tag.Float || k.tag === Tag.Double ? javaNumber(k.value, k.tag === Tag.Float) : String(k.value);
    } else lit += ch;
  }
  flush();
  m.invokevirtual(SB, "toString", "()Ljava/lang/String;").op(0xb0);
  const c: JClass = yield* defineHidden(vm, t, caller, w);
  return c.methodMap.get("concat" + desc)!;
}

// Float/Double.toString for the simple values javac folds into recipes.
function javaNumber(v: number, isFloat: boolean): string {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(v) && Math.abs(v) < 1e7) return (Object.is(v, -0) ? "-0" : String(v)) + ".0";
  return isFloat ? String(Math.fround(v)) : String(v);
}

// ---- ObjectMethods (records) -----------------------------------------------

function simpleName(c: JClass): string {
  const raw = c.cf?.attrs.get("InnerClasses");
  if (raw) {
    const cp = c.cf!.cp;
    for (let i = 0, n = u16(raw, 0); i < n; i++) {
      const p = 2 + i * 8;
      if (className(cp, u16(raw, p)) === c.cf!.name) {
        const ni = u16(raw, p + 4);
        return ni ? utf8(cp, ni) : "";
      }
    }
  }
  const n = c.cf!.name;
  return n.slice(n.lastIndexOf("/") + 1);
}

const HASH: Record<string, [string, string]> = {
  Z: ["java/lang/Boolean", "(Z)I"], B: ["java/lang/Byte", "(B)I"], S: ["java/lang/Short", "(S)I"],
  C: ["java/lang/Character", "(C)I"], I: ["java/lang/Integer", "(I)I"], J: ["java/lang/Long", "(J)I"],
  F: ["java/lang/Float", "(F)I"], D: ["java/lang/Double", "(D)I"],
};

function* spinObjectMethod(vm: JVM, t: JThread, caller: JClass, name: string, desc: string, args: BsmArg[]): NativeGen {
  const rec = args[0], names = args[1];
  if (rec.kind !== "class" || names.kind !== "value") return null;
  const getters = args.slice(2) as MethodHandleRef[];
  if (getters.some((g) => g.kind !== "mh" || g.refKind !== REF_getField)) return null;
  const recClass: JClass = yield* vm.loadClassGen(t, caller.loader, rec.name);
  const R = rec.name;
  const labels = (names.value as string).length ? (names.value as string).split(";") : [];
  const w = new ClassWriter(ACC_FINAL | ACC_SUPER | ACC_SYNTHETIC, `${caller.cf!.name}$$ObjectMethods`, "java/lang/Object");
  const m = w.addMethod(ACC_STATIC, name, desc);
  m.maxStack = 6;
  if (name === "toString") {
    m.anew(SB).op(0x59).ldcString(simpleName(recClass) + "[").invokespecial(SB, "<init>", "(Ljava/lang/String;)V");
    getters.forEach((g, i) => {
      m.ldcString((i ? ", " : "") + labels[i] + "=").invokevirtual(SB, "append", appendDesc("Ljava/lang/String;"));
      m.op(0x2a).getfield(g.owner, g.name, g.desc).invokevirtual(SB, "append", appendDesc(g.desc));
    });
    m.ldcString("]").invokevirtual(SB, "append", appendDesc("Ljava/lang/String;"));
    m.invokevirtual(SB, "toString", "()Ljava/lang/String;").op(0xb0);
  } else if (name === "hashCode") {
    m.op(0x03);
    for (const g of getters) {
      m.op(0x10, 31, 0x68);
      m.op(0x2a).getfield(g.owner, g.name, g.desc);
      const h = HASH[g.desc];
      if (h) m.invokestatic(h[0], "hashCode", h[1]);
      else m.invokestatic("java/util/Objects", "hashCode", "(Ljava/lang/Object;)I");
      m.op(0x60);
    }
    m.op(0xac);
  } else if (name === "equals") {
    const notSame = m.label(), isInst = m.label(), no = m.label();
    m.op(0x2a, 0x2b).jump(0xa6, notSame).op(0x04, 0xac).bind(notSame);
    m.op(0x2b).instanceOf(R).jump(0x9a, isInst).op(0x03, 0xac).bind(isInst);
    m.op(0x2b).checkcast(R).op(0x4d);
    for (const g of getters) {
      m.op(0x2a).getfield(g.owner, g.name, g.desc).op(0x2c).getfield(g.owner, g.name, g.desc);
      switch (g.desc) {
        case "J": m.op(0x94).jump(0x9a, no); break;
        case "F": m.invokestatic("java/lang/Float", "compare", "(FF)I").jump(0x9a, no); break;
        case "D": m.invokestatic("java/lang/Double", "compare", "(DD)I").jump(0x9a, no); break;
        case "Z": case "B": case "S": case "C": case "I": m.jump(0xa0, no); break;
        default: m.invokestatic("java/util/Objects", "equals", "(Ljava/lang/Object;Ljava/lang/Object;)Z").jump(0x99, no);
      }
    }
    m.op(0x04, 0xac).bind(no).op(0x03, 0xac);
  } else return null;
  const c: JClass = yield* defineHidden(vm, t, caller, w);
  return c.methodMap.get(name + desc)!;
}

// ---- SwitchBootstraps ------------------------------------------------------

function* spinSwitch(vm: JVM, t: JThread, caller: JClass, name: string, desc: string, labels: BsmArg[]): NativeGen {
  const isEnum = name === "enumSwitch";
  // a primitive selector (primitive patterns) goes through SwitchBootstraps
  if (!desc.startsWith("(L") && !desc.startsWith("([")) return null;
  for (const l of labels) {
    if (l.kind === "class") { if (l.name.length === 1) return null; continue; }
    if (l.kind !== "value") return null;
    if (isEnum ? l.tag !== Tag.String : l.tag !== Tag.String && l.tag !== Tag.Integer) return null;
  }
  const w = new ClassWriter(ACC_FINAL | ACC_SUPER | ACC_SYNTHETIC, `${caller.cf!.name}$$Switch`, "java/lang/Object");
  const m = w.addMethod(ACC_STATIC, name, desc);
  m.maxStack = 4;
  const nonNull = m.label();
  m.op(0x2a).jump(0xc7, nonNull).op(0x02, 0xac).bind(nonNull);
  labels.forEach((l, i) => {
    const skip = m.label();
    m.op(0x1b).iconst(i).jump(0xa3, skip);
    if (l.kind === "class") m.op(0x2a).instanceOf(l.name).jump(0x99, skip);
    else if (isEnum) {
      m.op(0x2a).invokevirtual("java/lang/Enum", "name", "()Ljava/lang/String;").ldcString((l as any).value)
        .invokevirtual("java/lang/String", "equals", "(Ljava/lang/Object;)Z").jump(0x99, skip);
    } else if (l.kind === "value" && l.tag === Tag.String) {
      m.ldcString(l.value).op(0x2a).invokevirtual("java/lang/Object", "equals", "(Ljava/lang/Object;)Z").jump(0x99, skip);
    } else {
      const notNum = m.label(), cmp = m.label();
      m.op(0x2a).instanceOf("java/lang/Number").jump(0x99, notNum);
      m.op(0x2a).checkcast("java/lang/Number").invokevirtual("java/lang/Number", "intValue", "()I").jump(0xa7, cmp);
      m.bind(notNum).op(0x2a).instanceOf("java/lang/Character").jump(0x99, skip);
      m.op(0x2a).checkcast("java/lang/Character").invokevirtual("java/lang/Character", "charValue", "()C");
      m.bind(cmp).iconst((l as any).value).jump(0xa0, skip);
    }
    m.iconst(i).op(0xac).bind(skip);
  });
  m.iconst(labels.length).op(0xac);
  const c: JClass = yield* defineHidden(vm, t, caller, w);
  return c.methodMap.get(name + desc)!;
}

// ---- general linking through java.lang.invoke ----------------------------

const MHN = "java/lang/invoke/MethodHandleNatives";

function* initialized(vm: JVM, t: JThread, name: string): NativeGen {
  const c = vm.loadBoot(name)!;
  if (c.state !== INITIALIZED) yield* vm.initGen(t, c);
  return c;
}

function* upcall(vm: JVM, t: JThread, key: string, ...args: any[]): NativeGen {
  const c: JClass = yield* initialized(vm, t, MHN);
  return yield t.call(c.methodMap.get(key)!, ...args);
}

export function* methodType(vm: JVM, t: JThread, loader: JObject | null, desc: string): NativeGen {
  const { params, ret } = parseMethodDesc(desc);
  const holder = { loader } as JClass;
  const r: JClass = yield* typeOf(t, holder, ret);
  const ps: JObject[] = [];
  for (const p of params) ps.push(vm.mirror(yield* typeOf(t, holder, p)));
  return yield* upcall(vm, t, "findMethodHandleType(Ljava/lang/Class;[Ljava/lang/Class;)Ljava/lang/invoke/MethodType;",
    vm.mirror(r), vm.newObjectArray("java/lang/Class", ps));
}

function* methodHandleConstant(vm: JVM, t: JThread, cls: JClass, mh: MethodHandleRef): NativeGen {
  const defc: JClass = yield* vm.loadClassGen(t, cls.loader, mh.owner);
  const type = mh.refKind <= REF_putStatic
    ? vm.mirror(yield* typeOf(t, cls, mh.desc))
    : yield* methodType(vm, t, cls.loader, mh.desc);
  return yield* upcall(vm, t,
    "linkMethodHandleConstant(Ljava/lang/Class;ILjava/lang/Class;Ljava/lang/String;Ljava/lang/Object;)Ljava/lang/invoke/MethodHandle;",
    vm.mirror(cls), mh.refKind, vm.mirror(defc), vm.intern(mh.name), type);
}

function* dynamicConstant(vm: JVM, t: JThread, cls: JClass, idx: number): NativeGen {
  const cp = cls.cf!.cp;
  const e = cp[idx]!;
  const bsm = cls.cf!.bootstrap[e.a];
  const nat = cp[e.b]!;
  const bsmHandle = yield* constantObject(vm, t, cls, bsm.ref);
  const type: JClass = yield* typeOf(t, cls, utf8(cp, nat.b));
  const args = yield* staticArgs(vm, t, cls, bsm.args);
  return yield* upcall(vm, t,
    "linkDynamicConstant(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",
    vm.mirror(cls), bsmHandle, vm.intern(utf8(cp, nat.a)), vm.mirror(type), args);
}

function* staticArgs(vm: JVM, t: JThread, cls: JClass, idxs: number[]): NativeGen {
  if (idxs.length === 0) return null;
  const out: (JObject | null)[] = [];
  for (const i of idxs) out.push(yield* constantObject(vm, t, cls, i));
  return vm.newObjectArray("java/lang/Object", out);
}

// The Java object for a loadable constant, boxing primitives.
export function* constantObject(vm: JVM, t: JThread, cls: JClass, idx: number): NativeGen {
  const cp = cls.cf!.cp;
  const e = cp[idx]!;
  switch (e.tag) {
    case Tag.Integer: return yield* box(t, "I", e.value);
    case Tag.Float: return yield* box(t, "F", e.value);
    case Tag.Long: return yield* box(t, "J", e.value);
    case Tag.Double: return yield* box(t, "D", e.value);
    case Tag.String: return vm.intern(utf8(cp, e.a));
    case Tag.Class: return vm.mirror(yield* vm.loadClassGen(t, cls.loader, className(cp, idx)));
  }
  const cached = cls.ldc[idx];
  if (cached !== undefined && e.tag !== Tag.Dynamic) return cached;
  let v: any;
  if (e.tag === Tag.MethodType) v = yield* methodType(vm, t, cls.loader, utf8(cp, e.a));
  else if (e.tag === Tag.MethodHandle) v = yield* methodHandleConstant(vm, t, cls, cpArg(cls, idx) as MethodHandleRef);
  else if (e.tag === Tag.Dynamic) return yield* dynamicConstant(vm, t, cls, idx);
  else throw new PendingThrow("java/lang/InternalError", `bad constant tag ${e.tag}`);
  cls.ldc[idx] = v;
  return v;
}

// ldc of a MethodType, MethodHandle or dynamic constant.
export function* resolveConstant(vm: JVM, t: JThread, cls: JClass, idx: number): NativeGen {
  const cp = cls.cf!.cp;
  const e = cp[idx]!;
  const v = yield* constantObject(vm, t, cls, idx);
  if (e.tag === Tag.Dynamic) {
    const desc = utf8(cp, cp[e.b]!.b);
    if (isPrim(desc)) return v === null ? null : vm.getField(v, v.cls.name, "value");
  }
  return v;
}

function* linkGeneral(vm: JVM, t: JThread, cls: JClass, idx: number): NativeGen {
  const cp = cls.cf!.cp;
  const e = cp[idx]!;
  const bsm = cls.cf!.bootstrap[e.a];
  const nat = cp[e.b]!;
  const bsmHandle = yield* constantObject(vm, t, cls, bsm.ref);
  const type = yield* methodType(vm, t, cls.loader, utf8(cp, nat.b));
  const args = yield* staticArgs(vm, t, cls, bsm.args);
  const appendix = vm.newObjectArray("java/lang/Object", [null]);
  const mn: JObject = yield* upcall(vm, t,
    "linkCallSite(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/invoke/MemberName;",
    vm.mirror(cls), bsmHandle, vm.intern(utf8(cp, nat.a)), type, args, appendix);
  return { m: memberTarget(t, mn), appendix: appendix.a[0] as JObject | null };
}

// ---- linking ---------------------------------------------------------------

export function* linkCallSite(vm: JVM, t: JThread, cls: JClass, idx: number): Generator<any, CallSite, any> {
  const cp = cls.cf!.cp;
  const e = cp[idx]!;
  const bsm = cls.cf!.bootstrap[e.a];
  const nat = cp[e.b]!;
  const name = utf8(cp, nat.a), desc = utf8(cp, nat.b);
  const ref = cpArg(cls, bsm.ref) as MethodHandleRef;
  const args = bsm.args.map((a) => cpArg(cls, a));
  let m: JMethod | null = null;
  switch (`${ref.owner}.${ref.name}`) {
    case "java/lang/invoke/LambdaMetafactory.metafactory":
      m = yield* spinLambda(vm, t, cls, name, desc, args, false); break;
    case "java/lang/invoke/LambdaMetafactory.altMetafactory":
      m = yield* spinLambda(vm, t, cls, name, desc, args, true); break;
    case "java/lang/invoke/StringConcatFactory.makeConcatWithConstants":
      m = yield* spinConcat(vm, t, cls, desc, args, true); break;
    case "java/lang/invoke/StringConcatFactory.makeConcat":
      m = yield* spinConcat(vm, t, cls, desc, args, false); break;
    case "java/lang/runtime/ObjectMethods.bootstrap":
      m = yield* spinObjectMethod(vm, t, cls, name, desc, args); break;
    case "java/lang/runtime/SwitchBootstraps.typeSwitch":
    case "java/lang/runtime/SwitchBootstraps.enumSwitch":
      m = yield* spinSwitch(vm, t, cls, name, desc, args); break;
  }
  if (m) return { m };
  return yield* linkGeneral(vm, t, cls, idx);
}

const MH = "java/lang/invoke/MethodHandle";

// invokeBasic and linkTo* are VM intrinsics; invokeExact, invoke and the
// VarHandle access methods are linked to a Java invoker on first use.
export function invokePolymorphic(vm: JVM, t: JThread, f: Frame, m: JMethod): boolean {
  const stack = f.stack;
  switch (m.name) {
    case "invokeBasic": {
      const mh = stack[f.sp - m.argSlots] as JObject | null;
      if (mh === null) throw new PendingThrow("java/lang/NullPointerException");
      const form = vm.getField(mh, MH, "form") as JObject;
      return invoke(t, f, memberTarget(t, vm.getField(form, "java/lang/invoke/LambdaForm", "vmentry")));
    }
    case "linkToStatic": case "linkToSpecial": case "linkToVirtual": case "linkToInterface": {
      let target = memberTarget(t, stack[f.sp - 1]);
      if (m.name === "linkToStatic" && target.cls.state !== INITIALIZED && !vm.initialize(t, target.cls)) return false;
      f.sp--;
      if (m.name === "linkToVirtual" || m.name === "linkToInterface") {
        const recv = stack[f.sp - target.argSlots] as JObject | null;
        if (recv === null) throw new PendingThrow("java/lang/NullPointerException");
        const sel = recv.cls.selectMethod(target.key);
        if (!sel) throw new PendingThrow("java/lang/AbstractMethodError", `${recv.cls.javaName}.${target.name}${target.desc}`);
        target = sel;
      }
      return invoke(t, f, target);
    }
    case "linkToNative":
      throw new PendingThrow("java/lang/UnsupportedOperationException", "native method handles are not supported");
  }
  const link = m.link;
  if (!link) {
    const caller = f.m.cls;
    t.pushNative((function* () {
      const type = yield* methodType(vm, t, caller.loader, m.desc);
      const appendix = vm.newObjectArray("java/lang/Object", [null]);
      const mn: JObject = yield* upcall(vm, t,
        "linkMethod(Ljava/lang/Class;ILjava/lang/Class;Ljava/lang/String;Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/invoke/MemberName;",
        vm.mirror(caller), REF_invokeVirtual, vm.mirror(m.cls), vm.intern(m.name), type, appendix);
      m.link = { m: memberTarget(t, mn), appendix: appendix.a[0] as JObject | null };
    })(), null, "V", true);
    return false;
  }
  if (link.m.argSlots === m.argSlots + 1) stack[f.sp++] = link.appendix;
  return invoke(t, f, link.m);
}
