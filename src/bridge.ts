// JS side of library mode: proxies for Java classes and objects. They talk to
// the VM through a Transport, which is a Worker in the browser and a direct
// call under Node. No DOM and no Node APIs here.
//
//   const ArrayList = await lib.java.util.ArrayList;   class proxy
//   const list = await new ArrayList();                object proxy
//   await list.add("x");                               method call
//   await System.out                                   field read
//   list.y = 5                                         field write
//
// Arrays and boxed numbers are copies: typed arrays for primitive arrays,
// JS arrays for reference arrays, JS numbers for Integer and the like.
// A typed array passed to a call is updated with what Java wrote to it.

import type { FieldRef, Handle, LibraryReply, LibraryRequest } from "./library.ts";

export interface Transport {
  // rejects with an Error that has the Handle of a Java exception as `throwable`
  call(vm: number, req: LibraryRequest): Promise<LibraryReply>;
  release(vm: number, ids: [number, number][]): void;
}

type Target = { obj: number } | { cls: string } | { via: MemberInfo };

interface MemberInfo {
  kind: "member";
  vm: number;
  target: Target;
  name: string;
}

interface ObjectInfo {
  kind: "object";
  vm: number;
  id: number;
  cls: string;
  // handouts of this object that the proxy stands for
  state: { n: number };
}

type Info = MemberInfo | ObjectInfo | { kind: "class"; vm: number; name: string };

const key = (vm: number, id: number) => `${vm}:${id}`;

// What Java wrote to a typed array argument goes back into the caller's array.
// The two are the same kind, except byte[] and boolean[], which both take
// a Uint8Array or an Int8Array.
function copyInto(dst: unknown, src: ArrayBufferView) {
  if (ArrayBuffer.isView(dst) && typeof (dst as { set?: unknown }).set === "function") (dst as unknown as { set(from: ArrayLike<number | bigint>): void }).set(src as unknown as ArrayLike<number>);
}

// Natives may come from another realm (a parent page, with java-web in an
// iframe), where instanceof Promise and instanceof Error are false.
export const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof (v as { then?: unknown } | null)?.then === "function";

export function messageOf(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e);
}

export class Bridge {
  private t: Transport;
  private info = new WeakMap<object, Info>();
  private live = new Map<string, WeakRef<object>>();
  private supers = new Map<string, Set<string>>();
  private classes = new Map<string, any>();
  private roots = new Map<number, any>();
  private registry: FinalizationRegistry<{ vm: number; id: number; state: { n: number } }>;
  private dropped = new Map<number, Map<number, number>>();

  constructor(t: Transport) {
    this.t = t;
    this.registry = new FinalizationRegistry(({ vm, id, state }) => {
      if (this.live.get(key(vm, id))?.deref() === undefined) this.live.delete(key(vm, id));
      if (this.dropped.size === 0) queueMicrotask(() => this.flush());
      let m = this.dropped.get(vm);
      if (!m) this.dropped.set(vm, (m = new Map()));
      m.set(id, (m.get(id) ?? 0) + state.n);
    });
  }

  private flush() {
    const all = this.dropped;
    this.dropped = new Map();
    for (const [vm, m] of all) this.t.release(vm, [...m]);
  }

  // `lib` for a VM: packages and classes by property access.
  root(vm: number): any {
    let r = this.roots.get(vm);
    if (!r) this.roots.set(vm, (r = this.pkg(vm, [])));
    return r;
  }

  // ---- values --------------------------------------------------------------

  decode(vm: number, w: unknown): unknown {
    if (w === null || typeof w !== "object" || ArrayBuffer.isView(w)) return w;
    if (Array.isArray(w)) return w.map((x) => this.decode(vm, x));
    return this.object(vm, w as Handle);
  }

  encode(vm: number, v: unknown): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v !== "object" && typeof v !== "function") return v;
    if (ArrayBuffer.isView(v)) return v;
    if (Array.isArray(v)) return v.map((x) => this.encode(vm, x));
    const i = this.info.get(v);
    if (i && i.kind !== "class") {
      if (i.vm !== vm) throw new Error("that Java value belongs to another VM");
      if (i.kind === "object") return { $java: i.id };
      return this.fieldRef(i);
    }
    throw new TypeError(`cannot pass ${i ? "a class" : typeof v} to Java`);
  }

  private fieldRef(m: MemberInfo): FieldRef {
    const t = m.target;
    return { $get: ["obj" in t ? t.obj : "cls" in t ? t.cls : this.fieldRef(t.via), m.name] };
  }

  private object(vm: number, h: Handle): object {
    const k = key(vm, h.$java);
    if (h.supers) this.supers.set(`${vm}:${h.cls}`, new Set(h.supers));
    const found = this.live.get(k)?.deref();
    if (found) {
      (this.info.get(found) as ObjectInfo).state.n++;
      return found;
    }
    const state = { n: 1 };
    const throwable = h.msg !== undefined;
    const target = throwable ? new Error(h.msg) : {};
    const self: any = new Proxy(target, {
      get: (t, name) => {
        if (name === Symbol.toPrimitive) return () => h.msg ?? `[Java ${h.cls}]`;
        if (typeof name === "symbol" || name === "then") return undefined;
        if (name === "constructor" || (throwable && (name === "message" || name === "stack"))) return Reflect.get(t, name);
        return this.member(vm, { obj: h.$java }, name);
      },
      set: (_, name, value) => {
        if (typeof name === "symbol") return false;
        this.invoke(vm, { op: "set", obj: h.$java, field: name, value: this.encode(vm, value) });
        return true;
      },
    });
    this.info.set(self, { kind: "object", vm, id: h.$java, cls: h.cls, state });
    this.live.set(k, new WeakRef(self));
    this.registry.register(self, { vm, id: h.$java, state });
    return self;
  }

  // Sends a request. args are the caller's arguments, whose typed arrays
  // receive what Java wrote to them.
  private async invoke(vm: number, req: LibraryRequest, args?: unknown[]): Promise<unknown> {
    let reply: LibraryReply;
    try {
      reply = await this.t.call(vm, req);
    } catch (e) {
      const throwable = (e as { throwable?: unknown } | null)?.throwable;
      throw throwable ? this.decode(vm, throwable) : e;
    }
    if (reply.back && args) for (const [i, data] of reply.back) copyInto(args[i], data);
    return this.decode(vm, reply.value);
  }

  private instanceOf(vm: number, name: string, v: unknown): boolean {
    const i = typeof v === "object" && v !== null ? this.info.get(v) : undefined;
    if (!i || i.kind !== "object" || i.vm !== vm) return false;
    return i.cls === name || (this.supers.get(`${vm}:${i.cls}`)?.has(name) ?? false);
  }

  // ---- proxies -------------------------------------------------------------

  // No "then" on a package root or a class, so awaiting one that is not
  // a class does not recurse.
  private pkg(vm: number, path: string[]): any {
    return new Proxy({}, {
      get: (_, name) => {
        if (typeof name !== "string") return undefined;
        if (name !== "then") return this.pkg(vm, [...path, name]);
        if (path.length === 0) return undefined;
        const cls = path.join(".");
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          this.invoke(vm, { op: "class", cls }).then(() => resolve(this.classProxy(vm, cls)), reject);
      },
    });
  }

  private classProxy(vm: number, name: string): any {
    const k = `${vm}:${name}`;
    let c = this.classes.get(k);
    if (c) return c;
    c = new Proxy(function () {}, {
      construct: (_, args) => this.invoke(vm, { op: "new", cls: name, args: args.map((a) => this.encode(vm, a)) }, args) as unknown as object,
      apply: () => { throw new TypeError(`use new ${name}(...) to construct a Java object`); },
      get: (_, prop) => {
        if (prop === Symbol.hasInstance) return (v: unknown) => this.instanceOf(vm, name, v);
        if (typeof prop !== "string" || prop === "then") return undefined;
        return this.member(vm, { cls: name }, prop);
      },
      set: (_, prop, value) => {
        if (typeof prop === "symbol") return false;
        this.invoke(vm, { op: "setStatic", cls: name, field: prop, value: this.encode(vm, value) });
        return true;
      },
    });
    this.info.set(c, { kind: "class", vm, name });
    this.classes.set(k, c);
    return c;
  }

  // A static or instance member. Call it for a method, await it for a field,
  // or take another member of it, as in `System.out.println(x)`.
  private member(vm: number, target: Target, name: string): any {
    const info: MemberInfo = { kind: "member", vm, target, name };
    const self: any = new Proxy(function () {}, {
      apply: (_, __, args) => {
        const encoded = args.map((a) => this.encode(vm, a));
        return this.owner(info).then((o) => this.invoke(vm, "obj" in o
          ? { op: "call", obj: o.obj, method: name, args: encoded }
          : { op: "static", cls: o.cls, method: name, args: encoded }, args));
      },
      get: (fn, prop) => {
        if (prop === Symbol.toPrimitive) return () => { throw new TypeError(`${name} is a Java member: await it to read a field, or call it`); };
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => this.read(info).then(resolve, reject);
        }
        if (prop === "call" || prop === "apply" || prop === "bind") return Reflect.get(fn, prop);
        return this.member(vm, { via: info }, prop);
      },
    });
    this.info.set(self, info);
    return self;
  }

  // The object or class a member belongs to.
  private async owner(m: MemberInfo): Promise<{ obj: number } | { cls: string }> {
    if (!("via" in m.target)) return m.target;
    const o = await this.read(m.target.via);
    const i = typeof o === "object" && o !== null ? this.info.get(o) : undefined;
    if (!i || i.kind !== "object") throw new TypeError(`${m.target.via.name} is not a Java object`);
    return { obj: i.id };
  }

  private async read(m: MemberInfo): Promise<unknown> {
    const o = await this.owner(m);
    return this.invoke(m.vm, "obj" in o ? { op: "get", obj: o.obj, field: m.name } : { op: "getStatic", cls: o.cls, field: m.name });
  }

  // ---- natives -------------------------------------------------------------

  // Runs a JS native for a Java call: the wire arguments become proxies and
  // values, and typed arguments go back so Java sees what the native wrote.
  native(vm: number, fn: (lib: object, ...args: any[]) => unknown, wire: unknown[]): NativeReply | Promise<NativeReply> {
    const args = wire.map((w) => this.decode(vm, w));
    const finish = (r: unknown): NativeReply => {
      const back = args.map((a) => (ArrayBuffer.isView(a) ? a : null));
      return { value: this.encode(vm, r), back: back.some(Boolean) ? back : undefined };
    };
    const r = fn(this.root(vm), ...args);
    return isThenable(r) ? Promise.resolve(r).then(finish) : finish(r);
  }
}

export interface NativeReply {
  value: unknown;
  back?: (ArrayBufferView | null)[];
}

// The natives a System.loadLibrary module exports: its default export, or the module itself.
export function nativeTable(mod: any): Record<string, (...args: any[]) => unknown> {
  const table = mod?.default ?? mod;
  if (table === null || typeof table !== "object") throw new Error("the module must export an object of native functions");
  for (const [k, v] of Object.entries(table)) if (typeof v !== "function") throw new Error(`native ${k} is not a function`);
  return table;
}
