// Sockets on the in-VM loopback backend, the only one a page has, and the
// hostName option. The same programs run on host sockets in programs.test.ts.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runNode } from "../src/node.ts";
import { LoopbackNet, ipv4Literal } from "../src/sockets.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, "build", "test-net");
mkdirSync(out, { recursive: true });
execFileSync(hotspot("javac"), [
  "-d", out, join(root, "test", "java", "Sockets.java"), join(root, "test", "java", "SocketEdges.java"), join(root, "test", "java", "UnixSockets.java"), join(root, "test", "java", "Http.java"), join(root, "test", "net", "HostName.java"), join(root, "test", "net", "Backlog.java"),
]);

async function run(main: string, opts: { hostName?: string } = {}) {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const code = await runNode({
    classpath: [out], mainClass: main, net: new LoopbackNet(ipv4Literal(opts.hostName)), ...opts,
    stdout: (b) => stdout.push(b), stderr: (b) => stderr.push(b),
  });
  return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

// Generous for a slow 2-core machine
const TIMEOUT = 10 * 60_000;

for (const main of ["Sockets", "SocketEdges", "UnixSockets", "Http", "Backlog"]) {
  test(`${main} on loopback sockets`, { timeout: TIMEOUT }, async () => {
    const ref = spawnSync(hotspot("java"), ["-cp", out, main], { encoding: "utf8", timeout: TIMEOUT });
    assert.equal(ref.error, undefined);
    const got = await run(main);
    assert.equal(got.stdout, ref.stdout);
    assert.equal(got.stderr, ref.stderr);
    assert.equal(got.code, ref.status);
  });
}

test("hostName sets the local host name", { timeout: TIMEOUT }, async () => {
  let got = await run("HostName", { hostName: "box.local" });
  assert.equal(got.stdout, "box.local 127.0.0.1\ntrue\ntrue true\n");
  assert.equal(got.stderr, "");
  assert.equal(got.code, 0);
  got = await run("HostName", { hostName: "10.10.90.200" });
  assert.equal(got.stdout, "10.10.90.200 10.10.90.200\ntrue\ntrue true\n");
  assert.equal(got.code, 0);
});
