// Page-side API. Load java-web.js with a script tag, then:
//
//   await cheerpjInit();
//   cheerpjCreateDisplay(800, 600);
//   await cheerpjRunJar("/app/app.jar");
//
// The names match CheerpJ so existing pages can switch. /app/ maps to the
// web server root, /files/ is writable storage, /str/ holds strings added
// with cheerpOSAddStringFile.

import { Bridge, messageOf, nativeTable } from "../bridge.ts";
import type { LibraryReply, LibraryRequest } from "../library.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

const LM_CLASS = 1, LM_JAR = 2;

export interface InitOptions {
  // accepted for CheerpJ compatibility and ignored
  version?: number;
  status?: string;
  preloadResources?: unknown;
  // called with the bytes of the runtime downloaded so far and in all
  preloadProgress?: (done: number, total: number) => void;
  // "key=value" strings, as in CheerpJ
  javaProperties?: string[];
  // what InetAddress.getLocalHost() reports
  hostName?: string;
  // "KEY=value" strings that System.getenv() returns, as in CheerpJ
  env?: string[];
  // load the formats and names of locales other than English
  localeData?: boolean;
  // where java-web.js, the worker and jdk/ live; defaults to the script's directory
  runtime?: string;
  // receives output instead of the page console element
  onOutput?: (text: string, stream: "stdout" | "stderr") => void;
  // native methods as in CheerpJ: Java_pkg_Class_method(lib, this, ...args), may be async
  natives?: Record<string, (lib: object, ...args: any[]) => unknown>;
}

const inPage = typeof document !== "undefined";

function keyValues(list: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of list) {
    const eq = p.indexOf("=");
    out[eq < 0 ? p : p.slice(0, eq)] = eq < 0 ? "" : p.slice(eq + 1);
  }
  return out;
}

// about:blank frames have no location of their own but inherit the base URL.
// A Web Worker has no document; the stack names the script that importScripts loaded.
const scriptUrl = inPage
  ? (document.currentScript as HTMLScriptElement | null)?.src || document.baseURI
  : /(https?:\/\/[^\s)]+?|blob:[^\s)]+?):\d+:\d+/.exec(new Error().stack ?? "")?.[1] ?? self.location.href;
const baseUrl = () => (inPage ? document.baseURI : self.location.href);

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
// settles once cheerpjInit has been called and the worker is ready
let initStarted!: (p: Promise<void>) => void;
const initDone = new Promise<void>((resolve) => (initStarted = resolve));
// ids of runs, libraries and requests
let nextRun = 1;
const runs = new Map<number, (code: number) => void>();
let output: InitOptions["onOutput"] | null = null;
let display: HTMLElement | null = null;
let appBase = "";
const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };

function send(m: ToWorker, transfer: Transferable[] = []) {
  worker!.postMessage(m, transfer);
}

function consoleElement(): HTMLElement | null {
  return inPage ? document.getElementById("console") ?? display : null;
}

// The browser console gets whole lines, so print("a"); print("b") logs "ab".
// A partial line that stays for 100 ms is logged anyway.
const partial = { stdout: "", stderr: "" };
const partialTimer: Partial<Record<"stdout" | "stderr", ReturnType<typeof setTimeout>>> = {};

function logLines(stream: "stdout" | "stderr", text: string) {
  const log = stream === "stderr" ? console.error : console.log;
  const lines = (partial[stream] + text).split("\n");
  partial[stream] = lines.pop()!;
  for (const line of lines) log(line);
  clearTimeout(partialTimer[stream]);
  if (partial[stream]) partialTimer[stream] = setTimeout(() => flushLog(stream), 100);
}

function flushLog(stream: "stdout" | "stderr") {
  clearTimeout(partialTimer[stream]);
  if (!partial[stream]) return;
  (stream === "stderr" ? console.error : console.log)(partial[stream]);
  partial[stream] = "";
}

function write(text: string, stream: "stdout" | "stderr") {
  if (output) return output(text, stream);
  const el = consoleElement();
  if (el) {
    const span = document.createElement("span");
    if (stream === "stderr") span.style.color = "#c33";
    span.textContent = text;
    el.appendChild(span);
  }
  logLines(stream, text);
}

// Hands a file Java wrote under /files/downloads/ to the browser's downloads.
function download(name: string, data: Uint8Array<ArrayBuffer>) {
  if (!inPage) return;
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// System.loadLibrary("name"): imports name.js and takes its default export as natives.
async function loadLibrary(id: number, path: string, bytes?: Uint8Array<ArrayBuffer>) {
  try {
    if (!bytes && !path.startsWith("/app/")) throw new Error("no bytes for a module outside /app/");
    const url = bytes ? URL.createObjectURL(new Blob([bytes], { type: "text/javascript" })) : new URL(path.slice("/app/".length), appBase).href;
    let mod: any;
    try {
      mod = await import(url);
    } finally {
      if (bytes) URL.revokeObjectURL(url);
    }
    const table = nativeTable(mod);
    Object.assign(natives, table);
    send({ type: "libraryLoaded", id, names: Object.keys(table) });
  } catch (e) {
    send({ type: "libraryLoaded", id, error: e instanceof Error ? e.message : String(e) });
  }
}

export function cheerpjInit(options: InitOptions = {}): Promise<void> {
  if (ready) return ready;
  const runtime = new URL(options.runtime ?? ".", scriptUrl).href;
  appBase = new URL("/", baseUrl()).href;
  output = options.onOutput ?? null;
  const props = keyValues(options.javaProperties);
  const env = keyValues(options.env);
  worker = new Worker(new URL("java-web-worker.js", runtime));
  ready = new Promise((resolve, reject) => {
    worker!.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      switch (m.type) {
        case "ready": resolve(); break;
        case "out": write(decoders[m.fd].decode(m.data, { stream: true }), m.fd === 1 ? "stdout" : "stderr"); break;
        case "exit":
          flushLog("stdout");
          flushLog("stderr");
          runs.get(m.id)?.(m.code);
          runs.delete(m.id);
          break;
        case "progress": options.preloadProgress?.(m.done, m.total); break;
        case "loadLibrary": loadLibrary(m.id, m.path, m.bytes as Uint8Array<ArrayBuffer> | undefined); break;
        case "download": download(m.name, m.data as Uint8Array<ArrayBuffer>); break;
        case "error": console.error("java-web:", m.message); reject(new Error(m.message)); break;
        case "native": callNative(m.vm, m.id, m.name, m.args); break;
        case "reply": {
          const p = requests.get(m.id);
          requests.delete(m.id);
          if (m.error !== undefined) p?.reject(Object.assign(new Error(m.error), { throwable: m.throwable }));
          else p?.resolve({ value: m.value, back: m.back });
          break;
        }
      }
    };
  });
  natives = options.natives ?? {};
  send({ type: "init", runtime, app: appBase, props, hostName: options.hostName, env, localeData: !!options.localeData, natives: Object.keys(natives), progress: !!options.preloadProgress });
  initStarted(ready);
  return ready;
}

let natives: NonNullable<InitOptions["natives"]> = {};

async function callNative(vm: number, id: number, name: string, args: unknown[]) {
  try {
    const r = await bridge.native(vm, natives[name], args);
    send({ type: "nativeResult", id, value: r.value, back: r.back });
  } catch (e) {
    send({ type: "nativeResult", id, error: messageOf(e) });
  }
}

const requests = new Map<number, { resolve: (v: LibraryReply) => void; reject: (e: Error) => void }>();

// Sends a message the worker answers with a reply.
function request(m: { type: "library"; lib: number; classpath: string[] } | { type: "call"; lib: number; req: LibraryRequest } | { type: "readFile"; path: string }): Promise<LibraryReply> {
  if (!ready) throw new Error("call cheerpjInit() first");
  return ready.then(() => new Promise((resolve, reject) => {
    const id = nextRun++;
    requests.set(id, { resolve, reject });
    send({ ...m, id } as ToWorker);
  }));
}

const bridge = new Bridge({
  call: (lib, req) => request({ type: "call", lib, req }),
  release: (lib, ids) => send({ type: "release", lib, ids }),
});

function start(mode: number, what: string, classpath: string[], args: string[]): Promise<number> {
  if (!ready) throw new Error("call cheerpjInit() first");
  return ready.then(() => new Promise<number>((resolve) => {
    const id = nextRun++;
    runs.set(id, resolve);
    send({ type: "run", id, mode, what, classpath, args });
  }));
}

// Runs a main class. classPath is ":"-separated, e.g. "/app/lib.jar:/app/classes/".
export function cheerpjRunMain(className: string, classPath: string, ...args: string[]): Promise<number> {
  return start(LM_CLASS, className, classPath.split(":").filter(Boolean), args.map(String));
}

export function cheerpjRunJar(jarPath: string, ...args: string[]): Promise<number> {
  return start(LM_JAR, jarPath, [jarPath], args.map(String));
}

// Starts a VM whose classes JS can call, as in CheerpJ: `await lib.pkg.Class`
// gives the class; call its static methods, read its static fields, make
// objects with `await new Class()` and call theirs. Can be called before
// cheerpjInit, and then waits for it.
export function cheerpjRunLibrary(classPath: string): Promise<any> {
  const lib = nextRun++;
  return initDone
    .then(() => request({ type: "library", lib, classpath: classPath.split(":").filter(Boolean) }))
    .then(() => bridge.root(lib));
}

// Reads a file from the VM's file system, e.g. one Java wrote under /files/.
export function cjFileBlob(path: string): Promise<Blob> {
  return request({ type: "readFile", path }).then((r) => new Blob([r.value as Uint8Array<ArrayBuffer>]));
}

// Creates the element program output goes to (and, later, AWT windows).
export function cheerpjCreateDisplay(width: number, height: number, parent?: HTMLElement): HTMLElement {
  if (!inPage) throw new Error("cheerpjCreateDisplay needs a page, not a Web Worker");
  display = document.createElement("pre");
  display.className = "cheerpjDisplay";
  Object.assign(display.style, {
    width: width < 0 ? "100%" : `${width}px`,
    height: height < 0 ? "100%" : `${height}px`,
    overflow: "auto", margin: "0", whiteSpace: "pre-wrap",
  });
  (parent ?? document.body).appendChild(display);
  return display;
}

// Adds a file under /str/ (or /files/) that Java code can read.
export function cheerpOSAddStringFile(path: string, data: string | Uint8Array) {
  if (!worker) throw new Error("call cheerpjInit() first");
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  send({ type: "file", path, data: bytes });
}

// Same as cheerpOSAddStringFile, under the name CheerpJ 2 used.
export const cheerpjAddStringFile = cheerpOSAddStringFile;

// Removes a file added under /str/ (or /files/). A missing file is ignored.
export function cheerpOSRemoveStringFile(path: string) {
  if (!worker) throw new Error("call cheerpjInit() first");
  send({ type: "removeFile", path });
}

// Feeds System.in; null ends the input.
export function javaWebWriteStdin(data: string | null) {
  send({ type: "stdin", data: data === null ? null : new TextEncoder().encode(data) });
}

Object.assign(globalThis, {
  cheerpjInit, cheerpjRunMain, cheerpjRunJar, cheerpjRunLibrary, cheerpjCreateDisplay, cheerpOSAddStringFile,
  cheerpjAddStringFile, cheerpOSRemoveStringFile, cjFileBlob, javaWebWriteStdin,
});
