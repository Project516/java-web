// Host sockets for the Node entry: node:net and node:dgram behind Sock.

import * as dgram from "node:dgram";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DGRAM_RCVBUF, HIGH_WATER, MAX_DGRAM, Sock } from "./sockets.ts";
import type { Endpoint, NetBackend, NetIf } from "./sockets.ts";
import * as E from "./sockets.ts";

const ERRNO: Record<string, number> = {
  ENOENT: E.ENOENT, EPERM: E.EPERM, EACCES: E.EACCES, EINVAL: E.EINVAL, EPIPE: E.EPIPE, EMSGSIZE: E.EMSGSIZE,
  EADDRINUSE: E.EADDRINUSE, EADDRNOTAVAIL: E.EADDRNOTAVAIL, ENETUNREACH: E.ENETUNREACH,
  ECONNABORTED: E.ECONNABORTED, ECONNRESET: E.ECONNRESET, ENOBUFS: E.ENOBUFS, ENOTCONN: E.ENOTCONN,
  ENODEV: 19, ETIMEDOUT: E.ETIMEDOUT, ECONNREFUSED: E.ECONNREFUSED, EHOSTUNREACH: E.EHOSTUNREACH, EAFNOSUPPORT: E.EAFNOSUPPORT,
};

// Linux errno numbers, whatever the host's are
function errnoOf(e: unknown): number {
  const code = (e as { code?: string })?.code;
  return (code && ERRNO[code]) || E.EINVAL;
}

function parseIp(s: string | undefined): Uint8Array {
  if (!s) return new Uint8Array(4);
  if (s.includes(":")) {
    const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
    return m ? Uint8Array.of(+m[1], +m[2], +m[3], +m[4]) : new Uint8Array(4);
  }
  return Uint8Array.from(s.split(".").map(Number));
}

const ipString = (a: Uint8Array) => (E.isWildcard(a) ? "0.0.0.0" : `${a[0]}.${a[1]}.${a[2]}.${a[3]}`);
const peerString = (a: Uint8Array) => (E.isWildcard(a) ? "127.0.0.1" : ipString(a));

function sysfs(name: string, file: string): number | null {
  try {
    return Number(fs.readFileSync(`/sys/class/net/${name}/${file}`, "utf8"));
  } catch {
    return null;
  }
}

function prefixOf(mask: string): number {
  let n = 0;
  for (const b of parseIp(mask)) for (let i = 7; i >= 0 && (b >> i) & 1; i--) n++;
  return n;
}

interface TcpImpl {
  ns?: net.Socket;
  srv?: net.Server;
  werr?: number;
  resume?: () => void;
  // listener: connections the host accepted beyond the backlog, and the clients in this VM connecting to it by local port
  overflow?: { c: Sock; pairing?: Pairing }[];
  clients?: Map<number, Pairing>;
  // client: its connect to a listener of this VM
  pairing?: Pairing;
}

// A connect from this VM to a listener of this VM finishes once the listener's accept queue
// admits the connection, as a kernel that drops the SYN of a full queue makes it.
interface Pairing {
  client: Sock;
  listener: Sock;
  port: number;
  connected: boolean;
  admitted: boolean;
  finish?: () => void;
}

interface UdpImpl {
  ds?: dgram.Socket;
  // the address the socket was bound to before a connect gave it a source address
  boundLocal?: Endpoint;
  // sends the host socket has not finished, which a close must wait for
  pending?: number;
  closing?: boolean;
}

// TCP connections reset; a Unix domain connection closes, since libuv has no reset for it
function reset(ns: net.Socket) {
  // a reset that fails emits 'error', which must not go unhandled
  ns.on("error", () => {});
  if (ns.remoteAddress) ns.resetAndDestroy();
  else ns.destroy();
}

// A socket address holds 107 bytes of path; a long absolute path under the working
// directory goes in relative, as a program that binds a relative name does.
function shortUnixPath(p: string): string {
  if (Buffer.byteLength(p) <= 107) return p;
  const rel = path.relative(process.cwd(), p);
  return Buffer.byteLength(rel) < Buffer.byteLength(p) ? rel : p;
}

export class NodeNet implements NetBackend {
  private live = new Set<Sock>();

  hostName() {
    return os.hostname();
  }

  interfaces(): NetIf[] {
    const out: NetIf[] = [];
    let ordinal = 1;
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      const v4 = (list ?? []).filter((a) => a.family === "IPv4");
      if (v4.length === 0) continue;
      const loopback = v4[0].internal;
      const mac = v4[0].mac.split(":").map((h) => parseInt(h, 16));
      out.push({
        name,
        index: sysfs(name, "ifindex") ?? ordinal,
        up: true,
        loopback,
        p2p: false,
        multicast: !loopback,
        mtu: sysfs(name, "mtu") ?? (loopback ? 65536 : 1500),
        mac: mac.some((b) => b !== 0) ? Uint8Array.from(mac) : null,
        addrs: v4.map((a) => {
          const addr = parseIp(a.address), prefix = prefixOf(a.netmask);
          const mask = parseIp(a.netmask);
          const broadcast = loopback ? null : addr.map((b, i) => b | (~mask[i] & 0xff));
          return { addr, prefix, broadcast };
        }),
      });
      ordinal++;
    }
    return out.sort((a, b) => a.index - b.index);
  }

  async lookup(host: string) {
    try {
      const r = await dns.promises.lookup(host, { all: true, family: 4 });
      return r.length > 0 ? r.map((a) => parseIp(a.address)) : null;
    } catch {
      return null;
    }
  }

  async lookupAddr(addr: Uint8Array) {
    try {
      return (await dns.promises.lookupService(ipString(addr), 0)).hostname;
    } catch {
      return null;
    }
  }

  bind(s: Sock, ep: Endpoint): number | Promise<number> {
    return s.stream ? this.bindTcp(s, ep) : this.bindUdp(s, ep);
  }

  readonly hostUnix = true;

  // The names clients of this VM bound before connecting to a path, in connect order. A host
  // socket cannot tell its peer's name, so an accepted socket takes the next one.
  private unixClients = new Map<string, { name: string }[]>();

  bindUnix(s: Sock, path: string) {
    return this.listenOn(s, { path: shortUnixPath(path) }, () => {
      s.localPath = path;
    }, path);
  }

  connectUnix(s: Sock, path: string) {
    const entry = { name: s.localPath };
    const names = this.unixClients.get(path);
    if (names) names.push(entry);
    else this.unixClients.set(path, [entry]);
    return this.connectTo(s, { path: shortUnixPath(path) }, () => {
      s.remotePath = path;
      s.peerInVm = [...this.live].some((l) => l.localPath === path && (l.impl as TcpImpl | null)?.srv);
    }, () => {
      const list = this.unixClients.get(path);
      const i = list?.indexOf(entry) ?? -1;
      if (i >= 0) list!.splice(i, 1);
      if (list?.length === 0) this.unixClients.delete(path);
    });
  }

  private bindTcp(s: Sock, ep: Endpoint): Promise<number> {
    return this.listenOn(s, { port: ep.port, host: ipString(ep.addr), reusePort: s.option(1, 15, 0) !== 0 }, (srv) => {
      s.local = { addr: ep.addr.slice(), port: (srv.address() as net.AddressInfo).port };
    });
  }

  // Listens with the given net options; s collects what connects.
  private listenOn(s: Sock, options: net.ListenOptions, bound: (srv: net.Server) => void, unixPath?: string): Promise<number> {
    return new Promise((resolve) => {
      const srv = net.createServer({ allowHalfOpen: true });
      srv.once("error", (e) => resolve(errnoOf(e)));
      srv.on("connection", (ns) => {
        if (s.closed) return void reset(ns);
        const c = new Sock("stream");
        c.connected = true;
        if (ns.localAddress) {
          c.local = { addr: parseIp(ns.localAddress), port: ns.localPort ?? 0 };
          c.remote = { addr: parseIp(ns.remoteAddress), port: ns.remotePort ?? 0 };
        } else {
          c.unix = true;
          c.localPath = s.localPath;
          const client = unixPath ? this.unixClients.get(unixPath)?.shift() : undefined;
          c.remotePath = client?.name ?? "";
          c.peerInVm = client !== undefined;
        }
        this.attach(c, ns);
        const im = s.impl as TcpImpl;
        const pairing = im.clients?.get(ns.remotePort ?? -1);
        if (s.backlog.length > s.maxBacklog) im.overflow!.push({ c, pairing });
        else {
          s.backlog.push(c);
          if (pairing) this.admit(pairing);
        }
        s.notify();
      });
      srv.listen(options, () => {
        srv.removeAllListeners("error");
        srv.on("error", () => {});
        bound(srv);
        s.impl = { srv, overflow: [], clients: new Map() } satisfies TcpImpl;
        this.live.add(s);
        resolve(0);
      });
    });
  }

  private bindUdp(s: Sock, ep: Endpoint): Promise<number> {
    return new Promise((resolve) => {
      const ds = dgram.createSocket({
        type: "udp4", reuseAddr: s.option(1, 2, 0) !== 0, reusePort: s.option(1, 15, 0) !== 0,
      });
      ds.once("error", (e) => resolve(errnoOf(e)));
      ds.on("message", (msg, r) => {
        if (s.rxBytes + msg.length > s.option(1, 8, DGRAM_RCVBUF)) return;
        s.rxBytes += msg.length;
        s.dgrams.push({ from: { addr: parseIp(r.address), port: r.port }, data: Uint8Array.from(msg) });
        s.notify();
      });
      ds.bind({ port: ep.port, address: ipString(ep.addr) }, () => {
        ds.removeAllListeners("error");
        ds.on("error", (e) => s.fail(errnoOf(e)));
        s.local = { addr: ep.addr.slice(), port: ds.address().port };
        s.impl = { ds } satisfies UdpImpl;
        this.live.add(s);
        for (const [k, v] of s.options) {
          const buffer = k >> 16 === 1 && ((k & 0xffff) === 7 || (k & 0xffff) === 8);
          this.setOption(s, k >> 16, k & 0xffff, buffer ? Math.trunc(v / 2) : v);
        }
        resolve(0);
      });
    });
  }

  listen(s: Sock, backlog: number) {
    s.listening = true;
    s.maxBacklog = E.backlogLimit(backlog);
    this.accepted(s);
    return 0;
  }

  // The accept queue lost its head: connections waiting beyond the backlog move in, and
  // the clients of this VM among them finish connecting.
  accepted(l: Sock) {
    const q = (l.impl as TcpImpl | null)?.overflow;
    while (q && q.length > 0 && l.backlog.length <= l.maxBacklog) {
      const { c, pairing } = q.shift()!;
      l.backlog.push(c);
      l.notify();
      if (pairing) this.admit(pairing);
    }
  }

  private admit(p: Pairing) {
    p.admitted = true;
    this.finishPairing(p);
  }

  private finishPairing(p: Pairing) {
    if (!p.admitted || !p.connected) return;
    (p.listener.impl as TcpImpl | null)?.clients?.delete(p.port);
    const im = p.client.impl as TcpImpl | null;
    if (im) im.pairing = undefined;
    p.finish!();
  }

  // Wires a connected host socket to s.
  private attach(s: Sock, ns: net.Socket) {
    const im: TcpImpl = { ns, resume: () => ns.resume() };
    s.impl = im;
    this.live.add(s);
    ns.on("data", (d: Buffer) => {
      if (s.shutRd) return;
      s.push(new Uint8Array(d.buffer, d.byteOffset, d.length));
      if (s.rxBytes >= HIGH_WATER) ns.pause();
    });
    ns.on("end", () => s.endOfFile());
    ns.on("drain", () => {
      s.wblocked = false;
      s.notify();
    });
    ns.on("error", (e) => {
      const n = errnoOf(e);
      if (s.connecting) {
        s.connecting = false;
        s.fail(n);
        return;
      }
      im.werr = E.EPIPE;
      s.eof = true;
      s.wblocked = false;
      s.fail(n);
    });
    ns.on("close", () => {
      im.werr ??= E.EPIPE;
      s.eof = true;
      s.wblocked = false;
      s.notify();
    });
  }

  connect(s: Sock, ep: Endpoint): number | Promise<number> {
    return s.stream ? this.connectTcp(s, ep) : this.connectUdp(s, ep);
  }

  private connectTcp(s: Sock, ep: Endpoint): number {
    const bound = s.local;
    return this.connectTo(s, {
      host: peerString(ep.addr), port: ep.port,
      ...(bound && { localAddress: ipString(bound.addr), localPort: bound.port }),
    }, (ns) => {
      s.local = { addr: parseIp(ns.localAddress), port: ns.localPort ?? 0 };
      s.remote = { addr: ep.addr.slice(), port: ep.port };
    }, undefined, this.listenerAt(ep));
  }

  private listenerAt(ep: Endpoint): Sock | undefined {
    const to = E.isWildcard(ep.addr) ? Uint8Array.of(127, 0, 0, 1) : ep.addr;
    return [...this.live].find((o) => o.listening && !o.unix && o.local?.port === ep.port && E.overlap(o.local.addr, to));
  }

  // listener is a listening socket of this VM that the connect goes to
  private connectTo(
    s: Sock, options: net.NetConnectOpts, connected: (ns: net.Socket) => void, failed?: () => void, listener?: Sock,
  ): number {
    s.connecting = true;
    const start = () => {
      const ns = net.connect({ ...options, allowHalfOpen: true });
      this.attach(s, ns);
      const im = s.impl as TcpImpl;
      let pairing: Pairing | undefined;
      // the host assigns the local port by now; the listener's connection event may come before this one's connect event
      if (listener) process.nextTick(() => {
        const clients = (listener.impl as TcpImpl | null)?.clients;
        if (!clients || ns.localPort === undefined || s.impl !== im) return;
        pairing = im.pairing = { client: s, listener, port: ns.localPort, connected: false, admitted: false };
        clients.set(ns.localPort, pairing);
      });
      let made = false;
      if (failed) ns.once("close", () => { if (!made) failed(); });
      ns.once("connect", () => {
        made = true;
        const finish = () => {
          s.connecting = false;
          s.connected = true;
          connected(ns);
          s.notify();
        };
        if (!pairing) return finish();
        pairing.finish = finish;
        pairing.connected = true;
        this.finishPairing(pairing);
      });
    };
    // a socket bound before connecting holds its port in a listening server
    const srv = (s.impl as TcpImpl | null)?.srv;
    if (srv) {
      s.impl = null;
      srv.close(start);
    } else start();
    return E.EINPROGRESS;
  }

  private connectUdp(s: Sock, ep: Endpoint): Promise<number> {
    const ds = (s.impl as UdpImpl | null)?.ds;
    if (!ds) return Promise.resolve(E.EBADF);
    return new Promise((resolve) => {
      // Linux lets a connected datagram socket connect again; Node wants it disconnected first
      if (s.connected) {
        try { ds.disconnect(); } catch { /* not connected */ }
      }
      const onConnect = () => {
        s.connected = true;
        s.remote = { addr: ep.addr.slice(), port: ep.port };
        // connecting gives a wildcard-bound socket the source address the route picks
        try {
          const a = ds.address();
          const im = s.impl as UdpImpl;
          if (a.family === "IPv4" && s.local && E.isWildcard(s.local.addr)) {
            im.boundLocal ??= s.local;
            s.local = { addr: parseIp(a.address), port: a.port };
          }
        } catch { /* keeps the bound address */ }
        resolve(0);
      };
      ds.once("connect", onConnect);
      try {
        ds.connect(ep.port, peerString(ep.addr));
      } catch (e) {
        // the host socket is disconnected by now
        ds.removeListener("connect", onConnect);
        s.connected = false;
        s.remote = null;
        resolve(errnoOf(e));
      }
    });
  }

  // Linux forgets the port of a socket that disconnects, so bind it again to keep it.
  async disconnect(s: Sock) {
    const ds = (s.impl as UdpImpl | null)?.ds;
    const local = (s.impl as UdpImpl | null)?.boundLocal ?? s.local;
    s.connected = false;
    s.remote = null;
    if (!ds || !local) return 0;
    ds.removeAllListeners("message");
    await new Promise<void>((done) => ds.close(done));
    return this.bindUdp(s, local);
  }

  write(s: Sock, data: Uint8Array) {
    const im = s.impl as TcpImpl | null;
    const ns = im?.ns;
    if (!ns) return E.ENOTCONN;
    if (im.werr || ns.destroyed || s.shutWr) return im.werr ?? E.EPIPE;
    if (!ns.write(data)) s.wblocked = true;
    return 0;
  }

  send(s: Sock, data: Uint8Array, to: Endpoint | null) {
    const im = s.impl as UdpImpl | null;
    const ds = im?.ds;
    if (!im || !ds) return E.EBADF;
    if (data.length > MAX_DGRAM) return E.EMSGSIZE;
    const done = (e: Error | null) => {
      if (e) s.fail(errnoOf(e));
      if (--im.pending! === 0 && im.closing) ds.close();
    };
    im.pending = (im.pending ?? 0) + 1;
    try {
      if (s.connected) ds.send(data, done);
      else if (to) ds.send(data, to.port, peerString(to.addr), done);
      else {
        im.pending--;
        return E.ENOTCONN;
      }
    } catch (e) {
      im.pending--;
      return errnoOf(e);
    }
    return 0;
  }

  shutdown(s: Sock, how: number) {
    if (how !== 1) s.shutRd = true;
    if (how !== 0) {
      s.shutWr = true;
      (s.impl as TcpImpl | null)?.ns?.end();
    }
    s.notify();
  }

  setOption(s: Sock, level: number, opt: number, value: number) {
    const im = s.impl as TcpImpl & UdpImpl | null;
    if (!im) return;
    try {
      if (im.ns) {
        if (level === 6 && opt === 1) im.ns.setNoDelay(value !== 0);
        else if (level === 1 && opt === 9) im.ns.setKeepAlive(value !== 0);
      } else if (im.ds) {
        if (level === 1 && opt === 6) im.ds.setBroadcast(value !== 0);
        else if (level === 1 && opt === 7) im.ds.setSendBufferSize(value);
        else if (level === 1 && opt === 8) im.ds.setRecvBufferSize(value);
        else if (level === 0 && opt === 2) im.ds.setTTL(value);
        else if (level === 0 && opt === 33) im.ds.setMulticastTTL(value);
        else if (level === 0 && opt === 34) im.ds.setMulticastLoopback(value !== 0);
        else if (level === 0 && opt === 32) im.ds.setMulticastInterface(ipString(Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)));
      }
    } catch {
      // the option stays as the JDK last set it
    }
  }

  membership(s: Sock, join: boolean, group: Uint8Array, iface: Uint8Array | null, source: Uint8Array | null) {
    const ds = (s.impl as UdpImpl | null)?.ds;
    if (!ds) return E.EBADF;
    try {
      const g = ipString(group), i = iface ? ipString(iface) : undefined;
      if (source) {
        const src = ipString(source);
        if (join) ds.addSourceSpecificMembership(src, g, i);
        else ds.dropSourceSpecificMembership(src, g, i);
      } else if (join) ds.addMembership(g, i);
      else ds.dropMembership(g, i);
    } catch (e) {
      return errnoOf(e);
    }
    return 0;
  }

  close(s: Sock) {
    this.live.delete(s);
    // a listener resets the connections nobody accepted
    for (const b of s.backlog) this.dropQueued(b);
    s.backlog = [];
    const im = s.impl as TcpImpl & UdpImpl | null;
    s.impl = null;
    if (!im) return;
    // a connect that timed out or was abandoned leaves the listener's queues
    const p = im.pairing;
    if (p) {
      const l = p.listener.impl as TcpImpl | null;
      l?.clients?.delete(p.port);
      const at = l?.overflow?.findIndex((e) => e.pairing === p) ?? -1;
      if (at >= 0) this.dropQueued(l!.overflow!.splice(at, 1)[0].c);
    }
    // the listener resets what nobody accepted; like a kernel that dropped the SYN, a held connect then gets refused
    for (const { c, pairing } of im.overflow ?? []) {
      this.dropQueued(c);
      const client = pairing?.client;
      const ci = client?.impl as TcpImpl | undefined;
      if (!client || !ci) continue;
      ci.pairing = undefined;
      ci.ns?.removeAllListeners();
      ci.ns?.on("error", () => {});
      ci.ns?.destroy();
      client.impl = null;
      client.connecting = false;
      client.fail(E.ECONNREFUSED);
    }
    im.overflow = [];
    im.clients?.clear();
    if (im.srv) {
      // libuv removes a closed server's socket file, a kernel leaves it
      const path = im.srv.address();
      im.srv.close();
      if (typeof path === "string" && !fs.existsSync(path)) fs.writeFileSync(path, "");
    }
    if (im.ds) {
      if (im.pending) im.closing = true;
      else im.ds.close();
    }
    const ns = im.ns;
    if (!ns) return;
    if (s.option(1, 13, -1) === 0) ns.resetAndDestroy();
    else if (ns.writableLength > 0 && !ns.destroyed) ns.end(() => ns.destroy());
    else ns.destroy();
  }

  private dropQueued(c: Sock) {
    this.live.delete(c);
    const ns = (c.impl as TcpImpl | null)?.ns;
    c.impl = null;
    if (ns) reset(ns);
  }

  closeAll() {
    for (const s of [...this.live]) this.close(s);
  }
}
