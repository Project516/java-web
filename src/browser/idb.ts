// Keeps a MemoryBackend in IndexedDB, so /files/ survives page reloads.
// The whole store loads at startup; changes are written back in batches.

import type { MemoryBackend, MemoryEntry } from "../fs.ts";

const DB = "java-web", STORE = "files";

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
