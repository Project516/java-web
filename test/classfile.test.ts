import assert from "node:assert/strict";
import { test } from "node:test";
import { ClassFormatError, Tag, className, cpEntry, parseClass, utf8 } from "../src/classfile.ts";
import { ClassWriter } from "../src/classwriter.ts";

test("constant pool retains UTF-8, references and wide constants", () => {
  const w = new ClassWriter(1, "Example", "java/lang/Object");
  const empty = w.utf8("");
  const text = w.utf8("a\0\u03bb");
  const cls = w.cls("Example");
  const str = w.string("a\0\u03bb");
  const wide = w.long(-7n);
  const cp = parseClass(w.toBytes()).cp;
  assert.equal(utf8(cp, empty), "");
  assert.equal(utf8(cp, text), "a\0\u03bb");
  assert.equal(cpEntry(cp, text)?.tag, Tag.Utf8);
  assert.equal(className(cp, cls), "Example");
  assert.equal(utf8(cp, cpEntry(cp, str)!.a), "a\0\u03bb");
  assert.equal(cpEntry(cp, wide)?.value, -7n);
  assert.equal(cpEntry(cp, wide + 1), undefined);
  assert.throws(() => utf8(cp, cls), ClassFormatError);
});
