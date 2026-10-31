# java-web

A JVM written in TypeScript that runs Java 25 class files and JARs in the
browser and under Node. It runs the real OpenJDK 25 class library unmodified,
and its page API matches CheerpJ's, so existing pages can switch.

## Use it in a page

```sh
pnpm add java-web
```

Serve `node_modules/java-web/dist/` as static files, then:

```html
<script src="java-web.js"></script>
<pre id="console"></pre>
<script type="module">
  await cheerpjInit();
  await cheerpjRunJar("/app/my-app.jar");   // /app/ is the web server root
</script>
```

`cheerpjRunMain`, `cheerpjRunLibrary` (call Java from JS), JS natives and
`/files/` storage work too. See [docs/browser.md](docs/browser.md).

## What runs

- Console apps, libraries and javac: every Java SE module, plus `jdk.compiler`,
  `jdk.httpserver` and a few more.
- The headless parts of `java.desktop`, including `Graphics2D` on a
  `BufferedImage`, with HotSpot's pixels except for text.
- Sockets: real ones under Node; in the browser, loopback inside the VM and
  `http:`/`https:` through `fetch`.
- Not yet: AWT and Swing windows, child processes, IPv6.

Details: [docs/support.md](docs/support.md).

## Develop

You need Node 23.6+, pnpm, curl and bzip2 on Linux or macOS.

```sh
pnpm install
pnpm jdk          # downloads the pinned JDK 25 and builds the image
pnpm test         # compares programs against HotSpot
pnpm build        # builds dist/
```

More: [docs/development.md](docs/development.md).

## License

AGPL-3.0-only. The OpenJDK class library is GPL-2.0 with the Classpath
Exception, and the bundled DejaVu Sans font has its own license; both notices
ship in `dist/jdk/legal/`.
