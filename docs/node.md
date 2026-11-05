# Using java-web under Node

The package's Node entry runs Java on Node 23.6 or newer, against the same
packaged JDK image (`dist/boot.pack`, `dist/jdk/`) that pages use. The host file
system is the VFS root, and Java sees the host's environment.

## Command

```sh
npx @project516/java-web [options] Main [args]
npx @project516/java-web [options] -jar app.jar [args]
```

| Option | Meaning |
|---|---|
| `-cp`, `-classpath`, `--class-path` | class path, `:`-separated (default `.`) |
| `-Dkey=value` | a system property |
| `-ea`, `-da`, `-esa` and the rest | assertions, as with `java` |
| `--enable-preview` | preview features |
| `--add-exports`, `--add-opens`, `--add-reads`, `--add-modules`, `--module-path`, `-p` | module options, as with `java` |
| `--locale-data` | locales other than English (see [support.md](support.md#locales)) |
| `-Xmx` | the largest array, and what `Runtime.maxMemory()` reports (default and at most 1g, rounded up to 2 MB steps, below 2m an error); the total heap is not counted |
| `--max-rss MB` | exit when resident memory passes this (default 2048) |
| `--jdk DIR` | a java-web JDK image instead of the packaged one |
| `--debug` | log VM events |

Other `-X` and HotSpot-only options are ignored.

## From JS

```js
import { runNode } from "@project516/java-web";

const out = [];
const code = await runNode({
  classpath: ["classes"],
  mainClass: "Main",        // or jar: "app.jar"
  args: ["a", "b"],
  stdout: (bytes) => out.push(bytes),
});
```

The package ships TypeScript declarations (`dist/node.d.ts`). `runNode`
resolves to the exit code. Its options:

- `classpath`, `mainClass` or `jar`, `args`, `props` (system properties)
- `stdout`, `stderr` (byte callbacks; default the process's), `input` (fixed stdin bytes)
- `env` (what `System.getenv()` returns; default the host's environment)
- `natives`: Java `native` methods in JS, as in the browser ([browser.md](browser.md))
- `assertions` (the flags, for example `["-ea"]`), `enablePreview`, `localeData`
- `hostName` (what `InetAddress.getLocalHost()` reports), `maxRssMb`, `jdk`, `debug`
- `fetch`: sockets stay inside the VM, and `http:` requests go to this `fetch`, as in the browser

- `snapshotDir`: where boot snapshots are kept, or `null` for none (see below)
- `warmSnapshot: true`: save a library VM once its calls have warmed it up (see below)

`startLibrary(options)` starts a VM in library mode, and `libraryOf(vm)` is its
`lib`, used as `cheerpjRunLibrary`'s result is in the browser. `vm.halt(0)`
stops it.

## Boot snapshots

Most of a start is the JDK's own boot. The second time a setup boots, java-web
saves the VM as it is after boot, and later starts with the same setup load it
instead, which is about three times faster. A setup is the java-web build, the
working directory, the class path, system properties and VM options: boot
reads all of them. The snapshots, about 1 MB each, are kept in
`$XDG_CACHE_HOME/java-web/snapshots` (`~/.cache/java-web/snapshots`), the 16
most recently used. Set `JAVA_WEB_SNAPSHOT_DIR` to keep them elsewhere, or to
an empty value to turn them off.

Set `warmSnapshot: true` in `startLibrary` options to save the VM after a call
returns once its calls have loaded at least 200 classes since boot (one javac
compile loads over a thousand) and no library handles are live. A later library
start with the same class path and working directory restores it, after
checking that the files, missing paths and directory listings those calls used
are unchanged; a javac compile from it takes about 1 s instead of 6 s on a
Raspberry Pi 5. An image is about 18 MB; warm snapshots share the snapshot
directory and keep the 2 most recent. They build on boot snapshots, so with
`snapshotDir: null` there are none.
