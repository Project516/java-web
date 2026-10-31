// CheerpJ-style library mode: Java classes and objects called from JS through proxies.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import type { JVM } from "../src/jvm.ts";
import { libraryOf, startLibrary } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, "build", "test-library");

let vm: JVM;
let lib: any;
let Lib: any, Counter: any, Throwable: any;

before(async () => {
  mkdirSync(out, { recursive: true });
  execFileSync(hotspot("javac"), ["-d", out, join(root, "test", "library", "Lib.java")]);
  vm = await startLibrary({
    classpath: [out],
    natives: {
      async Java_Lib_ping(lib: any, s: string) {
        const L = await lib.Lib;
        return s.toUpperCase() + (await L.hello());
      },
      async Java_Lib_00024Counter_shout(lib: any, self: any, s: string) {
        await self.inc();
        return `${s}!${await self.count}`;
      },
      // from another realm, as a parent page's natives are for java-web in an iframe
      ...runInNewContext(`({
        async Java_Lib_far(lib, s) {
          if (s === null) throw new Error("far failure");
          return s + " from afar";
        },
      })`),
    },
  });
  lib = libraryOf(vm);
  Lib = await lib.Lib;
  Counter = await lib["Lib$Counter"];
  Throwable = await lib.java.lang.Throwable;
});

after(() => vm.halt(0));

test("static calls", async () => {
  assert.equal(await vm.callStatic("Lib", "greet", ["web"]), "hello web");
  assert.equal(await vm.callStatic("Lib", "add", [2, 40]), 42);
  assert.equal(await vm.callStatic("Lib", "add", [1, 2, 3]), 6);
  assert.equal(await vm.callStatic("Lib", "not", [false]), true);
  assert.equal(await Lib.greet("again"), "hello again");
  assert.deepEqual(await Promise.all([2, 2.5, "s", 2n].map((a) => Lib.kind(a))), ["int", "double", "String", "long"]);
  await assert.rejects(Lib.kind(true), /no static method kind in Lib takes \(boolean\)/);
  await assert.rejects(vm.callStatic("Missing", "x", []), /ClassNotFoundException/);
  await assert.rejects(Lib.nope(1), /no static method nope/);
  await assert.rejects(Lib.add(1), /takes \(number\)/);
});

test("calls run in order", async () => {
  const before = await Lib.calls();
  await Promise.all([Lib.greet("a"), Lib.add(1, 2), Lib.greet("b")]);
  assert.equal(await Lib.calls(), before + 3);
});

test("classes and instanceof", async () => {
  const c = await new Counter();
  assert.ok(c instanceof Counter);
  assert.ok(c instanceof (await lib.java.lang.Runnable));
  assert.ok(c instanceof (await lib.java.lang.Object));
  assert.ok(!(c instanceof (await lib.java.util.ArrayList)));
  assert.ok(!({} instanceof Counter));
  assert.ok(!("str" as any instanceof Counter));
  await assert.rejects(Promise.resolve(lib.no.such.Klass), /ClassNotFoundException/);
  await assert.rejects(async () => new (await lib.java.lang.Runnable)(), /abstract/);
  await assert.rejects(async () => new (await lib.java.lang.Object)(1), /no constructor in java.lang.Object takes \(number\)/);
  assert.throws(() => (Counter as any)(), /use new Lib\$Counter\(\.\.\.\)/);
});

test("constructors choose by argument type", async () => {
  const before = await Counter.made;
  assert.equal(await (await new Counter()).name, "anon");
  assert.equal(await (await new Counter("x")).name, "x");
  const n = await new Counter(5);
  assert.equal(await n.name, "n5");
  assert.equal(await n.count, 5);
  assert.equal(await Counter.made, before + 3);
});

test("instance methods and objects as arguments", async () => {
  const a = await new Counter("a");
  const b = await new Counter("b");
  assert.equal(await a.inc(), 1);
  assert.equal(await a.inc(), 2);
  assert.equal(await a.describe(b), "a/b");
  assert.equal(await a.describe("s"), "a:s");
  const same = await a.self();
  assert.equal(await same.count, 2);
  assert.equal(same, a, "the same Java object is the same proxy");
  assert.notEqual(a, b);
  await a.run();
  assert.equal(await a.count, 12, "interface methods dispatch virtually");
  assert.equal(await (await Lib.make("m")).name(), "m");
  const shape = await Lib.shape();
  assert.equal(await shape.name(), "circle");
  assert.ok(shape instanceof (await lib["Lib$Shape"]), "superclasses count for instanceof");
  await assert.rejects(a.describe(1.5), /no method describe in Lib\$Counter takes \(number\)/);
  await assert.rejects(a.describe(await new (await lib.java.util.ArrayList)()), /takes \(java.util.ArrayList\)/);
});

test("fields", async () => {
  const c = await new Counter("f");
  assert.equal(await c.count, 0);
  c.count = 41;
  assert.equal(await c.inc(), 42, "a write is ordered before the next call");
  c.name = "renamed";
  assert.equal(await c.name(), "renamed");
  c.other = c;
  assert.equal(await c.other, c);
  c.other = null;
  assert.equal(await c.other, null);
  assert.deepEqual(await c.tags, ["a", "b"]);
  assert.deepEqual(Array.from(await c.data), [1, 2, 3]);
  c.data = new Int32Array([9, 8]);
  assert.deepEqual(Array.from(await c.data), [9, 8]);
  c.tags = ["q"];
  assert.deepEqual(await c.tags, ["q"]);
  const d = await new Counter(7);
  d.count = c.count;
  assert.equal(await d.count, 42, "a field passes to another without a round trip");
  assert.equal(await Lib.KIND, "lib");
  assert.equal(await Lib.tally, 3);
  Lib.tally = 10;
  assert.equal(await Lib.tally, 10);
  const log = await Lib.LOG;
  await log.append("+x");
  assert.equal(await log.toString(), "log+x");
  await assert.rejects(Promise.resolve(c.nope).then((x) => x), /no field nope in Lib\$Counter/);
  await assert.rejects(Promise.resolve(Lib.nope).then((x) => x), /no static field nope/);
  const System = await lib.java.lang.System;
  assert.equal(await System.out.println("through a static field"), undefined);
  assert.equal(await (await System.out).toString().then((s: string) => s.startsWith("java.io.PrintStream@")), true);
});

test("a field, even of a field, can be passed on without awaiting it", async () => {
  const a = await new Counter("a");
  const b = await new Counter("b");
  const c = await new Counter("c");
  a.count = 7;
  b.other = a;
  c.other = b;
  const d = await new Counter("d");
  d.count = c.other.other.count;
  d.other = c.other.other;
  assert.equal(await d.count, 7);
  assert.equal(await d.other, a);
});

test("arrays are copies in both directions", async () => {
  assert.equal(await Lib.sum(new Int32Array([1, 2, 3])), 6);
  assert.equal(await Lib.sum([1, 2, 3, 4]), 10);
  assert.equal(await Lib.total(new BigInt64Array([1n, 2n])), 3);
  assert.equal(await Lib.total([5, 6]), 11);
  const words = await Lib.words();
  assert.deepEqual(words, ["x", "y"]);
  assert.ok(await Lib.ints() instanceof Int32Array);
  assert.deepEqual(Array.from(await Lib.ints()), [4, 5, 6]);
  assert.ok(await Lib.chars() instanceof Uint16Array);
  assert.equal(await Lib.texts([["a", "b"], ["c", "d"]]), "2x2d");
  const mixed = await (await new Counter("m")).mixed();
  assert.equal(mixed.length, 4);
  assert.deepEqual([mixed[0], mixed[1], mixed[3]], ["s", 1, null]);
  assert.equal(await mixed[2].name(), "m");
});

test("typed array arguments receive what Java wrote", async () => {
  const b = new Int8Array(4);
  await Lib.fill(b);
  assert.deepEqual(Array.from(b), [1, 2, 3, 4]);
  const u = new Uint8Array(3);
  await Lib.fill(u);
  assert.deepEqual(Array.from(u), [1, 2, 3], "a Uint8Array works for byte[]");
  const z = new Uint8Array([1, 0, 1]);
  await Lib.flip(z);
  assert.deepEqual(Array.from(z), [0, 1, 0], "a Uint8Array is boolean[] when that fits");
  const same = new Int32Array([1, 2]);
  await Lib.untouched(same);
  assert.deepEqual(Array.from(same), [1, 2]);
  const Arrays = await lib.java.util.Arrays;
  const x = new Int32Array(4);
  await Arrays.fill(x, 7);
  assert.deepEqual(Array.from(x), [7, 7, 7, 7]);
  const y = new Int32Array([3, 1, 2]);
  await Arrays.sort(y);
  assert.deepEqual(Array.from(y), [1, 2, 3]);
  assert.equal(await Arrays.toString(y), "[1, 2, 3]");
  assert.equal(await Arrays.toString(["a", "b"]), "[a, b]");
});

test("boxed values are JS primitives", async () => {
  assert.equal(await Lib.boxed(0), 7);
  assert.equal(await Lib.boxed(1), true);
  assert.equal(await Lib.boxed(2), 1.5);
  assert.equal(await Lib.boxed(3), 2 ** 40);
  assert.deepEqual(await Promise.all([1, 1.5, "s", true, 2n, null].map((v) => Lib.typeOf(v))), ["Integer", "Double", "String", "Boolean", "Long", "null"]);
  const list = await new (await lib.java.util.ArrayList)();
  await list.add(5);
  await list.add("six");
  assert.equal(await list.get(0), 5);
  assert.equal(await list.get(1), "six");
  assert.equal(await list.size(), 2);
});

test("overloads score each argument", async () => {
  const Math = await lib.java.lang.Math;
  assert.deepEqual(await Promise.all([Math.abs(-2), Math.abs(-2.5), Math.max(3, 9), Math.sqrt(16)]), [2, 2.5, 9, 4]);
  const String = await lib.java.lang.String;
  assert.deepEqual(await Promise.all([String.valueOf(5), String.valueOf(true), String.valueOf("x")]), ["5", "true", "x"]);
  assert.equal(await Lib.pick("s"), "CharSequence");
  assert.equal(await Lib.pick(await new (await lib.java.lang.StringBuilder)()), "StringBuilder");
  assert.equal(await Lib.pick(await new Counter()), "Object");
  assert.equal(await Lib.pick(5), "Object");
});

test("varargs", async () => {
  assert.equal(await Lib.join("-", "a", "b", "c"), "a-b-c");
  assert.equal(await Lib.join("-"), "");
  assert.equal(await Lib.join("-", "a"), "a");
  assert.equal(await Lib.join("-", ["x", "y"]), "x-y", "an array fills the varargs parameter");
  assert.equal(await Lib.count(1, "a", null), 3);
  assert.equal(await Lib.count(), 0);
  assert.equal(await Lib.count(["a", "b"]), 2);
  const c = await new Counter("v");
  assert.equal(await c.join("+", "p", "q"), "p+q");
  const String = await lib.java.lang.String;
  assert.equal(await String.format("%s-%d", "a", 3), "a-3");
  const Paths = await lib.java.nio.file.Paths;
  assert.equal(await (await Paths.get("/tmp", "a", "b")).toString(), "/tmp/a/b");
  const Arrays = await lib.java.util.Arrays;
  assert.equal(await (await Arrays.asList(1, 2, 3)).size(), 3);
});

test("exceptions are throwable proxies", async () => {
  const IOException = await lib.java.io.IOException;
  const c = await new Counter();
  let caught: any;
  try {
    await c.fail();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof IOException);
  assert.ok(caught instanceof Throwable);
  assert.ok(caught instanceof Error);
  assert.ok(!(caught instanceof (await lib.java.lang.IllegalStateException)));
  assert.equal(await (caught as any).getMessage(), "disk full");
  assert.equal(caught.message, "java.io.IOException: disk full");
  await assert.rejects(Lib.fail("no"), (e: any) => e instanceof Error && /java.lang.IllegalStateException: no/.test(e.message));
  const thrown: any = await Lib.fail("again").catch((e: any) => e);
  assert.equal(await thrown.getMessage(), "again");
  await assert.rejects(async () => (await lib.java.lang.Integer).parseInt("x"), /NumberFormatException/);
});

test("natives get this, object arguments and a working lib", async () => {
  assert.equal(await Lib.viaNative("a"), "java got Ahello from java");
  const c = await new Counter("n");
  assert.equal(await c.twice("hi"), "hi!1!2");
  assert.equal(await c.count, 2);
});

test("natives from another realm return promises and throw errors", async () => {
  assert.equal(await Lib.viaFar("hi"), "java got hi from afar");
  assert.equal(await Lib.viaFarFailure(), "far failure");
});

test("handles are released when the page drops its proxies", async () => {
  const live = () => vm.library.handleCount;
  const before = live();
  await (async () => {
    for (let i = 0; i < 50; i++) await Lib.make("tmp" + i);
  })();
  for (let i = 0; i < 100 && live() > before + 2; i++) {
    (globalThis as any).gc();
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(live() <= before + 2, `${live() - before} handles left`);
  const kept = await Lib.make("kept");
  (globalThis as any).gc();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await kept.name(), "kept", "a proxy still in use keeps its object");
});

test("a proxy handed out again is reused", async () => {
  const c = await Lib.make("again");
  const ids = new Set<unknown>();
  for (let i = 0; i < 5; i++) ids.add(await c.self());
  assert.equal(ids.size, 1);
  assert.equal([...ids][0], c);
});

test("calls after the VM exits fail", async () => {
  const other = await startLibrary({ classpath: [out] });
  const OtherLib = await libraryOf(other).Lib;
  assert.equal(await OtherLib.greet("x"), "hello x");
  other.halt(0);
  await assert.rejects(OtherLib.greet("y"), /VM has exited/);
});
