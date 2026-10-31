// java-web.js in a Web Worker, started by index.html
importScripts("../java-web.js");

(async () => {
  await cheerpjInit();
  const lib = await cheerpjRunLibrary("");
  const Math = await lib.java.lang.Math;
  postMessage(await Math.max(3, 9));
})().catch((e) => postMessage("error: " + e.message));
