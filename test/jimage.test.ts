import assert from "node:assert/strict";
import { test } from "node:test";
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
