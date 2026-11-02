// Picks the OpenJDK tests a change needs, for CI.
//
//   node scripts/jtreg/select.ts [<base> | --full]
//
// Prints GitHub Actions outputs: `filters`, the tests to pass to run.ts (empty
// for all of them), and `shards`, a JSON list of shard numbers ([] when no test
// is needed). Tests added to passing.txt run alone; a change to anything the
// tests load runs them all.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const passingFile = "test/jtreg/passing.txt";

// TypeScript the tests load: everything src/node.ts (the VM each test runs on),
// the runner and this selection import, followed through their imports. Other .ts files under
// src/ and scripts/ (the page API, the web build) cannot change a test's result.
function loaded(): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(join(root, file), "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+\.ts)"/g)) visit(join(dirname(file), m[1]));
  };
  visit("src/node.ts");
  visit("scripts/jtreg/run.ts");
  visit("scripts/jtreg/select.ts");
  return seen;
}
const notLoaded = /\.md$|^docs\/|^LICENSE|^renovate\.json$|^\.coderabbit|^types\/|^test\/(?!jtreg\/)/;

const shardsFor = (n: number) => Array.from({ length: Math.min(4, Math.ceil(n / 400)) }, (_, i) => i + 1);
const listed = readFileSync(join(root, passingFile), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const under = (id: string, f: string) => id === f || id.startsWith(f + "/") || id.startsWith(f + "#");

function select(base: string | undefined): string[] | "all" {
  if (!base) return "all";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const filters = new Set<string>();
  let graph: Set<string> | undefined;
  for (const file of git("diff", "--name-only", "--no-renames", `${base}...HEAD`).split("\n").filter(Boolean)) {
    if (file === passingFile) {
      // the tests it adds
      for (const l of git("diff", "-U0", `${base}...HEAD`, "--", file).split("\n")) {
        if (l.startsWith("+") && !l.startsWith("+++") && !l.startsWith("+#") && l.slice(1).trim()) filters.add(l.slice(1).trim());
      }
      continue;
    }
    const ts = /^(src|scripts)\/.*\.ts$/.test(file);
    if (ts ? (graph ??= loaded()).has(file) : !notLoaded.test(file)) return "all";
  }
  return [...filters];
}

const arg = process.argv[2];
const picked = select(arg === "--full" ? undefined : arg);
const count = picked === "all" ? listed.length : listed.filter((id) => picked.some((f) => under(id, f))).length;
console.log(`filters=${picked === "all" ? "" : picked.join(" ")}`);
console.log(`shards=${JSON.stringify(count ? shardsFor(count) : [])}`);
console.error(`${count} tests${picked === "all" ? " (all)" : picked.length ? ": " + picked.join(" ") : ""}`);
