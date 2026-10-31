// Static file server for dist/: node scripts/serve.ts [port] [--like-github-pages [--compress-jars]]
//
// --like-github-pages compresses responses as GitHub Pages does: every type
// but .jar is gzipped for clients that accept it, and Range applies to the
// compressed bytes. --compress-jars compresses .jar files too, like hosts
// that compress everything.

import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";

const dist = join(import.meta.dirname, "..", "dist");
const args = process.argv.slice(2);
const likePages = args.includes("--like-github-pages");
const compressJars = args.includes("--compress-jars");
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 8080);
const gzipped = new Map<string, Buffer>();
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".map": "application/json",
  ".css": "text/css", ".jar": "application/java-archive", ".class": "application/java-vm",
  ".java": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) return void res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    const st = statSync(file);
    const headers: Record<string, string> = {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Accept-Ranges": "bytes",
    };
    if (likePages && (compressJars || extname(file) !== ".jar") && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
      let body = gzipped.get(file);
      if (!body) gzipped.set(file, (body = gzipSync(readFileSync(file))));
      headers["Content-Encoding"] = "gzip";
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${body.length}`;
      res.writeHead(range ? 206 : 200, { ...headers, "Content-Length": end - start + 1 });
      return void res.end(req.method === "HEAD" ? undefined : body.subarray(start, end + 1));
    }
    // single ranges, as static hosts serve them
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : st.size - 1, st.size - 1);
      if (start > end) return void res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end();
      res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}` });
      if (req.method === "HEAD") return void res.end();
      return void createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": st.size });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`serving dist/ on http://localhost:${port}/`));
