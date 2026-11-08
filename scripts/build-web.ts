// Builds dist/: the browser runtime (java-web.js + worker), the Node entry, the JDK image,
// a boot pack with the JDK files a typical start needs, a javac pack the
// worker fetches the first time javac runs, and the demo page.
// Run `pnpm jdk` first.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";
import { MemoryBackend, VFS } from "../src/fs.ts";
import type { Backend } from "../src/fs.ts";
import { JVM, LM_CLASS } from "../src/jvm.ts";
import { hotspot } from "./hotspot.ts";
import { NodeBackend } from "../src/node.ts";

const root = join(import.meta.dirname, "..");
const jdk = join(root, "build", "jdk");
const dist = join(root, "dist");
if (!existsSync(join(jdk, "lib", "image.sha256"))) throw new Error("run `pnpm jdk` first");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "samples"), { recursive: true });

// names the VM code and JDK image, for the worker's boot snapshots
const buildId = createHash("sha256");
for (const f of readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).sort()) {
  buildId.update(f).update(readFileSync(join(root, "src", f)));
}
buildId.update(readFileSync(join(jdk, "lib", "image.sha256")));
const define = { JAVA_WEB_BUILD: JSON.stringify(buildId.digest("hex")) };

for (const [entry, out] of [["api.ts", "java-web.js"], ["worker.ts", "java-web-worker.js"]]) {
  await build({
    define,
    entryPoints: [join(root, "src", "browser", entry)],
    outfile: join(dist, out),
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    sourcemap: true,
  });
}

// the Node entry (runNode and the java-web command), over the packaged image next to it
await build({
  entryPoints: [join(root, "src", "node.ts")],
  outfile: join(dist, "node.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node23",
  banner: { js: "#!/usr/bin/env node" },
  define,
});
cpSync(join(root, "types", "node.d.ts"), join(dist, "node.d.ts"));
// The java-web command. Node's compile cache covers only modules loaded after
// it is on, so it comes before the VM: later runs skip compiling node.js.
writeFileSync(join(dist, "cli.js"), `#!/usr/bin/env node
import { enableCompileCache } from "node:module";
enableCompileCache?.();
const { main } = await import("./node.js");
main(process.argv.slice(2));
`, { mode: 0o755 });

mkdirSync(join(dist, "jdk"), { recursive: true });

const samples = join(root, "web", "samples");
execFileSync(hotspot("javac"), ["-d", join(dist, "samples"), ...readdirSync(samples).map((f) => join(samples, f))]);
cpSync(join(root, "web", "index.html"), join(dist, "index.html"));
cpSync(samples, join(dist, "samples"), { recursive: true });

// browser smoke test of library mode, page natives, native libraries, a Web Worker, javac and cjFileBlob
const selftest = join(root, "web", "selftest");
mkdirSync(join(dist, "selftest"), { recursive: true });
execFileSync(hotspot("javac"), ["-d", join(dist, "selftest"), join(selftest, "SelfTest.java")]);
for (const f of ["index.html", "native.js", "worker.js"]) cpSync(join(selftest, f), join(dist, "selftest", f));

// Record the JDK files the samples read.
class Recorder implements Backend {
  readonly writable = false;
  readonly seen = new Set<string>();
  private inner: Backend;
  constructor(inner: Backend) { this.inner = inner; }
  stat(p: string) { return this.inner.stat(p); }
  list(p: string) { return this.inner.list(p); }
  // parts of files read in ranges (the JDK image), as [start, end) by path
  readonly ranges = new Map<string, [number, number][]>();
  canReadRange(p: string) { return this.inner.canReadRange?.(p) ?? !!this.inner.readRange; }
  readRange(p: string, off: number, len: number) {
    const d = this.inner.readRange?.(p, off, len) ?? null;
    if (d) {
      let r = this.ranges.get(p);
      if (!r) this.ranges.set(p, (r = []));
      r.push([off, off + d.length]);
    }
    return d;
  }
  read(p: string) {
    const d = this.inner.read(p);
    if (d) this.seen.add(p);
    return d;
  }
}
const recorder = new Recorder(new NodeBackend(jdk));
for (const main of ["Hello", "Primes", "Shapes"]) {
  const vfs = new VFS();
  vfs.mount("/", new MemoryBackend());
  vfs.mount("/jdk", recorder);
  vfs.mount("/tmp", new MemoryBackend());
  vfs.mount("/app", new NodeBackend(dist));
  const vm = new JVM({
    fs: vfs, javaHome: "/jdk", classpath: ["/app/samples"], cwd: "/tmp",
    props: { "java.io.tmpdir": "/tmp", "user.home": "/tmp" },
    stdout: () => {}, stderr: (b) => process.stderr.write(b),
  });
  const code = await vm.run(LM_CLASS, main, main === "Primes" ? ["100"] : []);
  if (code !== 0) throw new Error(`${main} exited with ${code}`);
}

// Record what a javax.tools compile reads on top of that.
const javacRecorder = new Recorder(new NodeBackend(jdk));
{
  const vfs = new VFS();
  vfs.mount("/", new MemoryBackend());
  vfs.mount("/jdk", javacRecorder);
  vfs.mount("/tmp", new MemoryBackend());
  vfs.mount("/files", new MemoryBackend());
  vfs.mount("/app", new NodeBackend(dist));
  const vm = new JVM({
    fs: vfs, javaHome: "/jdk", classpath: ["/app/selftest"], cwd: "/files",
    props: { "java.io.tmpdir": "/tmp", "user.home": "/files" },
    stdout: () => {}, stderr: (b) => process.stderr.write(b),
  });
  await vm.startLibrary();
  const src = "public class Hi { public static void main(String[] a) { System.out.println(\"hi \" + a.length); } }";
  const r = await vm.callStatic("SelfTest", "compile", ["/files/out", "Hi", src]);
  if (r !== "true ") throw new Error(`javac in the VM failed: ${r}`);
  vm.halt(0);
}
const javacFiles = [...javacRecorder.seen].filter((p) => !recorder.seen.has(p)).sort();

// Sorted [start, end) spans covering the given ones. Spans less than GAP apart
// join, since a pack entry costs more than a few bytes of filler.
const GAP = 256;
function merge(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + GAP) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
// the parts of spans that covered leaves out
function subtract(spans: [number, number][], covered: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let [s, e] of spans) {
    for (const [cs, ce] of covered) {
      if (ce <= s || cs >= e) continue;
      if (cs > s) out.push([s, cs]);
      s = Math.max(s, ce);
      if (s >= e) break;
    }
    if (s < e) out.push([s, e]);
  }
  return out;
}
const bootRanges = new Map([...recorder.ranges].map(([p, r]) => [p, merge(r)]));
const javacRanges = new Map([...javacRecorder.ranges].map(([p, r]) => [p, subtract(merge(r), bootRanges.get(p) ?? [])]));
const rangeEntries = (ranges: Map<string, [number, number][]>, src: Recorder) =>
  [...ranges].flatMap(([p, spans]) => spans.map(([s, e]): [string, Uint8Array] => [`@${s}:${p}`, src.readRange(p, s, e - s)!]));
const inJavacPack = new Set(javacFiles);

// A jimage's resources as runs of one module's, [module, start, end) in image
// order. Empty resources and module-info.class are left out: jlink puts the
// latter with the index, and javac reads them all.
function moduleRuns(image: Uint8Array): [string, number, number][] {
  const v = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const count = v.getUint32(16, true);
  const locations = 28 + count * 8, strings = locations + v.getUint32(20, true);
  const resources = strings + v.getUint32(24, true);
  const str = (off: number) => {
    let s = "";
    for (let i = strings + off; image[i]; i++) s += String.fromCharCode(image[i]);
    return s;
  };
  const found: [string, number, number][] = [];
  for (let i = 0; i < count; i++) {
    let p = locations + v.getUint32(28 + count * 4 + i * 4, true);
    const attrs = Array<number>(8).fill(0);
    while (image[p] > 7) {
      const b = image[p++];
      let value = 0;
      for (let n = (b & 7) + 1; n > 0; n--) value = value * 256 + image[p++];
      attrs[b >> 3] = value;
    }
    const size = attrs[6] || attrs[7];
    if (size && !(!attrs[2] && str(attrs[3]) === "module-info")) found.push([str(attrs[1]), resources + attrs[5], resources + attrs[5] + size]);
  }
  const runs: [string, number, number][] = [];
  for (const [module, start, end] of found.sort((a, b) => a[1] - b[1])) {
    const last = runs[runs.length - 1];
    if (last?.[0] === module) last[2] = Math.max(last[2], end);
    else runs.push([module, start, end]);
  }
  return runs;
}

// The java.home files go in jdk/image.jar, read in ranges, with the index
// saying where each is, so the worker can stat and list offline. Parts a page
// may never read go in their own files, which a host can leave out: each
// module of lib/modules but java.base in jdk/<module>.jar, and lib/ct.sym
// (javac --release) in jdk/ct.sym.jar.
const linked = new Set(/^MODULES="(.*)"$/m.exec(readFileSync(join(jdk, "release"), "utf8"))![1].split(" "));
const imageSizes = new Map<string, number>();
// appends data to jdk/<name>.jar, returning where it starts there
const put = (name: string, data: Uint8Array) => {
  const at = imageSizes.get(name) ?? 0;
  (at ? appendFileSync : writeFileSync)(join(dist, "jdk", `${name}.jar`), data);
  imageSizes.set(name, at + data.length);
  return at;
};
const lines: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = "/" + relative(jdk, p);
    if (rel === "/legal") continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      lines.push(`d ${rel}`);
      walk(p);
    } else if (rel === "/lib/modules") {
      const data = readFileSync(p);
      const parts: [number, string][] = [];
      let pos = 0;
      for (const [module, start, end] of moduleRuns(data)) {
        if (module === "java.base" || !linked.has(module)) continue;
        if (parts.some(([, m]) => m === module)) throw new Error(`lib/modules has ${module} in more than one place`);
        if (start > pos) parts.push([pos, "image"]);
        parts.push([start, module]);
        pos = end;
      }
      if (pos < data.length) parts.push([pos, "image"]);
      parts.forEach(([start, image], i) => {
        const at = put(image, data.subarray(start, i + 1 < parts.length ? parts[i + 1][0] : data.length));
        lines.push(start ? `p ${rel} ${start} ${image}:${at}` : `f ${rel} ${st.size} ${image}:${at}`);
      });
    } else {
      const image = rel === "/lib/ct.sym" ? "ct.sym" : "image";
      lines.push(`f ${rel} ${st.size} ${image}:${put(image, readFileSync(p))}${inJavacPack.has(rel) ? " javac" : ""}`);
    }
  }
};
walk(jdk);
// OpenJDK's licenses and notices ship next to the image as plain files
cpSync(join(jdk, "legal"), join(dist, "jdk", "legal"), { recursive: true, dereference: true });

const enc = new TextEncoder();

function writePack(file: string, entries: [string, Uint8Array][]) {
  const size = entries.reduce((n, [p, d]) => n + 6 + enc.encode(p).length + d.length, 0);
  const pack = new Uint8Array(size);
  const dv = new DataView(pack.buffer);
  let off = 0;
  for (const [p, d] of entries) {
    const name = enc.encode(p);
    dv.setUint16(off, name.length);
    pack.set(name, off + 2);
    off += 2 + name.length;
    dv.setUint32(off, d.length);
    pack.set(d, off + 4);
    off += 4 + d.length;
  }
  writeFileSync(file, pack);
  return `${(size / 1024).toFixed(0)} KB, ${entries.length} files`;
}

// Each line as the length it shares with the line before, then the rest.
function prefixCode(lines: string[]) {
  let previous = "";
  return enc.encode(lines.map((line) => {
    let n = 0;
    while (n < line.length && line[n] === previous[n]) n++;
    // Keep surrogate pairs together when encoding the suffix as UTF-8.
    if (n > 0 && line.charCodeAt(n - 1) >= 0xd800 && line.charCodeAt(n - 1) <= 0xdbff) n--;
    previous = line;
    return `${n} ${line.slice(n)}`;
  }).join("\n"));
}
const lazySpans = (name: string, ranges: Map<string, [number, number][]>): [string, Uint8Array][] => [...ranges].filter(([, r]) => r.length).map(([p, spans]) => {
  const data = new Uint8Array(spans.length * 8);
  const dv = new DataView(data.buffer);
  spans.forEach(([s, e], i) => { dv.setUint32(i * 8, s); dv.setUint32(i * 8 + 4, e); });
  return [`@lazy:${name}:${p}`, data];
});
const boot = writePack(join(dist, "boot.pack"), [
  ...rangeEntries(bootRanges, recorder),
  ...lazySpans("javac", javacRanges),
  ["/index.prefix", prefixCode(lines)],
  ...[...recorder.seen].sort().map((p): [string, Uint8Array] => [p, recorder.read(p)!]),
]);
const javacPack = writePack(join(dist, "jdk", "javac.pack"), [
  ...javacFiles.map((p): [string, Uint8Array] => [p, javacRecorder.read(p)!]),
  ...rangeEntries(javacRanges, javacRecorder),
]);
const mb = (n: number) => `${(n / 2 ** 20).toFixed(0)} MB`;
const others = [...imageSizes].filter(([n]) => n !== "image").reduce((n, [, size]) => n + size, 0);
console.log(`dist/ ready: boot.pack ${boot}, jdk/javac.pack ${javacPack}, jdk/image.jar ${mb(imageSizes.get("image")!)}, ${imageSizes.size - 1} more images ${mb(others)}`);
