// The JDK image as `pnpm build` packages it in dist/, read from disk under
// Node: boot.pack holds the index and the files and image ranges a typical
// start reads, and the rest is read at its offset in jdk/image.jar.

import * as fs from "node:fs";
import * as path from "node:path";
import { listIndex, packedRange, parsePack } from "./browser/http.ts";
import type { Pack } from "./browser/http.ts";
import type { Backend, Stat } from "./fs.ts";

// The JDK image is read for every boot class, by every VM in the process, so
// each image file stays open once opened.
const imageFds = new Map<string, number>();
export function imageFd(file: string): number {
  let fd = imageFds.get(file);
  if (fd === undefined) imageFds.set(file, (fd = fs.openSync(file, "r")));
  return fd;
}

export class ImageBackend implements Backend {
  readonly writable = false;
  private readonly dir: string;
  private readonly pack: Pack;

  // dir holds boot.pack and jdk/
  constructor(dir: string) {
    this.dir = path.resolve(dir);
    if (!fs.existsSync(path.join(this.dir, "jdk", "image.jar"))) {
      throw new Error(`no packaged JDK image in ${this.dir}: boot.pack needs jdk/ next to it`);
    }
    const buf = fs.readFileSync(path.join(this.dir, "boot.pack"));
    this.pack = parsePack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
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
    const size = this.pack.index!.get(p);
    if (size === undefined || size < 0) return null;
    len = Math.max(0, Math.min(len, size - off));
    const packed = this.pack.files.get(p);
    if (packed) return packed.subarray(off, off + len);
    const part = packedRange(this.pack, p, off, len);
    if (part) return part;
    const at = this.pack.offsets.get(p);
    if (!at) return null;
    const out = new Uint8Array(len);
    let n = 0;
    try {
      const fd = imageFd(path.join(this.dir, "jdk", at.image));
      while (n < len) {
        const got = fs.readSync(fd, out, n, len - n, at.at + off + n);
        if (got === 0) break;
        n += got;
      }
    } catch {
      return null;
    }
    // a short or unreadable image is damaged; the file reads as missing rather than cut off
    return n === len ? out : null;
  }

  list(p: string): string[] | null {
    return listIndex(this.pack.index!, p);
  }
}
