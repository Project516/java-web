# Development

You need Node 23.6 or newer, pnpm, curl, bzip2, and Linux or macOS. `pnpm jdk`
downloads a pinned Temurin 25 release for your host and one for Linux x64 (the
same download on Linux x64) into `~/.cache/java-web`, and checks each SHA-256.
The runtime image comes from the Linux x64 JDK, so every machine, a Mac
included, builds the same image, with the Linux class library whose natives
java-web implements. The host JDK is the HotSpot reference the tests run, linked
at `build/hotspot`. The build links the selected modules into `build/jdk/lib/modules`;
`lib/packages.txt` indexes packages for the boot class loader. `pnpm build`
puts it, with the files around it, in `dist/jdk/image.jar`, read by byte range.
It packs the byte ranges a typical start reads into `boot.pack`, and those javac
adds into `jdk/javac.pack`. Without `localeData`, the VM leaves `jdk.localedata`
out with `jdk.module.limitmods`, as `--limit-modules` does.

```sh
pnpm install
pnpm jdk                      # builds build/jdk from the pinned JDK 25
cat > /tmp/Hello.java <<'EOF'
void main() { IO.println("Hello from Java " + Runtime.version().feature()); }
EOF
build/hotspot/bin/javac -d /tmp /tmp/Hello.java
node src/node.ts -cp /tmp Hello
```

```sh
pnpm build        # bundles the runtime into dist/ with the JDK image
pnpm serve        # http://localhost:8080/ runs the demo page
```

## Tests

`pnpm test` compares programs in `test/java` with HotSpot (stdout, stderr and
exit code) and runs the native, library-mode, jar and text tests. Text pixels cannot match
HotSpot's, so `test/text` checks properties of drawn text instead. OpenJDK's own
regression tests (main, TestNG and JUnit) run separately:

```sh
node scripts/jtreg/run.ts <jdk-source> java/lang
```

`<jdk-source>` is a checkout of `openjdk/jdk25u` at the pinned JDK's tag:
`jdk-<version>-ga`, where `<version>` is `release=` in `scripts/build-jdk.sh`
without the `+build` part. A sparse checkout of `test/lib`, the test
directories, the `@library` directories they name and the Unicode and language
data under `src/java.base/share/data` (`lsrdata`, `unicodedata`) is enough;
`--only-passing --library-dirs` prints the `@library` directories of the listed
tests.

The runner follows jtreg where tests rely on it: `test.src.path` holds the test
directory and its `@library` directories, `${test.main.class}`, `${test.src}`
and the like are replaced in `@run` lines, the test directory is on the run
class path when the test's package starts there (for resource files next to a
test), `@clean` removes the named
classes between actions, `@run driver` runs as `main`, and `@run build` is a
`@build`. A test that patches `java.base`, needs a native library, is manual or
runs in a named module is skipped.

HotSpot always has every locale, but java-web loads the locale data only with
`--locale-data`, which makes start-up and locale-heavy tests slower (about 15%
on the `java/text`, `java/util/Locale`, `java/util/Calendar` and
`java/time/format` tests, and three tests over 5 times slower). So the runner
passes it only to the tests in `test/jtreg/locale-data.txt`. To find which new
tests need it, run them with and without the runner's `--locale-data` flag,
which sets it for every test.

The runner evaluates a test's `@requires` as jtreg does on a release Linux
HotSpot with default options (for example `vm.continuations` is true and
`vm.debug` is false); a test that needs more is skipped.

`test/jtreg/passing.txt` lists the tests CI runs, with `--only-passing`.
`--shard k/n` splits them into n shards of about equal run time, using each
test's time on java-web from `test/jtreg/times.tsv` (the median for a test
not in it). Each CI shard uploads its `build/jtreg/times.tsv` as an artifact.
To refresh the file from a run, download those artifacts and merge them in:
a test's new time replaces its old one, and tests the run left out keep theirs.

```sh
gh run download <run-id> -p 'times-*' -D build/times
cat test/jtreg/times.tsv build/times/*/times.tsv |
  awk -F'\t' '{ t[$2] = $1 } END { for (id in t) print t[id] "\t" id }' |
  sort -rn > build/times.tsv && mv build/times.tsv test/jtreg/times.tsv
```

`pnpm build` also builds `dist/selftest/`, a browser check of library mode
(objects, fields, arrays, exceptions), page natives and javac.
`node scripts/serve.ts 8080 --like-github-pages` serves `dist/` the way GitHub
Pages does (compressed responses, with Range applied to the compressed bytes),
and `--compress-jars` also compresses `.jar` files; the page must pass there
too.

## How it works

- An interpreter executes bytecode. Java threads are green threads scheduled
  on the JS event loop.
- The OpenJDK 25 class library (`java.base`, plus `jdk.compiler` so javac
  runs in-process through `javax.tools`) runs unmodified. java-web implements the
  JVM's side: class loading, initialization, monitors, exceptions, and the
  JDK's native methods in JavaScript.
- Files come from a virtual file system with mount points, so the same code
  can read from the host under Node and over HTTP in the browser.
