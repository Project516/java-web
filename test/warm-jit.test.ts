import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startLibrary } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

// Own file: a warm image restores reliably only in a process that has run no other VM.
const root = join(import.meta.dirname, "..");
const classes = join(root, "build", "test-warm-snapshot");
mkdirSync(classes, { recursive: true });
execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "warm-snapshot", "WarmJavac.java")]);

async function compile(cache: string, args: string[]) {
  const vm = await startLibrary({ classpath: [classes], snapshotDir: cache, warmSnapshot: true });
  try {
    const before = vm.jitCode.size;
    const result = await vm.callStatic("WarmJavac", "compile", args);
    return { result, before, after: vm.jitCode.size };
  } finally {
    vm.halt(0);
  }
}

test("a warm restore compiles methods from their saved code on first call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "java-web-warm-jit-"));
  try {
    const src = join(dir, "Result.java");
    writeFileSync(src, "public class Result { public static int value() { return 7; } }\n");
    const reference = join(dir, "reference");
    mkdirSync(reference);
    execFileSync(hotspot("javac"), ["-g:none", "-d", reference, src]);
    const expected = readFileSync(join(reference, "Result.class")).toString("base64");
    const args = [src, join(dir, "not-created", "Absent.class"), join(dir, "out")];

    const first = await compile(dir, args);
    assert.equal(first.result, expected);
    assert.ok(first.before < 100, "the first run has no saved code");

    const restored = await compile(dir, args);
    assert.equal(restored.result, expected);
    assert.ok(restored.before > 100, `saved code for ${restored.before} methods`);
    assert.ok(restored.after < restored.before / 2, `${restored.after} of ${restored.before} saved methods were not compiled`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
