// Messages between the page (api.ts) and the worker (worker.ts).

import type { LibraryRequest } from "../library.ts";

export interface InitMessage {
  type: "init";
  // URL of the directory holding jdk/ and boot.pack
  runtime: string;
  // URL that /app/ maps to
  app: string;
  props: Record<string, string>;
  hostName?: string;
  env: Record<string, string>;
  localeData: boolean;
  // JNI names of natives the page implements
  natives: string[];
  // report the download of the runtime
  progress: boolean;
}

export interface RunMessage {
  type: "run";
  id: number;
  // 1 = main class, 2 = jar (LauncherHelper modes)
  mode: number;
  what: string;
  classpath: string[];
  args: string[];
}

export interface FileMessage {
  type: "file";
  path: string;
  data: Uint8Array;
}

export interface RemoveFileMessage {
  type: "removeFile";
  path: string;
}

// The page imported a native library module (or failed to).
export interface LibraryLoadedMessage {
  type: "libraryLoaded";
  id: number;
  // JNI names the module implements
  names?: string[];
  error?: string;
}

export interface StdinMessage {
  type: "stdin";
  // null closes stdin
  data: Uint8Array | null;
}

export interface NativeResultMessage {
  type: "nativeResult";
  id: number;
  value?: unknown;
  // typed arguments the native changed, by argument index
  back?: (ArrayBufferView | null)[];
  error?: string;
}

// Starts a VM in library mode with id lib. Run ids and library ids share one
// counter, so a VM id names either.
export interface LibraryMessage {
  type: "library";
  id: number;
  lib: number;
  classpath: string[];
}

// A request to a VM's library: a call, a field access or a class load.
export interface CallMessage {
  type: "call";
  id: number;
  lib: number;
  req: LibraryRequest;
}

// The page dropped proxies: each [id, n] gives back n references.
export interface ReleaseMessage {
  type: "release";
  lib: number;
  ids: [number, number][];
}

export interface ReadFileMessage {
  type: "readFile";
  id: number;
  path: string;
}

export type ToWorker = InitMessage | RunMessage | FileMessage | RemoveFileMessage | LibraryLoadedMessage | StdinMessage | NativeResultMessage | LibraryMessage | CallMessage | ReleaseMessage | ReadFileMessage;

export type FromWorker =
  | { type: "ready" }
  | { type: "out"; fd: 1 | 2; data: Uint8Array }
  | { type: "exit"; id: number; code: number }
  | { type: "error"; message: string }
  | { type: "native"; id: number; vm: number; name: string; args: unknown[] }
  // System.loadLibrary: the page imports the module at path, from the bytes when it is not under /app/
  | { type: "loadLibrary"; id: number; path: string; bytes?: Uint8Array }
  // bytes of the runtime downloaded so far
  | { type: "progress"; done: number; total: number }
  // Java closed a file under /files/downloads/
  | { type: "download"; name: string; data: Uint8Array }
  // answers a library, call or readFile message; throwable is the Handle of a Java exception
  | { type: "reply"; id: number; value?: unknown; back?: [number, ArrayBufferView][]; error?: string; throwable?: unknown };
