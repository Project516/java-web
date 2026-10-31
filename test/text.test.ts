// Text drawing on the bundled font. Pixels cannot match HotSpot's FreeType
// output, so test/text/TextChecks.java checks properties that hold on any
// font and prints one "ok" or "FAIL" line per check. test/text/FontMatch.java
// covers what the rasterizer does not touch, against HotSpot.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runNode } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, "build", "test-text");

test("text drawing", async () => {
  mkdirSync(out, { recursive: true });
  execFileSync(hotspot("javac"), ["-d", out, join(root, "test", "text", "TextChecks.java")]);
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const code = await runNode({
    classpath: [out],
    mainClass: "TextChecks",
    stdout: (b) => stdout.push(b),
    stderr: (b) => stderr.push(b),
  });
  const lines = Buffer.concat(stdout).toString("utf8").trim().split("\n");
  assert.deepEqual(lines.filter((l) => !l.startsWith("ok ")), ["done"]);
  assert.ok(lines.length > 100, `${lines.length} checks`);
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  assert.equal(code, 0);
});

test("font metrics and outlines match HotSpot", async () => {
  mkdirSync(out, { recursive: true });
  execFileSync(hotspot("javac"), ["-d", out, join(root, "test", "text", "FontMatch.java")]);
  const expected = execFileSync(hotspot("java"), ["-cp", out, "FontMatch", join(root, "build", "jdk", "lib", "fonts", "DejaVuSans.ttf")], { encoding: "utf8" });
  const stdout: Uint8Array[] = [];
  const code = await runNode({
    classpath: [out],
    mainClass: "FontMatch",
    args: ["/jdk/lib/fonts/DejaVuSans.ttf"],
    stdout: (b) => stdout.push(b),
    stderr: (b) => process.stderr.write(b),
  });
  assert.equal(Buffer.concat(stdout).toString("utf8"), expected);
  assert.equal(code, 0);
});
