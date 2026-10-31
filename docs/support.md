# What runs

java-web targets headless Java: console apps, libraries and javac.

- The image has every Java SE module (`java.se`) plus `jdk.compiler`,
  `jdk.httpserver`, `jdk.jartool` (the `jar` tool), `jdk.security.jgss`,
  `jdk.unsupported`, `jdk.zipfs`, `jdk.internal.md` (Markdown in doc comments,
  for javac's doc comment API) and `jdk.localedata` (see Locales).
- `java.desktop`'s headless parts work: 2D geometry, image pixels, `Graphics2D`
  drawing on a `BufferedImage`, and JavaBeans. So does `java.xml`, including
  XML Schema validation and DTDs from the JDK's built-in catalog.
- `jrt:/` URLs read the JDK's resources but not its class files.
- Not supported: GUI apps (AWT and Swing windows), `ConvolveOp`, child
  processes, and native libraries other than JS natives.

## Locales

Locales other than English need `cheerpjInit({ localeData: true })`, or
  `--locale-data` under Node (`localeData: true` for `runNode`). Turn it on
  when a program formats numbers, dates or currencies, or prints month and day
  names, for a locale other than English: for example
  `String.format(Locale.GERMANY, ...)`, or a German default locale. Without it,
  those locales format as English. It is off by default because, once on, it
  slows the first formatting call of every program, English ones included, by
  a few hundred milliseconds. With it on, a page also fetches the locale file
  list (`jdk/jdk.localedata.txt`, 160 KB) at start, then only the locales it
  uses.

## Graphics and text

- `Graphics2D` fills, strokes, clips, transforms, composites, paints, XOR mode and `drawImage` give
  HotSpot's pixels on `INT_ARGB`, `INT_RGB`, `INT_ARGB_PRE`, `INT_BGR`, `3BYTE_BGR`, `4BYTE_ABGR`,
  `4BYTE_ABGR_PRE`, `BYTE_GRAY`, `USHORT_565_RGB`, `USHORT_555_RGB`, `USHORT_GRAY`, `BYTE_INDEXED`
  (including the ordered dither) and `BYTE_BINARY` images. Gray-palette `BYTE_INDEXED`
  images and custom color models use the JDK's own Java loops, which draw but can round blended
  pixels differently.
- Text (`drawString`, `drawGlyphVector`, `TextLayout`, `FontMetrics`, `Font.createGlyphVector`,
  glyph outlines) uses one bundled font, DejaVu Sans, in the image's `lib/fonts`. Dialog,
  SansSerif, Serif, Monospaced and DialogInput all map to it, and bold and italic are
  synthesized, as on a Linux HotSpot with only that font installed. A small TrueType
  rasterizer in JavaScript stands in for FreeType and does no hinting, so text pixels differ
  from HotSpot's, and so do the whole-pixel glyph advances of the default (not fractional)
  metrics, by up to a pixel per glyph. With fractional metrics, font metrics, advances and
  glyph outlines match HotSpot's. LCD text draws as grayscale antialiasing. Layout puts one
  glyph per character, with pair kerning when a font asks for it: no ligatures or shaping of
  complex scripts, and right to left text is only reversed. `Font.createFont` loads other
  TrueType (`glyf`) fonts, not OpenType fonts with CFF outlines.

## Networking

`java.net` sockets, NIO channels and selectors run on the JDK's own
`sun.nio.ch` code over a socket backend. `jdk.httpserver` is in the image.

- Under Node, TCP and UDP use real sockets (`node:net`, `node:dgram`), names
  resolve through `node:dns`, and `NetworkInterface` lists the host's IPv4
  interfaces.
- In the browser, sockets reach other threads of the same VM on 127.0.0.0/8,
  so a Java server and client can talk inside one page. `localhost` and
  address literals resolve, and `lo` is the only interface.
  `cheerpjInit({ hostName })` sets what `InetAddress.getLocalHost()` reports
  (`localhost` by default).
- In the browser, `http:` and `https:` URLs reach the network through the
  page's `fetch`, for `URL.openStream`, `HttpURLConnection` and
  `java.net.http.HttpClient`. The VM sets `http.proxyHost` and
  `https.proxyHost` to a virtual proxy at 127.0.0.2:3128 (unless
  `javaProperties` sets its own), and that proxy turns each request into a
  `fetch`. The browser's rules apply: CORS, and no `http:` requests from an
  `https:` page. A failed fetch is a 502 response. Redirects are followed by
  `fetch`, and a response body is read whole before Java sees it. Raw sockets
  to other hosts still fail.
- The browser does the TLS for `https:`. The proxy answers `CONNECT host:port`
  and then reads plain HTTP in the tunnel, and `fetch` does the TLS and checks
  the certificate. A small provider, the `javaweb.tls` module (`scripts/tls`),
  makes that work: the VM puts it first in the security provider list, through
  `conf/security/java-web-proxy.security`, so `SSLContext.getDefault()`,
  `getInstance("TLS")` and the default `SSLSocketFactory` return contexts that
  copy bytes through. Java then sees this:
  - The session reports cipher suite `TLS_NULL_WITH_NULL_NULL`, protocol
    `TLS` and no certificates. `getPeerCertificates` throws
    `SSLPeerUnverifiedException`, because the browser checked the chain and
    does not pass it on.
  - Key managers, trust managers and the arguments of `SSLContext.init` have
    no effect. The default hostname check passes, and a hostname verifier
    set on a connection is called with that session.
  - No ALPN is negotiated, so `HttpClient` uses HTTP/1.1.
  - TLS servers (`SSLServerSocket`, `HttpsServer`) are not supported.
  - Under Node with host sockets the JDK's own TLS is used, and the provider
    is off.
- TCP, UDP, IPv4 multicast, Unix domain sockets and `Pipe` work in both. Under
  Node a Unix domain socket is a file on the host; in the browser it is a file
  in the virtual file system.
- IPv4 only. Not supported: IPv6, asynchronous channels
  (`AsynchronousSocketChannel`), SCTP, ICMP (`isReachable` is true for the
  host's own addresses only) and inherited channels.
