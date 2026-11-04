import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { hotspot } from "../scripts/hotspot.ts";
import { JImage } from "../src/jimage.ts";
import { VFS } from "../src/fs.ts";
import { NodeBackend } from "../src/node.ts";

test("jimage finds classes and rejects missing names", () => {
  const fs = new VFS();
  fs.mount("/jdk", new NodeBackend("build/jdk"));
  const image = new JImage(fs, "/jdk/lib/modules");
  for (const [module, name] of [["java.base", "java/lang/Object.class"], ["java.xml", "javax/xml/XMLConstants.class"]]) {
    assert.deepEqual([...image.read(module, name)!.subarray(0, 4)], [0xca, 0xfe, 0xba, 0xbe]);
  }
  assert.equal(image.read("java.base", "java/lang/NoSuchClass.class"), null);
  assert.equal(image.read("java.xml", "java/lang/Object.class"), null);
});

// Every resource the JDK's jimage tool lists, many of them behind a second
// hash seed, comes back at its size.
test("jimage reads every resource the jimage tool lists", () => {
  const fs = new VFS();
  fs.mount("/jdk", new NodeBackend("build/jdk"));
  const image = new JImage(fs, "/jdk/lib/modules");
  let module = "", n = 0;
  for (const line of execFileSync(hotspot("jimage"), ["list", "--verbose", "build/jdk/lib/modules"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n")) {
    const m = /^Module: (\S+)/.exec(line);
    if (m) module = m[1];
    const r = /^\s+\d+\s+(\d+)\s+\d+\s+(\S.*)$/.exec(line);
    if (!r) continue;
    n++;
    assert.equal(image.read(module, r[2])?.length, Number(r[1]), `${module}/${r[2]}`);
  }
  assert.ok(n > 20000, `only ${n} resources listed`);
});
