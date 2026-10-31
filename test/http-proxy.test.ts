// Java's HTTP clients reach http: and https: URLs through fetch, on the loopback
// backend the browser uses. The fetch here is backed by a real HTTP server.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { runNode } from "../src/node.ts";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, "build", "test-http-proxy");
mkdirSync(out, { recursive: true });
execFileSync(hotspot("javac"), ["-d", out, join(root, "test", "java", "HttpProxy.java")]);

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

test("HttpURLConnection and HttpClient reach http: and https: through fetch", async () => {
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      const url = new URL(req.url!, "http://x");
      res.setHeader("X-Method", req.method!);
      if (url.pathname === "/hello") {
        const text = `hello ${url.search.slice(1)}`;
        // Node leaves the length off a HEAD response
        res.setHeader("Content-Length", Buffer.byteLength(text));
        res.end(text);
      } else if (url.pathname === "/echo") {
        res.setHeader("X-Custom", String(req.headers["x-custom"]));
        res.end(body);
      } else if (url.pathname === "/missing") {
        res.statusCode = 404;
        res.end("no such thing");
      } else if (url.pathname === "/gzip") {
        const zipped = gzipSync("zipped");
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Length", zipped.length);
        res.end(zipped);
      } else {
        res.statusCode = 204;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const calls: Call[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "down.test") throw new TypeError("fetch failed", { cause: new Error("connection refused") });
    calls.push({
      method: init?.method ?? "GET",
      url: url.href,
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: init?.body ? Buffer.from(init.body as Uint8Array).toString() : "",
    });
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };

  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const code = await runNode({
    classpath: [out], mainClass: "HttpProxy", fetch: fakeFetch,
    stdout: (b) => stdout.push(b), stderr: (b) => stderr.push(b),
  });
  server.close();
  server.closeAllConnections();
  assert.equal(Buffer.concat(stderr).toString(), "");
  assert.equal(Buffer.concat(stdout).toString(), [
    "127.0.0.2:3128 null JavaWebTLS",
    "hello a=1",
    "200 POST yes posted body",
    "200 chunked body",
    "404 no such thing",
    "200 null zipped",
    "204 -1",
    "200 10",
    "200 -1",
    "200 hello client GET",
    "200 from client",
    "IOException Server returned HTTP response code: 502 for URL: http://down.test/",
    "502 Bad Gateway: fetch failed: connection refused",
    "502",
    "JavaWebTLS JavaWebTLS",
    "hello a=1",
    "200 secure",
    "TLS_NULL_WITH_NULL_NULL",
    "SSLPeerUnverifiedException the browser verified the peer and does not pass its certificates on",
    "posted over https",
    "404 no such thing",
    "IOException Wrong HTTPS hostname: should be <strict.test>",
    "hello lenient",
    "SSLException TLS servers are not supported",
    "502 Bad Gateway: fetch failed: connection refused",
    "200 hello client HTTP_1_1 TLS_NULL_WITH_NULL_NULL",
    "200 secure from https client",
    "502",
    "local server",
    "done",
    "",
  ].join("\n"));
  assert.equal(code, 0);

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    "GET http://web.test/hello?a=1",
    "POST http://web.test/echo",
    "POST http://web.test/echo",
    "GET http://web.test/missing",
    "GET http://web.test/gzip",
    "GET http://web.test/empty",
    "HEAD http://web.test/hello?head",
    "HEAD http://web.test/gzip",
    "GET http://web.test/hello?client",
    "POST http://web.test/echo",
    "GET https://web.test/hello?a=1",
    "POST https://web.test:8443/echo",
    "GET https://web.test/missing",
    "GET https://lenient.test/hello?lenient",
    "GET https://web.test/hello?client",
    "POST https://web.test:8443/echo",
  ]);
  assert.equal(calls[1].body, "posted body");
  assert.equal(calls[1].headers["x-custom"], "yes");
  assert.equal(calls[2].body, "chunked body");
  assert.equal(calls[11].body, "posted over https");
  assert.equal(calls[11].headers["x-custom"], "secure");
  assert.equal(calls[15].body, "from https client");
  assert.equal(calls[15].headers["x-custom"], "secure");
  for (const c of calls) {
    for (const h of ["proxy-connection", "connection", "keep-alive", "host", "content-length", "transfer-encoding", "upgrade", "http2-settings"]) {
      assert.equal(c.headers[h], undefined, `${h} reached fetch`);
    }
  }
});

async function properties(opts: { props?: Record<string, string>; hostName?: string }) {
  const stdout: Uint8Array[] = [];
  await runNode({
    classpath: [out], mainClass: "HttpProxy", args: ["props"], fetch: fetch, ...opts,
    stdout: (b) => stdout.push(b), stderr: () => {},
  });
  return Buffer.concat(stdout).toString();
}

test("the page's proxy properties win over the default", async () => {
  assert.equal(await properties({ props: { "http.proxyHost": "other.test", "http.proxyPort": "1" } }), "other.test:1 null JavaWebTLS\n127.0.0.2:3128\n");
});

test("a page's own https proxy keeps the JDK's TLS", async () => {
  assert.equal(await properties({ props: { "https.proxyHost": "other.test", "https.proxyPort": "1" } }), "127.0.0.2:3128 null SUN\nother.test:1\n");
});

test("the VM's own address is not proxied", async () => {
  assert.equal(await properties({ hostName: "10.10.90.200" }), "127.0.0.2:3128 localhost|127.*|[::1]|0.0.0.0|[::0]|10.10.90.200 JavaWebTLS\n127.0.0.2:3128\n");
});

test("CONNECT opens a tunnel to the host it names, and only to that", async () => {
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response("tunneled", { headers: { "X-Seen": "yes" } });
  };
  const stdout: Uint8Array[] = [];
  await runNode({
    classpath: [out], mainClass: "HttpProxy", args: ["raw"], fetch: fakeFetch,
    stdout: (b) => stdout.push(b), stderr: () => {},
  });
  assert.deepEqual(Buffer.concat(stdout).toString().split("\n").slice(1), [
    "HTTP/1.1 400 bad CONNECT|Content-Length: 11|Connection: close||bad CONNECT",
    "HTTP/1.1 400 bad CONNECT|Content-Length: 11|Connection: close||bad CONNECT",
    "HTTP/1.1 200 Connection Established||HTTP/1.1 200 |content-type: text/plain;charset=UTF-8|x-seen: yes|Content-Length: 8|Connection: close||tunneled",
    "HTTP/1.1 200 Connection Established||HTTP/1.1 400 bad request target|Content-Length: 18|Connection: close||bad request target",
    "",
  ]);
  assert.deepEqual(urls, ["https://web.test/hello?raw"]);
});
