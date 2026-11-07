# What runs

java-web targets headless Java: console apps, libraries and javac.

- The image has every Java SE module (`java.se`) plus `jdk.compiler`,
  `jdk.httpserver`, `jdk.jartool` (the `jar` tool), `jdk.security.jgss`,
  `jdk.management` (`UnixOperatingSystemMXBean`), `jdk.unsupported`,
  `jdk.zipfs`, `jdk.internal.md` (Markdown in doc comments,
  for javac's doc comment API) and `jdk.localedata` (see Locales).
- `java.desktop`'s headless parts work: 2D geometry, image pixels, `Graphics2D`
  drawing on a `BufferedImage`, and JavaBeans. So does `java.xml`, including
  XML Schema validation and DTDs from the JDK's built-in catalog.
- File mappings are copies in the VM's 512 MB native memory, which is also
  shared with direct buffers and other native allocations. A mapping that does
  not fit fails with `IOException: Map failed` and an `OutOfMemoryError` cause.
  Read-write changes reach the file on force or unmap.
- `Deflater` is a DEFLATE compressor in TypeScript (`src/deflate.ts`) with
  zlib's levels, strategies, flush modes, dictionaries and `setLevel` and
  `setStrategy` changes. Compressed sizes are close to zlib's at each level, but
  the bytes are not the same as HotSpot's zlib output.
- Child processes (`ProcessBuilder`, `Runtime.exec`, `ProcessHandle`) work
  under Node and run the host's programs. Starting `java` starts another
  java-web VM on the same image. A child cannot use a directory that exists only
  in the VM, such as `/jdk`, as its working directory. `ProcessHandle` reads
  other processes from Linux's `/proc`; elsewhere it sees only its own children.
- Symbolic and hard links work on file systems that come from the host, as
  under Node. Elsewhere, such as the browser's in-memory files, creating a link
  fails with "Function not implemented". Files on host file systems have the
  host's inode numbers and link counts, and the modes `open` and `mkdir` ask
  for, less the process's umask. In-memory files get synthetic inode numbers, a
  link count of 1 and default modes.
- `-XX:OnOutOfMemoryError` runs its commands under Node only, and `StackWalker`
  has no live locals or operands. A virtual thread unmounts when it parks,
  blocks on a monitor or waits in `Object.wait`, holding its monitors, as in
  JDK 25. It stays pinned to its carrier while a native frame (such as a class
  initializer) is on its stack or inside a critical section.
- `ThreadMXBean` describes threads and finds deadlocks, but has no CPU times
  and no blocked or waited times (contention monitoring is off). Thread dumps
  find a frame's locked monitors from its synchronized blocks as compilers emit
  them, and list a monitor taken any other way with stack depth -1.
- `WatchService` reports files the program itself, or another thread in the
  same VM, creates, changes or deletes. Under Node it also reports what other
  processes do to a watched host directory, with Node's `fs.watch` (so a short-lived
  entry can show as a delete without its create). Elsewhere it does not see
  changes made outside the VM.
- Not supported: GUI apps (AWT and Swing windows), `ConvolveOp`, child
  processes in the browser, and native libraries other than JS natives.

## Locales

Locales other than English need `cheerpjInit({ localeData: true })`, or
  `--locale-data` under Node (`localeData: true` for `runNode`). Adding
  `jdk.localedata` or `ALL-SYSTEM` with `--add-modules` turns it on too, and a
  `--limit-modules` list that leaves `jdk.localedata` out turns it off. Turn it on
  when a program formats numbers, dates or currencies, or prints month and day
  names, for a locale other than English: for example
  `String.format(Locale.GERMANY, ...)`, or a German default locale. Without it,
  those locales format as English. It is off by default because, once on, it
  slows the first formatting call of every program, English ones included, by
  up to a second on slow devices. With it on, a page reads only the locales it
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
  `fetch`, even when Java disables redirect following: a browser's manual
  redirect response hides the status and `Location` header. A response body is
  read whole before Java sees it. Raw sockets
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
- `jdk.net` is in the image. Its socket options (TCP keep-alive time, interval
  and probes, quick ack, don't fragment) keep their values on the socket and do
  not reach a host socket. Peer credentials are this process's user and group
  when the peer is in the same VM, and -1 for both when it is a host socket. TCP urgent data (`sendUrgentData`,
  `MSG_OOB`) is not supported: Node cannot send or read it.
