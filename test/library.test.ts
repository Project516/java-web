// Library mode in the VM: requests and wire values, with no JS proxies on top
// (bridge.test.ts has those).

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import type { JVM } from "../src/jvm.ts";
import type { Handle, LibraryRequest } from "../src/library.ts";
import { LibraryError } from "../src/library.ts";
import { startLibrary } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, "build", "test-library");

let vm: JVM;

const val = (r: LibraryRequest) => vm.library.request(r).then((x) => x.value);
const stat = (cls: string, method: string, ...args: unknown[]) => val({ op: "static", cls, method, args });
const make = (cls: string, ...args: unknown[]) => val({ op: "new", cls, args }) as Promise<Handle>;
const call = (h: Handle, method: string, ...args: unknown[]) => val({ op: "call", obj: h.$java, method, args });
const get = (h: Handle, field: string) => val({ op: "get", obj: h.$java, field });
const set = (h: Handle, field: string, value: unknown) => val({ op: "set", obj: h.$java, field, value });
const Counter = "Lib$Counter";

before(async () => {
  mkdirSync(out, { recursive: true });
  execFileSync(hotspot("javac"), ["-d", out, join(root, "test", "library", "Lib.java")]);
  vm = await startLibrary({ classpath: [out] });
});

after(() => vm.halt(0));

test("static calls", async () => {
  assert.equal(await vm.callStatic("Lib", "greet", ["web"]), "hello web");
  assert.equal(await vm.callStatic("Lib", "add", [2, 40]), 42);
  assert.equal(await vm.callStatic("Lib", "add", [1, 2, 3]), 6);
  assert.equal(await vm.callStatic("Lib", "not", [false]), true);
  assert.equal(await stat("Lib", "calls"), 2);
  assert.deepEqual(await Promise.all([2, 2.5, "s", 2n].map((a) => stat("Lib", "kind", a))), ["int", "double", "String", "long"]);
  await assert.rejects(stat("Lib", "kind", true), /no static method kind in Lib takes \(boolean\)/);
  await assert.rejects(vm.callStatic("Missing", "x", []), /ClassNotFoundException/);
  await assert.rejects(stat("Lib", "nope", 1), /no static method nope/);
  await assert.rejects(stat("Lib", "add", 1), /takes \(number\)/);
});

test("calls run in order", async () => {
  const before = (await stat("Lib", "calls")) as number;
  await Promise.all([stat("Lib", "greet", "a"), stat("Lib", "add", 1, 2), stat("Lib", "greet", "b")]);
  assert.equal(await stat("Lib", "calls"), before + 3);
});

test("objects are handles that name their class once", async () => {
  const a = await make(Counter, "a");
  assert.equal(a.cls, "Lib$Counter");
  assert.ok(a.supers?.includes("java.lang.Runnable") && a.supers.includes("java.lang.Object"));
  const b = await make(Counter, "b");
  assert.equal(b.supers, undefined, "the supers of a class go out with its first handle");
  assert.notEqual(a.$java, b.$java);
  assert.equal(((await call(a, "self")) as Handle).$java, a.$java, "an object keeps its id");
  assert.equal(await call(a, "describe", b), "a/b", "a handle is an argument");
  assert.equal(await call(a, "describe", "s"), "a:s");
  assert.equal(await call(a, "inc"), 1);
  await call(a, "run");
  assert.equal(await get(a, "count"), 11, "interface methods dispatch virtually");
  await assert.rejects(call(a, "describe", 1.5), /no method describe in Lib\$Counter takes \(number\)/);
  await assert.rejects(make("java.lang.Runnable"), /abstract/);
  await assert.rejects(make("java.lang.Object", 1), /no constructor in java.lang.Object takes \(number\)/);
});

test("constructors choose by argument type", async () => {
  assert.equal(await get(await make(Counter), "name"), "anon");
  assert.equal(await get(await make(Counter, "x"), "name"), "x");
  const n = await make(Counter, 5);
  assert.equal(await get(n, "name"), "n5");
  assert.equal(await get(n, "count"), 5);
});

test("fields", async () => {
  const c = await make(Counter, "f");
  await set(c, "count", 41);
  assert.equal(await call(c, "inc"), 42);
  await set(c, "other", c);
  assert.equal(((await get(c, "other")) as Handle).$java, c.$java);
  await set(c, "other", null);
  assert.equal(await get(c, "other"), null);
  assert.deepEqual(await get(c, "tags"), ["a", "b"]);
  assert.deepEqual(Array.from((await get(c, "data")) as Int32Array), [1, 2, 3]);
  await set(c, "data", new Int32Array([9, 8]));
  assert.deepEqual(Array.from((await get(c, "data")) as Int32Array), [9, 8]);
  await set(c, "tags", ["q"]);
  assert.deepEqual(await get(c, "tags"), ["q"]);
  assert.equal(await val({ op: "getStatic", cls: "Lib", field: "KIND" }), "lib");
  await val({ op: "setStatic", cls: "Lib", field: "tally", value: 10 });
  assert.equal(await val({ op: "getStatic", cls: "Lib", field: "tally" }), 10);
  await assert.rejects(get(c, "nope"), /no field nope in Lib\$Counter/);
  await assert.rejects(val({ op: "getStatic", cls: "Lib", field: "nope" }), /no static field nope/);
  await assert.rejects(get(c, "made"), /no field made/, "a static field is not an instance field");
});

test("a field read can stand in for a value", async () => {
  const a = await make(Counter, "a");
  const b = await make(Counter, "b");
  const c = await make(Counter, "c");
  await set(a, "count", 7);
  await set(b, "count", { $get: [a.$java, "count"] });
  assert.equal(await get(b, "count"), 7);
  await set(b, "other", c);
  await set(a, "other", b);
  await set(c, "count", { $get: [{ $get: [a.$java, "other"] }, "count"] });
  assert.equal(await get(c, "count"), 7, "the target of a field read can be a field read");
  await set(b, "other", null);
  await assert.rejects(set(c, "count", { $get: [{ $get: [b.$java, "other"] }, "count"] }), /other is not a Java object/);
  assert.deepEqual(await stat("Lib", "join", "-", { $get: ["Lib", "KIND"] }, "x"), "lib-x", "static fields too");
});

test("arrays are copies in both directions", async () => {
  assert.equal(await stat("Lib", "sum", new Int32Array([1, 2, 3])), 6);
  assert.equal(await stat("Lib", "sum", [1, 2, 3, 4]), 10);
  assert.equal(await stat("Lib", "total", new BigInt64Array([1n, 2n])), 3);
  assert.equal(await stat("Lib", "total", [5, 6]), 11);
  assert.deepEqual(await stat("Lib", "words"), ["x", "y"]);
  const ints = (await stat("Lib", "ints")) as Int32Array;
  assert.ok(ints instanceof Int32Array);
  assert.deepEqual(Array.from(ints), [4, 5, 6]);
  assert.ok((await stat("Lib", "chars")) instanceof Uint16Array);
  assert.equal(await stat("Lib", "texts", [["a", "b"], ["c", "d"]]), "2x2d");
  const mixed = (await call(await make(Counter, "m"), "mixed")) as unknown[];
  assert.equal(mixed.length, 4);
  assert.deepEqual([mixed[0], mixed[1], mixed[3]], ["s", 1, null]);
  assert.equal(await call(mixed[2] as Handle, "name"), "m");
});

test("typed array arguments come back with what Java wrote", async () => {
  const fill = (a: ArrayBufferView) => vm.library.request({ op: "static", cls: "Lib", method: "fill", args: [a] });
  const bytes = await fill(new Int8Array(4));
  assert.deepEqual(bytes.back?.map(([i, d]) => [i, Array.from(d as Int8Array)]), [[0, [1, 2, 3, 4]]]);
  const viaUint8 = await fill(new Uint8Array(3));
  assert.deepEqual(viaUint8.back?.map(([, d]) => Array.from(d as Int8Array)), [[1, 2, 3]], "a Uint8Array fits byte[]");
  const flipped = await vm.library.request({ op: "static", cls: "Lib", method: "flip", args: [new Uint8Array([1, 0, 1])] });
  assert.deepEqual(flipped.back?.map(([, d]) => Array.from(d as Uint8Array)), [[0, 1, 0]], "a Uint8Array is boolean[] when that fits");
  const same = await vm.library.request({ op: "static", cls: "Lib", method: "untouched", args: [new Int32Array([1, 2])] });
  assert.equal(same.back, undefined, "an unchanged array is not sent back");
  const sorted = await vm.library.request({ op: "static", cls: "java.util.Arrays", method: "sort", args: [new Int32Array([3, 1, 2])] });
  assert.deepEqual(sorted.back?.map(([, d]) => Array.from(d as Int32Array)), [[1, 2, 3]]);
});

test("boxed values are JS primitives", async () => {
  assert.equal(await stat("Lib", "boxed", 0), 7);
  assert.equal(await stat("Lib", "boxed", 1), true);
  assert.equal(await stat("Lib", "boxed", 2), 1.5);
  assert.equal(await stat("Lib", "boxed", 3), 2 ** 40);
  assert.deepEqual(await Promise.all([1, 1.5, "s", true, 2n, 2 ** 40, null].map((v) => stat("Lib", "typeOf", v))), ["Integer", "Double", "String", "Boolean", "Long", "Long", "null"]);
  const list = await make("java.util.ArrayList");
  await call(list, "add", 5);
  await call(list, "add", "six");
  assert.equal(await call(list, "get", 0), 5);
  assert.equal(await call(list, "get", 1), "six");
});

test("overloads score each argument", async () => {
  assert.deepEqual(await Promise.all([-2, -2.5].map((x) => stat("java.lang.Math", "abs", x))), [2, 2.5]);
  assert.equal(await stat("java.lang.Math", "max", 3, 9), 9);
  assert.deepEqual(await Promise.all([5, true, "x"].map((x) => stat("java.lang.String", "valueOf", x))), ["5", "true", "x"]);
  assert.equal(await stat("Lib", "pick", "s"), "CharSequence");
  assert.equal(await stat("Lib", "pick", await make("java.lang.StringBuilder")), "StringBuilder");
  assert.equal(await stat("Lib", "pick", await make(Counter)), "Object");
  assert.equal(await stat("Lib", "pick", 5), "Object");
});

test("varargs take no, one or several trailing arguments, or an array", async () => {
  assert.equal(await stat("Lib", "join", "-"), "");
  assert.equal(await stat("Lib", "join", "-", "a"), "a");
  assert.equal(await stat("Lib", "join", "-", "a", "b", "c"), "a-b-c");
  assert.equal(await stat("Lib", "join", "-", ["x", "y"]), "x-y");
  assert.equal(await stat("Lib", "count"), 0);
  assert.equal(await stat("Lib", "count", 1), 1);
  assert.equal(await stat("Lib", "count", 1, "a", null), 3);
  assert.equal(await stat("Lib", "count", ["a", "b"]), 2);
  assert.equal(await call(await make(Counter, "v"), "join", "+", "p", "q"), "p+q");
  assert.equal(await stat("java.lang.String", "format", "%s-%d", "a", 3), "a-3");
  const path = (await stat("java.nio.file.Paths", "get", "/tmp", "a", "b")) as Handle;
  assert.equal(await call(path, "toString"), "/tmp/a/b");
  assert.equal(await call((await stat("java.util.Arrays", "asList", 1, 2, 3)) as Handle, "size"), 3);
});

test("exceptions carry a handle to the throwable", async () => {
  const failed = (await make(Counter).then((c) => call(c, "fail")).catch((e) => e)) as LibraryError;
  assert.ok(failed instanceof LibraryError);
  assert.equal(failed.message, "java.io.IOException: disk full");
  const t = failed.throwable as Handle;
  assert.equal(t.cls, "java.io.IOException");
  assert.equal(t.msg, "java.io.IOException: disk full");
  assert.ok(t.supers?.includes("java.lang.Throwable"));
  assert.equal(await call(t, "getMessage"), "disk full");
  await assert.rejects(stat("Lib", "fail", "no"), /java.lang.IllegalStateException: no/);
});

test("handles are counted and released", async () => {
  const before = vm.library.handleCount;
  const a = await make(Counter, "r");
  const again = (await call(a, "self")) as Handle;
  assert.equal(again.$java, a.$java);
  assert.equal(vm.library.handleCount, before + 1);
  vm.library.release([[a.$java, 1]]);
  assert.equal(await call(a, "name"), "r", "one reference is still out");
  vm.library.release([[a.$java, 1]]);
  assert.equal(vm.library.handleCount, before);
  await assert.rejects(call(a, "name"), /released/);
});

test("calls after the VM exits fail", async () => {
  const other = await startLibrary({ classpath: [out] });
  assert.equal(await other.callStatic("Lib", "greet", ["x"]), "hello x");
  other.halt(0);
  await assert.rejects(other.callStatic("Lib", "greet", ["y"]), /VM has exited/);
});
