// Types of the package's Node entry, dist/node.js. test/node-types.ts checks
// them against src/node.ts, so `pnpm typecheck` fails when they drift.

export interface NodeRunOptions {
  classpath: string[];
  mainClass?: string;
  jar?: string;
  args?: string[];
  // system properties
  props?: Record<string, string>;
  // an exploded JDK image instead of the packaged one
  jdk?: string;
  debug?: boolean;
  stdout?: (bytes: Uint8Array) => void;
  stderr?: (bytes: Uint8Array) => void;
  // fixed stdin contents instead of the process stdin
  input?: Uint8Array;
  // native methods in JS as in CheerpJ: Java_pkg_Class_method(lib, ...args)
  natives?: Record<string, (lib: any, ...args: any[]) => unknown>;
  // -ea, -da:pkg..., -esa and the like
  assertions?: string[];
  // the process exits when its resident memory goes past this
  maxRssMb?: number;
  enablePreview?: boolean;
  // what InetAddress.getLocalHost() reports instead of the host's name
  hostName?: string;
  // what System.getenv() returns instead of the host's environment
  env?: Record<string, string>;
  // load jdk.localedata, the formats and names of locales other than English
  localeData?: boolean;
  // loopback sockets whose http: requests go to this fetch, instead of host sockets
  fetch?: typeof fetch;
}

// A running VM, as startLibrary returns it.
export interface JavaVM {
  // resolves to the exit code
  readonly exited: Promise<number>;
  halt(code: number): void;
}

// Runs a main class or jar; resolves to the exit code.
export function runNode(options: NodeRunOptions): Promise<number>;

// Starts a VM in library mode.
export function startLibrary(options: NodeRunOptions): Promise<JavaVM>;

// A library-mode VM's `lib`, as cheerpjRunLibrary returns it in the browser.
export function libraryOf(vm: JavaVM): any;
