# java-web

A JVM written in TypeScript that runs unmodified Java 25 bytecode (classes and
JARs) in the browser, in the spirit of CheerpJ. It runs the real OpenJDK 25
class library: the JDK's own classes do the work, and this project implements
the JVM underneath them plus the native methods they call. It also runs under
Node, which is how the tests run.

## Direction

- Compatibility first. Run JDK classes unmodified and implement what HotSpot
  does for them (natives, VM upcalls, init order). Do not patch or replace JDK
  classes. When behavior differs from HotSpot, HotSpot is right.
- Performance second, and always measured. Startup time and memory matter as
  much as throughput; check numbers against `java` on the same machine.
- Small and memory efficient. It should run on low-end devices. Avoid
  dependencies; the runtime has none.
- The browser API mirrors CheerpJ's (`cheerpjInit`, `cheerpjRunMain`,
  `cheerpjRunJar`, `/app/` and `/files/` paths) so existing pages can switch.
- Headless Java first: console apps, libraries and javac. The
  image has every Java SE module, `java.desktop` for its headless parts (2D
  geometry, images, `Graphics2D` drawing on a `BufferedImage`, JavaBeans);
  GUI apps (AWT and Swing windows) are out of scope for now. Text draws with
  one bundled font, DejaVu Sans, rasterized in JS; its pixels differ from
  HotSpot's FreeType output, everything else follows a Linux HotSpot that has
  only that font.
- Prove it with tests: programs whose output must match HotSpot exactly, and
  OpenJDK's own regression tests where they can run.
- master is used: pages build pinned commits of it and rely on `cheerpjInit`
  (`natives`, `javaProperties`), `cheerpjRunMain`, `cheerpjRunLibrary`
  (static String calls), `cheerpOSAddStringFile`, `cjFileBlob`, `/files/` in
  IndexedDB and one VM per about:blank iframe. Keep these working.
- The release form is an npm package of the built browser files only
  (`java-web.js`, `java-web-worker.js`, `boot.pack`, `jdk/<module>.jar`,
  `jdk/javac.pack`, `jdk/jdk.localedata.txt`, and OpenJDK's notices in `jdk/legal/`), versioned, with
  nothing built at install. A GitHub Actions workflow triggered by a release
  publishes it to npm; never publish by hand.

## Layout

- `src/classfile.ts` class file parser
- `src/runtime.ts` classes, methods, fields, objects, arrays
- `src/interp.ts` bytecode interpreter and per-thread run loop
- `src/jvm.ts` loading, linking, initialization, resolution, scheduler, boot
- `src/indy.ts` invokedynamic, method handles
- `src/library.ts` library mode in the VM: object handles, calls, field access,
  value conversion; `src/bridge.ts` the JS proxies over it
- `src/natives/` JS implementations of JDK native methods, by package;
  `java2d*.ts` port libawt's Java2D loops and must match HotSpot's pixels;
  `font*.ts` are the font natives (scaler, fontconfig, layout) over one TrueType font
- `src/sockets.ts` sockets (`Sock`, POSIX readiness) and the in-VM loopback backend;
  `src/net-node.ts` host sockets, DNS and interfaces for Node
- `src/node.ts` Node entry; `scripts/build-jdk.sh` builds `build/jdk`
- `src/http-proxy.ts` the browser's virtual HTTP proxy (`fetch`); `scripts/tls/` the
  `javaweb.tls` pass-through TLS provider it relies on for `https:`

## Commands

- `pnpm jdk` downloads the pinned JDK 25 and builds `build/jdk` from it (needed before anything runs)
- `node src/node.ts -cp DIR Main` runs a class; `--debug` logs VM events
- `pnpm test` runs the tests, `pnpm typecheck` checks types; the OpenJDK suite
  needs inputs first (see docs/development.md)
- `JW_JIT_STATS=1` prints what the JIT compiled, fell back on and entered
  through the run loop; `JW_JIT_DUMP=<method>` prints a method's generated JS
- `project516-review-bot` reviews every PR. Merge only once its review of the
  head commit has every finding fixed or answered on its thread. When it
  cannot read the whole diff, a subagent reviews the files it skipped

## Glossary

- **java.home image**: `build/jdk`, the Linux x64 JDK's class library in the
  exploded layout (`modules/<module>/...` instead of a `lib/modules` jimage),
  built the same on every host. Mounted at
  `/jdk` in the VFS. It has no `lib/modules`, which would switch the JDK to
  image mode; `lib/resources.jimage` holds only the non-class resources, for
  `jrt:` URLs.
- **VFS**: the virtual file system the Java side sees (`src/fs.ts`).
- **native**: a JS function implementing a Java `native` method, keyed by
  `class.name(desc)`. A plain native returns its result; a generator native
  yields requests (call Java, wait on a promise) and returns at the end.
- **NativeFrame**: a frame on a Java thread's stack that runs a generator
  native or VM work such as class initialization.
- **re-execute**: an instruction that needs class loading or initialization
  pushes that work and leaves its pc unchanged, so it runs again afterwards.
- **PendingThrow**: thrown by JS code to raise a new Java exception; the
  interpreter builds it with its real constructor.
- **mirror**: the `java.lang.Class` object of a runtime class.
- **handle**: how the VM names a Java object it gave to JS; the page's proxy
  holds it until the proxy is dropped.
- **wire value**: a value as it crosses between the VM and JS (library.ts).
- **Sock**: a socket, event or epoll file descriptor behind the `sun.nio.ch` natives. A
  backend (host sockets under Node, loopback inside the VM) moves its bytes.
