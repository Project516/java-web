// Sockets as the JDK's natives see them: file descriptors for stream, datagram
// and event sockets with POSIX readiness. A backend moves the bytes: host
// sockets under Node (net-node.ts), or this file's in-VM loopback.

import { PROXY_HOST, PROXY_PORT, serveProxy } from "./http-proxy.ts";

export const POLLIN = 1, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32;

export const EPERM = 1, ENOENT = 2, EBADF = 9, EAGAIN = 11, EACCES = 13, EINVAL = 22, EPIPE = 32, ENOPROTOOPT = 92,
  EOPNOTSUPP = 95, EAFNOSUPPORT = 97, EADDRINUSE = 98, EADDRNOTAVAIL = 99, ENETUNREACH = 101, ECONNABORTED = 103,
  ECONNRESET = 104, ENOBUFS = 105, EISCONN = 106, ENOTCONN = 107, ETIMEDOUT = 110, ECONNREFUSED = 111,
  EHOSTUNREACH = 113, EINPROGRESS = 115, EMSGSIZE = 90;

const MESSAGES: Record<number, string> = {
  [EPERM]: "Operation not permitted", [ENOENT]: "No such file or directory", [EBADF]: "Bad file descriptor",
  [19]: "No such device", [EAGAIN]: "Resource temporarily unavailable", [EACCES]: "Permission denied", [EINVAL]: "Invalid argument",
  [EPIPE]: "Broken pipe", [EMSGSIZE]: "Message too long", [ENOPROTOOPT]: "Protocol not available",
  [EOPNOTSUPP]: "Operation not supported", [EAFNOSUPPORT]: "Address family not supported by protocol",
  [EADDRINUSE]: "Address already in use", [EADDRNOTAVAIL]: "Cannot assign requested address",
  [ENETUNREACH]: "Network is unreachable", [ECONNABORTED]: "Software caused connection abort",
  [ECONNRESET]: "Connection reset by peer", [ENOBUFS]: "No buffer space available",
  [EISCONN]: "Transport endpoint is already connected", [ENOTCONN]: "Transport endpoint is not connected",
  [ETIMEDOUT]: "Connection timed out", [ECONNREFUSED]: "Connection refused", [EHOSTUNREACH]: "No route to host",
  [EINPROGRESS]: "Operation now in progress",
};

export function strerror(errno: number): string {
  return MESSAGES[errno] ?? `Unknown error ${errno}`;
}

// IPv4 only: an address is 4 bytes
export interface Endpoint {
  addr: Uint8Array;
  port: number;
}

export interface Datagram {
  from: Endpoint;
  data: Uint8Array;
}

export interface NetIf {
  name: string;
  index: number;
  up: boolean;
  loopback: boolean;
  p2p: boolean;
  multicast: boolean;
  mtu: number;
  mac: Uint8Array | null;
  addrs: { addr: Uint8Array; prefix: number; broadcast: Uint8Array | null }[];
}

export interface NetBackend {
  hostName(): string;
  interfaces(): NetIf[];
  // IPv4 addresses of a name, or null when it does not resolve
  lookup(host: string): Promise<Uint8Array[] | null>;
  lookupAddr(addr: Uint8Array): Promise<string | null>;
  // each of these returns 0 or an errno
  bind(s: Sock, ep: Endpoint): number | Promise<number>;
  listen(s: Sock, backlog: number): number;
  // a listener's accept queue lost its head
  accepted?(listener: Sock): void;
  // a stream connect that has not finished returns EINPROGRESS and later sets s.connected or s.error
  connect(s: Sock, ep: Endpoint): number | Promise<number>;
  disconnect(s: Sock): number | Promise<number>;
  write(s: Sock, data: Uint8Array): number;
  send(s: Sock, data: Uint8Array, to: Endpoint | null): number;
  shutdown(s: Sock, how: number): void;
  // Unix domain sockets: the host makes the socket file itself, otherwise the caller does
  readonly hostUnix: boolean;
  bindUnix(s: Sock, path: string): number | Promise<number>;
  connectUnix(s: Sock, path: string): number | Promise<number>;
  // an option changed on a bound or connected socket
  setOption(s: Sock, level: number, opt: number, value: number): void;
  // joins or leaves an IPv4 multicast group on the interface with address iface (null for any); 0 or an errno
  membership(s: Sock, join: boolean, group: Uint8Array, iface: Uint8Array | null, source: Uint8Array | null): number;
  close(s: Sock): void;
  closeAll?(): void;
}

// Unread bytes a socket holds before its writer waits.
export const HIGH_WATER = 1 << 20;

// The most a UDP payload can hold.
export const MAX_DGRAM = 65507;

// SO_RCVBUF of a fresh UDP socket (rmem_default): the bytes it queues before dropping
export const DGRAM_RCVBUF = 212992;

export type SockKind = "stream" | "dgram" | "event" | "epoll";

export class Sock {
  fd = -1;
  readonly kind: SockKind;
  blocking = true;
  local: Endpoint | null = null;
  remote: Endpoint | null = null;
  listening = false;
  connecting = false;
  connected = false;
  closed = false;
  // closed under a blocked operation, which then sees end of file
  preclosed = false;
  // the peer sent end of file, or this end shut down reading or writing
  eof = false;
  shutRd = false;
  shutWr = false;
  // a pending error, as SO_ERROR holds it
  error = 0;
  rx: Uint8Array[] = [];
  rxBytes = 0;
  dgrams: Datagram[] = [];
  backlog: Sock[] = [];
  // connections the accept queue holds besides one
  maxBacklog = 0;
  // the transmit buffer is full
  wblocked = false;
  // event socket counter
  counter = 0;
  // socket options by level and name, as the JDK sets them
  options = new Map<number, number>();
  // a Unix domain socket, and the path it is bound to and connected to
  unix = false;
  localPath = "";
  remotePath = "";
  // one end of a pipe
  pipe = false;
  // the in-VM peer of a loopback stream or pipe
  peer: Sock | null = null;
  // multicast groups joined, by address
  groups = new Set<string>();
  // backend state
  impl: any = null;
  // threads waiting for a change, once each
  waiters = new Set<() => void>();
  // epoll sets, told of every change
  watchers = new Set<() => void>();

  constructor(kind: SockKind) {
    this.kind = kind;
  }

  get stream() {
    return this.kind === "stream";
  }

  option(level: number, opt: number, fallback: number): number {
    return this.options.get(level << 16 | opt) ?? fallback;
  }

  setOption(level: number, opt: number, value: number) {
    this.options.set(level << 16 | opt, value);
  }

  // The poll(2) events that are ready now.
  poll(): number {
    if (this.closed) return POLLNVAL;
    // an epoll set is readable when one of its sockets is ready
    if (this.kind === "epoll") return this.impl.ready() ? POLLIN : 0;
    if (this.kind === "event") return POLLOUT | (this.counter > 0 ? POLLIN : 0);
    let r = this.error ? POLLERR : 0;
    if (this.kind === "dgram") return r | POLLOUT | (this.dgrams.length > 0 ? POLLIN : 0);
    if (this.listening) return r | (this.backlog.length > 0 ? POLLIN : 0);
    if (this.connecting) return r;
    if (!this.connected) return r | POLLOUT | POLLHUP;
    if (this.rxBytes > 0 || this.eof || (this.shutRd && !this.pipe)) r |= POLLIN;
    if (!this.shutWr && !this.wblocked) r |= POLLOUT;
    if (this.pipe && this.shutRd && !this.peer) r |= POLLERR;
    if ((this.eof || this.shutRd) && this.shutWr) r |= POLLHUP;
    return r;
  }

  notify() {
    if (this.waiters.size > 0) {
      const w = [...this.waiters];
      this.waiters.clear();
      for (const f of w) f();
    }
    for (const f of this.watchers) f();
  }

  // Appends received stream bytes.
  push(data: Uint8Array) {
    if (data.length === 0) return;
    this.rx.push(data);
    this.rxBytes += data.length;
    this.notify();
  }

  // Moves up to len received bytes into dst at off.
  take(dst: Uint8Array, off: number, len: number): number {
    let n = 0;
    while (n < len && this.rx.length > 0) {
      const head = this.rx[0];
      const k = Math.min(len - n, head.length);
      dst.set(head.subarray(0, k), off + n);
      n += k;
      if (k === head.length) this.rx.shift();
      else this.rx[0] = head.subarray(k);
    }
    this.rxBytes -= n;
    if (n > 0) this.drained();
    return n;
  }

  // Called after bytes leave the receive queue; writers and host reads can go on.
  drained() {
    const p = this.peer;
    if (p && p.wblocked && this.rxBytes < HIGH_WATER) {
      p.wblocked = false;
      p.notify();
    }
    const resume = this.impl?.resume;
    if (resume && this.rxBytes < HIGH_WATER) resume();
  }

  endOfFile() {
    this.eof = true;
    this.notify();
  }

  fail(errno: number) {
    this.error = errno;
    this.notify();
  }
}

// The sockets of one VM by descriptor.
export class SockTable {
  readonly socks = new Map<number, Sock>();
}

export function socksOf(state: Map<string, any>): Map<number, Sock> {
  let t = state.get("socks") as SockTable | undefined;
  if (!t) state.set("socks", (t = new SockTable()));
  return t.socks;
}

// Closes the socket behind fd. A thread blocked on it wakes and sees end of file.
export function closeSockFd(state: Map<string, any>, net: NetBackend, fd: number): boolean {
  const socks = socksOf(state);
  const s = socks.get(fd);
  if (!s) return false;
  socks.delete(fd);
  s.closed = true;
  if (s.kind === "epoll") s.impl.dispose();
  else if (s.pipe) closePeer(s);
  else if (s.kind !== "event") net.close(s);
  s.notify();
  return true;
}

// Bytes into the peer's receive queue: pipes and loopback streams.
export function writeToPeer(s: Sock, data: Uint8Array): number {
  const p = s.peer;
  if (!p || p.closed || s.shutWr) return EPIPE;
  if (p.shutRd) return 0;
  p.push(data);
  if (p.rxBytes >= HIGH_WATER) s.wblocked = true;
  return 0;
}

// This end is gone: the peer reads end of file and its writes fail.
export function closePeer(s: Sock, reset = false) {
  const p = s.peer;
  if (!p) return;
  p.peer = null;
  if (reset) p.error = ECONNRESET;
  if (!s.shutWr || reset) p.endOfFile();
  p.wblocked = false;
  p.notify();
}

// A pipe: the read end and the write end.
export function newPipe(): [Sock, Sock] {
  const r = new Sock("stream"), w = new Sock("stream");
  r.pipe = w.pipe = true;
  r.connected = w.connected = true;
  r.shutWr = true;
  w.shutRd = true;
  r.peer = w;
  w.peer = r;
  return [r, w];
}

// What dup2 of a dead socket onto fd does: blocked and later operations see end of file.
export function preCloseSock(state: Map<string, any>, fd: number) {
  const s = socksOf(state).get(fd);
  if (!s) return;
  s.preclosed = true;
  s.notify();
}

export const isMulticast = (a: Uint8Array) => (a[0] & 0xf0) === 0xe0;
export const addrKey = (a: Uint8Array) => `${a[0]}.${a[1]}.${a[2]}.${a[3]}`;
export const isLoopback = (a: Uint8Array) => a[0] === 127;
export const isWildcard = (a: Uint8Array) => a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0;
export const sameAddr = (a: Uint8Array, b: Uint8Array) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
const WILDCARD = new Uint8Array(4);
const SOMAXCONN = 4096;
const overlap = (a: Uint8Array, b: Uint8Array) => isWildcard(a) || isWildcard(b) || sameAddr(a, b);

export function ipv4Literal(s: string | undefined): Uint8Array | null {
  const m = s ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s) : null;
  return m && m.slice(1).every((n) => +n < 256) ? Uint8Array.of(+m[1], +m[2], +m[3], +m[4]) : null;
}

const LO: NetIf = {
  name: "lo", index: 1, up: true, loopback: true, p2p: false, multicast: false, mtu: 65536, mac: null,
  addrs: [{ addr: Uint8Array.of(127, 0, 0, 1), prefix: 8, broadcast: null }],
};

// Sockets that talk only to other sockets of the same VM, on 127.0.0.0/8.
// All a page can have, since a browser has no raw sockets.
export class LoopbackNet implements NetBackend {
  private bound: Sock[] = [];
  // sockets bound to the wildcard address, whose local address a connect then narrows
  private wild = new WeakSet<Sock>();
  // connects waiting for room in a full accept queue, by listener
  private waiting = new Map<Sock, { s: Sock; to: Uint8Array }[]>();
  private nextPort = 49152;
  // an address of this host besides 127.0.0.1, which behaves like loopback
  private extra: Uint8Array | null;
  // when set, connecting to the HTTP proxy address reaches fetch (http-proxy.ts)
  readonly fetch: typeof fetch | null;

  constructor(extra: Uint8Array | null = null, fetchFn: typeof fetch | null = null) {
    this.extra = extra && !isLoopback(extra) && !isWildcard(extra) ? extra : null;
    this.fetch = fetchFn;
  }

  hostName() {
    return "localhost";
  }

  interfaces(): NetIf[] {
    if (!this.extra) return [LO];
    const eth: NetIf = { ...LO, name: "eth0", index: 2, loopback: false, multicast: true, mtu: 1500, addrs: [{ addr: this.extra, prefix: 24, broadcast: null }] };
    return [LO, eth];
  }

  private local(a: Uint8Array) {
    return isLoopback(a) || isWildcard(a) || (this.extra !== null && sameAddr(a, this.extra));
  }

  async lookup(host: string) {
    return host === "localhost" || host === "localhost.localdomain" ? [Uint8Array.of(127, 0, 0, 1)] : null;
  }

  async lookupAddr(addr: Uint8Array) {
    return isLoopback(addr) ? "localhost" : null;
  }

  private free(ep: Endpoint, s: Sock): boolean {
    for (const o of this.bound) {
      const oa = this.wild.has(o) ? WILDCARD : o.local!.addr;
      if (o === s || o.local!.port !== ep.port || o.kind !== s.kind || !overlap(oa, ep.addr)) continue;
      if (s.option(1, 15, 0) && o.option(1, 15, 0)) continue;
      const reuse = s.option(1, 2, 0) && o.option(1, 2, 0);
      if (s.stream ? !reuse || o.listening : !reuse) return false;
    }
    return true;
  }

  private ephemeral(): number {
    for (let i = 0; i < 28000; i++) {
      const p = this.nextPort;
      this.nextPort = this.nextPort >= 60999 ? 32768 : this.nextPort + 1;
      if (!this.bound.some((o) => o.local!.port === p)) return p;
    }
    return 0;
  }

  bind(s: Sock, ep: Endpoint) {
    if (!this.local(ep.addr)) return EADDRNOTAVAIL;
    const port = ep.port || this.ephemeral();
    if (port === 0) return EADDRINUSE;
    const local = { addr: ep.addr.slice(), port };
    if (!this.free(local, s)) return EADDRINUSE;
    s.local = local;
    if (isWildcard(local.addr)) this.wild.add(s);
    this.bound.push(s);
    return 0;
  }

  listen(s: Sock, backlog: number) {
    s.listening = true;
    s.maxBacklog = backlog < 0 ? SOMAXCONN : Math.min(backlog, SOMAXCONN);
    return 0;
  }

  // the source address of a socket that sends to `to`; connect narrows a wildcard bind to it, sendto does not
  private autobind(s: Sock, to: Uint8Array, connect = false) {
    if (s.local) {
      if (connect && isWildcard(s.local.addr)) s.local = { addr: to.slice(), port: s.local.port };
      return;
    }
    const port = this.ephemeral();
    s.local = { addr: isWildcard(to) ? Uint8Array.of(127, 0, 0, 1) : to.slice(), port };
    this.bound.push(s);
  }

  connect(s: Sock, ep: Endpoint) {
    if (!this.local(ep.addr)) return ENETUNREACH;
    const to = isWildcard(ep.addr) ? Uint8Array.of(127, 0, 0, 1) : ep.addr;
    if (!s.stream) {
      this.autobind(s, to, true);
      s.remote = { addr: to.slice(), port: ep.port };
      s.connected = true;
      return 0;
    }
    const l = this.bound.find((o) => o.listening && o.local!.port === ep.port && overlap(o.local!.addr, to));
    const proxy = !l && this.fetch !== null && ep.port === PROXY_PORT && addrKey(to) === PROXY_HOST;
    if (!l && !proxy) {
      if (s.blocking) return ECONNREFUSED;
      // like a kernel, a non-blocking connect reports the refusal later
      s.connecting = true;
      queueMicrotask(() => {
        s.connecting = false;
        s.fail(ECONNREFUSED);
      });
      return EINPROGRESS;
    }
    this.autobind(s, to, true);
    if (!l) {
      serveProxy(this.pair(s, to, ep.port), this.fetch!);
      return this.established(s);
    }
    if (l.backlog.length > l.maxBacklog) {
      // like a kernel that drops the SYN, the connect stays pending until accept makes room
      s.connecting = true;
      const q = this.waiting.get(l);
      if (q) q.push({ s, to });
      else this.waiting.set(l, [{ s, to }]);
      return EINPROGRESS;
    }
    this.enqueue(l, s, to);
    return this.established(s);
  }

  // The accepting end of a connection from s to to:port.
  private pair(s: Sock, to: Uint8Array, port: number): Sock {
    const b = new Sock("stream");
    b.local = { addr: to.slice(), port };
    b.remote = { addr: s.local!.addr.slice(), port: s.local!.port };
    b.connected = true;
    b.peer = s;
    s.peer = b;
    s.remote = { addr: to.slice(), port };
    return b;
  }

  private enqueue(l: Sock, s: Sock, to: Uint8Array) {
    l.backlog.push(this.pair(s, to, l.local!.port));
    l.notify();
  }

  accepted(l: Sock) {
    const q = this.waiting.get(l);
    while (q && q.length > 0 && l.backlog.length <= l.maxBacklog) {
      const { s, to } = q.shift()!;
      if (s.closed || s.preclosed) continue;
      this.enqueue(l, s, to);
      s.connecting = false;
      s.connected = true;
      s.notify();
    }
  }

  // A non-blocking connect finishes after it returns, as with a kernel.
  private established(s: Sock): number {
    if (s.blocking) {
      s.connected = true;
      return 0;
    }
    s.connecting = true;
    queueMicrotask(() => {
      s.connecting = false;
      s.connected = true;
      s.notify();
    });
    return EINPROGRESS;
  }

  disconnect(s: Sock) {
    s.remote = null;
    s.connected = false;
    return 0;
  }

  write(s: Sock, data: Uint8Array) {
    return writeToPeer(s, data);
  }

  send(s: Sock, data: Uint8Array, to: Endpoint | null) {
    const dst = to ?? s.remote;
    if (!dst) return ENOTCONN;
    if (data.length > MAX_DGRAM) return EMSGSIZE;
    if (isMulticast(dst.addr)) return this.multicast(s, data, dst);
    if (!this.local(dst.addr)) return ENETUNREACH;
    const addr = isWildcard(dst.addr) ? Uint8Array.of(127, 0, 0, 1) : dst.addr;
    this.autobind(s, addr);
    const from = { addr: isWildcard(s.local!.addr) ? addr.slice() : s.local!.addr.slice(), port: s.local!.port };
    let received = false;
    for (const o of this.bound) {
      if (o.kind !== "dgram" || o.closed || o.local!.port !== dst.port || !overlap(o.local!.addr, addr)) continue;
      if (o.remote && !(o.remote.port === from.port && sameAddr(o.remote.addr, from.addr))) continue;
      received = true;
      this.deliver(o, from, data);
    }
    // the ICMP error a connected socket gets for a port nobody listens on
    if (!received && s.connected) s.fail(ECONNREFUSED);
    return 0;
  }

  // Queues a datagram; like a kernel, drops it when the receive queue is full.
  private deliver(o: Sock, from: Endpoint, data: Uint8Array) {
    if (o.rxBytes + data.length > o.option(1, 8, DGRAM_RCVBUF)) return;
    o.rxBytes += data.length;
    o.dgrams.push({ from, data: data.slice() });
    o.notify();
  }

  // delivers to every socket on the port that joined the group, the sender too unless it turned loopback off
  private multicast(s: Sock, data: Uint8Array, dst: Endpoint) {
    this.autobind(s, Uint8Array.of(127, 0, 0, 1));
    const from = { addr: Uint8Array.of(127, 0, 0, 1), port: s.local!.port };
    const key = addrKey(dst.addr);
    for (const o of this.bound) {
      if (o.kind !== "dgram" || o.closed || o.local!.port !== dst.port || !o.groups.has(key)) continue;
      if (o === s && s.option(0, 34, 1) === 0) continue;
      this.deliver(o, from, data);
    }
    return 0;
  }

  membership(s: Sock, join: boolean, group: Uint8Array) {
    if (!isMulticast(group)) return EINVAL;
    const key = addrKey(group);
    if (join ? s.groups.has(key) : !s.groups.has(key)) return join ? EADDRINUSE : EADDRNOTAVAIL;
    if (join) s.groups.add(key);
    else s.groups.delete(key);
    return 0;
  }

  shutdown(s: Sock, how: number) {
    if (how !== 1) s.shutRd = true;
    if (how !== 0) {
      s.shutWr = true;
      const p = s.peer;
      if (p) p.endOfFile();
    }
    s.notify();
  }

  setOption() {}

  close(s: Sock) {
    const i = this.bound.indexOf(s);
    if (i >= 0) this.bound.splice(i, 1);
    // a listener resets the connections nobody accepted
    for (const b of s.backlog) closePeer(b, true);
    s.backlog = [];
    for (const w of this.waiting.get(s) ?? []) {
      w.s.connecting = false;
      w.s.fail(ECONNREFUSED);
    }
    this.waiting.delete(s);
    for (const q of this.waiting.values()) {
      const i = q.findIndex((w) => w.s === s);
      if (i >= 0) q.splice(i, 1);
    }
    for (const [path, o] of this.unixBound) if (o === s) this.unixBound.delete(path);
    // linger 0, or bytes nobody read, reset the connection
    closePeer(s, s.stream && !s.pipe && (s.option(1, 13, -1) === 0 || s.rxBytes > 0));
  }

  readonly hostUnix = false;
  private unixBound = new Map<string, Sock>();

  // path is absolute and normalized, and no file is there: an entry for it is a socket whose file is gone
  bindUnix(s: Sock, path: string) {
    this.unixBound.set(path, s);
    s.localPath = path;
    return 0;
  }

  connectUnix(s: Sock, path: string) {
    const l = this.unixBound.get(path);
    if (!l || !l.listening) return ECONNREFUSED;
    const b = new Sock("stream");
    b.unix = true;
    b.localPath = l.localPath;
    b.connected = true;
    b.peer = s;
    s.peer = b;
    s.remotePath = l.localPath;
    l.backlog.push(b);
    l.notify();
    return this.established(s);
  }
}
