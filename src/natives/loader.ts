// java.lang.ClassLoader and java.lang.Module natives.

import { INITIALIZED, JArray, JObject } from "../runtime.ts";
import type { JThread, NativeGen } from "../thread.ts";
import { nestHostOf } from "./reflect.ts";
import { jstr, u8 } from "./util.ts";
import type { Natives } from "./util.ts";

const CL = "java/lang/ClassLoader";
const HIDDEN_CLASS = 0x2, NESTMATE_CLASS = 0x1;

function internalName(t: JThread, name: JObject | null): string | null {
  return name === null ? null : jstr(t, name)!.replace(/\./g, "/");
}

function* define(t: JThread, loader: JObject | null, name: JObject | null, bytes: Uint8Array, pd: JObject | null): NativeGen {
  const c = yield* t.vm.defineClassGen(t, loader, bytes, internalName(t, name), pd);
  return t.vm.mirror(c);
}

function defineModule(t: JThread, m: JObject, version: JObject | null, location: JObject | null, pns: JArray) {
  const vm = t.vm;
  const name = jstr(t, vm.getField(m, "java/lang/Module", "name"));
  m.x = { version: jstr(t, version), location: jstr(t, location) };
  const loader = vm.getField(m, "java/lang/Module", "loader") as JObject | null;
  const pkgs = (pns.a as JObject[]).map((p) => vm.jsString(p).replace(/\./g, "/"));
  if (loader === null) {
    if (name) vm.bootModules.set(name, m);
    const set = new Set(pkgs);
    for (const c of [...vm.boot.values(), ...vm.prims.values()]) {
      let e = c;
      while (e.component) e = e.component;
      if (c.mirror && (e.prim ? name === "java.base" : set.has(e.packageName))) vm.setField(c.mirror, "java/lang/Class", "module", m);
    }
  } else {
    const mods = vm.loaderData(loader).modules;
    for (const p of pkgs) mods.set(p, m);
  }
}

export const natives: Natives = {
  "java/lang/Module.defineModule0(Ljava/lang/Module;ZLjava/lang/String;Ljava/lang/String;[Ljava/lang/Object;)V":
    (t, [m, , version, location, pns]) => defineModule(t, m, version, location, pns),
  "java/lang/Module.addReads0(Ljava/lang/Module;Ljava/lang/Module;)V": () => undefined,
  "java/lang/Module.addExports0(Ljava/lang/Module;Ljava/lang/String;Ljava/lang/Module;)V": () => undefined,
  "java/lang/Module.addExportsToAll0(Ljava/lang/Module;Ljava/lang/String;)V": () => undefined,
  "java/lang/Module.addExportsToAllUnnamed0(Ljava/lang/Module;Ljava/lang/String;)V": () => undefined,

  [`${CL}.defineClass1(Ljava/lang/ClassLoader;Ljava/lang/String;[BIILjava/security/ProtectionDomain;Ljava/lang/String;)Ljava/lang/Class;`]:
    (t, [loader, name, b, off, len, pd]) => define(t, loader, name, u8(b, off, len).slice(), pd),
  [`${CL}.defineClass2(Ljava/lang/ClassLoader;Ljava/lang/String;Ljava/nio/ByteBuffer;IILjava/security/ProtectionDomain;Ljava/lang/String;)Ljava/lang/Class;`]:
    (t, [loader, name, buf, off, len, pd]) => {
      const vm = t.vm;
      const hb = vm.getField(buf, "java/nio/ByteBuffer", "hb") as JArray | null;
      let bytes: Uint8Array;
      if (hb) {
        const base = vm.getField(buf, "java/nio/ByteBuffer", "offset") as number;
        bytes = u8(hb, base + off, len).slice();
      } else {
        const addr = Number(vm.getField(buf, "java/nio/Buffer", "address"));
        bytes = vm.mem.u8.slice(addr + off, addr + off + len);
      }
      return define(t, loader, name, bytes, pd);
    },
  [`${CL}.defineClass0(Ljava/lang/ClassLoader;Ljava/lang/Class;Ljava/lang/String;[BIILjava/security/ProtectionDomain;ZILjava/lang/Object;)Ljava/lang/Class;`]:
    function* (t, [loader, lookup, name, b, off, len, pd, init, flags, classData]): NativeGen {
      const vm = t.vm;
      const hidden = (flags & HIDDEN_CLASS) !== 0;
      const c = yield* vm.defineClassGen(t, loader, u8(b, off, len).slice(), internalName(t, name), pd, hidden);
      if (flags & NESTMATE_CLASS) {
        c.nestHost = yield* nestHostOf(t, vm.classOf(lookup));
      }
      const mirror = vm.mirror(c);
      vm.setField(mirror, "java/lang/Class", "classData", classData);
      if (init && c.state !== INITIALIZED) yield* vm.initGen(t, c);
      return mirror;
    },
  [`${CL}.findBootstrapClass(Ljava/lang/String;)Ljava/lang/Class;`]: (t, [name]) => {
    const n = internalName(t, name)!;
    if (n.startsWith("[")) return null;
    const c = t.vm.loadBoot(n);
    return c ? t.vm.mirror(c) : null;
  },
  [`${CL}.findLoadedClass0(Ljava/lang/String;)Ljava/lang/Class;`]: (t, [loader, name]) => {
    const c = t.vm.findLoaded(loader, internalName(t, name)!);
    return c ? t.vm.mirror(c) : null;
  },
  [`${CL}.retrieveDirectives()Ljava/lang/AssertionStatusDirectives;`]: function* (t): NativeGen {
    const vm = t.vm;
    const c = vm.loadBoot("java/lang/AssertionStatusDirectives")!;
    if (c.state !== INITIALIZED) yield* vm.initGen(t, c);
    const o = vm.newObject(c);
    const A = "java/lang/AssertionStatusDirectives";
    const a = vm.opts.assertions;
    const names = (l: [string, boolean][]) => vm.newObjectArray("java/lang/String", l.map(([n]) => vm.str(n)));
    const flags = (l: [string, boolean][]) => {
      const arr = vm.newArray(vm.primClass("Z"), l.length);
      l.forEach(([, on], i) => (arr.a[i] = on ? 1 : 0));
      return arr;
    };
    vm.setField(o, A, "classes", names(a?.classes ?? []));
    vm.setField(o, A, "classEnabled", flags(a?.classes ?? []));
    vm.setField(o, A, "packages", names(a?.packages ?? []));
    vm.setField(o, A, "packageEnabled", flags(a?.packages ?? []));
    vm.setField(o, A, "deflt", a?.user ? 1 : 0);
    return o;
  },
};
