import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { startLibrary } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const classes = join(root, "build", "test-warm-snapshot");
mkdirSync(classes, { recursive: true });
execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "warm-snapshot", "WarmJavac.java"), join(root, "test", "warm-snapshot", "WarmVirtual.java")]);

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "java-web-warm-"));
  dirs.push(dir);
  return dir;
}

async function compile(cache: string, source: string, missing: string) {
  return callWarm(cache, "WarmJavac", "compile", [source, missing, join(cache, "out")]);
}

async function callWarm(cache: string, cls: string, method: string, args: string[]) {
  let log = "";
  let settled: () => void = () => {};
  const done = new Promise<void>((resolve) => (settled = resolve));
  const error = console.error;
  console.error = (...parts: unknown[]) => {
    log += `${parts.join(" ")}\n`;
    if (/warm snapshot (saved|busy|restored)/.test(log)) settled();
  };
  let vm: Awaited<ReturnType<typeof startLibrary>> | undefined;
  try {
    vm = await startLibrary({ classpath: [classes], snapshotDir: cache, warmSnapshot: true, debug: true });
    const result = await vm.callStatic(cls, method, args);
    // the VM saves after the call has returned, when it goes idle
    await done;
    return { result, log };
  } finally {
    vm?.halt(0);
    console.error = error;
  }
}

test("library warm snapshots restore and validate reads and missing paths", async () => {
  const dir = scratch();
  const src = join(dir, "Result.java");
  const missing = join(dir, "not-created", "Absent.class");
  const source = (value: number) => `public class Result { public static int value() { return ${value}; } }\n`;
  writeFileSync(src, source(7));
  const reference7 = join(dir, "reference7");
  mkdirSync(reference7);
  execFileSync(hotspot("javac"), ["-g:none", "-d", reference7, src]);
  const expected7 = readFileSync(join(reference7, "Result.class")).toString("base64");
  const first = await compile(dir, src, missing);
  assert.equal(first.result, expected7);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".warm")).length, 1, first.log);

  const restored = await compile(dir, src, missing);
  assert.equal(restored.result, expected7);
  assert.match(restored.log, /warm snapshot restored/);

  writeFileSync(src, source(8));
  const reference8 = join(dir, "reference8");
  mkdirSync(reference8);
  execFileSync(hotspot("javac"), ["-g:none", "-d", reference8, src]);
  const expected8 = readFileSync(join(reference8, "Result.class")).toString("base64");
  const changed = await compile(dir, src, missing);
  assert.equal(changed.result, expected8);
  assert.match(changed.log, /warm snapshot missed validation/);

  mkdirSync(join(dir, "not-created"));
  writeFileSync(missing, new Uint8Array());
  const created = await compile(dir, src, missing);
  assert.equal(created.result, expected8);
  assert.match(created.log, /warm snapshot missed validation/);

});

test("a library VM that ran virtual threads blocked on monitors declines a warm snapshot and keeps working", async () => {
  const dir = scratch();
  const first = await callWarm(dir, "WarmVirtual", "run", []);
  assert.equal(first.result, "119:15");
  assert.match(first.log, /warm snapshot busy: snapshot: thread .* is blocked in/);
  const second = await callWarm(dir, "WarmVirtual", "run", []);
  assert.equal(second.result, "119:15");
});
