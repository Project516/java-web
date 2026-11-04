import type { VFS } from "./fs.ts";

// Uncompressed jlink image. Only the index is kept in memory.
export class JImage {
  private readonly index: Uint8Array;
  private readonly view: DataView;
  private readonly count: number;
  private readonly locations: number;
  private readonly strings: number;

  private readonly fs: VFS;
  private readonly path: string;

  constructor(fs: VFS, path: string) {
    this.fs = fs;
    this.path = path;
    const header = fs.readRange(path, 0, 28);
    if (!header || header.length !== 28) throw new Error(`cannot read image header: ${path}`);
    const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (h.getUint32(0, true) !== 0xcafedada || h.getUint32(4, true) !== 0x10000) throw new Error(`invalid image: ${path}`);
    this.count = h.getUint32(16, true);
    this.locations = 28 + this.count * 8;
    this.strings = this.locations + h.getUint32(20, true);
    const size = this.strings + h.getUint32(24, true);
    const index = fs.readRange(path, 0, size);
    if (!index || index.length !== size) throw new Error(`cannot read image index: ${path}`);
    this.index = index;
    this.view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  }

  read(module: string, name: string): Uint8Array | null {
    const full = `/${module}/${name}`;
    const hash = (seed: number) => {
      for (let i = 0; i < full.length; i++) {
        const c = full.charCodeAt(i);
        const bytes = c === 0 ? [0xc0, 0x80] : c < 0x80 ? [c] : c < 0x800 ? [0xc0 | (c >> 6), 0x80 | (c & 63)] : [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
        for (const b of bytes) seed = Math.imul(seed, 0x01000193) ^ b;
      }
      return (seed & 0x7fffffff) % this.count;
    };
    const redirect = this.view.getInt32(28 + hash(0x01000193) * 4, true);
    if (!redirect) return null;
    const slot = redirect < 0 ? -redirect - 1 : hash(redirect);
    let p = this.locations + this.view.getUint32(28 + this.count * 4 + slot * 4, true);
    const attrs = Array<number>(8).fill(0);
    while (this.index[p] > 7) {
      const b = this.index[p++];
      let value = 0;
      for (let n = (b & 7) + 1; n > 0; n--) value = value * 256 + this.index[p++];
      attrs[b >> 3] = value;
    }
    const str = (off: number) => {
      if (!off) return "";
      const start = this.strings + off;
      let value = "";
      for (let i = start; this.index[i]; i++) {
        const b = this.index[i];
        if (b < 0x80) value += String.fromCharCode(b);
        else if (b < 0xe0) value += String.fromCharCode(((b & 31) << 6) | (this.index[++i] & 63));
        else value += String.fromCharCode(((b & 15) << 12) | ((this.index[++i] & 63) << 6) | (this.index[++i] & 63));
      }
      return value;
    };
    const actual = `/${str(attrs[1])}/${attrs[2] ? str(attrs[2]) + "/" : ""}${str(attrs[3])}${attrs[4] ? "." + str(attrs[4]) : ""}`;
    if (actual !== full) return null;
    if (attrs[6]) throw new Error("compressed jimage resource");
    return this.fs.readRange(this.path, this.index.length + attrs[5], attrs[7]);
  }
}
