// Runs OpenJDK regression tests (the `@run main`, `testng` and `junit` kinds) on java-web.
//
//   node scripts/jtreg/run.ts <jdk-source-checkout> [dir or file filters...]
//        [--jobs 1] [--timeout 120] [--rerun] [--only-passing] [--shard 1/4] [--vm path/to/node.ts] [--cool 75]
//
// Each test is compiled the way jtreg does it, run on HotSpot first (only
// tests that pass there count), then on java-web in a child process.
// Results go to build/jtreg/results.jsonl; --only-passing reruns the tests
// listed in test/jtreg/passing.txt (those under the filters, if any) on
// java-web alone, and fails if any of them regress. --shard k/n runs every
// nth of the selected tests, for parallel CI jobs.

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { hotspot } from "../hotspot.ts";

const root = join(import.meta.dirname, "..", "..");
const out = join(root, "build", "jtreg");
const resultsFile = join(out, "results.jsonl");
const passingFile = join(root, "test", "jtreg", "passing.txt");

const argv = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = argv.indexOf(name);
  return i < 0 ? def : argv.splice(i, 2)[1];
};
const has = (name: string) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const jobs = Number(flag("--jobs", "1"));
const timeout = Number(flag("--timeout", "120"));
const rerun = has("--rerun");
// pause new tests while the CPU is at or above this many degrees C (for small boards)
const cool = Number(flag("--cool", "0"));
const onlyPassing = has("--only-passing");
const [shardK, shardN] = flag("--shard", "1/1").split("/").map(Number);
if (!Number.isInteger(shardK) || !Number.isInteger(shardN) || shardK < 1 || shardK > shardN) {
  console.error("--shard takes k/n with 1 <= k <= n");
  process.exit(2);
}
// node entry to test; point it at a copy of src/ to keep editing during a long run
const vm = resolve(flag("--vm", join(root, "src", "node.ts")));
const src = resolve(argv.shift() ?? "");
const testRoot = join(src, "test", "jdk");
if (!existsSync(testRoot)) {
  console.error("usage: node scripts/jtreg/run.ts <jdk-source-checkout> [filters...]");
  process.exit(2);
}
const javaHome = dirname(dirname(realpathSync(hotspot("java"))));

type Kind = "main" | "testng" | "junit" | "compile";
// a compile action keeps its javac options in opts and its files in args
interface Action { kind: Kind; opts: string[]; main: string; args: string[]; timeout: number }
interface TestCase {
  id: string;
  file: string;
  dir: string;
  libraries: string[];
  build: string[];
  modules: string[];
  preview: boolean;
  runs: Action[];
  skip?: string;
}

// ---- parsing ----------------------------------------------------------------

// TEST.properties from the test root down to dir; nearer files override
const propsCache = new Map<string, ReturnType<typeof readProps>>();
function dirProps(dir: string) {
  let p = propsCache.get(dir);
  if (!p) propsCache.set(dir, (p = readProps(dir)));
  return p;
}

function readProps(dir: string) {
  const p = { testng: false, junit: false, libs: [] as string[], build: [] as string[], modules: [] as string[] };
  const chain: string[] = [];
  for (let d = dir; d.startsWith(testRoot); d = dirname(d)) chain.unshift(d);
  for (const d of chain) {
    const f = join(d, "TEST.properties");
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8").replace(/\\\n/g, " ");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const words = m[2].trim().split(/\s+/).filter(Boolean);
      const under = () => words.some((w) => {
        const base = w.startsWith("/") ? join(testRoot, w) : resolve(d, w);
        return dir === base || dir.startsWith(base + "/");
      });
      if (m[1] === "TestNG.dirs" && under()) p.testng = true;
      else if (m[1] === "JUnit.dirs" && under()) p.junit = true;
      else if (m[1] === "lib.dirs") p.libs = words;
      else if (m[1] === "lib.build") p.build = words;
      else if (m[1] === "modules") p.modules = words;
    }
  }
  return p;
}

// the package declaration, which can only come before any other code
function packageOf(source: string): string | undefined {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "").match(/^\s*package\s+([\w.]+)\s*;/)?.[1];
}

function parseFile(file: string): TestCase[] {
  const text = readFileSync(file, "utf8");
  const pkg = packageOf(text);
  const base = (pkg ? pkg + "." : "") + file.slice(file.lastIndexOf("/") + 1, -5);
  const props = dirProps(dirname(file));
  const framework = props.testng ? "testng" : props.junit ? "junit" : null;
  const cases: TestCase[] = [];
  let blocks = (text.match(/\/\*[\s\S]*?\*\//g) ?? []).filter((b) => /@test\b/.test(b));
  // every file in a TestNG or JUnit directory is one test, with or without @test
  if (framework) blocks = [blocks[0] ?? ""];
  let n = 0;
  for (const block of blocks) {
    const tags: [string, string][] = [];
    for (const raw of block.split("\n")) {
      const line = raw.replace(/^\s*(\/\*+|\*\/|\*)?\s?/, "").replace(/\*\/\s*$/, "").trim();
      const m = line.match(/^@(\S+)\s*(.*)$/);
      if (m) tags.push([m[1], m[2]]);
      else if (tags.length && line) tags[tags.length - 1][1] += " " + line;
    }
    const rel = relative(testRoot, file);
    const id = rel + (n++ ? `#${n}` : "");
    const tc: TestCase = { id, file, dir: dirname(file), libraries: [...props.libs], build: [...props.build], modules: [], preview: false, runs: [] };
    for (const [tag, value] of tags) {
      const [name, ...mods] = tag.split("/");
      switch (name) {
        case "library": tc.libraries.push(...value.split(/\s+/).filter(Boolean)); break;
        case "build": tc.build.push(...value.split(/\s+/).filter(Boolean)); break;
        case "modules": tc.modules.push(...value.split(/\s+/).filter(Boolean)); break;
        case "enablePreview": tc.preview = true; break;
        case "requires": tc.skip ??= "requires"; break;
        case "ignore": tc.skip ??= "ignore"; break;
        case "clean": tc.skip ??= "@clean"; break;
        case "compile": {
          if (framework) break;
          if (mods.some((x) => !x.startsWith("timeout="))) { tc.skip ??= `@${tag}`; break; }
          const words = value.split(/\s+/).filter(Boolean);
          const opts: string[] = [];
          while (words.length && words[0].startsWith("-")) {
            const w = words.shift()!;
            opts.push(w);
            if (/^(--add-(exports|opens|modules|reads)|-cp|-classpath|--class-path|-p|--module-path|-source|-target|--release|-encoding|-processor)$/.test(w) && words.length) opts.push(words.shift()!);
          }
          const files: string[] = [];
          while (words.length && words[0].endsWith(".java")) files.push(words.shift()!);
          if (!files.length) { tc.skip ??= "@compile without .java files"; break; }
          tc.runs.push({ kind: "compile", opts, main: "", args: files, timeout: 120 });
          break;
        }
        case "run": {
          if (framework) break;
          const m = value.match(/^(\S+)\s*(.*)$/);
          if (!m) break;
          const kind = m[1].split("/");
          if (kind[0] !== "main" && kind[0] !== "testng" && kind[0] !== "junit") { tc.skip ??= `@run ${kind[0]}`; break; }
          if (kind.includes("native") || kind.includes("manual")) { tc.skip ??= `@run ${m[1]}`; break; }
          const t = kind.find((k) => k.startsWith("timeout="));
          const words = m[2].split(/\s+/).filter(Boolean);
          const opts: string[] = [];
          while (words.length && words[0].startsWith("-")) {
            const w = words.shift()!;
            opts.push(w);
            if (/^(--add-(exports|opens|modules|reads)|-cp|-classpath|--class-path|-p|--module-path)$/.test(w) && words.length) opts.push(words.shift()!);
          }
          if (!words.length) break;
          const main = words.shift()!;
          tc.runs.push({ kind: kind[0] as Kind, opts, main, args: words, timeout: t ? Number(t.slice(8)) : 120 });
          break;
        }
      }
    }
    if (!tc.modules.length) tc.modules.push(...props.modules);
    if (tc.libraries.some((l) => l.includes("bootlib"))) tc.skip ??= "patches java.base";
    if (tc.runs.some((r) => (r.kind === "testng" || r.kind === "junit") && r.main.includes("/"))) tc.skip ??= "test class in a named module";
    // as in jtreg, the implied run applies only to a test with no action tags
    const hasAction = tags.some(([t]) => /^(run|compile|build|clean|ignore)(\/|$)/.test(t));
    if (framework) tc.runs = [{ kind: framework, opts: [], main: base, args: [], timeout: 120 }];
    else if (!hasAction) tc.runs.push({ kind: "main", opts: [], main: base, args: [], timeout: 120 });
    else if (!tc.runs.some((r) => r.kind !== "compile")) tc.skip ??= "no run action";
    cases.push(tc);
  }
  return cases;
}

function libraryDir(tc: TestCase, lib: string): string {
  if (lib.startsWith("/")) {
    const fromRoot = join(testRoot, lib);
    return existsSync(fromRoot) ? fromRoot : join(src, lib);
  }
  return resolve(tc.dir, lib);
}

// ---- test frameworks --------------------------------------------------------

// the versions jtreg bundles, with its SHA-1 sums
const maven = "https://repo1.maven.org/maven2/";
const frameworkJars: [string, string][] = [
  ["org/testng/testng/7.3.0/testng-7.3.0.jar", "a5069c3dfba58d23702f96c3d9f5081f5ce7136f"],
  ["com/beust/jcommander/1.82/jcommander-1.82.jar", "0a7c5fef184d238065de38f81bbc6ee50cca2e21"],
  ["com/google/inject/guice/5.1.0/guice-5.1.0.jar", "da25056c694c54ba16e78e4fc35f17fc60f0d1b4"],
  ["org/junit/platform/junit-platform-console-standalone/1.14.4/junit-platform-console-standalone-1.14.4.jar", "02deb74daae8c2187cfc9fe85392f8421eb004c6"],
];
const runnerDir = join(out, "runner");
let frameworks: Promise<string[]> | null = null;

// classpath entries for TestNG and JUnit tests: the jars and TestRunner, fetched once for all workers
function frameworkPath(): Promise<string[]> {
  return (frameworks ??= fetchFrameworks());
}

async function fetchFrameworks(): Promise<string[]> {
  const lib = join(out, "lib");
  mkdirSync(lib, { recursive: true });
  const jars: string[] = [];
  for (const [path, sha1] of frameworkJars) {
    const jar = join(lib, path.slice(path.lastIndexOf("/") + 1));
    if (!existsSync(jar)) {
      const res = await fetch(maven + path);
      if (!res.ok) throw new Error(`${res.status} fetching ${path}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const sum = createHash("sha1").update(bytes).digest("hex");
      if (sum !== sha1) throw new Error(`${path}: sha1 ${sum}, expected ${sha1}`);
      writeFileSync(jar, bytes);
    }
    jars.push(jar);
  }
  const r = spawnSync(hotspot("javac"), ["-d", runnerDir, "-cp", jars.join(":"), join(import.meta.dirname, "TestRunner.java")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return [...jars, runnerDir];
}

// ---- compile and run --------------------------------------------------------

function classesDir(tc: TestCase) {
  return join(out, "classes", tc.id.replace(/[#/]/g, "_"));
}

function exportsFlags(tc: TestCase): string[] {
  const flags: string[] = [];
  for (const m of tc.modules) {
    const [mod, pkg, how] = m.split(/[/:]/);
    if (!pkg) continue;
    if (how !== "open") flags.push("--add-exports", `${mod}/${pkg}=ALL-UNNAMED`);
    if (how === "open" || how === "+open") flags.push("--add-opens", `${mod}/${pkg}=ALL-UNNAMED`);
  }
  return flags;
}

// the directory a file's package starts in
function packageRoot(tc: TestCase): string {
  const pkg = packageOf(readFileSync(tc.file, "utf8"));
  const tail = pkg ? "/" + pkg.replace(/\./g, "/") : "";
  return tail && tc.dir.endsWith(tail) ? tc.dir.slice(0, -tail.length) : tc.dir;
}

const usesFramework = (tc: TestCase) => tc.runs.some((r) => r.kind === "testng" || r.kind === "junit");

// one warm javac, fed requests in order
let server: ChildProcess | null = null;
let serverBuf = "";
const waiting: ((line: string) => void)[] = [];
function javac(args: string[]): Promise<string> {
  if (!server) {
    const dir = join(out, "compile-server");
    mkdirSync(dir, { recursive: true });
    spawnSync(hotspot("javac"), ["-d", dir, join(import.meta.dirname, "CompileServer.java")]);
    server = spawn(hotspot("java"), ["-cp", dir, "CompileServer"], { stdio: ["pipe", "pipe", "inherit"] });
    server.stdout!.on("data", (d: Buffer) => {
      serverBuf += d.toString();
      for (let i; (i = serverBuf.indexOf("\n")) >= 0;) {
        const line = serverBuf.slice(0, i);
        serverBuf = serverBuf.slice(i + 1);
        waiting.shift()?.(line);
      }
    });
  }
  return new Promise((r) => {
    waiting.push(r);
    server!.stdin!.write(args.join("\t") + "\n");
  });
}

async function compile(tc: TestCase, cp: string[]): Promise<string | null> {
  const dest = classesDir(tc);
  mkdirSync(dest, { recursive: true });
  const libs = tc.libraries.map((l) => libraryDir(tc, l));
  const files = [tc.file];
  for (const b of tc.build) {
    const path = b.replace(/\.\*$/, "").replace(/\*$/, "").replace(/\./g, "/");
    for (const base of [tc.dir, ...libs]) {
      const f = join(base, path + ".java");
      if (existsSync(f)) { files.push(f); break; }
      const d = join(base, path);
      if (b.endsWith("*") && existsSync(d) && statSync(d).isDirectory()) {
        for (const x of readdirSync(d)) if (x.endsWith(".java")) files.push(join(d, x));
        break;
      }
    }
  }
  return javacInto(tc, cp, [], [...new Set(files)]);
}

async function javacInto(tc: TestCase, cp: string[], opts: string[], files: string[]): Promise<string | null> {
  const libs = tc.libraries.map((l) => libraryDir(tc, l));
  const args = ["-d", classesDir(tc), "-nowarn", "-XDignore.symbol.file", "-sourcepath", [packageRoot(tc), ...libs].join(":"),
    "-cp", cp.join(":"), ...exportsFlags(tc), ...(tc.preview ? ["--enable-preview", "--release", "25"] : []), ...opts, ...files];
  const [rc, msg] = (await javac(args)).split("\t");
  return rc === "0" ? null : msg;
}

function props(tc: TestCase): string[] {
  const dest = classesDir(tc);
  return [
    `-Dtest.src=${tc.dir}`, `-Dtest.src.path=${tc.dir}`, `-Dtest.classes=${dest}`, `-Dtest.class.path=${dest}`,
    `-Dtest.jdk=${javaHome}`, `-Dcompile.jdk=${javaHome}`, `-Dtest.root=${testRoot}`, "-Dtest.vm.opts=", "-Dtest.java.opts=",
    `-Dtest.file=${tc.file}`, `-Dtest.name=${tc.id}`,
  ];
}

interface RunResult { ok: boolean; ms: number; timedOut: boolean; tail: string }

function exec(cmd: string, args: string[], cwd: string, limit: number): Promise<RunResult> {
  return new Promise((done) => {
    const start = Date.now();
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let text = "";
    const keep = (d: Buffer) => { text = (text + d.toString()).slice(-4000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
    }, limit * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(join(cwd, "output.txt"), text);
      const lines = text.split("\n").filter((l) => /Exception|Error|FAIL|failed/i.test(l));
      done({ ok: code === 0 && !timedOut, ms: Date.now() - start, timedOut, tail: (lines[0] ?? text.split("\n").filter(Boolean).pop() ?? "").slice(0, 300) });
    });
  });
}

async function runCase(tc: TestCase): Promise<Record<string, unknown>> {
  if (tc.skip) return { status: "skip", why: tc.skip };
  const dest = classesDir(tc);
  const path = [dest, ...(usesFramework(tc) ? await frameworkPath() : [])];
  const err = await compile(tc, path);
  if (err) return { status: "skip", why: `javac: ${err}` };
  // each VM starts in an empty scratch directory, as under jtreg
  const scratch = (vmName: string) => {
    const dir = join(out, "work", tc.id.replace(/[#/]/g, "_"), vmName);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const preview = tc.preview ? ["--enable-preview"] : [];
  const cp = ["-cp", path.join(":")];
  const entry = (a: Action) => a.kind === "main" ? [a.main] : ["TestRunner", a.kind, a.main];
  // the whole sequence on one VM, then the other: later runs may depend on files earlier ones left
  let refMs = 0;
  let work = scratch("hotspot");
  // tests in passing.txt already pass on HotSpot
  for (const a of onlyPassing ? [] : tc.runs) {
    if (a.kind === "compile") {
      const err = await javacInto(tc, path, a.opts, a.args.map((f) => resolve(tc.dir, f)));
      if (err) return { status: "skip", why: `javac: ${err}` };
      continue;
    }
    const ref = await exec(hotspot("java"), [...preview, ...exportsFlags(tc), ...a.opts, ...props(tc), ...cp, ...entry(a), ...a.args], work, a.timeout);
    if (!ref.ok) return { status: "skip", why: `fails on HotSpot: ${ref.tail}` };
    refMs += ref.ms;
  }
  let total = 0;
  work = scratch("java-web");
  for (const a of tc.runs) {
    // recompile, since a later @compile may have replaced classes the first run used
    if (a.kind === "compile") {
      const err = await javacInto(tc, path, a.opts, a.args.map((f) => resolve(tc.dir, f)));
      if (err) return { status: "skip", why: `javac: ${err}` };
      continue;
    }
    const ours = await exec("node", [vm, "--jdk", join(root, "build", "jdk"), ...preview, ...exportsFlags(tc), ...a.opts, ...props(tc), ...cp, ...entry(a), ...a.args], work, timeout);
    total += ours.ms;
    if (!ours.ok) return { status: ours.timedOut ? "timeout" : "fail", ms: total, refMs, why: ours.tail };
  }
  return { status: "pass", ms: total };
}

// ---- main -------------------------------------------------------------------

function findTests(paths: string[]): string[] {
  const files: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const x of readdirSync(p).sort()) walk(join(p, x));
    else if (p.endsWith(".java") && !/(module|package)-info\.java$/.test(p)) {
      const props = dirProps(dirname(p));
      if (props.testng || props.junit || /@test\b/.test(readFileSync(p, "utf8").slice(0, 20000))) files.push(p);
    }
  };
  for (const p of paths) walk(join(testRoot, p));
  return files;
}

// test ids in passing.txt
function listed(): string[] {
  if (!existsSync(passingFile)) return [];
  return readFileSync(passingFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

mkdirSync(out, { recursive: true });
let selected: TestCase[];
if (onlyPassing) {
  const under = (id: string) => !argv.length || argv.some((f) => id === f || id.startsWith(f + "/") || id.startsWith(f + "#"));
  const ids = new Set(listed().filter(under));
  const files = [...new Set([...ids].map((id) => join(testRoot, id.split("#")[0])))];
  selected = files.flatMap(parseFile).filter((tc) => ids.has(tc.id));
} else {
  const args = argv.length ? argv : ["java/lang", "java/util", "java/math", "java/io", "java/text", "java/time"];
  // an id like "dir/Test.java#2", as results print it, picks one test of the file
  const ids = new Set(args.filter((a) => a.includes("#")));
  const whole = new Set(args.filter((a) => !a.includes("#")));
  const narrowed = new Set([...ids].map((id) => id.split("#")[0]));
  selected = findTests([...new Set(args.map((a) => a.split("#")[0]))]).flatMap(parseFile).filter((tc) => {
    const file = tc.id.split("#")[0];
    return ids.has(tc.id) || whole.has(file) || !narrowed.has(file);
  });
}
selected = selected.filter((_, i) => i % shardN === shardK - 1);
const done = new Set<string>();
if (!rerun && !onlyPassing && existsSync(resultsFile)) {
  for (const l of readFileSync(resultsFile, "utf8").split("\n")) if (l) done.add(JSON.parse(l).id);
}
const queue = selected.filter((tc) => !done.has(tc.id));
console.log(`${selected.length} tests, ${queue.length} to run, ${jobs} at a time`);

const counts: Record<string, number> = {};
const regressions: string[] = [];
// java-web's time per test, to spot tests that run close to the timeout
const times: [string, number][] = [];
let finished = 0;
async function coolDown() {
  const zone = "/sys/class/thermal/thermal_zone0/temp";
  if (!cool || !existsSync(zone)) return;
  const temp = () => Number(readFileSync(zone, "utf8")) / 1000;
  if (temp() < cool) return;
  console.log(`cpu at ${temp()}C, pausing until it drops below ${cool - 5}C`);
  while (temp() >= cool - 5) await new Promise((r) => setTimeout(r, 15000));
}

async function worker() {
  for (;;) {
    await coolDown();
    const tc = queue.shift();
    if (!tc) return;
    const r: Record<string, any> = { id: tc.id, ...(await runCase(tc)) };
    counts[r.status as string] = (counts[r.status as string] ?? 0) + 1;
    finished++;
    if (onlyPassing) {
      if (r.status !== "pass") regressions.push(`${tc.id}: ${r.status} ${r.why ?? ""}`);
      if (typeof r.ms === "number") times.push([tc.id, r.ms]);
    }
    else appendFileSync(resultsFile, JSON.stringify(r) + "\n");
    if (r.status !== "skip") console.log(`[${finished}] ${r.status.toString().padEnd(7)} ${tc.id}${r.why ? "  " + r.why : ""}`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
(server as ChildProcess | null)?.stdin?.end();
console.log(counts);

if (onlyPassing) {
  times.sort((a, b) => b[1] - a[1]);
  writeFileSync(join(out, "times.tsv"), times.map(([id, ms]) => `${ms}\t${id}`).join("\n") + "\n");
  console.log("slowest:\n" + times.slice(0, 15).map(([id, ms]) => `${Math.round(ms / 1000)}s ${id}`).join("\n"));
  if (regressions.length) {
    console.log("regressions:\n" + regressions.join("\n"));
    process.exit(1);
  }
} else if (existsSync(resultsFile)) {
  // a test rerun with --rerun appears again; its latest result counts
  const latest = new Map<string, { id: string; status: string }>();
  for (const l of readFileSync(resultsFile, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    latest.set(r.id, r);
  }
  const all = [...latest.values()];
  // results cover only the tests run here, so the list keeps the others
  const passing = new Set(listed());
  for (const r of all) {
    if (r.status === "pass") passing.add(r.id);
    else passing.delete(r.id);
  }
  const total = (s: string) => all.filter((r) => r.status === s).length;
  writeFileSync(join(out, "summary.txt"),
    `pass ${total("pass")}, fail ${total("fail")}, timeout ${total("timeout")}, skip ${total("skip")}\n`);
  mkdirSync(dirname(passingFile), { recursive: true });
  writeFileSync(passingFile, "# OpenJDK tests that pass on java-web; scripts/jtreg/run.ts --only-passing reruns them\n" + [...passing].sort().join("\n") + "\n");
}
