// The Node backend over the packaged image (boot.pack and jdk/<module>.jar),
// and dist/node.js, the Node entry `pnpm build` makes; those tests skip until
// dist/ is built.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageBackend } from "../src/image.ts";
import { listIndex, packedRange, parsePack } from "../src/browser/http.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const enc = new TextEncoder();

// the boot.pack layout: [u16 path length][path][u32 size][bytes], repeated
function pack(entries: [string, string | Uint8Array][]): Uint8Array {
  const parts: number[] = [];
  for (const [p, d] of entries) {
    const name = enc.encode(p), data = typeof d === "string" ? enc.encode(d) : d;
    parts.push(name.length >> 8, name.length & 255, ...name);
    parts.push(data.length >>> 24, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255, ...data);
  }
  return Uint8Array.from(parts);
}

test("ImageBackend reads the index, packed files and module images", () => {
  const dir = mkdtempSync(join(tmpdir(), "jw-image-"));
  try {
    mkdirSync(join(dir, "jdk"));
    // image.jar holds "BOOTabcdef", the other image "XYZ"
    writeFileSync(join(dir, "jdk", "image.jar"), "BOOTabcdef");
    writeFileSync(join(dir, "jdk", "jdk.other.jar"), "XYZ");
    writeFileSync(join(dir, "boot.pack"), pack([
      ["/index.txt", "d /lib\nf /lib/boot 4 image:0\nf /lib/rest 6 image:4\nf /lib/cut 6 jdk.other:1\nd /modules\nd /modules/jdk.other\nf /modules/jdk.other/x 3 jdk.other:0"],
      ["/lib/boot", "BOOT"],
      // a packed part of /lib/rest, which reads come from before the image
      ["@1:/lib/rest", "BCD"],
    ]));
    const b = new ImageBackend(dir);
    assert.deepEqual(b.stat("/lib"), { dir: true, size: 0, mtime: 0 });
    assert.deepEqual(b.stat("/lib/rest"), { dir: false, size: 6, mtime: 0 });
    assert.equal(b.stat("/lib/none"), null);
    assert.deepEqual(b.list("/lib"), ["boot", "rest", "cut"]);
    assert.deepEqual(b.list("/"), ["lib", "modules"]);
    assert.equal(b.list("/lib/boot"), null);
    const text = (d: Uint8Array | null) => d && new TextDecoder().decode(d);
    assert.equal(text(b.read("/lib/boot")), "BOOT");
    assert.equal(text(b.read("/lib/rest")), "abcdef");
    assert.equal(text(b.readRange("/lib/rest", 1, 2)), "BC");
    assert.equal(text(b.readRange("/lib/rest", 3, 2)), "de");
    // a range is cut at the file's end, not read into the next file
    assert.equal(text(b.readRange("/lib/boot", 2, 10)), "OT");
    assert.equal(text(b.readRange("/lib/rest", 4, 10)), "ef");
    assert.equal(text(b.read("/modules/jdk.other/x")), "XYZ");
    assert.equal(b.read("/lib"), null);
    // past the end of a damaged image
    assert.equal(b.read("/lib/cut"), null);
    rmSync(join(dir, "jdk", "image.jar"));
    assert.throws(() => new ImageBackend(dir), /no packaged JDK image/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a VM keeps reading the image it started with when an upgrade replaces it", () => {
  const dir = mkdtempSync(join(tmpdir(), "jw-image-"));
  try {
    mkdirSync(join(dir, "jdk"));
    writeFileSync(join(dir, "jdk", "image.jar"), "OLD!");
    writeFileSync(join(dir, "boot.pack"), pack([["/index.txt", "d /lib\nf /lib/x 4 image:0"]]));
    const text = (d: Uint8Array | null) => d && new TextDecoder().decode(d);
    const before = new ImageBackend(dir);
    assert.equal(text(before.read("/lib/x")), "OLD!");
    // as a package manager replaces a file: a new one renamed over it
    writeFileSync(join(dir, "jdk", "image.new"), "NEW!");
    renameSync(join(dir, "jdk", "image.new"), join(dir, "jdk", "image.jar"));
    assert.equal(text(new ImageBackend(dir).read("/lib/x")), "NEW!");
    assert.equal(text(before.readRange("/lib/x", 0, 4)), "OLD!");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compact index keeps paths, sizes, offsets, and directory order", () => {
  const buf = pack([["/index.prefix", "0 d /lib\n0 f /lib/one 3 image:0\n7 two 4 image:3 javac\n0 d /modules"]]);
  const image = parsePack(buf.buffer as ArrayBuffer);
  assert.deepEqual([...image.index!], [["/", -1], ["/lib", -1], ["/lib/one", 3], ["/lib/two", 4], ["/modules", -1]]);
  assert.deepEqual(listIndex(image.index!, "/lib"), ["one", "two"]);
  assert.deepEqual(image.offsets.get("/lib/two"), { image: "/image.jar", at: 3 });
  assert.equal(image.lazy.get("/lib/two"), "javac");
});

test("packed image ranges are found by offset, and a lazy pack lists its own", () => {
  const spans = new Uint8Array(16);
  const dv = new DataView(spans.buffer);
  [100, 110, 200, 205].forEach((v, i) => dv.setUint32(i * 4, v));
  const buf = pack([
    ["@10:/lib/modules", "abcdef"],
    ["@0:/lib/modules", "0123"],
    ["@50:/lib/modules", "XY"],
    ["@lazy:javac:/lib/modules", spans],
  ]);
  const image = parsePack(buf.buffer as ArrayBuffer);
  const text = (d: Uint8Array | undefined) => d && new TextDecoder().decode(d);
  assert.equal(image.files.size, 0);
  assert.equal(text(packedRange(image, "/lib/modules", 1, 3)), "123");
  assert.equal(text(packedRange(image, "/lib/modules", 12, 4)), "cdef");
  assert.equal(text(packedRange(image, "/lib/modules", 50, 2)), "XY");
  // across two parts, past a part's end, or between parts: not packed
  assert.equal(packedRange(image, "/lib/modules", 3, 8), undefined);
  assert.equal(packedRange(image, "/lib/modules", 14, 3), undefined);
  assert.equal(packedRange(image, "/lib/modules", 30, 1), undefined);
  assert.equal(packedRange(image, "/lib/other", 0, 1), undefined);
  assert.deepEqual(image.lazyRanges.get("/lib/modules"), { name: "javac", spans: [100, 110, 200, 205] });
});

const node = join(root, "dist", "node.js");
const skip = existsSync(node) ? false : "run `pnpm build` first";
const out = join(root, "build", "test-image");

test("dist/node.js and the java-web command run a program as HotSpot does", { skip }, () => {
  mkdirSync(out, { recursive: true });
  spawnSync(hotspot("javac"), ["-d", out, join(root, "test", "java", "Collections.java")], { stdio: "inherit" });
  const ref = spawnSync(hotspot("java"), ["-cp", out, "Collections"], { encoding: "utf8" });
  for (const entry of [node, join(root, "dist", "cli.js")]) {
    const got = spawnSync(process.execPath, [entry, "-cp", out, "Collections"], { encoding: "utf8" });
    assert.deepEqual({ stdout: got.stdout, stderr: got.stderr, code: got.status }, { stdout: ref.stdout, stderr: ref.stderr, code: ref.status }, entry);
  }
});

test("dist/node.js starts child processes", { skip: skip || process.platform !== "linux" }, () => {
  mkdirSync(out, { recursive: true });
  spawnSync(hotspot("javac"), ["-d", out, join(root, "test", "java", "Processes.java")], { stdio: "inherit" });
  const ref = spawnSync(hotspot("java"), ["-cp", out, "Processes"], { encoding: "utf8" });
  const got = spawnSync(process.execPath, [node, "-cp", out, "Processes"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(got.error, undefined);
  assert.deepEqual({ stdout: got.stdout, stderr: got.stderr, code: got.status }, { stdout: ref.stdout, stderr: ref.stderr, code: ref.status });
});

test("dist/node.js exports runNode, and javac runs on the packaged image", { skip }, async () => {
  mkdirSync(out, { recursive: true });
  spawnSync(hotspot("javac"), ["-d", out, join(root, "test", "java", "Javac.java")], { stdio: "inherit" });
  const ref = spawnSync(hotspot("java"), ["-cp", out, "Javac"], { encoding: "utf8" });
  const { runNode } = await import(node);
  const stdout: Uint8Array[] = [];
  const code = await runNode({ classpath: [out], mainClass: "Javac", stdout: (b: Uint8Array) => stdout.push(b) });
  assert.equal(Buffer.concat(stdout).toString("utf8"), ref.stdout);
  assert.equal(code, ref.status);
});
