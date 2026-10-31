// Natives implemented in JS by the embedder, CheerpJ style.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runNode } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, "build", "test-natives");

test("host natives", async () => {
  mkdirSync(out, { recursive: true });
  execFileSync(hotspot("javac"), ["-d", out, join(root, "test", "natives", "Bridge.java")]);
  const stdout: Uint8Array[] = [];
  const page: string[] = [];
  let wake: ((m: string) => void) | null = null;
  const code = await runNode({
    classpath: [out],
    mainClass: "Bridge",
    stdout: (b) => stdout.push(b),
    stderr: (b) => stdout.push(b),
    natives: {
      async Java_Bridge_send(_lib: object, json: string) {
        await new Promise((r) => setTimeout(r, 5));
        return JSON.stringify({ reply: JSON.parse(json).op });
      },
      Java_Bridge_add: (_lib: object, a: number, b: number) => a + b,
      Java_Bridge_twice: (_lib: object, v: number) => v * 2,
      Java_Bridge_not: (_lib: object, b: boolean) => !b,
      Java_Bridge_half: (_lib: object, d: number) => d / 2,
      Java_Bridge_sum: (_lib: object, a: Int32Array) => a.reduce((x, y) => x + y, 0),
      Java_Bridge_fail() { throw new Error("from js"); },
      Java_Bridge_post(_lib: object, json: string) {
        setTimeout(() => {
          const reply = `ack${JSON.parse(json).tick}`;
          if (wake) {
            wake(reply);
            wake = null;
          } else page.push(reply);
        }, 3);
      },
      Java_Bridge_receive: () => page.length ? page.shift() : new Promise<string>((r) => (wake = r)),
      async Java_Bridge_callback(lib: any, sb: any, data: Int32Array) {
        await sb.append("+js");
        data[0] = 100;
        return await (await lib.Bridge).hello();
      },
      Java_Bridge_describe: (_lib: object, self: unknown, what: string) => `${self ? "has self" : "no self"} ${what}`,
    },
  });
  assert.equal(Buffer.concat(stdout).toString("utf8"), [
    '{"reply":"ping"}',
    "42 42 true 2.5 6",
    "has self instance",
    "caught from js",
    'thread {"reply":"thread"}',
    "received ack0ack1ack2ack3ack4",
    "hello from java sb+js [100, 2, 3]",
    "",
  ].join("\n"));
  assert.equal(code, 0);
});

test("System.loadLibrary imports name.js from java.library.path", async () => {
  const dir = join(root, "test", "natives");
  mkdirSync(out, { recursive: true });
  execFileSync(hotspot("javac"), ["-d", out, join(dir, "LoadLib.java")]);
  const stdout: Uint8Array[] = [];
  const code = await runNode({
    classpath: [out],
    mainClass: "LoadLib",
    props: { "java.library.path": dir, "jdk.module.enable.native.access.0": "ALL-UNNAMED" },
    stdout: (b) => stdout.push(b),
    stderr: (b) => stdout.push(b),
  });
  assert.equal(Buffer.concat(stdout).toString("utf8"), "42\nmylib.js libnet.so\nbadlib.js: native Java_LoadLib_twice is not a function\n");
  assert.equal(code, 0);
});
