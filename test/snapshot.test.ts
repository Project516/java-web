// Boot snapshots: a VM restored from one behaves as one that booted.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { runNode, startLibrary } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, "build", "test-snapshot");
mkdirSync(out, { recursive: true });
execFileSync(hotspot("javac"), ["-d", out, join(root, "test", "snapshot", "Boot.java")]);
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function cacheDir() {
  const d = mkdtempSync(join(tmpdir(), "java-web-snap-"));
  dirs.push(d);
  return d;
}

async function run(snapshotDir: string | null, props: Record<string, string> = {}) {
  const chunks: Uint8Array[] = [];
  const code = await runNode({ classpath: [out], mainClass: "Boot", args: ["a", "b"], props, snapshotDir, stdout: (b) => chunks.push(b) });
  return { code, stdout: Buffer.concat(chunks).toString("utf8") };
}

// java-web's own messages go to the process's stderr
async function stderrOf<T>(f: () => Promise<T>): Promise<[T, string]> {
  const write = process.stderr.write;
  let text = "";
  process.stderr.write = ((s: string | Uint8Array) => { text += s; return true; }) as typeof write;
  try {
    return [await f(), text];
  } finally {
    process.stderr.write = write;
  }
}

const files = (dir: string, ext: string) => readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f));

// marks a snapshot unused, so a load shows in its time
function age(file: string) {
  utimesSync(file, new Date(0), new Date(0));
}
const used = (file: string) => statSync(file).mtimeMs > 0;

test("a snapshot is taken on the second boot and restored on the third", async () => {
  const ref = spawnSync(hotspot("java"), ["-cp", out, "Boot", "a", "b"], { encoding: "utf8" });
  const expected = { code: ref.status, stdout: ref.stdout };
  const dir = cacheDir();
  assert.deepEqual(await run(dir), expected);
  assert.equal(files(dir, ".snap").length, 0);
  assert.deepEqual(await run(dir), expected);
  const [snap] = files(dir, ".snap");
  age(snap);
  assert.deepEqual(await run(dir), expected);
  assert.ok(used(snap));
});

test("other properties boot without the snapshot", async () => {
  const dir = cacheDir();
  await run(dir);
  await run(dir);
  const [snap] = files(dir, ".snap");
  age(snap);
  const got = await run(dir, { "snap.prop": "x" });
  assert.equal(got.stdout.split("\n")[2], "x");
  assert.ok(!used(snap));
});

test("library mode restores its own snapshot", async () => {
  const dir = cacheDir();
  for (let i = 0; i < 2; i++) await run(dir);
  const where = async () => {
    const vm = await startLibrary({ classpath: [out], snapshotDir: dir });
    try {
      return await vm.callStatic("Boot", "where", []);
    } finally {
      vm.halt(0);
    }
  };
  assert.equal(await where(), "null on main");
  assert.equal(await where(), "null on main");
  assert.equal(files(dir, ".snap").length, 2);
  for (const f of files(dir, ".snap")) age(f);
  assert.equal(await where(), "null on main");
  assert.equal(files(dir, ".snap").filter(used).length, 1);
});

test("a snapshot that cannot be saved leaves the run as it was", async () => {
  const dir = cacheDir();
  const expected = await run(null);
  assert.deepEqual(await run(dir), expected);
  const [marker] = files(dir, ".seen");
  // the snapshot's own path taken by a directory, so saving it fails
  mkdirSync(marker.replace(/\.seen$/, ".snap"));
  assert.deepEqual(await run(dir), expected);
  assert.deepEqual(files(dir, ".tmp"), []);
});

test("a snapshot that cannot be restored is dropped and the VM boots", async () => {
  const dir = cacheDir();
  const expected = await run(null);
  await run(dir);
  await run(dir);
  const [snap] = files(dir, ".snap");
  const image = deserialize(readFileSync(snap));
  image.classes.at(-1).name = "no/such/Class";
  writeFileSync(snap, serialize(image));
  const [got, err] = await stderrOf(() => run(dir));
  assert.deepEqual(got, expected);
  assert.match(err, /boot snapshot not restored/);
  // the boot saved a good one in its place
  age(snap);
  assert.deepEqual(await stderrOf(() => run(dir)), [expected, ""]);
  assert.ok(used(snap));
});

test("a module path turns snapshots off, since boot reads its modules", async () => {
  const dir = cacheDir();
  for (let i = 0; i < 2; i++) await run(dir, { "jdk.module.path": cacheDir() });
  assert.deepEqual(readdirSync(dir), []);
});
