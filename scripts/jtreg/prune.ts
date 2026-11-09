// Splits the tests of passing.txt and redundant.txt between the two by what
// they cover. Coverage comes from a run with --coverage, which reruns both:
//
//   node scripts/jtreg/run.ts <jdk> --only-passing --coverage build/coverage --vm dist/node.js
//   node scripts/jtreg/prune.ts build/coverage
//
// java-web runs OpenJDK's class library unmodified, so a test only checks
// java-web where it runs java-web's own code. Fastest first (times.tsv), a
// test goes in passing.txt when it ran a block of the VM no test before it
// there ran, and in redundant.txt otherwise. Tests in locale-data.txt stay in
// passing.txt, and a test without a coverage file (it failed, timed out or did
// not run) stays in the list it was in.

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

const passing = list("passing.txt"), wasRedundant = list("redundant.txt").filter((id) => !passing.includes(id));
const times = new Map((existsSync(file("times.tsv")) ? readFileSync(file("times.tsv"), "utf8") : "").split("\n").filter(Boolean).map((l) => {
  const [ms, id] = l.split("\t");
  return [id, Number(ms)];
}));
const median = [...times.values()].sort((a, b) => a - b)[times.size >> 1] ?? 0;
const ms = (id: string) => times.get(id) ?? median;
const locale = new Set(list("locale-data.txt"));
const blocksOf = (id: string) => {
  const f = join(dir, `${id.replace(/[#/]/g, "_")}.txt`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : null;
};

const covered = new Set<string>();
const keep = new Set<string>(), drop = new Set<string>();
const candidates: [string, string[]][] = [];
for (const id of [...passing, ...wasRedundant]) {
  const blocks = blocksOf(id);
  if (!blocks) (passing.includes(id) ? keep : drop).add(id);
  else if (locale.has(id)) keep.add(id);
  else {
    candidates.push([id, blocks]);
    continue;
  }
  for (const b of blocks ?? []) covered.add(b);
}
for (const [id, blocks] of candidates.sort((a, b) => ms(a[0]) - ms(b[0]))) {
  if (blocks.some((b) => !covered.has(b))) {
    keep.add(id);
    for (const b of blocks) covered.add(b);
  } else drop.add(id);
}

writeFileSync(file("passing.txt"), "# OpenJDK tests that pass on java-web; scripts/jtreg/run.ts --only-passing reruns them\n"
  + [...keep].sort().join("\n") + "\n");
writeFileSync(file("redundant.txt"), "# OpenJDK tests that pass on java-web but run no java-web code that a faster test in\n"
  + "# passing.txt does not (scripts/jtreg/prune.ts). To run one again, move it to passing.txt.\n" + [...drop].sort().join("\n") + "\n");
const min = (ids: Set<string>) => ([...ids].reduce((n, id) => n + ms(id), 0) / 60000).toFixed(0);
console.log(`passing.txt: ${keep.size} tests (${min(keep)} test-minutes); redundant.txt: ${drop.size} (${min(drop)} test-minutes)`);
