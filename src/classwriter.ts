// Minimal class file writer for classes the VM generates (lambda proxies,
// string concatenation, record methods). No stack maps: the VM does not
// verify bytecode.

import { encodeMutf8, Tag } from "./classfile.ts";
import { isWide, parseMethodDesc } from "./runtime.ts";

class Bytes {
  b: number[] = [];
  u1(v: number) { this.b.push(v & 0xff); }
  u2(v: number) { this.b.push((v >> 8) & 0xff, v & 0xff); }
  u4(v: number) { this.u2(v >>> 16); this.u2(v & 0xffff); }
  raw(a: ArrayLike<number>) { for (let i = 0; i < a.length; i++) this.b.push(a[i]); }
}

export class Code {
  readonly w: ClassWriter;
  readonly out = new Bytes();
  maxStack = 16;
  maxLocals: number;
  private fixups: { at: number; from: number; label: Label }[] = [];
  constructor(w: ClassWriter, maxLocals: number) {
    this.w = w;
    this.maxLocals = maxLocals;
  }
  get pc() { return this.out.b.length; }
  op(...ops: number[]) { for (const o of ops) this.out.u1(o); return this; }
  u2op(op: number, v: number) { this.out.u1(op); this.out.u2(v); return this; }

  iconst(v: number) {
    if (v >= -1 && v <= 5) return this.op(0x03 + v);
    if (v >= -128 && v <= 127) return this.op(0x10, v);
    if (v >= -32768 && v <= 32767) return this.op(0x11, (v >> 8) & 0xff, v);
    return this.ldc(this.w.int(v));
  }
  ldc(idx: number) {
    return idx < 256 ? this.op(0x12, idx) : this.u2op(0x13, idx);
  }
  ldcString(s: string) { return this.ldc(this.w.string(s)); }
  ldc2(idx: number) { return this.u2op(0x14, idx); }

  // load / store by descriptor kind
  load(desc: string, slot: number) {
    return this.local([0x15, 0x16, 0x17, 0x18, 0x19], desc, slot);
  }
  store(desc: string, slot: number) {
    return this.local([0x36, 0x37, 0x38, 0x39, 0x3a], desc, slot);
  }
  private local(ops: number[], desc: string, slot: number) {
    const k = kindIndex(desc);
    if (slot < 256) return this.op(ops[k], slot);
    return this.op(0xc4, ops[k], (slot >> 8) & 0xff, slot);
  }
  ret(desc: string) {
    if (desc === "V") return this.op(0xb1);
    return this.op([0xac, 0xad, 0xae, 0xaf, 0xb0][kindIndex(desc)]);
  }

  getfield(owner: string, name: string, desc: string) { return this.u2op(0xb4, this.w.field(owner, name, desc)); }
  putfield(owner: string, name: string, desc: string) { return this.u2op(0xb5, this.w.field(owner, name, desc)); }
  getstatic(owner: string, name: string, desc: string) { return this.u2op(0xb2, this.w.field(owner, name, desc)); }
  putstatic(owner: string, name: string, desc: string) { return this.u2op(0xb3, this.w.field(owner, name, desc)); }
  invokevirtual(owner: string, name: string, desc: string) { return this.u2op(0xb6, this.w.method(owner, name, desc, false)); }
  invokespecial(owner: string, name: string, desc: string, iface = false) {
    return this.u2op(0xb7, this.w.method(owner, name, desc, iface));
  }
  invokestatic(owner: string, name: string, desc: string, iface = false) {
    return this.u2op(0xb8, this.w.method(owner, name, desc, iface));
  }
  invokeinterface(owner: string, name: string, desc: string) {
    const { params } = parseMethodDesc(desc);
    let n = 1;
    for (const p of params) n += isWide(p) ? 2 : 1;
    this.u2op(0xb9, this.w.method(owner, name, desc, true));
    return this.op(n, 0);
  }
  anew(cls: string) { return this.u2op(0xbb, this.w.cls(cls)); }
  checkcast(cls: string) { return this.u2op(0xc0, this.w.cls(cls)); }
  instanceOf(cls: string) { return this.u2op(0xc1, this.w.cls(cls)); }

  label(): Label { return new Label(); }
  bind(l: Label) { l.pc = this.pc; return this; }
  // branch opcodes with a 16-bit offset
  jump(op: number, l: Label) {
    const from = this.pc;
    this.op(op);
    this.fixups.push({ at: this.pc, from, label: l });
    this.out.u2(0);
    return this;
  }

  finish(): number[] {
    for (const f of this.fixups) {
      const off = f.label.pc - f.from;
      this.out.b[f.at] = (off >> 8) & 0xff;
      this.out.b[f.at + 1] = off & 0xff;
    }
    return this.out.b;
  }
}

export class Label {
  pc = -1;
}

function kindIndex(desc: string) {
  switch (desc[0]) {
    case "J": return 1;
    case "F": return 2;
    case "D": return 3;
    case "L": case "[": return 4;
    default: return 0;
  }
}

interface Member {
  access: number;
  name: string;
  desc: string;
  code?: Code;
}

export class ClassWriter {
  private pool = new Bytes();
  private count = 1;
  private keys = new Map<string, number>();
  readonly name: string;
  private access: number;
  private superName: string;
  private interfaces: string[];
  private fields: Member[] = [];
  private methods: Member[] = [];
  private attrs: [string, number[]][] = [];

  constructor(access: number, name: string, superName: string, interfaces: string[] = []) {
    this.access = access;
    this.name = name;
    this.superName = superName;
    this.interfaces = interfaces;
  }

  private entry(key: string, write: (b: Bytes) => void, slots = 1): number {
    const found = this.keys.get(key);
    if (found !== undefined) return found;
    const idx = this.count;
    write(this.pool);
    this.count += slots;
    this.keys.set(key, idx);
    return idx;
  }

  utf8(s: string) {
    return this.entry("U" + s, (b) => {
      const bytes = encodeMutf8(s);
      b.u1(Tag.Utf8);
      b.u2(bytes.length);
      b.raw(bytes);
    });
  }
  cls(name: string) {
    const u = this.utf8(name);
    return this.entry("C" + name, (b) => { b.u1(Tag.Class); b.u2(u); });
  }
  string(s: string) {
    const u = this.utf8(s);
    return this.entry("S" + s, (b) => { b.u1(Tag.String); b.u2(u); });
  }
  int(v: number) {
    return this.entry("I" + v, (b) => { b.u1(Tag.Integer); b.u4(v); });
  }
  float(v: number) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v);
    return this.entry("F" + dv.getUint32(0), (b) => { b.u1(Tag.Float); b.u4(dv.getUint32(0)); });
  }
  long(v: bigint) {
    return this.entry("J" + v, (b) => {
      b.u1(Tag.Long);
      b.u4(Number(BigInt.asUintN(64, v) >> 32n));
      b.u4(Number(BigInt.asUintN(32, v)));
    }, 2);
  }
  double(v: number) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v);
    return this.entry("D" + dv.getBigUint64(0), (b) => {
      b.u1(Tag.Double);
      b.u4(dv.getUint32(0));
      b.u4(dv.getUint32(4));
    }, 2);
  }
  nat(name: string, desc: string) {
    const n = this.utf8(name), d = this.utf8(desc);
    return this.entry(`N${name}:${desc}`, (b) => { b.u1(Tag.NameAndType); b.u2(n); b.u2(d); });
  }
  field(owner: string, name: string, desc: string) {
    const c = this.cls(owner), nt = this.nat(name, desc);
    return this.entry(`f${owner}.${name}:${desc}`, (b) => { b.u1(Tag.Fieldref); b.u2(c); b.u2(nt); });
  }
  method(owner: string, name: string, desc: string, iface: boolean) {
    const c = this.cls(owner), nt = this.nat(name, desc);
    const tag = iface ? Tag.InterfaceMethodref : Tag.Methodref;
    return this.entry(`m${tag}${owner}.${name}:${desc}`, (b) => { b.u1(tag); b.u2(c); b.u2(nt); });
  }

  addField(access: number, name: string, desc: string) {
    this.fields.push({ access, name, desc });
  }

  addMethod(access: number, name: string, desc: string): Code {
    const { params } = parseMethodDesc(desc);
    let locals = access & 0x0008 ? 0 : 1;
    for (const p of params) locals += isWide(p) ? 2 : 1;
    const code = new Code(this, locals + 4);
    this.methods.push({ access, name, desc, code });
    return code;
  }

  addAttribute(name: string, body: number[]) {
    this.attrs.push([name, body]);
  }

  toBytes(): Uint8Array {
    const thisIdx = this.cls(this.name), superIdx = this.cls(this.superName);
    const ifaces = this.interfaces.map((i) => this.cls(i));
    const members = (list: Member[]) => {
      const b = new Bytes();
      b.u2(list.length);
      for (const m of list) {
        b.u2(m.access);
        b.u2(this.utf8(m.name));
        b.u2(this.utf8(m.desc));
        if (!m.code) { b.u2(0); continue; }
        const body = m.code.finish();
        b.u2(1);
        b.u2(this.utf8("Code"));
        b.u4(12 + body.length);
        b.u2(m.code.maxStack);
        b.u2(m.code.maxLocals);
        b.u4(body.length);
        b.raw(body);
        b.u2(0);
        b.u2(0);
      }
      return b.b;
    };
    const fields = members(this.fields), methods = members(this.methods);
    const attrNames = this.attrs.map(([n]) => this.utf8(n));
    const out = new Bytes();
    out.u4(0xcafebabe);
    out.u2(0);
    out.u2(52);
    out.u2(this.count);
    out.raw(this.pool.b);
    out.u2(this.access);
    out.u2(thisIdx);
    out.u2(superIdx);
    out.u2(ifaces.length);
    for (const i of ifaces) out.u2(i);
    out.raw(fields);
    out.raw(methods);
    out.u2(this.attrs.length);
    this.attrs.forEach(([, body], i) => {
      out.u2(attrNames[i]);
      out.u4(body.length);
      out.raw(body);
    });
    return Uint8Array.from(out.b);
  }
}
