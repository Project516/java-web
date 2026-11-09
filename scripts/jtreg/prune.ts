// Moves the listed tests that add no coverage from passing.txt to
// redundant.txt. Coverage comes from a run with --coverage:
//
//   node scripts/jtreg/run.ts <jdk> --only-passing --coverage build/coverage --vm dist/node.js
//   node scripts/jtreg/prune.ts build/coverage
//
// java-web runs OpenJDK's class library unmodified, so a test only checks
// java-web where it runs java-web's own code. Fastest first (times.tsv), a
// test stays when it ran a block of the VM no test kept before it ran. Tests
// in locale-data.txt and tests without a coverage file (failed, timed out or
// not run) stay.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/jtreg/prune.ts <coverage dir>");
  process.exit(2);
}
const file = (name: string) => join(root, "test", "jtreg", name);
const list = (name: string) => existsSync(file(name))
  ? readFileSync(file(name), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];

const ids = list("passing.txt");
const times = new Map(readFileSync(file("times.tsv"), "utf8").split("\n").filter(Boolean).map((l) => {
  const [ms, id] = l.split("\t");
  return [id, Number(ms)];
}));
const median = [...times.values()].sort((a, b) => a - b)[times.size >> 1];
const ms = (id: string) => times.get(id) ?? median;
const locale = new Set(list("locale-data.txt"));
const blocksOf = (id: string) => {
  const f = join(dir, `${id.replace(/[#/]/g, "_")}.txt`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : null;
};

const covered = new Set<string>();
const keep = new Set<string>();
const candidates: [string, string[]][] = [];
for (const id of ids) {
  const blocks = blocksOf(id);
  if (!blocks || locale.has(id)) {
    keep.add(id);
    for (const b of blocks ?? []) covered.add(b);
  } else candidates.push([id, blocks]);
}
for (const [id, blocks] of candidates.sort((a, b) => ms(a[0]) - ms(b[0]))) {
  if (blocks.some((b) => !covered.has(b))) {
    keep.add(id);
    for (const b of blocks) covered.add(b);
  }
}

const drop = ids.filter((id) => !keep.has(id));
const redundant = [...new Set([...list("redundant.txt"), ...drop])].sort();
writeFileSync(file("passing.txt"), "# OpenJDK tests that pass on java-web; scripts/jtreg/run.ts --only-passing reruns them\n"
  + ids.filter((id) => keep.has(id)).join("\n") + "\n");
writeFileSync(file("redundant.txt"), "# OpenJDK tests that pass on java-web but run no java-web code that a faster test in\n"
  + "# passing.txt does not (scripts/jtreg/prune.ts). Move one back to passing.txt to run it again.\n" + redundant.join("\n") + "\n");
const min = (list: string[]) => (list.reduce((n, id) => n + ms(id), 0) / 60000).toFixed(0);
console.log(`kept ${keep.size} tests (${min([...keep])} test-minutes), moved ${drop.length} (${min(drop)} test-minutes) to redundant.txt`);
