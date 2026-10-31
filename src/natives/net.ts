// java.net natives: name lookup and network interfaces over vm.net.

import { INITIALIZED } from "../runtime.ts";
import type { JArray, JClass, JObject } from "../runtime.ts";
import { PendingThrow } from "../thread.ts";
import type { JThread, NativeGen } from "../thread.ts";
import { ipv4Literal, isLoopback, isWildcard, sameAddr } from "../sockets.ts";
import type { Endpoint, NetIf } from "../sockets.ts";
import type { Natives } from "./util.ts";

function* construct(t: JThread, c: JClass, desc: string, ...args: any[]): NativeGen {
  const vm = t.vm;
  if (c.state !== INITIALIZED) yield* vm.initGen(t, c);
  const o = vm.newObject(c);
  yield t.call(c.methodMap.get(`<init>${desc}`)!, o, ...args);
  return o;
}

export function* inet4(t: JThread, host: string | null, bytes: Uint8Array): NativeGen {
  const vm = t.vm;
  const addr = vm.newArray(vm.primClass("B"), 4);
  (addr.a as Int8Array).set(bytes);
  return yield* construct(t, vm.loadBoot("java/net/Inet4Address")!, "(Ljava/lang/String;[B)V", host === null ? null : vm.str(host), addr);
}

export function* socketAddress(t: JThread, ep: Endpoint): NativeGen {
  const ia = yield* inet4(t, null, ep.addr);
  return yield* construct(t, t.vm.loadBoot("java/net/InetSocketAddress")!, "(Ljava/net/InetAddress;I)V", ia, ep.port);
}

export function inetBytes(t: JThread, ia: JObject): Uint8Array {
  if (ia.cls.name === "java/net/Inet6Address") throw new PendingThrow("java/net/SocketException", "Protocol family unavailable");
  const holder = t.vm.getField(ia, "java/net/InetAddress", "holder");
  const a = t.vm.getField(holder, "java/net/InetAddress$InetAddressHolder", "address") as number;
  return Uint8Array.of(a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255);
}

function localName(t: JThread): string {
  return t.vm.opts.hostName ?? t.vm.net.hostName();
}

function* lookup(t: JThread, host: string): NativeGen {
  const found = host === t.vm.opts.hostName ? [ipv4Literal(host) ?? Uint8Array.of(127, 0, 0, 1)] : yield t.block(t.vm.net.lookup(host));
  if (!found) throw new PendingThrow("java/net/UnknownHostException", `${host}: Name or service not known`);
  const out: JObject[] = [];
  for (const a of found) out.push(yield* inet4(t, host, a));
  return t.vm.newObjectArray("java/net/InetAddress", out);
}

function* hostByAddr(t: JThread, addr: JArray): NativeGen {
  const a = (addr.a as Int8Array);
  const bytes = Uint8Array.from(a);
  const name = isLoopback(bytes) ? "localhost" : yield t.block(t.vm.net.lookupAddr(bytes));
  if (!name) throw new PendingThrow("java/net/UnknownHostException");
  return t.vm.str(name);
}

function ifaces(t: JThread): NetIf[] {
  return t.vm.net.interfaces();
}

function owns(i: NetIf, addr: Uint8Array) {
  return i.addrs.some((a) => sameAddr(a.addr, addr));
}

function* networkInterface(t: JThread, i: NetIf): NativeGen {
  const vm = t.vm;
  const ni = vm.loadBoot("java/net/NetworkInterface")!;
  const addrs: JObject[] = [], binds: JObject[] = [];
  const ib = vm.loadBoot("java/net/InterfaceAddress")!;
  if (ib.state !== INITIALIZED) yield* vm.initGen(t, ib);
  for (const a of i.addrs) {
    const ia = yield* inet4(t, null, a.addr);
    addrs.push(ia);
    const b = vm.newObject(ib);
    vm.setField(b, "java/net/InterfaceAddress", "address", ia);
    if (a.broadcast) vm.setField(b, "java/net/InterfaceAddress", "broadcast", yield* inet4(t, null, a.broadcast));
    vm.setField(b, "java/net/InterfaceAddress", "maskLength", a.prefix);
    binds.push(b);
  }
  const o: JObject = yield* construct(t, ni, "(Ljava/lang/String;I[Ljava/net/InetAddress;)V", vm.str(i.name), i.index, vm.newObjectArray("java/net/InetAddress", addrs));
  vm.setField(o, "java/net/NetworkInterface", "displayName", vm.str(i.name));
  vm.setField(o, "java/net/NetworkInterface", "bindings", vm.newObjectArray("java/net/InterfaceAddress", binds));
  vm.setField(o, "java/net/NetworkInterface", "childs", vm.newObjectArray("java/net/NetworkInterface", []));
  return o;
}

function named(t: JThread, name: JObject | null): NetIf {
  if (!name) throw new PendingThrow("java/lang/NullPointerException", "network interface name is NULL");
  const n = t.vm.jsString(name);
  const i = ifaces(t).find((x) => x.name === n);
  if (!i) throw new PendingThrow("java/net/SocketException", "No such device");
  return i;
}

export const natives: Natives = {
  "java/net/InetAddress.init()V": () => undefined,
  "java/net/Inet4Address.init()V": () => undefined,
  "java/net/Inet6Address.init()V": () => undefined,
  "java/net/NetworkInterface.init()V": () => undefined,
  "java/net/InetAddress.isIPv4Available()Z": () => 1,
  "java/net/InetAddress.isIPv6Supported()Z": () => 0,
  "java/net/NetworkInterface.getAll()[Ljava/net/NetworkInterface;": function* (t): NativeGen {
    const out: JObject[] = [];
    for (const i of ifaces(t)) out.push(yield* networkInterface(t, i));
    return t.vm.newObjectArray("java/net/NetworkInterface", out);
  },
  "java/net/NetworkInterface.getByName0(Ljava/lang/String;)Ljava/net/NetworkInterface;": function* (t, [name]): NativeGen {
    if (!name) throw new PendingThrow("java/lang/NullPointerException", "network interface name is NULL");
    const n = t.vm.jsString(name);
    const i = ifaces(t).find((x) => x.name === n);
    return i ? yield* networkInterface(t, i) : null;
  },
  "java/net/NetworkInterface.getByIndex0(I)Ljava/net/NetworkInterface;": function* (t, [index]): NativeGen {
    const i = index > 0 ? ifaces(t).find((x) => x.index === index) : undefined;
    return i ? yield* networkInterface(t, i) : null;
  },
  "java/net/NetworkInterface.getByInetAddress0(Ljava/net/InetAddress;)Ljava/net/NetworkInterface;": function* (t, [ia]): NativeGen {
    const a = inetBytes(t, ia);
    const i = ifaces(t).find((x) => owns(x, a));
    return i ? yield* networkInterface(t, i) : null;
  },
  "java/net/NetworkInterface.boundInetAddress0(Ljava/net/InetAddress;)Z": (t, [ia]) => {
    const a = inetBytes(t, ia);
    return ifaces(t).some((x) => owns(x, a)) ? 1 : 0;
  },
  "java/net/NetworkInterface.isUp0(Ljava/lang/String;I)Z": (t, [name]) => (named(t, name).up ? 1 : 0),
  "java/net/NetworkInterface.isLoopback0(Ljava/lang/String;I)Z": (t, [name]) => (named(t, name).loopback ? 1 : 0),
  "java/net/NetworkInterface.supportsMulticast0(Ljava/lang/String;I)Z": (t, [name]) => (named(t, name).multicast ? 1 : 0),
  "java/net/NetworkInterface.isP2P0(Ljava/lang/String;I)Z": (t, [name]) => (named(t, name).p2p ? 1 : 0),
  "java/net/NetworkInterface.getMTU0(Ljava/lang/String;I)I": (t, [name]) => named(t, name).mtu,
  "java/net/NetworkInterface.getMacAddr0([BLjava/lang/String;I)[B": (t, [, name]) => {
    const mac = named(t, name).mac;
    if (!mac) return null;
    const a = t.vm.newArray(t.vm.primClass("B"), mac.length);
    (a.a as Int8Array).set(mac);
    return a;
  },
  "java/net/Inet4AddressImpl.getLocalHostName()Ljava/lang/String;": (t) => t.vm.str(localName(t)),
  "java/net/Inet4AddressImpl.lookupAllHostAddr(Ljava/lang/String;)[Ljava/net/InetAddress;": (t, [, host]) => lookup(t, t.vm.jsString(host)),
  "java/net/Inet4AddressImpl.getHostByAddr([B)Ljava/lang/String;": (t, [, addr]) => hostByAddr(t, addr),
  "java/net/Inet4AddressImpl.isReachable0([BI[BI)Z": (t, [, addr]) => reachable(t, addr),
  "java/net/Inet6AddressImpl.getLocalHostName()Ljava/lang/String;": (t) => t.vm.str(localName(t)),
  "java/net/Inet6AddressImpl.lookupAllHostAddr(Ljava/lang/String;I)[Ljava/net/InetAddress;": (t, [, host]) => lookup(t, t.vm.jsString(host)),
  "java/net/Inet6AddressImpl.getHostByAddr([B)Ljava/lang/String;": (t, [, addr]) => hostByAddr(t, addr),
  "java/net/Inet6AddressImpl.isReachable0([BII[BII)Z": (t, [, addr]) => reachable(t, addr),

  "java/util/TimeZone.getSystemTimeZoneID(Ljava/lang/String;)Ljava/lang/String;": (t) => {
    let id = "UTC";
    try {
      id = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      // no Intl time zone support
    }
    return t.vm.str(id);
  },
  "java/util/TimeZone.getSystemGMTOffsetID()Ljava/lang/String;": (t) => {
    const off = -new Date().getTimezoneOffset();
    const a = Math.abs(off);
    const pad = (n: number) => String(n).padStart(2, "0");
    return t.vm.str(`GMT${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`);
  },
};

// Only addresses of this host count as reachable.
function reachable(t: JThread, addr: JArray): number {
  const a = Uint8Array.from(addr.a as Int8Array);
  return isLoopback(a) || (!isWildcard(a) && ifaces(t).some((i) => owns(i, a))) ? 1 : 0;
}
