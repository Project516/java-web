// Class file parser (JVMS chapter 4), up to class file version 69 (Java 25).

export const Tag = {
  Utf8: 1, Integer: 3, Float: 4, Long: 5, Double: 6, Class: 7, String: 8,
  Fieldref: 9, Methodref: 10, InterfaceMethodref: 11, NameAndType: 12,
  MethodHandle: 15, MethodType: 16, Dynamic: 17, InvokeDynamic: 18,
  Module: 19, Package: 20,
} as const;

// a and b are constant pool indexes, except a is the reference kind for
// MethodHandle and the bootstrap method index for (Invoke)Dynamic.
export interface CpEntry {
  tag: number;
  value?: string | number | bigint;
  a: number;
  b: number;
}

// Numeric values live in values. Other entries keep a and b as two u16 in one
// word of ab. A Utf8 entry keeps the offset of its bytes in ab, and its string
// in values once something asks for it.
export interface ConstantPool {
  length: number;
  values: (string | number | bigint | undefined)[];
  tags: Uint8Array;
  ab: Uint32Array;
  bytes: Uint8Array;
}

export interface ExceptionEntry {
  start: number;
  end: number;
  handler: number;
  catchType: number;
}

export class Code {
  readonly maxStack: number;
  readonly maxLocals: number;
  readonly code: Uint8Array;
  readonly handlers: ExceptionEntry[];
  // raw LocalVariableTable attribute body, parsed on demand
  readonly localVars: Uint8Array | null;
  private rawLines: Uint8Array[] | null;
  private parsedLines: number[] | null | undefined;
  constructor(maxStack: number, maxLocals: number, code: Uint8Array, handlers: ExceptionEntry[], rawLines: Uint8Array[] | null, localVars: Uint8Array | null) {
    this.maxStack = maxStack;
    this.maxLocals = maxLocals;
    this.code = code;
    this.handlers = handlers;
    this.rawLines = rawLines;
    this.localVars = localVars;
  }
  // pairs of (start pc, line), sorted by pc
  get lines(): number[] | null {
    if (this.parsedLines !== undefined) return this.parsedLines;
    let lines: number[] | null = null;
    for (const body of this.rawLines ?? []) {
      const lr = new Reader(body);
      lines ??= [];
      for (let n = lr.u2(); n > 0; n--) lines.push(lr.u2(), lr.u2());
    }
    this.rawLines = null;
    if (lines && lines.length > 2) {
      let sorted = true;
      for (let i = 2; i < lines.length; i += 2) if (lines[i] < lines[i - 2]) { sorted = false; break; }
      if (!sorted) {
        const pairs: [number, number][] = [];
        for (let i = 0; i < lines.length; i += 2) pairs.push([lines[i], lines[i + 1]]);
        pairs.sort((a, b) => a[0] - b[0]);
        lines = pairs.flat();
      }
    }
    return this.parsedLines = lines;
  }
}

export interface Member {
  access: number;
  name: string;
  desc: string;
  attrs: Map<string, Uint8Array>;
  code: Code | null;
}

export interface BootstrapMethod {
  ref: number;
  args: number[];
}

export interface ClassFile {
  // a hidden class defined under another name: the name in its own bytes
  renamedFrom?: string;
  minor: number;
  major: number;
  cp: ConstantPool;
  access: number;
  name: string;
  superName: string | null;
  interfaces: string[];
  fields: Member[];
  methods: Member[];
  attrs: Map<string, Uint8Array>;
  bootstrap: BootstrapMethod[];
}

export class ClassFormatError extends Error {}

// A version this VM does not run; the loader words the message, since only
// it knows the class name.
export class UnsupportedVersion extends Error {
  readonly major: number;
  readonly minor: number;
  constructor(major: number, minor: number) {
    super(`class file version ${major}.${minor}`);
    this.major = major;
    this.minor = minor;
  }
}

export class BadMagic extends ClassFormatError {
  readonly magic: number;
  constructor(magic: number) {
    super("Incompatible magic value");
    this.magic = magic;
  }
}

export const MAX_MAJOR = 69;

export class Reader {
  pos = 0;
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u1() { return this.bytes[this.pos++]; }
  u2() { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  u4() { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  i4() { const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  slice(n: number) {
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
}

export function decodeMutf8(b: Uint8Array): string {
  let ascii = true;
  for (let i = 0; i < b.length; i++) if (b[i] & 0x80) { ascii = false; break; }
  if (ascii) return String.fromCharCode.apply(null, b as unknown as number[]);
  const out: number[] = [];
  for (let i = 0; i < b.length;) {
    const x = b[i++];
    if (x < 0x80) out.push(x);
    else if ((x & 0xe0) === 0xc0) out.push(((x & 0x1f) << 6) | (b[i++] & 0x3f));
    else {
      const y = b[i++], z = b[i++];
      out.push(((x & 0x0f) << 12) | ((y & 0x3f) << 6) | (z & 0x3f));
    }
  }
  let s = "";
  for (let i = 0; i < out.length; i += 8192) s += String.fromCharCode.apply(null, out.slice(i, i + 8192));
  return s;
}

export function encodeMutf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 1 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

const NO_ATTRS = new Map<string, Uint8Array>();

function readMember(r: Reader, cp: ClassFile["cp"]): Member {
  const access = r.u2();
  const name = utf8(cp, r.u2());
  const desc = utf8(cp, r.u2());
  let attrs = NO_ATTRS;
  let code: Code | null = null;
  for (let n = r.u2(); n > 0; n--) {
    const attr = utf8(cp, r.u2());
    const length = r.u4();
    if (attr === "Code") {
      const end = r.pos + length;
      code = readCode(r, cp);
      r.pos = end;
    } else {
      if (attrs === NO_ATTRS) attrs = new Map();
      attrs.set(attr, r.slice(length));
    }
  }
  return { access, name, desc, attrs, code };
}

function readAttrs(r: Reader, cp: ClassFile["cp"]) {
  const attrs = new Map<string, Uint8Array>();
  for (let n = r.u2(); n > 0; n--) {
    const name = utf8(cp, r.u2());
    attrs.set(name, r.slice(r.u4()));
  }
  return attrs;
}

function readCode(r: Reader, cp: ClassFile["cp"]): Code {
  const maxStack = r.u2();
  const maxLocals = r.u2();
  const code = r.slice(r.u4());
  const handlers: ExceptionEntry[] = [];
  for (let n = r.u2(); n > 0; n--) {
    handlers.push({ start: r.u2(), end: r.u2(), handler: r.u2(), catchType: r.u2() });
  }
  let lines: Uint8Array[] | null = null;
  let localVars: Uint8Array | null = null;
  for (let n = r.u2(); n > 0; n--) {
    const name = utf8(cp, r.u2());
    const body = r.slice(r.u4());
    if (name === "LocalVariableTable") localVars = body;
    else if (name === "LineNumberTable") (lines ??= []).push(body);
  }
  return new Code(maxStack, maxLocals, code, handlers, lines, localVars);
}

export function cpEntry(cp: ClassFile["cp"], i: number): CpEntry | undefined {
  const tag = cp.tags[i];
  if (!tag) return undefined;
  if (tag === Tag.Utf8) return { tag, value: utf8(cp, i), a: 0, b: 0 };
  return { tag, value: cp.values[i], a: cp.ab[i] >>> 16, b: cp.ab[i] & 0xffff };
}

export function cpTag(cp: ClassFile["cp"], i: number): number { return cp.tags[i]; }
export function cpA(cp: ClassFile["cp"], i: number): number { return cp.ab[i] >>> 16; }
export function cpB(cp: ClassFile["cp"], i: number): number { return cp.ab[i] & 0xffff; }
export function cpValue(cp: ClassFile["cp"], i: number): number | bigint | undefined { return cp.values[i] as number | bigint | undefined; }

export function utf8(cp: ClassFile["cp"], i: number): string {
  const s = cp.values[i];
  if (typeof s === "string") return s;
  if (cp.tags[i] !== Tag.Utf8) throw new ClassFormatError(`bad utf8 index ${i}`);
  const at = cp.ab[i], b = cp.bytes;
  return cp.values[i] = decodeMutf8(b.subarray(at + 2, at + 2 + ((b[at] << 8) | b[at + 1])));
}

export function className(cp: ClassFile["cp"], i: number): string {
  if (cp.tags[i] !== Tag.Class) throw new ClassFormatError(`bad class index ${i}`);
  return utf8(cp, cp.ab[i] >>> 16);
}

export function parseClass(bytes: Uint8Array, preview = false): ClassFile {
  const r = new Reader(bytes);
  try {
    const cf = parseBody(r, preview);
    if (r.pos > bytes.length) throw new RangeError();
    if (r.pos < bytes.length) throw new ClassFormatError(`Extra bytes at the end of class file ${cf.name}`);
    return cf;
  } catch (e) {
    if (e instanceof RangeError) throw new ClassFormatError("Truncated class file");
    throw e;
  }
}

function parseBody(r: Reader, preview: boolean): ClassFile {
  const magic = r.u4();
  if (magic !== 0xcafebabe) throw new BadMagic(magic);
  const minor = r.u2();
  const major = r.u2();
  // JVMS 4.1: from version 56 on, minor is 0, or 65535 for preview features of this release
  if (major < 45 || major > MAX_MAJOR) throw new UnsupportedVersion(major, minor);
  if (major >= 56 && minor !== 0 && !(minor === 0xffff && major === MAX_MAJOR && preview)) throw new UnsupportedVersion(major, minor);
  const count = r.u2();
  const cp: ClassFile["cp"] = {
    length: count,
    values: new Array(count),
    tags: new Uint8Array(count),
    ab: new Uint32Array(count),
    bytes: r.bytes,
  };
  for (let i = 1; i < count; i++) {
    const tag = r.u1();
    let value: CpEntry["value"], a = 0, b = 0, start = 0;
    switch (tag) {
      case Tag.Utf8: start = r.pos; r.pos += 2 + r.view.getUint16(r.pos); break;
      case Tag.Integer: value = r.i4(); break;
      case Tag.Float: value = r.view.getFloat32(r.pos); r.pos += 4; break;
      case Tag.Long: value = r.view.getBigInt64(r.pos); r.pos += 8; break;
      case Tag.Double: value = r.view.getFloat64(r.pos); r.pos += 8; break;
      case Tag.Class: case Tag.String: case Tag.MethodType: case Tag.Module: case Tag.Package:
        a = r.u2(); break;
      case Tag.MethodHandle: a = r.u1(); b = r.u2(); break;
      case Tag.Fieldref: case Tag.Methodref: case Tag.InterfaceMethodref: case Tag.NameAndType:
      case Tag.Dynamic: case Tag.InvokeDynamic:
        a = r.u2(); b = r.u2(); break;
      default: throw new ClassFormatError(`bad constant pool tag ${tag} at ${i}`);
    }
    cp.tags[i] = tag;
    if (value !== undefined) cp.values[i] = value;
    cp.ab[i] = tag === Tag.Utf8 ? start : a << 16 | b;
    if (tag === Tag.Long || tag === Tag.Double) i++;
  }
  const access = r.u2();
  const name = className(cp, r.u2());
  const superIndex = r.u2();
  const superName = superIndex ? className(cp, superIndex) : null;
  const interfaces: string[] = [];
  for (let n = r.u2(); n > 0; n--) interfaces.push(className(cp, r.u2()));
  const fields: Member[] = [];
  for (let n = r.u2(); n > 0; n--) fields.push(readMember(r, cp));
  const methods: Member[] = [];
  for (let n = r.u2(); n > 0; n--) methods.push(readMember(r, cp));
  const attrs = readAttrs(r, cp);
  const bootstrap: BootstrapMethod[] = [];
  const bsm = attrs.get("BootstrapMethods");
  if (bsm) {
    const br = new Reader(bsm);
    for (let n = br.u2(); n > 0; n--) {
      const ref = br.u2();
      const args: number[] = [];
      for (let k = br.u2(); k > 0; k--) args.push(br.u2());
      bootstrap.push({ ref, args });
    }
  }
  return { minor, major, cp, access, name, superName, interfaces, fields, methods, attrs, bootstrap };
}
