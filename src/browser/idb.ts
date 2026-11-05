// Keeps a MemoryBackend in IndexedDB, so /files/ survives page reloads, and
// the boot snapshots of recent starts. The whole file store loads at startup;
// changes are written back in batches.

import type { MemoryBackend, MemoryEntry } from "../fs.ts";
import type { SnapshotImage, WarmSnapshotImage } from "../snapshot.ts";

const DB = "java-web", STORE = "files";
// its own database, so adding it needs no version change that open pages would block
const SNAPSHOT_DB = "java-web-snapshots";
// snapshot keys, most recently used first
const ORDER = "#order";
const WARM_ORDER = "#warm-order";
const KEEP_SNAPSHOTS = 4, KEEP_WARM_SNAPSHOTS = 4;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Loads saved files into backend and keeps saving its changes. Without
// IndexedDB (private mode, some workers) the backend stays memory-only.
export async function persist(backend: MemoryBackend): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  let db: IDBDatabase;
  try {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    db = await request(open);
  } catch {
    return;
  }
  const tx = db.transaction(STORE, "readonly").objectStore(STORE);
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
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
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

// null without IndexedDB
let snapshotDb: Promise<IDBDatabase | null> | null = null;
function openSnapshots(): Promise<IDBDatabase | null> {
  return (snapshotDb ??= (async () => {
    if (typeof indexedDB === "undefined") return null;
    try {
      const open = indexedDB.open(SNAPSHOT_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      return await request(open);
    } catch {
      return null;
    }
  })());
}

// Moves key to the front of the use order, dropping snapshots past the limit.
// image, when given, is stored under key; null deletes it.
async function useSnapshot(key: string, image?: SnapshotImage | null) {
  const db = await openSnapshots();
  if (!db) return;
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  if (image) store.put(image, key);
  const order = ((await request(store.get(ORDER))) as string[] | undefined ?? []).filter((k) => k !== key);
  if (image !== null) order.unshift(key);
  for (const k of [...order.slice(KEEP_SNAPSHOTS), ...(image === null ? [key] : [])]) store.delete(k);
  store.put(order.slice(0, KEEP_SNAPSHOTS), ORDER);
}

export async function loadSnapshot(key: string): Promise<SnapshotImage | null> {
  try {
    const db = await openSnapshots();
    if (!db) return null;
    const image = (await request(db.transaction(STORE, "readonly").objectStore(STORE).get(key))) as SnapshotImage | undefined;
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

export function dropSnapshot(key: string) {
  useSnapshot(key, null).catch(() => {});
}

async function useWarmSnapshot(key: string, image?: WarmSnapshotImage | null) {
  const db = await openSnapshots();
  if (!db) return;
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  const id = `warm:${key}`;
  if (image) store.put(image, id);
  const order = ((await request(store.get(WARM_ORDER))) as string[] | undefined ?? []).filter((k) => k !== id);
  if (image !== null) order.unshift(id);
  for (const k of [...order.slice(KEEP_WARM_SNAPSHOTS), ...(image === null ? [id] : [])]) store.delete(k);
  store.put(order.slice(0, KEEP_WARM_SNAPSHOTS), WARM_ORDER);
}

export async function loadWarmSnapshot(key: string): Promise<WarmSnapshotImage | null> {
  try {
    const db = await openSnapshots();
    if (!db) return null;
    const id = `warm:${key}`;
    const image = (await request(db.transaction(STORE, "readonly").objectStore(STORE).get(id))) as WarmSnapshotImage | undefined;
    if (!image) return null;
    useWarmSnapshot(key).catch(() => {});
    return image;
  } catch { return null; }
}

export function saveWarmSnapshot(image: WarmSnapshotImage) {
  useWarmSnapshot(image.warmKey, image).catch(() => {});
}

export function dropWarmSnapshot(key: string) {
  useWarmSnapshot(key, null).catch(() => {});
}
