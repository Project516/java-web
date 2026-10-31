// Builds dist/: the browser runtime (java-web.js + worker), the Node entry, the JDK image,
// a boot pack with the JDK files a typical start needs, a javac pack the
// worker fetches the first time javac runs, and the demo page.
// Run `pnpm jdk` first.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
if (!existsSync(join(jdk, "lib", "packages.txt"))) throw new Error("run `pnpm jdk` first");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "samples"), { recursive: true });

for (const [entry, out] of [["api.ts", "java-web.js"], ["worker.ts", "java-web-worker.js"]]) {
  await build({
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
});

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
  vfs.hide("/jdk/modules/jdk.localedata");
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
  vfs.hide("/jdk/modules/jdk.localedata");
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
const inJavacPack = new Set(javacFiles);

// The image is one file per module, jdk/<module>.jar, read in ranges. Files
// outside the modules go with java.base, which every start reads. The index
// says where each file is, so the worker can stat and list offline. Files of a
// package sit together, so one block read serves several classes.
const lines: string[] = [];
// jdk.localedata's lines go in jdk/jdk.localedata.txt, which a page fetches only with localeData on
const localeLines: string[] = [];
const images = new Map<string, { parts: Uint8Array[]; size: number }>();
const imageOf = (rel: string) => /^\/modules\/([^/]+)\//.exec(rel)?.[1] ?? "java.base";
const walk = (dir: string) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = "/" + relative(jdk, p);
    if (rel === "/legal") continue;
    const st = statSync(p);
    const out = rel.startsWith("/modules/jdk.localedata") ? localeLines : lines;
    if (st.isDirectory()) {
      out.push(`d ${rel}`);
      walk(p);
    } else {
      const name = imageOf(rel);
      let image = images.get(name);
      if (!image) images.set(name, (image = { parts: [], size: 0 }));
      out.push(`f ${rel} ${st.size} ${name}:${image.size}${inJavacPack.has(rel) ? " javac" : ""}`);
      image.parts.push(readFileSync(p));
      image.size += st.size;
    }
  }
};
walk(jdk);
writeFileSync(join(dist, "jdk", "jdk.localedata.txt"), localeLines.join("\n"));
for (const [name, image] of images) writeFileSync(join(dist, "jdk", `${name}.jar`), Buffer.concat(image.parts));
const imageSize = [...images.values()].reduce((n, i) => n + i.size, 0);
const largest = [...images].sort((a, b) => b[1].size - a[1].size)[0];
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

const boot = writePack(join(dist, "boot.pack"), [
  ["/index.txt", enc.encode(lines.join("\n"))],
  ...[...recorder.seen].sort().map((p): [string, Uint8Array] => [p, recorder.read(p)!]),
]);
const javacPack = writePack(join(dist, "jdk", "javac.pack"), javacFiles.map((p) => [p, javacRecorder.read(p)!]));
console.log(`dist/ ready: boot.pack ${boot}, jdk/javac.pack ${javacPack}, jdk/<module>.jar ${(imageSize / 2 ** 20).toFixed(0)} MB in ${images.size} files, the largest ${largest[0]} at ${(largest[1].size / 2 ** 20).toFixed(0)} MB`);
