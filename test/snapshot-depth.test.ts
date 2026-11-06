import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { startLibrary } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const classes = join(root, "build", "test-snapshot-depth");
mkdirSync(classes, { recursive: true });
execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "snapshot-depth", "Chain.java"), join(root, "test", "warm-snapshot", "WarmJavac.java")]);

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const NODES = 200_000;

// the longest path V8 would recurse through when serializing or restoring value
function nesting(value: unknown): number {
  const seen = new Set<object>();
  let max = 0;
  const stack: { it: Iterator<unknown>; depth: number }[] = [];
  const enter = (x: unknown, depth: number) => {
    if (x === null || typeof x !== "object" || seen.has(x) || ArrayBuffer.isView(x) || x instanceof ArrayBuffer) return;
    seen.add(x);
    max = Math.max(max, depth);
    const kids = x instanceof Map ? [...x.keys(), ...x.values()] : x instanceof Set ? [...x] : Array.isArray(x) ? x : Object.values(x);
    stack.push({ it: kids[Symbol.iterator](), depth });
  };
  enter(value, 1);
  while (stack.length) {
    const top = stack[stack.length - 1];
    const next = top.it.next();
    if (next.done) stack.pop();
    else enter(next.value, top.depth + 1);
  }
  return max;
}

async function run(cache: string, work: string, warm: boolean, build: boolean) {
  let log = "";
  let settled: () => void = () => {};
  const done = new Promise<void>((resolve) => (settled = resolve));
  const error = console.error;
  console.error = (...args: unknown[]) => {
    log += `${args.join(" ")}\n`;
    if (/warm snapshot (saved|busy|restored)/.test(log)) settled();
  };
  let vm: Awaited<ReturnType<typeof startLibrary>> | undefined;
  try {
    vm = await startLibrary({ classpath: [classes], snapshotDir: cache, warmSnapshot: warm, debug: true });
    if (build) await vm.callStatic("Chain", "build", [NODES]);
    const check = await vm.callStatic("Chain", "check", []);
    if (warm) {
      await vm.callStatic("WarmJavac", "compile", [join(work, "Result.java"), join(work, "absent", "A.class"), join(work, "out")]);
      await done;
    }
    return { check, log };
  } finally {
    vm?.halt(0);
    console.error = error;
  }
}

test("snapshots of a heap with a 200,000 node linked list stay shallow and restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "java-web-depth-"));
  dirs.push(dir);
  const cache = join(dir, "cache");
  mkdirSync(cache);
  writeFileSync(join(dir, "Result.java"), "public class Result { public static int value() { return 7; } }\n");
  const sum = ((NODES - 1) * NODES) / 2;
  const expected = `${NODES} ${NODES} ${sum}`;

  const saved = await run(cache, dir, true, true);
  assert.equal(saved.check, expected);
  assert.match(saved.log, /warm snapshot saved/);
  const [warmFile] = readdirSync(cache).filter((f) => f.endsWith(".warm"));
  assert.ok(warmFile, saved.log);
  assert.ok(nesting(deserialize(readFileSync(join(cache, warmFile)))) < 400);

  // a second VM in this process restores it, rather than booting
  const restored = await run(cache, dir, true, false);
  assert.match(restored.log, /warm snapshot restored/);
  assert.equal(restored.check, expected);

  // boot snapshots, taken on a key's second boot without warm snapshots
  await run(cache, dir, false, false);
  await run(cache, dir, false, false);
  const [bootFile] = readdirSync(cache).filter((f) => f.endsWith(".snap"));
  assert.ok(bootFile);
  assert.ok(nesting(deserialize(readFileSync(join(cache, bootFile)))) < 400);
  assert.equal((await run(cache, dir, false, true)).check, expected);
});
