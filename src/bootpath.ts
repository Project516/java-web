// Class files on the -Xbootclasspath/a path: directories and jars on the host.

import * as fs from "node:fs";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";

type Jar = { buf: Buffer; entries: Map<string, { method: number; size: number; at: number }> };

function readJar(file: string): Jar | null {
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch { return null; }
  // a jar that cannot be read has no classes, as a malformed one on HotSpot's path
  try {
    let end = buf.length - 22;
    while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0) return null;
    const entries = new Map<string, { method: number; size: number; at: number }>();
    let p = buf.readUInt32LE(end + 16);
    for (let n = buf.readUInt16LE(end + 10); n > 0 && buf.readUInt32LE(p) === 0x02014b50; n--) {
      const nameLen = buf.readUInt16LE(p + 28);
      entries.set(buf.toString("utf8", p + 46, p + 46 + nameLen), { method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20), at: buf.readUInt32LE(p + 42) });
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return { buf, entries };
  } catch {
    return null;
  }
}

function fromJar(jar: Jar, name: string): Uint8Array | null {
  const e = jar.entries.get(name);
  if (!e) return null;
  try {
    const start = e.at + 30 + jar.buf.readUInt16LE(e.at + 26) + jar.buf.readUInt16LE(e.at + 28);
    const data = jar.buf.subarray(start, start + e.size);
    return e.method === 0 ? data : e.method === 8 ? inflateRawSync(data) : null;
  } catch {
    return null;
  }
}

// entries is the colon-separated -Xbootclasspath/a value
export function bootClassPath(entries: string | undefined): ((name: string) => { bytes: Uint8Array; location: string } | null) | undefined {
  if (!entries) return undefined;
  const list = entries.split(":").filter(Boolean).map((e) => ({ entry: path.resolve(e), jar: undefined as Jar | null | undefined }));
  return (name) => {
    for (const e of list) {
      if (e.jar === undefined) e.jar = fs.statSync(e.entry, { throwIfNoEntry: false })?.isDirectory() ? null : readJar(e.entry);
      if (e.jar) {
        const bytes = fromJar(e.jar, `${name}.class`);
        if (bytes) return { bytes, location: e.entry };
      } else if (e.jar === null) {
        try { return { bytes: fs.readFileSync(path.join(e.entry, `${name}.class`)), location: e.entry }; } catch { /* not here */ }
      }
    }
    return null;
  };
}

// --patch-module module=path:path, as the jdk.module.patch.N properties hold it
export function bootPatches(props: Record<string, string> | undefined): ((module: string, name: string) => Uint8Array | null) | undefined {
  const paths = new Map<string, string[]>();
  for (const [k, v] of Object.entries(props ?? {})) {
    const eq = v.indexOf("=");
    if (/^jdk\.module\.patch\.\d+$/.test(k) && eq > 0) paths.set(v.slice(0, eq), [...(paths.get(v.slice(0, eq)) ?? []), v.slice(eq + 1)]);
  }
  if (paths.size === 0) return undefined;
  const finders = new Map([...paths].map(([module, list]) => [module, bootClassPath(list.join(":"))!]));
  return (module, name) => finders.get(module)?.(name)?.bytes ?? null;
}
