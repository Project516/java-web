// Read-only VFS backend over HTTP for use inside a Web Worker, where
// synchronous XHR is allowed. An optional index (from the boot pack) answers
// stat/list without requests, and preloaded file contents skip the network.

import type { Backend, Stat } from "../fs.ts";

export interface Pack {
  files: Map<string, Uint8Array>;
  // path -> size, or -1 for directories
  index: PackIndex | null;
  // path -> name of the lazily fetched pack that holds it
  lazy: Map<string, string>;
  // path -> the image file holding it and its offset there
  offsets: Map<string, { image: string; at: number }>;
}

// Pack layout: repeated [u16 path length][path][u32 size][bytes]. In the boot
// pack, "/index.prefix" holds prefix-coded "d path" and "f path size
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
  const raw = files.get("/index.prefix") ?? files.get("/index.txt");
  if (raw) {
    pack.index = new PackIndex(pack);
    addIndex(pack, dec.decode(raw), files.has("/index.prefix"));
    files.delete("/index.txt");
    files.delete("/index.prefix");
    for (const [p, data] of files) {
      if (!p.startsWith("/index/")) continue;
      pack.index.modules.set(p.slice(7, -7), data);
      files.delete(p);
    }
  }
  return pack;
}

// A pack's index. A module's file lines ("/index/<module>.prefix") are parsed
// the first time a path in that module is looked up, since a start reads few
// of the image's modules.
export class PackIndex extends Map<string, number> {
  readonly modules = new Map<string, Uint8Array>();
  private readonly pack: Pack;
  // directory -> names in it, built for the entries there were at the time
  private dirs: Map<string, string[]> | null = null;
  private dirsSize = 0;

  constructor(pack: Pack) {
    super([["/", -1]]);
    this.pack = pack;
  }

  override get(path: string) {
    this.load(path);
    return super.get(path);
  }

  override has(path: string) {
    this.load(path);
    return super.has(path);
  }

  // The names in each directory. Entries are only ever added, so a change in
  // size means new ones.
  children(): Map<string, string[]> {
    if (this.dirs && this.dirsSize === this.size) return this.dirs;
    const dirs = new Map<string, string[]>();
    for (const p of this.keys()) {
      if (p === "/") continue;
      const i = p.lastIndexOf("/");
      const parent = i === 0 ? "/" : p.slice(0, i);
      let names = dirs.get(parent);
      if (!names) dirs.set(parent, (names = []));
      names.push(p.slice(i + 1));
    }
    this.dirs = dirs;
    this.dirsSize = this.size;
    return dirs;
  }

  // Parses the lines of the module path is in. The module directories
  // themselves are in the main index.
  load(path: string) {
    if (this.modules.size === 0 || !path.startsWith("/modules/")) return;
    const end = path.indexOf("/", 9);
    if (end < 0) return;
    const module = path.slice(9, end);
    const raw = this.modules.get(module);
    if (!raw) return;
    this.modules.delete(module);
    addIndex(this.pack, new TextDecoder().decode(raw), true);
  }
}

// Adds index lines to a pack that has an index. Runs on every start, so it
// scans with indexOf rather than split and regexes.
export function addIndex(pack: Pack, text: string, prefix = false) {
  const index = pack.index!;
  const images = new Map<string, string>();
  let previous = "";
  for (let s = 0; s < text.length;) {
    let e = text.indexOf("\n", s);
    if (e < 0) e = text.length;
    let line = text.slice(s, e);
    s = e + 1;
    if (prefix) {
      const space = line.indexOf(" ");
      line = previous.slice(0, +line.slice(0, space)) + line.slice(space + 1);
      previous = line;
    }
    const a = line.indexOf(" ", 2);
    const path = a < 0 ? line.slice(2) : line.slice(2, a);
    if (line[0] === "d") index.set(path, -1);
    else if (line[0] === "f") {
      let b = line.indexOf(" ", a + 1);
      if (b < 0) b = line.length;
      index.set(path, +line.slice(a + 1, b));
      if (b === line.length) continue;
      let c = line.indexOf(" ", b + 1);
      if (c < 0) c = line.length;
      const colon = line.lastIndexOf(":", c);
      if (colon > b) {
        const module = line.slice(b + 1, colon);
        let image = images.get(module);
        if (image === undefined) images.set(module, (image = `/${module}.jar`));
        pack.offsets.set(path, { image, at: +line.slice(colon + 1, c) });
        if (c === line.length) continue;
        b = c;
      }
      pack.lazy.set(path, line.slice(b + 1));
    }
  }
}

const BLOCK = 64 << 10;

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

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
    xhr.open(method, this.base + encodePath(path), false);
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
    else if (path.endsWith(".class")) {
      const data = this.read(path);
      if (data) st = { dir: false, size: data.length, mtime: 0 };
    } else {
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
    // before lazy: a module's lazy entries appear once its index is parsed
    if (this.pack.index && !this.pack.index.has(path)) return null;
    const name = this.pack.lazy.get(path);
    if (name !== undefined && !this.fetchedPacks.has(name)) {
      this.fetchedPacks.add(name);
      const xhr = this.request("GET", `/${name}.pack`);
      if (xhr) for (const [p, d] of parsePack(xhr.response as ArrayBuffer).files) this.pack.files.set(p, d);
      return this.read(path);
    }
    if (this.cache.has(path)) return this.cache.get(path)!;
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
    // has() parses the path's module first; image files themselves are not indexed
    const at = this.pack.index?.has(path) ? this.pack.offsets.get(path) : undefined;
    if (at !== undefined) return this.readRange(at.image, at.at + off, len);
    let blocks = this.blocks.get(path);
    if (!blocks) this.blocks.set(path, (blocks = new Map()));
    const first = Math.floor(off / BLOCK), last = Math.floor((off + len - 1) / BLOCK);
    for (let b = first; b <= last; b++) {
      if (blocks.has(b)) continue;
      let end = b;
      while (end < last && !blocks.has(end + 1)) end++;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", this.base + encodePath(path), false);
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
export function listIndex(idx: PackIndex, path: string): string[] | null {
  if (idx.get(path) !== -1) return null;
  const prefix = path === "/" ? "/" : path + "/";
  idx.load(prefix);
  return [...(idx.children().get(path) ?? [])];
}
