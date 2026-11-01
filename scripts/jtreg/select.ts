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
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const passingFile = "test/jtreg/passing.txt";

// Files the OpenJDK tests never load. Natives are shared across the whole
// class library (file natives serve class loading and most tests), so any other
// change runs every test rather than guessing which areas it reaches.
const untested = /\.md$|^docs\/|^LICENSE|^renovate\.json$|^\.coderabbit|^types\/|^test\/(?!jtreg\/)|^src\/browser\/|^src\/(bridge|library|image|http-proxy)\.ts$|^scripts\/(build-web|serve)\.ts$/;

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
    if (!untested.test(file)) return "all";
  }
  return [...filters];
}

const arg = process.argv[2];
const picked = select(arg === "--full" ? undefined : arg);
const count = picked === "all" ? listed.length : listed.filter((id) => picked.some((f) => under(id, f))).length;
console.log(`filters=${picked === "all" ? "" : picked.join(" ")}`);
console.log(`shards=${JSON.stringify(count ? shardsFor(count) : [])}`);
console.error(`${count} tests${picked === "all" ? " (all)" : picked.length ? ": " + picked.join(" ") : ""}`);
