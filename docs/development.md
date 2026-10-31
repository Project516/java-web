# Development

You need Node 23.6 or newer, pnpm, curl, bzip2, and Linux or macOS. `pnpm jdk`
downloads a pinned Temurin 25 release for your host and one for Linux x64 (the
same download on Linux x64) into `~/.cache/java-web`, and checks each SHA-256.
The runtime image comes from the Linux x64 JDK, so every machine, a Mac
included, builds the same image, with the Linux class library whose natives
java-web implements. The host JDK is the HotSpot reference the tests run, linked
at `build/hotspot`.

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
without the `+build` part. A sparse checkout of `test/lib` and the test
directories is enough.

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
