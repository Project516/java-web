// The Node backend over the packaged image (boot.pack and jdk/<module>.jar),
// and dist/node.js, the Node entry `pnpm build` makes; those tests skip until
// dist/ is built.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageBackend } from "../src/image.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const enc = new TextEncoder();

// the boot.pack layout: [u16 path length][path][u32 size][bytes], repeated
function pack(entries: [string, string][]): Uint8Array {
  const parts: number[] = [];
  for (const [p, d] of entries) {
    const name = enc.encode(p), data = enc.encode(d);
    parts.push(name.length >> 8, name.length & 255, ...name);
    parts.push(data.length >>> 24, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255, ...data);
  }
  return Uint8Array.from(parts);
}

test("ImageBackend reads the index, packed files and module images", () => {
  const dir = mkdtempSync(join(tmpdir(), "jw-image-"));
  try {
    mkdirSync(join(dir, "jdk"));
    // java.base.jar holds "BOOTabcdef", the other image "XYZ"
    writeFileSync(join(dir, "jdk", "java.base.jar"), "BOOTabcdef");
    writeFileSync(join(dir, "jdk", "jdk.other.jar"), "XYZ");
    writeFileSync(join(dir, "jdk", "jdk.localedata.txt"), "d /modules/jdk.localedata\nf /modules/jdk.localedata/L 3 jdk.other:0");
    writeFileSync(join(dir, "boot.pack"), pack([
      ["/index.txt", "d /lib\nf /lib/boot 4 java.base:0\nf /lib/rest 6 java.base:4\nf /lib/cut 6 jdk.other:1\nd /modules\nd /modules/jdk.other\nf /modules/jdk.other/x 3 jdk.other:0"],
      ["/lib/boot", "BOOT"],
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
    assert.equal(text(b.readRange("/lib/rest", 2, 3)), "cde");
    assert.equal(text(b.read("/modules/jdk.other/x")), "XYZ");
    assert.equal(b.read("/lib"), null);
    // past the end of a damaged image
    assert.equal(b.read("/lib/cut"), null);
    assert.equal(b.stat("/modules/jdk.localedata"), null);
    assert.equal(text(new ImageBackend(dir, true).read("/modules/jdk.localedata/L")), "XYZ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const node = join(root, "dist", "node.js");
const skip = existsSync(node) ? false : "run `pnpm build` first";
const out = join(root, "build", "test-image");

test("dist/node.js runs a program as HotSpot does", { skip }, () => {
  mkdirSync(out, { recursive: true });
  spawnSync(hotspot("javac"), ["-d", out, join(root, "test", "java", "Collections.java")], { stdio: "inherit" });
  const ref = spawnSync(hotspot("java"), ["-cp", out, "Collections"], { encoding: "utf8" });
  const got = spawnSync(process.execPath, [node, "-cp", out, "Collections"], { encoding: "utf8" });
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
