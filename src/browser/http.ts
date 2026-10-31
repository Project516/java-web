// Read-only VFS backend over HTTP for use inside a Web Worker, where
// synchronous XHR is allowed. An optional index (from the boot pack) answers
// stat/list without requests, and preloaded file contents skip the network.

import type { Backend, Stat } from "../fs.ts";

export interface Pack {
  files: Map<string, Uint8Array>;
  // path -> size, or -1 for directories
  index: Map<string, number> | null;
  // path -> name of the lazily fetched pack that holds it
  lazy: Map<string, string>;
  // path -> the image file holding it and its offset there
  offsets: Map<string, { image: string; at: number }>;
}

// Pack layout: repeated [u16 path length][path][u32 size][bytes]. In the boot
// pack, a file named "/index.txt" holds "d path" and "f path size
// [image:offset] [pack]" lines. A file with an offset is read in ranges from
// <image>.jar, one per module; a named pack is <name>.pack next to it and is
// fetched whole the first time one of its files is read. Images are .jar
// files because static hosts such as GitHub Pages compress other types and
// then apply Range to the compressed bytes; they leave .jar alone.
export function parsePack(buf: ArrayBuffer): Pack {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const dec = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let p = 0; p < buf.byteLength;) {
    const n = dv.getUint16(p);
    const path = dec.decode(u8.subarray(p + 2, p + 2 + n));
    p += 2 + n;
    const size = dv.getUint32(p);
    files.set(path, u8.subarray(p + 4, p + 4 + size));
    p += 4 + size;
  }
  const pack: Pack = { files, index: null, lazy: new Map(), offsets: new Map() };
  const raw = files.get("/index.txt");
  if (raw) {
    pack.index = new Map([["/", -1]]);
    addIndex(pack, dec.decode(raw));
    files.delete("/index.txt");
  }
  return pack;
}

// Adds index lines, as in /index.txt, to a pack that has an index.
export function addIndex(pack: Pack, text: string) {
  for (const line of text.split("\n")) {
    const [kind, path, size, ...rest] = line.split(" ");
    if (kind === "d") pack.index!.set(path, -1);
    else if (kind === "f") {
      pack.index!.set(path, Number(size));
      const at = rest[0] === undefined ? null : /^([^:]+):(\d+)$/.exec(rest[0]);
      if (at) {
        pack.offsets.set(path, { image: `/${at[1]}.jar`, at: Number(at[2]) });
        rest.shift();
      }
      if (rest[0]) pack.lazy.set(path, rest[0]);
    }
  }
}

const BLOCK = 64 << 10;

function compressed(xhr: XMLHttpRequest): boolean {
  const enc = xhr.getResponseHeader("Content-Encoding");
  return !!enc && enc !== "identity";
}

// Whether a 206 holds exactly the bytes asked for. Headers a cross-origin
// server does not expose read as null and are not checked.
function rangeOk(xhr: XMLHttpRequest, start: number, got: number): boolean {
  if (compressed(xhr)) return false;
  const range = xhr.getResponseHeader("Content-Range");
  if (range === null) return true;
  const m = /^bytes (\d+)-(\d+)\//.exec(range);
  return m !== null && Number(m[1]) === start && Number(m[2]) - start + 1 === got;
}

export class HttpBackend implements Backend {
  readonly writable = false;
  private readonly base: string;
  private readonly pack: Pack;
  private cache = new Map<string, Uint8Array | null>();
  private stats = new Map<string, Stat | null>();

  private fetchedPacks = new Set<string>();
  // 64 KB blocks of files read in parts, by path
  private blocks = new Map<string, Map<number, Uint8Array>>();

  constructor(base: string, pack: Pack = { files: new Map(), index: null, lazy: new Map(), offsets: new Map() }) {
    this.base = base.endsWith("/") ? base.slice(0, -1) : base;
    this.pack = pack;
  }

  private request(method: string, path: string): XMLHttpRequest | null {
    const xhr = new XMLHttpRequest();
    xhr.open(method, this.base + encodeURI(path), false);
    if (method === "GET") xhr.responseType = "arraybuffer";
    try {
      xhr.send();
    } catch {
      return null;
    }
    return xhr.status === 200 ? xhr : null;
  }

  stat(path: string): Stat | null {
    const idx = this.pack.index;
    if (idx) {
      const size = idx.get(path);
      return size === undefined ? null : { dir: size < 0, size: Math.max(size, 0), mtime: 0 };
    }
    if (path === "/") return { dir: true, size: 0, mtime: 0 };
    if (this.stats.has(path)) return this.stats.get(path)!;
    const known = this.cache.get(path);
    let st: Stat | null = null;
    if (known) st = { dir: false, size: known.length, mtime: 0 };
    else {
      // HTTP cannot tell us about directories. An extensionless path that is
      // missing, or answered with an HTML page (a server's directory index),
      // is taken to be one, so class folders work on the classpath.
      const xhr = this.request("HEAD", path);
      const bare = !path.slice(path.lastIndexOf("/") + 1).includes(".");
      if (bare && (!xhr || xhr.getResponseHeader("Content-Type")?.startsWith("text/html"))) st = { dir: true, size: 0, mtime: 0 };
      else if (xhr && compressed(xhr)) {
        // the length is of the compressed body, so read the file to size it
        const data = this.read(path);
        if (data) st = { dir: false, size: data.length, mtime: 0 };
      } else if (xhr) st = { dir: false, size: Number(xhr.getResponseHeader("Content-Length") ?? 0), mtime: 0 };
    }
    this.stats.set(path, st);
    return st;
  }

  read(path: string): Uint8Array | null {
    const packed = this.pack.files.get(path);
    if (packed) return packed;
    const name = this.pack.lazy.get(path);
    if (name !== undefined && !this.fetchedPacks.has(name)) {
      this.fetchedPacks.add(name);
      const xhr = this.request("GET", `/${name}.pack`);
      if (xhr) for (const [p, d] of parsePack(xhr.response as ArrayBuffer).files) this.pack.files.set(p, d);
      return this.read(path);
    }
    if (this.cache.has(path)) return this.cache.get(path)!;
    if (this.pack.index && !this.pack.index.has(path)) return null;
    const at = this.pack.offsets.get(path);
    if (at !== undefined) return this.readRange(path, 0, this.pack.index!.get(path)!);
    const xhr = this.request("GET", path);
    const data = xhr ? new Uint8Array(xhr.response as ArrayBuffer) : null;
    this.cache.set(path, data);
    return data;
  }

  // Fetches missing 64 KB blocks with Range requests, each run of them in
  // one request. A server that ignores Range sends the whole file instead.
  readRange(path: string, off: number, len: number): Uint8Array | null {
    const whole = this.pack.files.get(path) ?? this.cache.get(path);
    if (whole) return whole.subarray(off, off + len);
    if (len === 0) return new Uint8Array(0);
    const at = this.pack.offsets.get(path);
    if (at !== undefined) return this.readRange(at.image, at.at + off, len);
    let blocks = this.blocks.get(path);
    if (!blocks) this.blocks.set(path, (blocks = new Map()));
    const first = Math.floor(off / BLOCK), last = Math.floor((off + len - 1) / BLOCK);
    for (let b = first; b <= last; b++) {
      if (blocks.has(b)) continue;
      let end = b;
      while (end < last && !blocks.has(end + 1)) end++;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", this.base + encodeURI(path), false);
      xhr.responseType = "arraybuffer";
      xhr.setRequestHeader("Range", `bytes=${b * BLOCK}-${(end + 1) * BLOCK - 1}`);
      try {
        xhr.send();
      } catch {
        // a compressed range fails to decode
        return this.readWhole(path, off, len);
      }
      const data = new Uint8Array(xhr.response as ArrayBuffer);
      if (xhr.status === 200) {
        this.cache.set(path, data);
        this.blocks.delete(path);
        return data.subarray(off, off + len);
      }
      if (xhr.status !== 206) return null;
      if (!rangeOk(xhr, b * BLOCK, data.length)) return this.readWhole(path, off, len);
      for (let i = b; i <= end; i++) blocks.set(i, data.subarray((i - b) * BLOCK, (i - b + 1) * BLOCK));
      b = end;
    }
    const out = new Uint8Array(len);
    for (let b = first, at = 0; b <= last; b++) {
      const block = blocks.get(b)!;
      const from = b === first ? off - b * BLOCK : 0;
      const part = block.subarray(from, Math.min(block.length, from + len - at));
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  // When ranges of a file come back wrong, reads all of it once: a whole
  // response decodes correctly even from a host that compresses it.
  private readWhole(path: string, off: number, len: number): Uint8Array | null {
    console.warn(`java-web: range reads of ${this.base}${path} came back compressed or wrong, so it is read whole. Serve it without compression (as .jar files are on GitHub Pages).`);
    const xhr = this.request("GET", path);
    if (!xhr) return null;
    const data = new Uint8Array(xhr.response as ArrayBuffer);
    this.cache.set(path, data);
    this.blocks.delete(path);
    return data.subarray(off, off + len);
  }

  list(path: string): string[] | null {
    return this.pack.index ? listIndex(this.pack.index, path) : null;
  }
}

// The names in a directory of a pack index, or null if path is not one.
export function listIndex(idx: Map<string, number>, path: string): string[] | null {
  if (idx.get(path) !== -1) return null;
  const prefix = path === "/" ? "/" : path + "/";
  const out: string[] = [];
  for (const p of idx.keys()) {
    if (p.startsWith(prefix) && p.length > prefix.length && !p.slice(prefix.length).includes("/")) out.push(p.slice(prefix.length));
  }
  return out;
}
