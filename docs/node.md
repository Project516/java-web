# Using java-web under Node

The package's Node entry runs Java on Node 23.6 or newer, against the same
packaged JDK image (`dist/boot.pack`, `dist/jdk/`) that pages use. The host file
system is the VFS root, and Java sees the host's environment.

## Command

```sh
npx java-web [options] Main [args]
npx java-web [options] -jar app.jar [args]
```

| Option | Meaning |
|---|---|
| `-cp`, `-classpath`, `--class-path` | class path, `:`-separated (default `.`) |
| `-Dkey=value` | a system property |
| `-ea`, `-da`, `-esa` and the rest | assertions, as with `java` |
| `--enable-preview` | preview features |
| `--add-exports`, `--add-opens`, `--add-reads`, `--add-modules`, `--module-path`, `-p` | module options, as with `java` |
| `--locale-data` | locales other than English (see [support.md](support.md#locales)) |
| `--max-rss MB` | exit when resident memory passes this (default 2048) |
| `--jdk DIR` | an exploded JDK image instead of the packaged one |
| `--debug` | log VM events |

Other `-X` and HotSpot-only options are ignored.

## From JS

```js
import { runNode } from "java-web";

const out = [];
const code = await runNode({
  classpath: ["classes"],
  mainClass: "Main",        // or jar: "app.jar"
  args: ["a", "b"],
  stdout: (bytes) => out.push(bytes),
});
```

`runNode` resolves to the exit code. Its options:

- `classpath`, `mainClass` or `jar`, `args`, `props` (system properties)
- `stdout`, `stderr` (byte callbacks; default the process's), `input` (fixed stdin bytes)
- `env` (what `System.getenv()` returns; default the host's environment)
- `natives`: Java `native` methods in JS, as in the browser ([browser.md](browser.md))
- `assertions` (the flags, for example `["-ea"]`), `enablePreview`, `localeData`
- `hostName` (what `InetAddress.getLocalHost()` reports), `maxRssMb`, `jdk`, `debug`

`startLibrary(options)` starts a VM in library mode, and `libraryOf(vm)` is its
`lib`, used as `cheerpjRunLibrary`'s result is in the browser. `vm.halt(0)`
stops it.
