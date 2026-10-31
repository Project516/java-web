// A virtual HTTP proxy for the loopback backend. A stream socket connected to
// PROXY_HOST:PROXY_PORT has this code as its peer: it parses the HTTP/1.1
// requests Java writes and answers them with fetch. For https:, Java sends
// CONNECT and then plain HTTP inside the tunnel (the javaweb.tls provider
// skips TLS), and fetch does the TLS to the host the CONNECT named.

import { closePeer } from "./sockets.ts";
import type { Sock } from "./sockets.ts";

// 127.0.0.2 is not the address of any server a page would run, and 3128 is the usual proxy port
export const PROXY_HOST = "127.0.0.2";
export const PROXY_PORT = 3128;

const MAX_HEAD = 64 * 1024;
const AUTHORITY = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+):(\d{1,5})$/i;
// the connection's own headers, and ones fetch sets for itself
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer",
  "transfer-encoding", "upgrade", "http2-settings", "host", "content-length", "expect",
]);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Head {
  method: string;
  target: string;
  close: boolean;
  headers: Headers;
  chunked: boolean;
  length: number;
}

interface Request extends Head {
  body: Uint8Array;
}

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

const bytes = (s: string) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

function find(buf: Uint8Array, needle: string, from: number): number {
  const n = needle.length;
  outer: for (let i = from; i <= buf.length - n; i++) {
    for (let j = 0; j < n; j++) if (buf[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

function parseHead(text: string): Head {
  const lines = text.split("\r\n");
  const m = /^([A-Za-z]+) (\S+) HTTP\/(\d)\.(\d)$/.exec(lines[0]);
  if (!m) throw new HttpError(400, "bad request line");
  const headers = new Headers();
  try {
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i <= 0) throw new Error();
      headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
  } catch {
    throw new HttpError(400, "bad header");
  }
  const chunked = /chunked/i.test(headers.get("transfer-encoding") ?? "");
  const length = Number(headers.get("content-length") ?? 0);
  if (!(length >= 0) || !Number.isInteger(length)) throw new HttpError(400, "bad Content-Length");
  const close = /close/i.test(headers.get("connection") ?? "") || (m[3] === "1" && m[4] === "0");
  return { method: m[1].toUpperCase(), target: m[2], close, headers, chunked, length };
}

// The decoded body and the bytes it took, or null until the whole body has arrived.
function dechunk(buf: Uint8Array): { body: Uint8Array; used: number } | null {
  const parts: Uint8Array[] = [];
  let pos = 0, total = 0;
  for (;;) {
    const eol = find(buf, "\r\n", pos);
    if (eol < 0) return null;
    const size = parseInt(latin1(buf.subarray(pos, eol)), 16);
    if (!(size >= 0)) throw new HttpError(400, "bad chunk size");
    pos = eol + 2;
    if (size === 0) {
      for (;;) {
        const e = find(buf, "\r\n", pos);
        if (e < 0) return null;
        const blank = e === pos;
        pos = e + 2;
        if (blank) break;
      }
      const body = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        body.set(p, at);
        at += p.length;
      }
      return { body, used: pos };
    }
    if (buf.length < pos + size + 2) return null;
    parts.push(buf.subarray(pos, pos + size));
    total += size;
    pos += size + 2;
  }
}

// b is the proxy's end of a connected stream socket.
export function serveProxy(b: Sock, fetchFn: typeof fetch) {
  new ProxyConnection(b, fetchFn);
}

class ProxyConnection {
  private b: Sock;
  private fetch: typeof fetch;
  private buf = new Uint8Array(0);
  private head: Head | null = null;
  private continued = false;
  // host[:port] of an https: origin once CONNECT has been answered
  private tunnel: string | null = null;
  private busy = false;
  private done = false;

  constructor(b: Sock, fetchFn: typeof fetch) {
    this.b = b;
    this.fetch = fetchFn;
    b.watchers.add(() => this.pump());
  }

  private async pump() {
    if (this.busy || this.done) return;
    this.busy = true;
    try {
      for (;;) {
        this.fill();
        const req = this.parse();
        if (!req) break;
        if (!(await this.serve(req))) return this.finish();
      }
      if (this.b.eof) this.finish();
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, String(e));
      this.reply(err.status, err.message, [], new TextEncoder().encode(err.message), true);
      this.finish();
    } finally {
      this.busy = false;
    }
  }

  private fill() {
    const n = this.b.rxBytes;
    if (n === 0) return;
    const grown = new Uint8Array(this.buf.length + n);
    grown.set(this.buf);
    this.b.take(grown, this.buf.length, n);
    this.buf = grown;
  }

  private finish() {
    this.done = true;
    this.b.watchers.clear();
    closePeer(this.b);
  }

  private parse(): Request | null {
    if (!this.head) {
      const end = find(this.buf, "\r\n\r\n", 0);
      if (end < 0) {
        if (this.buf.length > MAX_HEAD) throw new HttpError(431, "request header too large");
        return null;
      }
      this.head = parseHead(latin1(this.buf.subarray(0, end)));
      this.buf = this.buf.subarray(end + 4);
      this.continued = false;
    }
    const h = this.head;
    let body: Uint8Array | null = null;
    if (h.chunked) {
      const c = dechunk(this.buf);
      if (c) {
        body = c.body;
        this.buf = this.buf.subarray(c.used);
      }
    } else if (this.buf.length >= h.length) {
      body = this.buf.slice(0, h.length);
      this.buf = this.buf.subarray(h.length);
    }
    if (!body) {
      if (!this.continued && /100-continue/i.test(h.headers.get("expect") ?? "")) {
        this.continued = true;
        this.b.peer?.push(bytes("HTTP/1.1 100 Continue\r\n\r\n"));
      }
      return null;
    }
    this.head = null;
    return { ...h, body };
  }

  // Answers one request; false when the connection should end.
  private async serve(r: Request): Promise<boolean> {
    if (r.method === "CONNECT") return this.connect(r);
    let url = r.target;
    if (this.tunnel) {
      if (!url.startsWith("/")) throw new HttpError(400, "bad request target");
      url = `https://${this.tunnel}${url}`;
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      const host = r.headers.get("host");
      if (!host) throw new HttpError(400, "no host");
      url = `http://${host}${url}`;
    }
    for (const name of HOP_BY_HOP) r.headers.delete(name);
    try {
      const body = r.method === "GET" || r.method === "HEAD" || r.body.length === 0 ? undefined : (r.body as Uint8Array<ArrayBuffer>);
      const res = await this.fetch(url, { method: r.method, headers: r.headers, body });
      const data = new Uint8Array(await res.arrayBuffer());
      const headers: [string, string][] = [];
      // fetch has decoded the body already
      for (const [k, v] of res.headers) if (!HOP_BY_HOP.has(k) && k !== "content-encoding") headers.push([k, v]);
      // a HEAD response has no body, but its length is the resource's, unless fetch would decode it
      // (a CORS response hides Content-Encoding, so its length can't be trusted); null leaves it unknown
      const origin = res.headers.get("content-length");
      const plain = res.type !== "cors" && !res.headers.has("content-encoding");
      const length = r.method !== "HEAD" ? undefined : plain && /^\d+$/.test(origin ?? "") ? origin : null;
      return this.reply(res.status, res.statusText, headers, data, r.close, length);
    } catch (e: any) {
      const why = [e?.message, e?.cause?.message].filter(Boolean).join(": ");
      return this.reply(502, "Bad Gateway", [], new TextEncoder().encode(`Bad Gateway: ${why || e}`), r.close);
    }
  }

  // The rest of the connection is plain HTTP for this origin.
  private connect(r: Request): boolean {
    const m = AUTHORITY.exec(r.target);
    if (this.tunnel || !m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new HttpError(400, "bad CONNECT");
    this.tunnel = m[2] === "443" ? m[1] : r.target;
    this.b.peer?.push(bytes("HTTP/1.1 200 Connection Established\r\n\r\n"));
    return true;
  }

  // Writes a response to Java; false when the connection should end.
  private reply(status: number, text: string, headers: [string, string][], body: Uint8Array, close: boolean, length?: string | null): boolean {
    const out = this.b.peer;
    if (!out) return false;
    const bodiless = status === 204 || status === 304;
    const lines = [`HTTP/1.1 ${status} ${text}`];
    for (const [k, v] of headers) lines.push(`${k}: ${v.replace(/[\r\n]+/g, " ")}`);
    if (!bodiless && length !== null) lines.push(`Content-Length: ${length ?? body.length}`);
    if (close) lines.push("Connection: close");
    const head = bytes(lines.join("\r\n") + "\r\n\r\n");
    out.push(head);
    if (!bodiless) out.push(body);
    return !close;
  }
}
