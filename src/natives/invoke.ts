// java.lang.invoke.MethodHandleNatives: MemberName resolution and the VM
// side of method handles. A resolved MemberName keeps its target in x
// ({ m } or { f }); methods also get a ResolvedMethodName holding the JMethod,
// so clones of the MemberName share it as they do in HotSpot.

import { ACC_FINAL, ACC_STATIC, INITIALIZED, JClass, JField, JMethod, JObject, STATIC_OFFSET_BASE } from "../runtime.ts";
import { JThread, PendingThrow } from "../thread.ts";
import type { NativeGen } from "../thread.ts";
import { fieldOf } from "./misc.ts";
import { methodOf } from "./reflect.ts";
import { u16 } from "./util.ts";
import type { Natives } from "./util.ts";
import { utf8 } from "../classfile.ts";

const MN = "java/lang/invoke/MemberName";
const IS_METHOD = 0x10000, IS_CONSTRUCTOR = 0x20000, IS_FIELD = 0x40000;
const CALLER_SENSITIVE = 0x100000, TRUSTED_FINAL = 0x200000;
const KIND_SHIFT = 24;
const REF_getField = 1, REF_getStatic = 2, REF_putField = 3, REF_putStatic = 4;
const REF_invokeVirtual = 5, REF_invokeStatic = 6, REF_invokeSpecial = 7, REF_newInvokeSpecial = 8, REF_invokeInterface = 9;
const METHOD_MODIFIERS = 0x1dff, FIELD_MODIFIERS = 0x50df;

export function memberTarget(t: JThread, mn: JObject): JMethod {
  const m = mn.x?.m ?? (t.vm.getField(mn, MN, "method") as JObject | null)?.x;
  if (!m) throw new PendingThrow("java/lang/InternalError", "unresolved MemberName");
  return m;
}

export function memberField(mn: JObject): JField {
  const f = mn.x?.f;
  if (!f) throw new PendingThrow("java/lang/InternalError", "unresolved field MemberName");
  return f;
}

// Descriptor of a MethodType, Class or String member type.
export function typeDescriptor(t: JThread, type: JObject): string {
  const vm = t.vm;
  if (type.cls.name === "java/lang/String") return vm.jsString(type);
  if (type.cls.name === "java/lang/Class") return vm.classOf(type).desc;
  if (type.cls.name === "java/lang/invoke/MethodType") {
    const r = vm.classOf(vm.getField(type, "java/lang/invoke/MethodType", "rtype"));
    const ps = (vm.getField(type, "java/lang/invoke/MethodType", "ptypes").a as JObject[]).map((p) => vm.classOf(p).desc);
    return `(${ps.join("")})${r.desc}`;
  }
  throw new PendingThrow("java/lang/InternalError", `bad member type ${type.cls.name}`);
}

export function annotationTypes(c: JClass, raw: Uint8Array | undefined): string[] {
  if (!raw) return [];
  const cp = c.cf!.cp;
  const out: string[] = [];
  let p = 0;
  const value = (): void => {
    const tag = String.fromCharCode(raw[p++]);
    if (tag === "e") p += 4;
    else if (tag === "@") annotation();
    else if (tag === "[") for (let n = u16(raw, (p += 2) - 2); n > 0; n--) value();
    else p += 2;
  };
  const annotation = (): string => {
    const type = utf8(cp, u16(raw, p));
    p += 2;
    for (let n = u16(raw, (p += 2) - 2); n > 0; n--) { p += 2; value(); }
    return type;
  };
  for (let n = u16(raw, (p += 2) - 2); n > 0; n--) out.push(annotation());
  return out;
}

export function isCallerSensitive(m: JMethod) {
  return annotationTypes(m.cls, m.attrs.get("RuntimeVisibleAnnotations")).includes("Ljdk/internal/reflect/CallerSensitive;");
}

export function resolvedMethodName(t: JThread, m: JMethod): JObject {
  const vm = t.vm;
  const o = vm.newObject(vm.loadBoot("java/lang/invoke/ResolvedMethodName")!);
  vm.setField(o, "java/lang/invoke/ResolvedMethodName", "vmholder", vm.mirror(m.cls));
  o.x = m;
  return o;
}

export function initMethodMember(t: JThread, mn: JObject, m: JMethod, refKind: number) {
  const vm = t.vm;
  let flags = m.access & METHOD_MODIFIERS;
  let kind: number;
  if (m.name === "<init>") {
    flags |= IS_CONSTRUCTOR;
    kind = REF_invokeSpecial;
  } else {
    flags |= IS_METHOD;
    if (m.isStatic) kind = REF_invokeStatic;
    else if (refKind === REF_invokeSpecial || m.isPrivate) kind = REF_invokeSpecial;
    else if (m.cls.isInterface) kind = REF_invokeInterface;
    // HotSpot binds calls to final methods statically and says so
    else if ((m.access & ACC_FINAL) !== 0 || (m.cls.access & ACC_FINAL) !== 0) kind = REF_invokeSpecial;
    else kind = REF_invokeVirtual;
  }
  if (isCallerSensitive(m)) flags |= CALLER_SENSITIVE;
  vm.setField(mn, MN, "flags", flags | (kind << KIND_SHIFT));
  vm.setField(mn, MN, "clazz", vm.mirror(m.cls));
  vm.setField(mn, MN, "method", resolvedMethodName(t, m));
  mn.x = { m };
}

export function initFieldMember(t: JThread, mn: JObject, f: JField, setter: boolean) {
  const vm = t.vm;
  let flags = (f.access & FIELD_MODIFIERS) | IS_FIELD;
  const isRecord = f.cls.superclass?.name === "java/lang/Record";
  if ((f.access & ACC_FINAL) && ((f.access & ACC_STATIC) || isRecord || f.cls.hidden)) flags |= TRUSTED_FINAL;
  const kind = (f.isStatic ? REF_getStatic : REF_getField) + (setter ? REF_putField - REF_getField : 0);
  vm.setField(mn, MN, "flags", flags | (kind << KIND_SHIFT));
  vm.setField(mn, MN, "clazz", vm.mirror(f.cls));
  mn.x = { f };
}

function findMethodIn(c: JClass, key: string, refKind: number): JMethod | null {
  if (refKind === REF_invokeInterface) return c.findInterfaceMethod(key) ?? c.findMethod(key);
  return c.findMethod(key);
}

function resolve(t: JThread, mn: JObject, speculative: boolean): JObject | null {
  const vm = t.vm;
  const clazz = vm.getField(mn, MN, "clazz") as JObject | null;
  const nameObj = vm.getField(mn, MN, "name") as JObject | null;
  const type = vm.getField(mn, MN, "type") as JObject | null;
  const flags = vm.getField(mn, MN, "flags") as number;
  if (!clazz || !nameObj || !type) throw new PendingThrow("java/lang/IllegalArgumentException", "incomplete MemberName");
  const c = vm.classOf(clazz);
  const name = vm.jsString(nameObj);
  const desc = typeDescriptor(t, type);
  const refKind = (flags >>> KIND_SHIFT) & 0xf;
  if (flags & IS_FIELD) {
    const f = c.findField(name, desc);
    if (!f) {
      if (speculative) return null;
      throw new PendingThrow("java/lang/NoSuchFieldError", name);
    }
    initFieldMember(t, mn, f, refKind === REF_putField || refKind === REF_putStatic);
    return mn;
  }
  let m = findMethodIn(c, name + desc, refKind);
  if (!m && (c.name === "java/lang/invoke/MethodHandle" || c.name === "java/lang/invoke/VarHandle")) {
    m = vm.resolveMethod(c, name, desc);
  }
  if (!m || ((flags & IS_CONSTRUCTOR) && m.cls !== c)) {
    if (speculative) return null;
    throw new PendingThrow("java/lang/NoSuchMethodError", `'${desc}' ${c.javaName}.${name}`);
  }
  initMethodMember(t, mn, m, refKind);
  return mn;
}

export const natives: Natives = {
  "java/lang/invoke/MethodHandleNatives.init(Ljava/lang/invoke/MemberName;Ljava/lang/Object;)V": (t, [mn, ref]) => {
    if (ref.cls.name === "java/lang/reflect/Field") {
      initFieldMember(t, mn, fieldOf(t, ref), false);
    } else {
      initMethodMember(t, mn, methodOf(t, ref), REF_invokeVirtual);
    }
  },
  "java/lang/invoke/MethodHandleNatives.expand(Ljava/lang/invoke/MemberName;)V": (t, [mn]) => {
    const vm = t.vm;
    const x = mn.x;
    if (!x) throw new PendingThrow("java/lang/IllegalArgumentException", "MemberName not resolved");
    const member = x.m ?? x.f;
    if (!vm.getField(mn, MN, "clazz")) vm.setField(mn, MN, "clazz", vm.mirror(member.cls));
    if (!vm.getField(mn, MN, "name")) vm.setField(mn, MN, "name", vm.intern(member.name));
    if (!vm.getField(mn, MN, "type")) vm.setField(mn, MN, "type", vm.intern(member.desc));
  },
  "java/lang/invoke/MethodHandleNatives.resolve(Ljava/lang/invoke/MemberName;Ljava/lang/Class;IZ)Ljava/lang/invoke/MemberName;":
    (t, [mn, , , speculative]) => resolve(t, mn, speculative === 1),
  "java/lang/invoke/MethodHandleNatives.objectFieldOffset(Ljava/lang/invoke/MemberName;)J": (_t, [mn]) => BigInt(memberField(mn).slot),
  "java/lang/invoke/MethodHandleNatives.staticFieldOffset(Ljava/lang/invoke/MemberName;)J": (_t, [mn]) =>
    BigInt(STATIC_OFFSET_BASE + memberField(mn).slot),
  "java/lang/invoke/MethodHandleNatives.staticFieldBase(Ljava/lang/invoke/MemberName;)Ljava/lang/Object;": (t, [mn]) =>
    t.vm.mirror(memberField(mn).cls),
  "java/lang/invoke/MethodHandleNatives.getMemberVMInfo(Ljava/lang/invoke/MemberName;)Ljava/lang/Object;": function* (t, [mn]): NativeGen {
    const vm = t.vm;
    const long = vm.loadBoot("java/lang/Long")!;
    if (long.state !== INITIALIZED) yield* vm.initGen(t, long);
    const isField = !!mn.x?.f;
    // a method reference that dispatches has a vtable index; others none
    const kind = (vm.getField(mn, MN, "flags") >> KIND_SHIFT) & 0xf;
    const index = isField ? BigInt(mn.x.f.slot) : kind === REF_invokeVirtual || kind === REF_invokeInterface ? 0n : -2n;
    const boxed = yield t.call(long.methodMap.get("valueOf(J)Ljava/lang/Long;")!, index);
    return vm.newObjectArray("java/lang/Object", [boxed, isField ? vm.mirror(mn.x.f.cls) : mn]);
  },
  "java/lang/invoke/MethodHandleNatives.setCallSiteTargetNormal(Ljava/lang/invoke/CallSite;Ljava/lang/invoke/MethodHandle;)V":
    (t, [site, target]) => t.vm.setField(site, "java/lang/invoke/CallSite", "target", target),
  "java/lang/invoke/MethodHandleNatives.setCallSiteTargetVolatile(Ljava/lang/invoke/CallSite;Ljava/lang/invoke/MethodHandle;)V":
    (t, [site, target]) => t.vm.setField(site, "java/lang/invoke/CallSite", "target", target),
  "java/lang/invoke/MethodHandleNatives.getNamedCon(I[Ljava/lang/Object;)I": () => 0,
};

export { REF_getField, REF_getStatic, REF_putField, REF_putStatic, REF_invokeVirtual, REF_invokeStatic,
  REF_invokeSpecial, REF_newInvokeSpecial, REF_invokeInterface };
