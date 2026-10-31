// The JDK image as `pnpm build` packages it in dist/, read from disk under
// Node: boot.pack holds the index and the files a typical start reads, and
// every other file is read at its offset in jdk/<module>.jar.

import * as fs from "node:fs";
import * as path from "node:path";
import { addIndex, listIndex, parsePack } from "./browser/http.ts";
import type { Pack } from "./browser/http.ts";
import type { Backend, Stat } from "./fs.ts";

// open module images by host path, shared by every VM in the process
const images = new Map<string, number>();

export class ImageBackend implements Backend {
  readonly writable = false;
  private readonly dir: string;
  private readonly pack: Pack;

  // dir holds boot.pack and jdk/; localeData adds jdk.localedata's files
  constructor(dir: string, localeData = false) {
    this.dir = path.resolve(dir);
    const buf = fs.readFileSync(path.join(this.dir, "boot.pack"));
    this.pack = parsePack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (localeData) addIndex(this.pack, fs.readFileSync(path.join(this.dir, "jdk", "jdk.localedata.txt"), "utf8"));
  }

  stat(p: string): Stat | null {
    const size = this.pack.index!.get(p);
    return size === undefined ? null : { dir: size < 0, size: Math.max(size, 0), mtime: 0 };
  }

  read(p: string): Uint8Array | null {
    const size = this.pack.index!.get(p);
    return size === undefined || size < 0 ? null : this.readRange(p, 0, size);
  }

  readRange(p: string, off: number, len: number): Uint8Array | null {
    const packed = this.pack.files.get(p);
    if (packed) return packed.subarray(off, off + len);
    const at = this.pack.offsets.get(p);
    if (!at) return null;
    const file = path.join(this.dir, "jdk", at.image);
    let fd = images.get(file);
    if (fd === undefined) images.set(file, (fd = fs.openSync(file, "r")));
    const out = new Uint8Array(len);
    let n = 0;
    while (n < len) {
      const got = fs.readSync(fd, out, n, len - n, at.at + off + n);
      if (got === 0) break;
      n += got;
    }
    return n === len ? out : out.subarray(0, n);
  }

  list(p: string): string[] | null {
    return listIndex(this.pack.index!, p);
  }
}
