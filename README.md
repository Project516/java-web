# java-web

A JVM written in TypeScript that runs Java 25 class files and JARs in the
browser and under Node. It runs the real OpenJDK 25 class library unmodified,
and its page API matches CheerpJ's, so existing pages can switch.

## Use it in a page

```sh
pnpm add @project516/java-web
```

Serve `node_modules/@project516/java-web/dist/` as static files (on a GitHub
Pages project site, `/app/` is the site root `user.github.io`, so the page's
files are under `/app/<repo>/`), then:

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

## Use it under Node

```sh
npx @project516/java-web -cp classes Main          # or: npx @project516/java-web -jar app.jar
```

```js
import { runNode } from "@project516/java-web";
const code = await runNode({ classpath: ["classes"], mainClass: "Main" });
```

See [docs/node.md](docs/node.md).

## What runs

- Console apps, libraries and javac: every Java SE module, plus `jdk.compiler`,
  `jdk.httpserver` and a few more.
- The headless parts of `java.desktop`, including `Graphics2D` on a
  `BufferedImage`, with HotSpot's pixels except for text.
- Sockets: real ones under Node; in the browser, loopback inside the VM and
  `http:`/`https:` through `fetch`.
- Child processes under Node, through the host's own programs.
- Not yet: AWT and Swing windows, child processes in the browser, IPv6.

Details: [docs/support.md](docs/support.md).

## Compared with CheerpJ

[CheerpJ](https://cheerpj.com/) 5.0 takes the same page calls (`cheerpjInit`,
`cheerpjRunMain`), so the two can be compared on one page. Medians, measured
2026-11-08 in headless Chromium on one machine, with java-web 0.1.3 from npm
and CheerpJ 5.0 from its CDN. Cold means an empty browser cache; the downloads
are the runtime and JDK only, not the program's own jars.

| | java-web 0.1.3 | CheerpJ 5.0 |
|---|---|---|
| Java 25 | yes | preview |
| Hello world, cold | 0.55 s, 3.7 MB | 4.3 s, 10.8 MB |
| Hello world, warm | 0.17 s, nothing downloaded | 2.4 s, 3.8 MB |
| AWT and Swing windows | not yet | yes |
| License | AGPL-3.0 | free for personal, educational, evaluation and non-commercial open-source use, loaded from CheerpJ's CDN; business use needs a licence |

CheerpJ also runs Java 8, 11, 17 and 21, applets and JNLP; java-web runs only Java 25.

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
