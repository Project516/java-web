import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpBackend } from "../src/browser/http.ts";

test("HTTP file reads preserve reserved characters in filenames", (t) => {
  const files = new Map([
    ["/app/a#b.txt", new Uint8Array([1, 2, 3])],
    ["/app/a?b.txt", new Uint8Array([4, 5, 6])],
    ["/app/a%20b.txt", new Uint8Array([7, 8, 9])],
    ["/app/a\\b-é.txt", new Uint8Array([10, 11, 12])],
  ]);
  class XHR {
    status = 404;
    response = new ArrayBuffer(0);
    private url!: URL;
    private range = false;
    open(_method: string, url: string) { this.url = new URL(url); }
    setRequestHeader() { this.range = true; }
    getResponseHeader(name: string) {
      if (name === "Content-Length") return "3";
      if (name === "Content-Range" && this.range) return "bytes 0-2/3";
      return null;
    }
    send() {
      const data = files.get(decodeURIComponent(this.url.pathname));
      if (!data || this.url.search || this.url.hash) return;
      this.status = this.range ? 206 : 200;
      this.response = data.slice().buffer;
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: XHR });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "XMLHttpRequest", original);
    else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  });

  for (const [path, data] of files) {
    const name = path.slice("/app".length);
    const backend = new HttpBackend("https://example.test/app");
    assert.equal(backend.stat(name)?.size, data.length, path);
    assert.deepEqual(backend.read(name), data, path);
    assert.deepEqual(new HttpBackend("https://example.test/app").readRange(name, 1, 1), data.subarray(1, 2), path);
  }
});
