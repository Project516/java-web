// Picks the OpenJDK tests a change needs, for CI.
//
//   node scripts/jtreg/select.ts [<base> | --full]
//
// Prints GitHub Actions outputs: `filters`, the tests to pass to run.ts (empty
// for all of them), and `shards`, a JSON list of shard numbers ([] when no test
// is needed). Tests added to passing.txt or locale-data.txt run alone. A change
// to a loaded file with a table entry runs the test directories it maps to,
// plus every tenth listed test; a change to any other loaded file runs them
// all. A change to times.tsv alone runs none.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const passingFile = "test/jtreg/passing.txt";
const localeFile = "test/jtreg/locale-data.txt";
const timesFile = "test/jtreg/times.tsv";

// TypeScript the tests load: everything src/node.ts (the VM each test runs on),
// the web build that bundles it into dist/node.js, the runner and this
// selection import, followed through their imports. Other .ts files under
// src/ and scripts/ (the page API) cannot change a test's result.
function loaded(): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(join(root, file), "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+\.ts)["']/g)) visit(join(dirname(file), m[1]));
  };
  visit("src/node.ts");
  visit("scripts/build-web.ts");
  visit("scripts/jtreg/run.ts");
  visit("scripts/jtreg/select.ts");
  return seen;
}
const notLoaded = /\.md$|^docs\/|^LICENSE|^renovate\.json$|^\.coderabbit|^types\/|^test\/(?!jtreg\/)/;

// The test directories a change to a loaded file can affect. A file not here
// runs every test, so only add one when its effect is known and narrow.
const zipTests = ["java/util/zip", "java/util/jar", "jdk/nio/zipfs", "java/net/URLClassLoader"];
const netTests = ["java/net", "java/nio/channels", "javax/net", "sun/net"];
const ioTests = ["java/io", "java/nio", ...zipTests, "java/util/prefs",
  "java/lang/ProcessBuilder", "java/lang/Process", "java/lang/RuntimeTests"];
const processTests = ["java/lang/ProcessBuilder", "java/lang/Process", "java/lang/ProcessHandle", "java/lang/RuntimeTests"];
const awtTests = ["java/awt", "java/beans", "javax/imageio"];
const cryptoTests = ["java/security", "javax/crypto", "javax/net", "java/math", "sun/security"];
const managementTests = ["java/lang/management", "java/util/concurrent"];

const affects: [string, string[]][] = [
  ["src/natives/zip.ts", zipTests],
  ["src/inflate.ts", zipTests],
  ["src/deflate.ts", zipTests],
  ["src/natives/net.ts", netTests],
  ["src/sockets.ts", netTests],
  ["src/net-node.ts", netTests],
  ["src/natives/sockets.ts", netTests],
  ["src/http-proxy.ts", netTests],
  ["src/natives/nio.ts", ioTests],
  ["src/natives/io.ts", ioTests],
  ["src/fs.ts", ioTests],
  ["src/process-node.ts", processTests],
  ["src/natives/java2d*.ts", awtTests],
  ["src/natives/font*.ts", awtTests],
  ["src/natives/crypto.ts", cryptoTests],
  ["src/natives/management.ts", managementTests],
];
const patterns = affects.map(([file, dirs]) =>
  [new RegExp(`^${file.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`), dirs] as const);
const dirsFor = (file: string) => patterns.find(([re]) => re.test(file))?.[1];

// about 10 test-minutes a shard, so a selection spreads over up to 8
const times = new Map<string, number>();
for (const l of (existsSync(join(root, timesFile)) ? readFileSync(join(root, timesFile), "utf8") : "").split("\n")) {
  const [ms, id] = l.split("\t");
  if (id && Number.isFinite(Number(ms))) times.set(id, Number(ms));
}
const median = [...times.values()].sort((a, b) => a - b)[times.size >> 1] ?? 0;
const shardsFor = (ids: string[]) => {
  const ms = ids.reduce((n, id) => n + (times.get(id) ?? median), 0);
  return Array.from({ length: Math.min(8, Math.max(1, Math.ceil(ms / 600_000))) }, (_, i) => i + 1);
};
const listed = readFileSync(join(root, passingFile), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const under = (id: string, f: string) => id === f || id.startsWith(f + "/") || id.startsWith(f + "#");

function select(base: string | undefined): string[] | "all" {
  if (!base) return "all";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const filters = new Set<string>();
  let graph: Set<string> | undefined;
  let dirs: string[] | undefined;
  for (const file of git("diff", "--name-only", "--no-renames", `${base}...HEAD`).split("\n").filter(Boolean)) {
    if (file === passingFile || file === localeFile) {
      // the tests it adds, and listed tests that leave locale-data.txt and so run differently
      for (const l of git("diff", "-U0", `${base}...HEAD`, "--", file).split("\n")) {
        const id = l.slice(1).trim();
        if (!id || id.startsWith("#") || l.startsWith("+++") || l.startsWith("---")) continue;
        if (l.startsWith("+") || (l.startsWith("-") && file === localeFile && listed.includes(id))) filters.add(id);
      }
      continue;
    }
    // it only balances shards
    if (file === timesFile) continue;
    if (/^(src|scripts)\/.*\.ts$/.test(file)) {
      if (!(graph ??= loaded()).has(file)) continue;
      const mapped = dirsFor(file);
      if (!mapped) return "all";
      dirs = dirs ? [...dirs, ...mapped] : mapped;
    } else if (!notLoaded.test(file)) return "all";
  }
  if (dirs) {
    // every tenth listed test, for a regression in shared code a mapped file calls into
    for (const f of [...dirs, ...listed.filter((_, i) => i % 10 === 0)]) filters.add(f);
  }
  return [...filters];
}

const arg = process.argv[2];
const picked = select(arg === "--full" ? undefined : arg);
const chosen = picked === "all" ? listed : listed.filter((id) => picked.some((f) => under(id, f)));
const count = chosen.length;
console.log(`filters=${picked === "all" ? "" : picked.join(" ")}`);
console.log(`shards=${JSON.stringify(count ? shardsFor(chosen) : [])}`);
console.error(`${count} tests${picked === "all" ? " (all)" : picked.length ? ": " + picked.join(" ") : ""}`);
