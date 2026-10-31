// sun.nio.ch socket natives over Sock: Net, the socket and datagram
// dispatchers, epoll and eventfd. A blocking call is a generator native that
// waits on the socket; a non-blocking one returns IOStatus.UNAVAILABLE.

import type { JArray, JObject } from "../runtime.ts";
import { PendingThrow } from "../thread.ts";
import type { JThread, NativeGen } from "../thread.ts";
import {
  EADDRINUSE, EADDRNOTAVAIL, EACCES, ENOENT, ECONNREFUSED, ECONNRESET, EHOSTUNREACH, EINVAL, ENOPROTOOPT, ENOTCONN, EOPNOTSUPP, EPIPE, ETIMEDOUT,
  DGRAM_RCVBUF, POLLERR, POLLHUP, POLLIN, POLLNVAL, POLLOUT, Sock, newPipe, socksOf, strerror, writeToPeer,
} from "../sockets.ts";
import type { Datagram, Endpoint } from "../sockets.ts";
import { closeFd, newFd, openFile, resolvePath } from "./io.ts";
import { inet4, inetBytes, socketAddress } from "./net.ts";
import type { Natives } from "./util.ts";

const FD = "java/io/FileDescriptor";
const IOS_EOF = -1, IOS_UNAVAILABLE = -2, IOS_INTERRUPTED = -3;
const EEXIST = 17, EBADF = 9, EPROTO = 71;

// the JDK thread token for signalling a thread out of a blocking call
const blocked = new WeakMap<JThread, () => void>();

type Wake = "ready" | "timeout" | "signal";

// Waits for w to change, up to ms (forever when negative) or a signal.
function waitOn(t: JThread, w: { waiters: Set<() => void> }, ms: number): Promise<Wake> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (why: Wake) => {
      w.waiters.delete(wake);
      blocked.delete(t);
      if (timer !== undefined) {
        clearTimeout(timer);
        t.vm.timers.delete(timer);
      }
      resolve(why);
    };
    const wake = () => finish("ready");
    w.waiters.add(wake);
    blocked.set(t, () => finish("signal"));
    if (ms >= 0) {
      timer = setTimeout(() => finish("timeout"), ms);
      t.vm.timers.add(timer);
    }
  });
}

// poll(2) timeouts: below -1 is -1
const clampTimeout = (ms: number | bigint) => {
  const n = Number(ms);
  return n < -1 ? -1 : Math.min(n, 0x7fffffff);
};

function register(t: JThread, s: Sock): number {
  const vm = t.vm;
  const socks = socksOf(vm.state);
  if (socks.size === 0 && !vm.state.get("socksHooked")) {
    vm.state.set("socksHooked", true);
    vm.exited.then(() => {
      for (const x of socks.values()) x.closed = true;
      vm.net.closeAll?.();
      socks.clear();
    });
  }
  s.fd = newFd(t);
  socks.set(s.fd, s);
  return s.fd;
}

function fdNum(t: JThread, fdObj: JObject): number {
  return t.vm.getField(fdObj, FD, "fd");
}

function lookup(t: JThread, fdObj: JObject): Sock | undefined {
  return socksOf(t.vm.state).get(fdNum(t, fdObj));
}

function sockOf(t: JThread, fdObj: JObject, cls = "java/net/SocketException"): Sock {
  const s = lookup(t, fdObj);
  if (!s) throw new PendingThrow(cls, strerror(EBADF));
  return s;
}

// handleSocketError in libnio
export function socketError(errno: number, msg?: string): PendingThrow {
  let cls = "java/net/SocketException";
  switch (errno) {
    case EPROTO: cls = "java/net/ProtocolException"; break;
    case ECONNREFUSED: case ETIMEDOUT: case ENOTCONN: cls = "java/net/ConnectException"; break;
    case EHOSTUNREACH: cls = "java/net/NoRouteToHostException"; break;
    case EADDRINUSE: case EADDRNOTAVAIL: case EACCES: cls = "java/net/BindException"; break;
  }
  return new PendingThrow(cls, msg ? `${strerror(errno)} (${msg})` : strerror(errno));
}

const ioError = (errno: number) => new PendingThrow("java/io/IOException", strerror(errno));
const connectionReset = () => new PendingThrow("sun/net/ConnectionResetException", "Connection reset");

// Reads and discards up to max wake-up bytes; an event counter counts as one.
function drain(t: JThread, fd: number, max: number): number {
  const s = socksOf(t.vm.state).get(fd);
  if (!s) throw ioError(EBADF);
  if (s.kind === "event") {
    const had = s.counter > 0 ? 1 : 0;
    s.counter = 0;
    return had;
  }
  return s.take(new Uint8Array(max), 0, max);
}

function* done<T>(r: T | Promise<T>, t: JThread): Generator<any, T, any> {
  return r instanceof Promise ? yield t.block(r) : r;
}

// Waits until s is not connecting; a failed connect throws.
function* finishConnect(t: JThread, s: Sock, ms: number, detail?: string): NativeGen {
  const end = ms < 0 ? Infinity : performance.now() + ms;
  while (s.connecting) {
    const left = end - performance.now();
    if (left <= 0) return false;
    if ((yield t.block(waitOn(t, s, left === Infinity ? -1 : left))) === "signal") return false;
  }
  if (s.error) {
    const e = s.error;
    s.error = 0;
    throw socketError(e, detail);
  }
  if (!s.connected) throw socketError(ENOTCONN, "peer closed connection after accepting");
  return true;
}

// Waits until some of events (or an error) is ready on s.
function* pollSock(t: JThread, s: Sock, events: number, timeout: number): NativeGen {
  const mask = events | POLLERR | POLLHUP | POLLNVAL;
  const end = timeout < 0 ? Infinity : performance.now() + timeout;
  for (;;) {
    const r = s.preclosed ? POLLIN | POLLOUT | POLLHUP : s.poll();
    if (r & mask) return r & mask;
    const left = end - performance.now();
    if (left <= 0) return 0;
    if ((yield t.block(waitOn(t, s, left === Infinity ? -1 : left))) === "signal") return 0;
  }
}

// Takes stream bytes: into(cap) moves up to cap bytes and returns the count.
function* recv(t: JThread, s: Sock, len: number, into: (cap: number) => number): NativeGen {
  if (len === 0) return 0;
  for (;;) {
    if (s.rxBytes > 0) return into(Math.min(len, s.rxBytes));
    if (s.error) {
      const e = s.error;
      s.error = 0;
      s.eof = true;
      if (e === ECONNRESET || e === EPIPE) throw connectionReset();
      throw ioError(e);
    }
    if (s.preclosed || s.eof || s.shutRd) return IOS_EOF;
    if (!s.connected) throw ioError(ENOTCONN);
    if (!s.blocking) return IOS_UNAVAILABLE;
    if ((yield t.block(waitOn(t, s, -1))) === "signal") return IOS_INTERRUPTED;
  }
}

function* xmit(t: JThread, s: Sock, data: Uint8Array): NativeGen {
  if (data.length === 0) return 0;
  for (;;) {
    if (s.preclosed || s.shutWr) throw ioError(EPIPE);
    if (!s.connected) throw ioError(ENOTCONN);
    if (!s.wblocked) {
      const e = s.pipe ? writeToPeer(s, data) : t.vm.net.write(s, data);
      if (e) throw ioError(e);
      return data.length;
    }
    if (!s.blocking) return IOS_UNAVAILABLE;
    if ((yield t.block(waitOn(t, s, -1))) === "signal") return IOS_INTERRUPTED;
  }
}

// The next connection of a listening socket, or an IOStatus code.
function* acceptFrom(t: JThread, s: Sock): NativeGen {
  for (;;) {
    const c = s.backlog.shift();
    if (c) {
      t.vm.net.accepted?.(s);
      return c;
    }
    if (s.preclosed) return IOS_INTERRUPTED;
    if (!s.listening) throw ioError(EINVAL);
    if (!s.blocking) return IOS_UNAVAILABLE;
    if ((yield t.block(waitOn(t, s, -1))) === "signal") return IOS_INTERRUPTED;
  }
}

function* acceptInto(t: JThread, fd: JObject, newfd: JObject, isaa: JArray): NativeGen {
  const c = yield* acceptFrom(t, sockOf(t, fd));
  if (typeof c === "number") return c;
  t.vm.setField(newfd, FD, "fd", register(t, c));
  isaa.a[0] = yield* socketAddress(t, c.remote!);
  return 1;
}

const decodePath = (b: JArray) => new TextDecoder().decode(Uint8Array.from(b.a as Int8Array));

// The file a Unix domain socket path names: relative to the working directory, without . and ..
const unixFile = (t: JThread, b: JArray) => resolvePath(t, decodePath(b));

function pathBytes(t: JThread, path: string): JArray {
  const b = new TextEncoder().encode(path);
  const a = t.vm.newArray(t.vm.primClass("B"), b.length);
  (a.a as Int8Array).set(new Int8Array(b.buffer, b.byteOffset, b.length));
  return a;
}

// stream and pipe reads and writes from the file dispatchers; null when fd is not a socket
export function sockRead(t: JThread, fd: JObject, addr: bigint, len: number): NativeGen | null {
  const s = lookup(t, fd);
  return s ? recv(t, s, len, (n) => s.take(t.vm.mem.u8, Number(addr), n)) : null;
}

export function sockReadv(t: JThread, fd: JObject, addr: bigint, n: number): NativeGen | null {
  const s = lookup(t, fd);
  if (!s) return null;
  const segs = iovecs(t, addr, n);
  return (function* () {
    return BigInt(yield* recv(t, s, segs.reduce((a, g) => a + g.len, 0), (k) => {
      const tmp = new Uint8Array(k);
      s.take(tmp, 0, k);
      return scatter(t, segs, tmp);
    }));
  })();
}

export function sockWrite(t: JThread, fd: JObject, addr: bigint, len: number): NativeGen | null {
  const s = lookup(t, fd);
  return s ? xmit(t, s, t.vm.mem.u8.slice(Number(addr), Number(addr) + len)) : null;
}

export function sockWritev(t: JThread, fd: JObject, addr: bigint, n: number): NativeGen | null {
  const s = lookup(t, fd);
  if (!s) return null;
  return (function* () {
    return BigInt(yield* xmit(t, s, gather(t, iovecs(t, addr, n))));
  })();
}

// the sockaddr_in layout the NativeSocketAddress natives describe
function putSockaddr(u8: Uint8Array, at: number, ep: Endpoint) {
  u8[at] = 2;
  u8[at + 1] = 0;
  u8[at + 2] = ep.port >> 8;
  u8[at + 3] = ep.port & 255;
  u8.set(ep.addr, at + 4);
}

function getSockaddr(u8: Uint8Array, at: number, len: number): Endpoint {
  const v6 = len > 16 && u8[at] === 10;
  const port = (u8[at + 2] << 8) | u8[at + 3];
  const addr = v6 ? u8.slice(at + 8 + 12, at + 8 + 16) : u8.slice(at + 4, at + 8);
  return { addr, port };
}

function* recvDatagram(t: JThread, s: Sock, connected: boolean, into: (d: Datagram) => number): NativeGen {
  for (;;) {
    const d = s.dgrams.shift();
    if (d) {
      s.rxBytes -= d.data.length;
      return into(d);
    }
    if (s.error) {
      const e = s.error;
      s.error = 0;
      if (e === ECONNREFUSED) {
        if (connected) throw new PendingThrow("java/net/PortUnreachableException");
        continue;
      }
      throw socketError(e);
    }
    if (s.preclosed) return IOS_INTERRUPTED;
    if (!s.blocking) return IOS_UNAVAILABLE;
    if ((yield t.block(waitOn(t, s, -1))) === "signal") return IOS_INTERRUPTED;
  }
}

function checkedDatagramError(s: Sock) {
  if (s.error === ECONNREFUSED) {
    s.error = 0;
    throw new PendingThrow("java/net/PortUnreachableException");
  }
}

const ipOf = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

// iovec: { void *base; size_t len; } pairs of 64-bit words
function iovecs(t: JThread, addr: bigint, n: number): { base: number; len: number }[] {
  const dv = t.vm.mem.dv, out: { base: number; len: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = Number(addr) + i * 16;
    out.push({ base: Number(dv.getBigInt64(p, true)), len: Number(dv.getBigInt64(p + 8, true)) });
  }
  return out;
}

function scatter(t: JThread, segs: { base: number; len: number }[], data: Uint8Array): number {
  let off = 0;
  for (const g of segs) {
    if (off >= data.length) break;
    const k = Math.min(g.len, data.length - off);
    t.vm.mem.u8.set(data.subarray(off, off + k), g.base);
    off += k;
  }
  return off;
}

function gather(t: JThread, segs: { base: number; len: number }[]): Uint8Array {
  const out = new Uint8Array(segs.reduce((n, g) => n + g.len, 0));
  let off = 0;
  for (const g of segs) {
    out.set(t.vm.mem.u8.subarray(g.base, g.base + g.len), off);
    off += g.len;
  }
  return out;
}

// SOL_SOCKET and IPPROTO_* option defaults, as a fresh Linux socket reports them
const DEFAULTS = new Map<number, number>([
  [1 << 16 | 13, -1], [0 << 16 | 33, 1], [0 << 16 | 34, 1], [0 << 16 | 2, 64],
]);

// SO_SNDBUF and SO_RCVBUF of a fresh socket with Linux's stock sysctls:
// tcp_wmem and tcp_rmem's defaults for TCP, wmem_default and rmem_default for UDP
const bufferDefault = (s: Sock, opt: number) => (s.stream ? (opt === 7 ? 16384 : 131072) : DGRAM_RCVBUF);

function getOption(s: Sock, convert: boolean, level: number, opt: number): number {
  if (level === 1 && opt === 4) {
    const e = s.error;
    s.error = 0;
    return e;
  }
  if (level === 1 && opt === 3) return s.stream ? 1 : 2;
  const buffer = level === 1 && (opt === 7 || opt === 8);
  const v = s.option(level, opt, buffer ? bufferDefault(s, opt) : DEFAULTS.get(level << 16 | opt) ?? 0);
  // Linux keeps twice the buffer size asked for, and the JDK halves it back
  return convert && buffer ? Math.trunc(v / 2) : v;
}

function setOption(t: JThread, s: Sock, convert: boolean, level: number, opt: number, value: number) {
  if (level === 1 && (opt === 7 || opt === 8)) {
    if (convert && opt === 8) value = Math.max(value, 1024);
    value = Math.min(value, 212992);
    s.setOption(level, opt, Math.max(value * 2, opt === 7 ? 4608 : 2304));
  } else {
    if (convert && level === 0 && opt === 1) value &= 0xfe;
    s.setOption(level, opt, value);
  }
  t.vm.net.setOption(s, level, opt, value);
}

// ---- epoll -----------------------------------------------------------------

const EPOLLONESHOT = 1 << 30;
const EVENT_SIZE = 12;

interface Interest {
  events: number;
  armed: boolean;
}

interface EpollSet {
  interest: Map<number, Interest>;
  // told of each watched socket's changes
  wake: () => void;
  ready: () => boolean;
  dispose: () => void;
}

function epollOf(t: JThread, epfd: number): { s: Sock; set: EpollSet } {
  const s = socksOf(t.vm.state).get(epfd);
  if (!s || s.kind !== "epoll") throw new PendingThrow("java/io/IOException", strerror(EBADF));
  return { s, set: s.impl };
}

function collect(t: JThread, set: EpollSet, address: number, max: number): number {
  const socks = socksOf(t.vm.state);
  const dv = t.vm.mem.dv;
  let n = 0;
  for (const [fd, e] of set.interest) {
    if (n >= max) break;
    const w = socks.get(fd);
    if (!w) {
      set.interest.delete(fd);
      continue;
    }
    if (!e.armed) continue;
    const ev = (w.preclosed ? POLLIN | POLLOUT | POLLHUP : w.poll()) & (e.events | POLLERR | POLLHUP);
    if (!ev) continue;
    dv.setUint32(address + n * EVENT_SIZE, ev, true);
    dv.setUint32(address + n * EVENT_SIZE + 4, fd, true);
    dv.setUint32(address + n * EVENT_SIZE + 8, 0, true);
    if (e.events & EPOLLONESHOT) e.armed = false;
    n++;
  }
  return n;
}

function newEpoll(t: JThread): number {
  const s = new Sock("epoll");
  const socks = socksOf(t.vm.state);
  const set: EpollSet = {
    interest: new Map(),
    wake: () => s.notify(),
    ready: () => {
      for (const [fd, e] of set.interest) {
        const w = socks.get(fd);
        if (w && e.armed && (w.preclosed ? POLLIN | POLLOUT | POLLHUP : w.poll()) & (e.events | POLLERR | POLLHUP)) return true;
      }
      return false;
    },
    dispose: () => {
      for (const fd of set.interest.keys()) socks.get(fd)?.watchers.delete(set.wake);
      set.interest.clear();
    },
  };
  s.impl = set;
  return register(t, s);
}

// ---- natives ---------------------------------------------------------------

const N = "sun/nio/ch/Net.";
const SD = "sun/nio/ch/SocketDispatcher.";
const DD = "sun/nio/ch/DatagramDispatcher.";
const DC = "sun/nio/ch/DatagramChannelImpl.";
const NSA = "sun/nio/ch/NativeSocketAddress.";

export const natives: Natives = {
  [`${N}isIPv6Available0()Z`]: () => 0,
  [`${N}isReusePortAvailable0()Z`]: () => 1,
  [`${N}isExclusiveBindAvailable()I`]: () => -1,
  [`${N}shouldShutdownWriteBeforeClose0()Z`]: () => 0,
  [`${N}shouldSetBothIPv4AndIPv6Options0()Z`]: () => 1,
  [`${N}canIPv6SocketJoinIPv4Group0()Z`]: () => 1,
  [`${N}canJoin6WithIPv4Group0()Z`]: () => 0,
  [`${N}canUseIPv6OptionsWithIPv4LocalAddress0()Z`]: () => 1,
  [`${N}pollinValue()S`]: () => POLLIN,
  [`${N}polloutValue()S`]: () => POLLOUT,
  [`${N}pollerrValue()S`]: () => POLLERR,
  [`${N}pollhupValue()S`]: () => POLLHUP,
  [`${N}pollnvalValue()S`]: () => POLLNVAL,
  [`${N}pollconnValue()S`]: () => POLLOUT,

  [`${N}socket0(ZZZZ)I`]: (t, [, stream, reuse]) => {
    const s = new Sock(stream ? "stream" : "dgram");
    if (reuse) s.setOption(1, 2, 1);
    return register(t, s);
  },
  [`${N}bind0(Ljava/io/FileDescriptor;ZZLjava/net/InetAddress;I)V`]: function* (t, [fd, , , ia, port]): NativeGen {
    const s = sockOf(t, fd);
    if (s.local) throw socketError(EINVAL);
    const e = yield* done(t.vm.net.bind(s, { addr: inetBytes(t, ia), port }), t);
    if (e) throw socketError(e);
  },
  [`${N}listen(Ljava/io/FileDescriptor;I)V`]: (t, [fd, backlog]) => {
    const s = sockOf(t, fd);
    if (!s.local && !s.localPath) throw socketError(EINVAL);
    const e = t.vm.net.listen(s, backlog);
    if (e) throw socketError(e);
  },
  [`${N}connect0(ZLjava/io/FileDescriptor;Ljava/net/InetAddress;I)I`]: function* (t, [, fd, ia, port]): NativeGen {
    const s = sockOf(t, fd);
    if (s.connected || s.connecting) throw socketError(106);
    const e = yield* done(t.vm.net.connect(s, { addr: inetBytes(t, ia), port }), t);
    if (e && e !== 115) throw socketError(e);
    if (s.connecting) {
      if (!s.blocking) return IOS_UNAVAILABLE;
      yield* finishConnect(t, s, -1);
    }
    return 1;
  },
  [`${N}accept(Ljava/io/FileDescriptor;Ljava/io/FileDescriptor;[Ljava/net/InetSocketAddress;)I`]: function* (t, [fd, newfd, isaa]): NativeGen {
    return yield* acceptInto(t, fd, newfd, isaa);
  },
  [`${N}shutdown(Ljava/io/FileDescriptor;I)V`]: (t, [fd, how]) => {
    const s = sockOf(t, fd);
    if (!s.connected) return;
    t.vm.net.shutdown(s, how);
  },
  [`${N}localPort(Ljava/io/FileDescriptor;)I`]: (t, [fd]) => sockOf(t, fd).local?.port ?? 0,
  [`${N}localInetAddress(Ljava/io/FileDescriptor;)Ljava/net/InetAddress;`]: function* (t, [fd]): NativeGen {
    return yield* inet4(t, null, sockOf(t, fd).local?.addr ?? new Uint8Array(4));
  },
  [`${N}remotePort(Ljava/io/FileDescriptor;)I`]: (t, [fd]) => {
    const s = sockOf(t, fd);
    if (!s.remote) throw socketError(ENOTCONN);
    return s.remote.port;
  },
  [`${N}remoteInetAddress(Ljava/io/FileDescriptor;)Ljava/net/InetAddress;`]: function* (t, [fd]): NativeGen {
    const s = sockOf(t, fd);
    if (!s.remote) throw socketError(ENOTCONN);
    return yield* inet4(t, null, s.remote.addr);
  },
  [`${N}getIntOption0(Ljava/io/FileDescriptor;ZII)I`]: (t, [fd, convert, level, opt]) => getOption(sockOf(t, fd), convert === 1, level, opt),
  [`${N}setIntOption0(Ljava/io/FileDescriptor;ZIIIZ)V`]: (t, [fd, convert, level, opt, arg]) => setOption(t, sockOf(t, fd), convert === 1, level, opt, arg),
  [`${N}poll(Ljava/io/FileDescriptor;IJ)I`]: function* (t, [fd, events, timeout]): NativeGen {
    const s = lookup(t, fd);
    if (!s) return POLLNVAL;
    return yield* pollSock(t, s, events, clampTimeout(timeout));
  },
  [`${N}pollConnect(Ljava/io/FileDescriptor;J)Z`]: function* (t, [fd, timeout]): NativeGen {
    return yield* finishConnect(t, sockOf(t, fd), clampTimeout(timeout), "connect failed");
  },
  [`${N}available(Ljava/io/FileDescriptor;)I`]: (t, [fd]) => {
    const s = sockOf(t, fd);
    return s.stream ? Math.min(s.rxBytes, 0x7fffffff) : s.dgrams[0]?.data.length ?? 0;
  },
  [`${N}sendOOB(Ljava/io/FileDescriptor;B)I`]: () => { throw new PendingThrow("java/net/SocketException", "Operation not supported"); },
  [`${N}discardOOB(Ljava/io/FileDescriptor;)Z`]: () => 0,
  [`${N}joinOrDrop4(ZLjava/io/FileDescriptor;III)I`]: (t, [join, fd, group, iface, source]) => {
    const e = t.vm.net.membership(sockOf(t, fd), join === 1, ipOf(group), iface === 0 ? null : ipOf(iface), source === 0 ? null : ipOf(source));
    if (e && join === 1 && (e === ENOPROTOOPT || e === EOPNOTSUPP)) return IOS_UNAVAILABLE;
    if (e) throw socketError(e, "setsockopt failed");
    return 0;
  },
  [`${N}blockOrUnblock4(ZLjava/io/FileDescriptor;III)I`]: () => IOS_UNAVAILABLE,
  [`${N}joinOrDrop6(ZLjava/io/FileDescriptor;[BI[B)I`]: () => IOS_UNAVAILABLE,
  [`${N}blockOrUnblock6(ZLjava/io/FileDescriptor;[BI[B)I`]: () => IOS_UNAVAILABLE,
  [`${N}setInterface4(Ljava/io/FileDescriptor;I)V`]: (t, [fd, v]) => setOption(t, sockOf(t, fd), false, 0, 32, v),
  [`${N}getInterface4(Ljava/io/FileDescriptor;)I`]: (t, [fd]) => sockOf(t, fd).option(0, 32, 0),
  [`${N}setInterface6(Ljava/io/FileDescriptor;I)V`]: () => undefined,
  [`${N}getInterface6(Ljava/io/FileDescriptor;)I`]: () => 0,

  [`${SD}read0(Ljava/io/FileDescriptor;JI)I`]: function* (t, [fd, addr, len]): NativeGen {
    return yield* recv(t, sockOf(t, fd, "java/io/IOException"), len, (n) => sockOf(t, fd).take(t.vm.mem.u8, Number(addr), n));
  },
  [`${SD}readv0(Ljava/io/FileDescriptor;JI)J`]: function* (t, [fd, addr, n]): NativeGen {
    const segs = iovecs(t, addr, n);
    const cap = segs.reduce((a, g) => a + g.len, 0);
    const r = yield* recv(t, sockOf(t, fd, "java/io/IOException"), cap, (k) => {
      const tmp = new Uint8Array(k);
      sockOf(t, fd).take(tmp, 0, k);
      return scatter(t, segs, tmp);
    });
    return BigInt(r);
  },
  [`${SD}write0(Ljava/io/FileDescriptor;JI)I`]: function* (t, [fd, addr, len]): NativeGen {
    return yield* xmit(t, sockOf(t, fd, "java/io/IOException"), t.vm.mem.u8.slice(Number(addr), Number(addr) + len));
  },
  [`${SD}writev0(Ljava/io/FileDescriptor;JI)J`]: function* (t, [fd, addr, n]): NativeGen {
    return BigInt(yield* xmit(t, sockOf(t, fd, "java/io/IOException"), gather(t, iovecs(t, addr, n))));
  },

  [`${DD}read0(Ljava/io/FileDescriptor;JI)I`]: function* (t, [fd, addr, len]): NativeGen {
    const s = sockOf(t, fd, "java/io/IOException");
    checkedDatagramError(s);
    const n = yield* recvDatagram(t, s, true, ({ data }) => {
      const k = Math.min(len, data.length);
      t.vm.mem.u8.set(data.subarray(0, k), Number(addr));
      return k;
    });
    return n === 0 ? IOS_EOF : n;
  },
  [`${DD}readv0(Ljava/io/FileDescriptor;JI)J`]: function* (t, [fd, addr, n]): NativeGen {
    const s = sockOf(t, fd, "java/io/IOException");
    checkedDatagramError(s);
    const segs = iovecs(t, addr, n);
    const r = yield* recvDatagram(t, s, true, ({ data }) => scatter(t, segs, data));
    return BigInt(r === 0 ? IOS_EOF : r);
  },
  [`${DD}write0(Ljava/io/FileDescriptor;JI)I`]: (t, [fd, addr, len]) => {
    const s = sockOf(t, fd, "java/io/IOException");
    checkedDatagramError(s);
    const e = t.vm.net.send(s, t.vm.mem.u8.slice(Number(addr), Number(addr) + len), null);
    if (e) throw ioError(e);
    return len;
  },
  [`${DD}writev0(Ljava/io/FileDescriptor;JI)J`]: (t, [fd, addr, n]) => {
    const s = sockOf(t, fd, "java/io/IOException");
    checkedDatagramError(s);
    const data = gather(t, iovecs(t, addr, n));
    const e = t.vm.net.send(s, data, null);
    if (e) throw ioError(e);
    return BigInt(data.length);
  },
  [`${DD}dup0(Ljava/io/FileDescriptor;Ljava/io/FileDescriptor;)V`]: () => { throw ioError(EINVAL); },

  [`${DC}disconnect0(Ljava/io/FileDescriptor;Z)V`]: function* (t, [fd]): NativeGen {
    const s = sockOf(t, fd);
    const e = yield* done(t.vm.net.disconnect(s), t);
    if (e) throw socketError(e);
  },
  [`${DC}receive0(Ljava/io/FileDescriptor;JIJZ)I`]: function* (t, [fd, buf, len, sender, connected]): NativeGen {
    return yield* recvDatagram(t, sockOf(t, fd), connected === 1, ({ data, from }) => {
      const k = Math.min(len, data.length);
      const u8 = t.vm.mem.u8;
      u8.set(data.subarray(0, k), Number(buf));
      putSockaddr(u8, Number(sender), from);
      return k;
    });
  },
  [`${DC}send0(Ljava/io/FileDescriptor;JIJI)I`]: (t, [fd, buf, len, target, targetLen]) => {
    const s = sockOf(t, fd);
    const to = getSockaddr(t.vm.mem.u8, Number(target), targetLen);
    const e = t.vm.net.send(s, t.vm.mem.u8.slice(Number(buf), Number(buf) + len), to);
    if (e === ECONNREFUSED) throw new PendingThrow("java/net/PortUnreachableException");
    if (e) throw socketError(e);
    return len;
  },

  [`${NSA}AFINET()I`]: () => 2,
  [`${NSA}AFINET6()I`]: () => 10,
  [`${NSA}sizeofSockAddr4()I`]: () => 16,
  [`${NSA}sizeofSockAddr6()I`]: () => 28,
  [`${NSA}sizeofFamily()I`]: () => 2,
  [`${NSA}offsetFamily()I`]: () => 0,
  [`${NSA}offsetSin4Port()I`]: () => 2,
  [`${NSA}offsetSin4Addr()I`]: () => 4,
  [`${NSA}offsetSin6Port()I`]: () => 2,
  [`${NSA}offsetSin6Addr()I`]: () => 8,
  [`${NSA}offsetSin6ScopeId()I`]: () => 24,
  [`${NSA}offsetSin6FlowInfo()I`]: () => 4,

  "sun/nio/ch/UnixDomainSockets.init()Z": () => 1,
  "sun/nio/ch/UnixDomainSockets.socket0()I": (t) => {
    const s = new Sock("stream");
    s.unix = true;
    return register(t, s);
  },
  "sun/nio/ch/UnixDomainSockets.bind0(Ljava/io/FileDescriptor;[B)V": function* (t, [fd, path]): NativeGen {
    const s = sockOf(t, fd);
    const p = unixFile(t, path);
    if (s.localPath) throw socketError(EINVAL);
    if (!t.vm.net.hostUnix) {
      if (t.vm.fs.stat(p)) throw socketError(EADDRINUSE);
      if (!t.vm.fs.write(p, new Uint8Array(0))) throw socketError(EACCES);
    }
    const e = yield* done(t.vm.net.bindUnix(s, p), t);
    if (e) throw socketError(e);
    s.localPath = decodePath(path);
  },
  "sun/nio/ch/UnixDomainSockets.connect0(Ljava/io/FileDescriptor;[B)I": function* (t, [fd, path]): NativeGen {
    const s = sockOf(t, fd);
    const p = unixFile(t, path);
    if (s.connected || s.connecting) throw socketError(106);
    if (!t.vm.net.hostUnix && !t.vm.fs.stat(p)) throw socketError(ENOENT);
    const e = yield* done(t.vm.net.connectUnix(s, p), t);
    if (e && e !== 115) throw socketError(e);
    if (s.connecting) {
      if (!s.blocking) return IOS_UNAVAILABLE;
      yield* finishConnect(t, s, -1);
    }
    return 1;
  },
  "sun/nio/ch/UnixDomainSockets.accept0(Ljava/io/FileDescriptor;Ljava/io/FileDescriptor;[Ljava/lang/Object;)I": function* (t, [fd, newfd, array]): NativeGen {
    const c = yield* acceptFrom(t, sockOf(t, fd));
    if (typeof c === "number") return c;
    t.vm.setField(newfd, FD, "fd", register(t, c));
    (array as JArray).a[0] = pathBytes(t, c.remotePath);
    return 1;
  },
  "sun/nio/ch/UnixDomainSockets.localAddress0(Ljava/io/FileDescriptor;)[B": (t, [fd]) => pathBytes(t, sockOf(t, fd).localPath),

  "sun/nio/ch/IOUtil.makePipe(Z)J": (t, [blocking]) => {
    const [r, w] = newPipe();
    r.blocking = w.blocking = blocking === 1;
    return (BigInt(register(t, r)) << 32n) | BigInt(register(t, w));
  },
  "sun/nio/ch/IOUtil.write1(IB)I": (t, [fd, b]) => {
    const s = socksOf(t.vm.state).get(fd);
    if (!s) throw ioError(EBADF);
    const e = writeToPeer(s, Uint8Array.of(b));
    if (e) throw ioError(e);
    return 1;
  },

  "sun/net/spi/DefaultProxySelector.init()Z": () => 0,
  "sun/net/spi/DefaultProxySelector.getSystemProxies(Ljava/lang/String;Ljava/lang/String;)[Ljava/net/Proxy;": () => null,

  "sun/nio/ch/InheritedChannel.dup(I)I": (_t, [fd]) => fd,
  "sun/nio/ch/InheritedChannel.dup2(II)V": () => undefined,
  "sun/nio/ch/InheritedChannel.open0(Ljava/lang/String;I)I": (t, [path]) => openFile(t, t.vm.jsString(path), true, false, false),
  "sun/nio/ch/InheritedChannel.close0(I)V": (t, [fd]) => {
    if (fd > 2) closeFd(t, fd);
  },
  "sun/nio/ch/InheritedChannel.soType0(I)I": () => -1,
  "sun/nio/ch/InheritedChannel.addressFamily(I)I": () => -1,
  "sun/nio/ch/InheritedChannel.inetPeerAddress0(I)Ljava/net/InetAddress;": () => null,
  "sun/nio/ch/InheritedChannel.unixPeerAddress0(I)[B": () => null,
  "sun/nio/ch/InheritedChannel.peerPort0(I)I": () => 0,
  "sun/nio/ch/InheritedChannel.isConnected(I)Z": () => 0,
  "sun/net/PortConfig.getLower0()I": () => 32768,
  "sun/net/PortConfig.getUpper0()I": () => 60999,

  "sun/nio/ch/EPoll.eventSize()I": () => EVENT_SIZE,
  "sun/nio/ch/EPoll.eventsOffset()I": () => 0,
  "sun/nio/ch/EPoll.dataOffset()I": () => 4,
  "sun/nio/ch/EPoll.create()I": (t) => newEpoll(t),
  "sun/nio/ch/EPoll.ctl(IIII)I": (t, [epfd, op, fd, events]) => {
    const { set } = epollOf(t, epfd);
    const w = socksOf(t.vm.state).get(fd);
    if (!w) return fd >= 0 && t.vm.state.get("fds")?.files.has(fd) ? 1 : EBADF;
    const have = set.interest.get(fd);
    switch (op) {
      case 1:
        if (have) return EEXIST;
        set.interest.set(fd, { events, armed: true });
        w.watchers.add(set.wake);
        // a socket that is ready already wakes a thread blocked in wait, as on Linux
        set.wake();
        return 0;
      case 2:
        if (!have) return ENOENT;
        set.interest.delete(fd);
        w.watchers.delete(set.wake);
        return 0;
      case 3:
        if (!have) return ENOENT;
        have.events = events;
        have.armed = true;
        set.wake();
        return 0;
    }
    return EINVAL;
  },
  "sun/nio/ch/EPoll.wait(IJII)I": function* (t, [epfd, address, max, timeout]): NativeGen {
    const { s, set } = epollOf(t, epfd);
    const ms = clampTimeout(timeout);
    const end = ms < 0 ? Infinity : performance.now() + ms;
    for (;;) {
      const n = collect(t, set, Number(address), max);
      if (n > 0) return n;
      const left = end - performance.now();
      if (left <= 0) return 0;
      if ((yield t.block(waitOn(t, s, left === Infinity ? -1 : left))) === "signal") return IOS_INTERRUPTED;
    }
  },

  "sun/nio/ch/EventFD.eventfd0()I": (t) => register(t, new Sock("event")),
  "sun/nio/ch/EventFD.set0(I)I": (t, [fd]) => {
    const s = socksOf(t.vm.state).get(fd);
    if (!s) throw ioError(EBADF);
    s.counter++;
    s.notify();
    return 8;
  },
  "sun/nio/ch/IOUtil.drain(I)Z": (t, [fd]) => (drain(t, fd, 16) > 0 ? 1 : 0),
  "sun/nio/ch/IOUtil.drain1(I)I": (t, [fd]) => drain(t, fd, 1),

  "sun/nio/ch/EPollPort.socketpair([I)V": (t, [sv]) => {
    const [r, w] = newPipe();
    r.blocking = w.blocking = false;
    sv.a[0] = register(t, r);
    sv.a[1] = register(t, w);
  },
  "sun/nio/ch/EPollPort.interrupt(I)V": (t, [fd]) => {
    const s = socksOf(t.vm.state).get(fd);
    if (!s) throw ioError(EBADF);
    writeToPeer(s, Uint8Array.of(1));
  },
  "sun/nio/ch/EPollPort.drain1(I)V": (t, [fd]) => void drain(t, fd, 1),
  "sun/nio/ch/EPollPort.close0(I)V": (t, [fd]) => void closeFd(t, fd),
  "sun/nio/ch/UnixAsynchronousServerSocketChannelImpl.accept0(Ljava/io/FileDescriptor;Ljava/io/FileDescriptor;[Ljava/net/InetSocketAddress;)I": function* (t, [fd, newfd, isaa]): NativeGen {
    return yield* acceptInto(t, fd, newfd, isaa);
  },
  "sun/nio/ch/UnixAsynchronousSocketChannelImpl.checkConnect(I)V": (t, [fd]) => {
    const s = socksOf(t.vm.state).get(fd);
    if (!s) throw ioError(EBADF);
    const e = s.error;
    s.error = 0;
    if (e) throw socketError(e);
  },
  "sun/nio/ch/IOUtil.configureBlocking(Ljava/io/FileDescriptor;Z)V": (t, [fd, blocking]) => {
    const s = lookup(t, fd);
    if (s) s.blocking = blocking === 1;
  },

  "sun/nio/ch/NativeThread.current0()J": (t) => BigInt(t.id),
  "sun/nio/ch/NativeThread.signal0(J)V": (t, [tid]) => {
    for (const x of t.vm.threads) if (BigInt(x.id) === tid) blocked.get(x)?.();
  },
};
