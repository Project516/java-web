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

test("class metadata and contents use one request without Content-Length", (t) => {
  const calls: string[] = [];
  class XHR {
    status = 404;
    response = new ArrayBuffer(0);
    private method = "";
    private url = "";
    open(method: string, url: string) { this.method = method; this.url = url; }
    getResponseHeader(name: string) { return name === "Content-Type" ? "text/html" : null; }
    send() {
      calls.push(`${this.method} ${this.url}`);
      if (this.url.endsWith("/Found.class")) {
        this.status = 200;
        this.response = Uint8Array.of(1, 2, 3).buffer;
      }
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: XHR });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "XMLHttpRequest", original);
    else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  });
  const backend = new HttpBackend("https://example.test/app");
  assert.deepEqual(backend.stat("/Found.class"), { dir: false, size: 3, mtime: 0 });
  assert.deepEqual(backend.read("/Found.class"), Uint8Array.of(1, 2, 3));
  assert.equal(backend.stat("/Missing.class"), null);
  assert.equal(backend.read("/Missing.class"), null);
  assert.deepEqual(backend.stat("/folder"), { dir: true, size: 0, mtime: 0 });
  assert.deepEqual(calls, ["GET https://example.test/app/Found.class", "GET https://example.test/app/Missing.class", "HEAD https://example.test/app/folder"]);
});
