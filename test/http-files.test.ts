import { test } from "node:test";
import assert from "node:assert/strict";
import { addIndex, HttpBackend, PackIndex } from "../src/browser/http.ts";
import type { Pack } from "../src/browser/http.ts";

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

test("a file split across image files reads each part by range, and a missing one warns once", (t) => {
  // /lib/modules is "HEAD" "MOD" "TAIL", the middle in jdk.other.jar, which the server lacks at first
  const files = new Map([["/jdk/image.jar", new TextEncoder().encode("xHEADTAIL")], ["/jdk/jdk.other.jar", new TextEncoder().encode("MOD")]]);
  const calls: string[] = [];
  class XHR {
    status = 404;
    response = new ArrayBuffer(0);
    private url!: URL;
    private range: [number, number] | null = null;
    open(_method: string, url: string) { this.url = new URL(url); }
    setRequestHeader(_name: string, value: string) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(value)!;
      this.range = [+m[1], +m[2]];
    }
    getResponseHeader() { return null; }
    send() {
      calls.push(this.url.pathname);
      const data = files.get(this.url.pathname);
      if (!data || !this.range) return;
      this.status = 206;
      this.response = data.slice(this.range[0], this.range[1] + 1).buffer;
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: XHR });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (m: string) => warnings.push(m));
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "XMLHttpRequest", original);
    else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  });
  const pack = (): Pack => {
    const p: Pack = { files: new Map(), index: new PackIndex(), lazy: new Map(), offsets: new Map(), parts: new Map(), ranges: new Map(), lazyRanges: new Map() };
    addIndex(p, "d /lib\nf /lib/modules 11 image:1\np /lib/modules 4 jdk.other:0\np /lib/modules 7 image:5");
    return p;
  };
  const text = (d: Uint8Array | null) => d && new TextDecoder().decode(d);
  const b = new HttpBackend("https://example.test/jdk", pack());
  assert.equal(text(b.readRange("/lib/modules", 0, 11)), "HEADMODTAIL");
  assert.equal(text(b.readRange("/lib/modules", 5, 4)), "ODTA");
  files.delete("/jdk/jdk.other.jar");
  const left = new HttpBackend("https://example.test/jdk", pack());
  assert.equal(text(left.readRange("/lib/modules", 7, 4)), "TAIL");
  calls.length = 0;
  assert.equal(left.readRange("/lib/modules", 4, 3), null);
  assert.equal(left.readRange("/lib/modules", 5, 1), null);
  assert.deepEqual(calls, ["/jdk/jdk.other.jar"]);
  assert.deepEqual(warnings, ["java-web: https://example.test/jdk/jdk.other.jar is missing, so the classes in it do not load"]);
});
