// Compiles each test/java/*.java and checks that java-web prints exactly
// what HotSpot prints, with the same exit code.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { moduleFlag, runNode } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const src = join(root, "test", "java");
const out = join(root, "build", "test-classes");
const only = process.env.ONLY;

const files = readdirSync(src).filter((f) => f.endsWith(".java") && (!only || f.startsWith(only)));
mkdirSync(out, { recursive: true });
// A line "// javac: -g" adds javac flags for that file, "// java: -ea" VM flags.
const flagged = files.filter((f) => javacFlags(f).length);
const plain = files.filter((f) => !flagged.includes(f));
if (plain.length) execFileSync(hotspot("javac"), ["-d", out, ...plain.map((f) => join(src, f))], { stdio: "inherit" });
for (const f of flagged) execFileSync(hotspot("javac"), ["-d", out, ...javacFlags(f), join(src, f)], { stdio: "inherit" });

for (const file of files) {
  const main = file.slice(0, -5);
  const input = readInput(main);
  const vmFlags = flags(file, "java");
  test(main, async () => {
    const ref = spawnSync(hotspot("java"), [...vmFlags, "-cp", out, main], { input, encoding: "utf8" });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    // module options go in as the properties HotSpot's launcher makes of them
    const opts = { classpath: [out], props: {}, enablePreview: false };
    const assertions: string[] = [];
    for (let i = 0; i < vmFlags.length; i++) {
      if (vmFlags[i] === "--enable-preview") opts.enablePreview = true;
      else if (!moduleFlag(opts, vmFlags[i], vmFlags[i + 1])) assertions.push(vmFlags[i]);
      else if (!vmFlags[i].includes("=")) i++;
    }
    const code = await runNode({
      ...opts,
      mainClass: main,
      assertions,
      stdout: (b) => stdout.push(b),
      stderr: (b) => stderr.push(b),
      input: input === undefined ? undefined : new TextEncoder().encode(input),
    });
    const text = (parts: Uint8Array[]) => Buffer.concat(parts).toString("utf8");
    // one comparison, so a failure shows stderr and the exit code along with stdout
    assert.deepEqual(
      { stdout: text(stdout), stderr: normalizeTrace(text(stderr)), code },
      { stdout: ref.stdout, stderr: normalizeTrace(ref.stderr), code: ref.status },
    );
  });
}

function flags(file: string, tool: string): string[] {
  const m = new RegExp(`^// ${tool}: (.*)$`, "m").exec(readFileSync(join(src, file), "utf8"));
  return m ? m[1].split(" ") : [];
}

function javacFlags(file: string): string[] {
  return flags(file, "javac");
}

function readInput(main: string): string | undefined {
  try {
    return readFileSync(join(src, `${main}.in`), "utf8");
  } catch {
    return undefined;
  }
}

// Lambda proxy class names carry a VM-specific address.
function normalizeTrace(s: string) {
  return s.replace(/\/0x[0-9a-f]+/g, "/0x0");
}

// A packaged app: classes and a compressed resource in a jar, run with -jar.
test("jar app", async () => {
  const jarDir = join(root, "build", "test-jar");
  const classes = join(jarDir, "classes");
  mkdirSync(join(classes, "app"), { recursive: true });
  const appSrc = join(root, "test", "jar", "app");
  execFileSync(hotspot("javac"), ["-d", classes, join(appSrc, "Main.java"), join(appSrc, "Helper.java")]);
  copyFileSync(join(appSrc, "data.txt"), join(classes, "app", "data.txt"));
  const jar = join(jarDir, "app.jar");
  execFileSync(hotspot("jar"), ["--create", "--file", jar, "--main-class", "app.Main", "-C", classes, "."]);
  const ref = spawnSync(hotspot("java"), ["-jar", jar, "a", "b"], { encoding: "utf8" });
  const stdout: Uint8Array[] = [];
  const code = await runNode({ classpath: [], jar, args: ["a", "b"], stdout: (b) => stdout.push(b), stderr: (b) => stdout.push(b) });
  assert.equal(Buffer.concat(stdout).toString("utf8"), ref.stdout + ref.stderr);
  assert.equal(code, ref.status);
});

test("env option replaces the host environment", async () => {
  const stdout: Uint8Array[] = [];
  const code = await runNode({ classpath: [out], mainClass: "Environment", env: { GREETING: "hi", PATH: "/bin" }, stdout: (b) => stdout.push(b) });
  assert.equal(Buffer.concat(stdout).toString("utf8"), "[GREETING, PATH]\n/bin\nnull\nEnvironment\n");
  assert.equal(code, 0);
});

// jdk.localedata loads only when asked for; without it other locales format as English.
test("locale data", async () => {
  const classes = join(root, "build", "test-locales");
  execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "locales", "Locales.java")]);
  const ref = spawnSync(hotspot("java"), ["-cp", classes, "Locales"], { encoding: "utf8" });
  const run = async (localeData: boolean) => {
    const stdout: Uint8Array[] = [];
    const code = await runNode({ classpath: [classes], mainClass: "Locales", localeData, stdout: (b) => stdout.push(b) });
    assert.equal(code, 0);
    return Buffer.concat(stdout).toString("utf8");
  };
  assert.equal(await run(true), ref.stdout);
  assert.match(await run(false), /^de_DE 1,234,567\.89 /m);
});

// The host refuses these writes; root is allowed them, so the test needs a normal user.
test("permission denied", { skip: process.getuid?.() === 0 }, async () => {
  const classes = join(root, "build", "test-permissions");
  execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "permissions", "Permissions.java")]);
  const dir = mkdtempSync(join(tmpdir(), "java-web-perm-"));
  const file = join(dir, "read-only.txt"), locked = join(dir, "locked");
  writeFileSync(file, "x");
  chmodSync(file, 0o444);
  mkdirSync(locked, { mode: 0o555 });
  try {
    const ref = spawnSync(hotspot("java"), ["-cp", classes, "Permissions", file, locked], { encoding: "utf8" });
    const stdout: Uint8Array[] = [];
    const code = await runNode({ classpath: [classes], mainClass: "Permissions", args: [file, locked], stdout: (b) => stdout.push(b) });
    assert.equal(Buffer.concat(stdout).toString("utf8"), ref.stdout);
    assert.equal(code, ref.status);
  } finally {
    chmodSync(locked, 0o755);
    rmSync(dir, { recursive: true });
  }
});
