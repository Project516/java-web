# Using java-web in a page

The npm package holds the built files: `java-web.js`, `java-web-worker.js`,
`boot.pack` and `jdk/` for pages, and `node.js` for Node ([node.md](node.md)). Serve `node_modules/@project516/java-web/dist/` as static files
and load `java-web.js` with a classic `<script>` tag. It finds the other files
next to itself, or where `cheerpjInit({ runtime: "/path/to/dist/" })` says.

- The server should answer range requests for the `jdk/<module>.jar` files,
  so a page reads only the classes it needs. A host that compresses ranged
  responses still works, at the cost of one full download per file.
- The JIT compiles hot Java methods with `new Function`, so a page with a
  Content Security Policy needs `'unsafe-eval'` in `script-src`. Without it,
  Java still runs, only interpreted.

A page loads `java-web.js` and uses the same calls as CheerpJ:

```html
<script src="java-web.js"></script>
<pre id="console"></pre>
<script type="module">
  await cheerpjInit();
  await cheerpjRunJar("/app/my-app.jar");      // /app/ is the web server root
</script>
```

`cheerpjRunMain(className, classPath, ...args)`, `cheerpjCreateDisplay`,
`cheerpOSAddStringFile` (also as `cheerpjAddStringFile`), `cheerpOSRemoveStringFile`
and `cjFileBlob(path)` also work.

- `java-web.js` also loads in a Web Worker with `importScripts`. It finds the
  runtime next to itself, or at the `runtime` option. `cheerpjCreateDisplay` needs a page.
- `env: ["KEY=value"]` sets what `System.getenv()` returns, as in CheerpJ 5. A page
  has no environment otherwise. Under Node, Java sees the host's environment.
- `preloadProgress(done, total)` reports the bytes of the runtime downloaded at start.
  `total` is 0 while the server has not sent a length; the last call has `done === total`.
- A file Java closes under `/files/downloads/` is downloaded by the browser.
  `/files/uploads/` exists for files the page adds there.
- The browser console gets whole lines, so two `print` calls and a `println` log one
  line. A partial line is logged after 100 ms.
- `javaWebWriteStdin(text)` feeds `System.in` (CheerpJ has no such call). A read
  waits until the page sends text, and text sent before Java reads it is kept.
  `javaWebWriteStdin(null)` ends the input. Nothing is echoed, so the page shows
  what the user typed itself.

Library mode calls Java from JS, as in CheerpJ's library mode guide. The VM
stays up between calls:

```js
const lib = await cheerpjRunLibrary("/app/tools.jar");   // "" for the JDK alone
const ArrayList = await lib.java.util.ArrayList;         // a class
const list = await new ArrayList();                      // an object
await list.add("x");                                     // a method
const System = await lib.java.lang.System;
await System.out.println(await list.size());             // a static field, then a method
const Tools = await lib.com.example.Tools;
try {
  await Tools.run("input");                              // static methods
} catch (e) {
  if (e instanceof (await lib.java.io.IOException)) console.log(await e.getMessage());
}
```

- A Java exception rejects the call with a proxy of the throwable. It works with
  `instanceof` and its methods, and also is an `Error` whose `message` is
  `java.io.IOException: text`.
- Read a field with `await`, write it by assignment. A field read can also be
  passed on without awaiting it: `a.y = a.x`. Writes and calls run in order.
  An assignment cannot be awaited, so a failed write is an unhandled
  rejection; call a setter to wait for the write.
- Overloads are chosen by how well each argument fits the parameter type, then
  varargs as a last resort. Pass an array or the elements for a varargs parameter.
- Java strings are JS strings. Boxed `Integer`, `Double`, `Boolean` and the
  other numbers are JS primitives, and a JS number passed as an `Object` becomes
  an `Integer` when it is whole and a `Double` otherwise. Any other object is a proxy.
- Arrays are copies. A primitive array is a typed array (`Int32Array` for `int[]`,
  `Int8Array` for `byte[]`, `Uint8Array` for `boolean[]`) and a reference array is
  a JS array. A typed array you pass to a call is updated with what Java wrote
  to it, so `Arrays.fill(buf, 7)` and `stream.read(buf)` work. Changing an array
  you got back does not change the Java array.
- The VM keeps each object it hands out until the page drops its proxy; a
  `FinalizationRegistry` tells the VM then.
- `cheerpjRunLibrary` can be called before `cheerpjInit`. Its promise settles once
  `cheerpjInit` has been called and finished, so do not `await` it first.

Java `native` methods can be written in JS the CheerpJ way: name the function
after the JNI name and pass it in `natives`. It gets `lib` first, then `this`
for instance methods, then the arguments, and uses the same proxies as library
mode. `lib` calls back into the Java VM that made the call. An `async` function
makes only the calling Java thread wait, and that thread runs the callbacks and
any other library call meanwhile.

```js
await cheerpjInit({
  natives: {
    async Java_com_example_Bridge_send(lib, self, json) {
      await self.log("sending");                          // call a method on `this`
      const Bridge = await lib.com.example.Bridge;
      return JSON.stringify(await Bridge.handle(JSON.parse(json)));
    },
  },
});
```

A Java class can also load its natives from a JS module:
`System.loadLibrary("name")` imports `name.js` from a directory on
`java.library.path`, and the module's default export is a table of natives like the
one above. Set the path with `javaProperties: ["java.library.path=/app/js/"]`. A name
that no directory has a `.js` file for throws `UnsatisfiedLinkError`, as on HotSpot,
unless it is one of the JDK's own libraries, which are built in.

Natives run on the page's main thread while Java runs in a Worker, so a typed
array argument is a copy; what the native writes to it goes back to Java when it
returns. Output goes to the element with id `console`, or to the display. `/files/`
is writable storage, kept in IndexedDB.
