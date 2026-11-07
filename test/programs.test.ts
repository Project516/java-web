// Compiles each test/java/*.java and checks that java-web prints exactly
// what HotSpot prints, with the same exit code.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  // other processes are visible to java-web through Linux's /proc only
  test(main, { skip: main === "Processes" && process.platform !== "linux" }, async () => {
    const ref = spawnSync(hotspot("java"), [...vmFlags, "-cp", out, main], { input, encoding: "utf8" });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let code: number;
    if (vmFlags.some((f) => /^-(Xmx|XX:(OnOutOfMemoryError|MaxDirectMemorySize)=)/.test(f))) {
      const got = spawnSync(process.execPath, [join(root, "src", "node.ts"), ...vmFlags, "-cp", out, main], { input, encoding: "utf8" });
      stdout.push(new TextEncoder().encode(got.stdout));
      stderr.push(new TextEncoder().encode(got.stderr));
      code = got.status ?? 1;
    } else {
      // module options go in as the properties HotSpot's launcher makes of them
      const opts = { classpath: [out], props: {}, enablePreview: false };
      const assertions: string[] = [];
      for (let i = 0; i < vmFlags.length; i++) {
        if (vmFlags[i] === "--enable-preview") opts.enablePreview = true;
        else if (!moduleFlag(opts, vmFlags[i], vmFlags[i + 1])) assertions.push(vmFlags[i]);
        else if (!vmFlags[i].includes("=")) i++;
      }
      code = await runNode({
        ...opts,
        mainClass: main,
        assertions,
        stdout: (b) => stdout.push(b),
        stderr: (b) => stderr.push(b),
        input: input === undefined ? undefined : new TextEncoder().encode(input),
      });
    }
    const text = (parts: Uint8Array[]) => Buffer.concat(parts).toString("utf8");
    // one comparison, so a failure shows stderr and the exit code along with stdout
    assert.deepEqual(
      { stdout: text(stdout), stderr: normalizeTrace(text(stderr)), code },
      { stdout: ref.stdout, stderr: normalizeTrace(ref.stderr), code: ref.status },
    );
  });
}

// the java-web command, which node starts without --expose-gc
test("System.gc collects under the command", { skip: !files.includes("Refs.java") }, () => {
  const ref = spawnSync(hotspot("java"), ["-cp", out, "Refs"], { encoding: "utf8" });
  assert.equal(ref.status, 0);
  const got = spawnSync(process.execPath, [join(root, "src", "node.ts"), "-cp", out, "Refs"], { encoding: "utf8" });
  assert.deepEqual({ stdout: got.stdout, code: got.status }, { stdout: ref.stdout, code: ref.status });
});

test("-Xmx caps an allocation under the command", () => {
  const classes = join(root, "build", "test-heap");
  execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "heap", "Heap.java")]);
  const args = ["-Xmx17m", "-cp", classes, "Heap"];
  const ref = spawnSync(hotspot("java"), args, { encoding: "utf8" });
  const got = spawnSync(process.execPath, [join(root, "src", "node.ts"), ...args], { encoding: "utf8" });
  assert.deepEqual({ stdout: got.stdout, code: got.status }, { stdout: ref.stdout, code: ref.status });
  // x64 HotSpot rounds the heap up to 2 MB steps
  const max = spawnSync(process.execPath, [join(root, "src", "node.ts"), ...args, "max"], { encoding: "utf8" });
  assert.match(max.stdout, /^max 18874368$/m);
});

// ulimit -f makes the host refuse writes past 4 KB; SIGXFSZ ignored, they fail with EFBIG
test("writes the host refuses", { skip: process.platform !== "linux" }, () => {
  const classes = join(root, "build", "test-full");
  execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "full", "Full.java")]);
  const dir = mkdtempSync(join(tmpdir(), "java-web-full-"));
  const limited = (cmd: string, args: string[]) =>
    spawnSync("bash", ["-c", 'trap "" XFSZ; ulimit -f 4; exec "$@"', "bash", cmd, ...args, "-cp", classes, "Full", join(dir, "out.bin")], { encoding: "utf8" });
  try {
    const ref = limited(hotspot("java"), []);
    const got = limited(process.execPath, [join(root, "src", "node.ts")]);
    assert.deepEqual({ stdout: got.stdout, code: got.status }, { stdout: ref.stdout, code: ref.status });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("stdout closed by its reader", async () => {
  const classes = join(root, "build", "test-pipe");
  execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "pipe", "Pipe.java")]);
  // reads the first chunk, then closes the pipe
  const run = (cmd: string, args: string[]) => new Promise<{ stderr: string; code: number | null }>((resolve) => {
    const p = spawn(cmd, [...args, "-cp", classes, "Pipe"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.stdout.once("data", () => p.stdout.destroy());
    p.on("close", (code) => resolve({ stderr, code }));
  });
  assert.deepEqual(await run(process.execPath, [join(root, "src", "node.ts")]), await run(hotspot("java"), []));
});

function flags(file: string, tool: string): string[] {
  const m = new RegExp(`^// ${tool}: (.*)$`, "m").exec(readFileSync(join(src, file), "utf8"));
  return m ? m[1].split(" ") : [];
}

test("host symlinks resolve before parent components", { skip: process.platform === "win32" }, () => {
  const classes = join(root, "build", "test-paths");
  mkdirSync(classes, { recursive: true });
  execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "paths", "SymlinkDotDot.java")]);
  const dir = mkdtempSync(join(tmpdir(), "java-web-links-"));
  const setup = (name: string) => {
    const work = join(dir, name, "work"), target = join(dir, name, "target");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(work, "dir"));
    mkdirSync(join(target, "dir"), { recursive: true });
    symlinkSync(join(target, "dir"), join(work, "link"), "dir");
    writeFileSync(join(work, "file"), "lexical");
    writeFileSync(join(target, "file"), "target");
    writeFileSync(join(target, "victim"), "keep");
    symlinkSync(join(target, "victim"), join(work, "last"));
    return ["-cp", classes, "SymlinkDotDot", work, target];
  };
  try {
    const ref = spawnSync(hotspot("java"), setup("hotspot"), { encoding: "utf8" });
    assert.equal(ref.status, 0, ref.stderr);
    const got = spawnSync(process.execPath, [join(root, "src", "node.ts"), ...setup("vm")], { encoding: "utf8" });
    assert.deepEqual({ stdout: got.stdout, code: got.status }, { stdout: ref.stdout, code: ref.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

// both raise a lower soft limit to the hard one at startup, and report the raised value
test("open file limit as HotSpot reports it", { skip: process.platform !== "linux" }, () => {
  const under = (cmd: string[]) => spawnSync("bash", ["-c", 'ulimit -S -n 4096; exec "$@"', "bash", ...cmd, "-cp", out, "FileLimit"], { encoding: "utf8" });
  const ref = under([hotspot("java")]);
  const got = under([process.execPath, join(root, "src", "node.ts")]);
  assert.deepEqual({ stdout: got.stdout, code: got.status }, { stdout: ref.stdout, code: ref.status });
});

// A directory or an unreadable match is EACCES when nothing else is found. ELOOP stops the
// search when the child inherits the environment and does not when it has its own.
test("PATH lookup as the JDK's launcher", { skip: process.platform !== "linux" }, async () => {
  const classes = join(root, "build", "test-path");
  execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "process", "PathLookup.java")]);
  const dir = mkdtempSync(join(tmpdir(), "java-web-path-"));
  try {
    const exec = join(dir, "exec");
    mkdirSync(join(dir, "dirs", "dirtool"), { recursive: true });
    mkdirSync(join(dir, "plain"));
    writeFileSync(join(dir, "plain", "noexec"), "", { mode: 0o644 });
    symlinkSync(join(dir, "loop"), join(dir, "loop"));
    mkdirSync(exec);
    writeFileSync(join(exec, "dirtool"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    writeFileSync(join(exec, "loopy"), "#!/bin/sh\nexit 4\n", { mode: 0o755 });
    const file = join(dir, "file");
    writeFileSync(file, "");
    const lookup = async (PATH: string, args: string[]) => {
      const ref = spawnSync(hotspot("java"), ["-cp", classes, "PathLookup", ...args], { env: { PATH }, encoding: "utf8" });
      const stdout: Uint8Array[] = [];
      const code = await runNode({ classpath: [classes], mainClass: "PathLookup", args, env: { PATH }, stdout: (b) => stdout.push(b) });
      assert.deepEqual({ stdout: Buffer.concat(stdout).toString("utf8"), code }, { stdout: ref.stdout, code: ref.status });
      return ref.stdout;
    };
    const eacces = "Exec failed, error: 13 (Permission denied) ";
    const enoent = "Exec failed, error: 2 (No such file or directory) ";
    const eloop = "Exec failed, error: 40 (Too many levels of symbolic links) ";
    assert.equal(
      await lookup([join(dir, "dirs"), join(dir, "plain"), exec, join(dir, "missing")].join(":"), ["dirtool", "noexec", "absent"]),
      `dirtool exit 3\nnoexec ${eacces}\nabsent ${enoent}\n`,
    );
    assert.equal(
      await lookup([join(dir, "loop"), join(dir, "plain"), exec, join(dir, "missing")].join(":"), ["-env", "dirtool", "noexec", "absent"]),
      `dirtool exit 3\nnoexec ${eacces}\nabsent ${enoent}\n`,
    );
    assert.equal(await lookup([join(dir, "loop"), exec].join(":"), ["dirtool"]), `dirtool ${eloop}\n`);
    assert.equal(await lookup(file, ["absent"]), "absent Exec failed, error: 20 (Not a directory) \n");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// jdk.localedata loads only when asked for; without it other locales format as English.
test("locale data", async () => {
  const classes = join(root, "build", "test-locales");
  execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "locales", "Locales.java")]);
  const ref = spawnSync(hotspot("java"), ["-cp", classes, "Locales"], { encoding: "utf8" });
  assert.equal(ref.status, 0, ref.stderr);
  const run = async (localeData: boolean, props: Record<string, string> = {}) => {
    const stdout: Uint8Array[] = [];
    const code = await runNode({ classpath: [classes], mainClass: "Locales", localeData, props, stdout: (b) => stdout.push(b) });
    assert.equal(code, 0);
    return Buffer.concat(stdout).toString("utf8");
  };
  assert.equal(await run(true), ref.stdout);
  // --add-modules=ALL-SYSTEM asks for every module, locale data included
  assert.equal(await run(false, { "jdk.module.addmods.0": "ALL-SYSTEM" }), ref.stdout);
  const modules = readFileSync(join(root, "build/jdk/release"), "utf8").match(/MODULES="([^"]+)"/)![1]
    .split(" ").filter((m) => m !== "jdk.localedata" && m !== "javaweb.tls").join(",");
  const limited = spawnSync(hotspot("java"), ["--limit-modules", modules, "-cp", classes, "Locales"], { encoding: "utf8" });
  assert.equal(limited.status, 0, limited.stderr);
  assert.equal(await run(false), limited.stdout);
  // a limit the caller gives wins over localeData
  assert.equal(await run(true, { "jdk.module.limitmods": modules }), limited.stdout);
});

// The host refuses these writes; root is allowed them, so the test needs a normal user.
test("permission denied", { skip: process.getuid?.() === 0 }, async () => {
  const classes = join(root, "build", "test-permissions");
  execFileSync(hotspot("javac"), ["-d", classes, join(root, "test", "permissions", "Permissions.java")]);
  const dir = mkdtempSync(join(tmpdir(), "java-web-perm-"));
  const file = join(dir, "read-only.txt"), locked = join(dir, "locked"), open = join(dir, "open.txt");
  writeFileSync(file, "x");
  chmodSync(file, 0o444);
  mkdirSync(locked, { mode: 0o555 });
  try {
    writeFileSync(open, "x");
    const ref = spawnSync(hotspot("java"), ["-cp", classes, "Permissions", file, locked, open], { encoding: "utf8" });
    writeFileSync(open, "x");
    chmodSync(open, 0o644);
    const stdout: Uint8Array[] = [];
    const code = await runNode({ classpath: [classes], mainClass: "Permissions", args: [file, locked, open], stdout: (b) => stdout.push(b) });
    assert.equal(Buffer.concat(stdout).toString("utf8"), ref.stdout);
    assert.equal(code, ref.status);
  } finally {
    chmodSync(locked, 0o755);
    rmSync(dir, { recursive: true });
  }
});
