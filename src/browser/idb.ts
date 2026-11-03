// Keeps a MemoryBackend in IndexedDB, so /files/ survives page reloads, and
// the boot snapshots of recent starts. The whole file store loads at startup;
// changes are written back in batches.

import type { MemoryBackend, MemoryEntry } from "../fs.ts";
import type { SnapshotImage } from "../snapshot.ts";

const DB = "java-web", FILES = "files", SNAPSHOTS = "snapshots";
// snapshot keys, most recently used first
const ORDER = "#order";
const KEEP_SNAPSHOTS = 4;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// null without IndexedDB (private mode, some workers)
let opened: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  return (opened ??= (async () => {
    if (typeof indexedDB === "undefined") return null;
    try {
      const open = indexedDB.open(DB, 2);
      open.onupgradeneeded = () => {
        for (const s of [FILES, SNAPSHOTS]) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
      };
      return await request(open);
    } catch {
      return null;
    }
  })());
}

// Loads saved files into backend and keeps saving its changes. Without
// IndexedDB the backend stays memory-only.
export async function persist(backend: MemoryBackend): Promise<void> {
  const d = await db();
  if (!d) return;
  const tx = d.transaction(FILES, "readonly").objectStore(FILES);
  const [keys, values] = await Promise.all([request(tx.getAllKeys()), request(tx.getAll())]);
  keys.forEach((k, i) => {
    const v = values[i] as MemoryEntry | "dir";
    if (v === "dir") backend.putDir(k as string);
    else backend.put(k as string, v.data, v.mtime);
  });

  const pending = new Map<string, MemoryEntry | "dir" | null>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const store = d.transaction(FILES, "readwrite").objectStore(FILES);
    for (const [path, entry] of pending) {
      if (entry === null) store.delete(path);
      else store.put(entry, path);
    }
    pending.clear();
  };
  backend.onChange = (path, entry) => {
    pending.set(path, entry);
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 50);
    }
  };
}

// Moves key to the front of the use order, dropping snapshots past the limit;
// image, when given, is stored under key.
async function useSnapshot(key: string, image?: SnapshotImage) {
  const d = await db();
  if (!d) return;
  const store = d.transaction(SNAPSHOTS, "readwrite").objectStore(SNAPSHOTS);
  if (image) store.put(image, key);
  const order = [key, ...((await request(store.get(ORDER))) as string[] | undefined ?? []).filter((k) => k !== key)];
  for (const k of order.slice(KEEP_SNAPSHOTS)) store.delete(k);
  store.put(order.slice(0, KEEP_SNAPSHOTS), ORDER);
}

export async function loadSnapshot(key: string): Promise<SnapshotImage | null> {
  try {
    const d = await db();
    if (!d) return null;
    const image = (await request(d.transaction(SNAPSHOTS, "readonly").objectStore(SNAPSHOTS).get(key))) as SnapshotImage | undefined;
    if (!image) return null;
    useSnapshot(key).catch(() => {});
    return image;
  } catch {
    return null;
  }
}

// image must not change afterwards: it is stored once the database is open
export function saveSnapshot(image: SnapshotImage) {
  useSnapshot(image.key, image).catch(() => {});
}
