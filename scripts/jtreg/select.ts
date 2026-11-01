// Picks the OpenJDK tests a change needs, for CI.
//
//   node scripts/jtreg/select.ts [<base> | --full]
//
// Prints GitHub Actions outputs: `filters`, the test areas to pass to run.ts
// (empty for all of them), and `shards`, a JSON list of shard numbers ([] when
// no test is needed). A changed file this does not know runs every test.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const passingFile = "test/jtreg/passing.txt";

// first match wins; null runs no test
const areas: [RegExp, string[] | null][] = [
  [/\.md$|^docs\/|^LICENSE|^renovate\.json$|^\.coderabbit/, null],
  [/^src\/browser\/|^src\/(bridge|library|image|http-proxy)\.ts$|^types\/|^scripts\/(build-web|serve)\.ts$/, null],
  [/^test\/(?!jtreg\/)/, null],
  [/^src\/natives\/zip\.ts$|^src\/inflate\.ts$/, ["java/util/zip", "java/util/jar"]],
  [/^src\/natives\/(io|nio)\.ts$|^src\/fs\.ts$/, ["java/io", "java/nio", "java/util/zip", "java/util/jar"]],
  [/^src\/natives\/(net|sockets)\.ts$|^src\/(sockets|net-node)\.ts$|^scripts\/tls\//, ["java/net", "java/nio/channels"]],
  [/^src\/natives\/(font|java2d)[\w-]*\.ts$/, ["java/awt", "java/beans"]],
  [/^src\/natives\/management\.ts$/, ["java/lang/management"]],
];

const shardsFor = (n: number) => Array.from({ length: Math.min(4, Math.ceil(n / 400)) }, (_, i) => i + 1);
const listed = readFileSync(join(root, passingFile), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const under = (id: string, f: string) => id === f || id.startsWith(f + "/") || id.startsWith(f + "#");

function select(base: string | undefined): string[] | "all" {
  if (!base) return "all";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const filters = new Set<string>();
  for (const file of git("diff", "--name-only", "--no-renames", `${base}...HEAD`).split("\n").filter(Boolean)) {
    if (file === passingFile) {
      // the tests it adds
      for (const l of git("diff", "-U0", `${base}...HEAD`, "--", file).split("\n")) {
        if (l.startsWith("+") && !l.startsWith("+++") && !l.startsWith("+#") && l.slice(1).trim()) filters.add(l.slice(1).trim());
      }
      continue;
    }
    const hit = areas.find(([re]) => re.test(file));
    if (!hit) return "all";
    for (const f of hit[1] ?? []) filters.add(f);
  }
  return [...filters];
}

const arg = process.argv[2];
const picked = select(arg === "--full" ? undefined : arg);
const count = picked === "all" ? listed.length : listed.filter((id) => picked.some((f) => under(id, f))).length;
console.log(`filters=${picked === "all" ? "" : picked.join(" ")}`);
console.log(`shards=${JSON.stringify(count ? shardsFor(count) : [])}`);
console.error(`${count} tests${picked === "all" ? " (all)" : picked.length ? ": " + picked.join(" ") : ""}`);
