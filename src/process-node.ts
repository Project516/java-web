import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { JArray } from "./runtime.ts";
import { PendingThrow } from "./thread.ts";
import type { NativeGen } from "./thread.ts";
import { addProcessPipe, closeFd, fileOf, flushOrThrow, processPipe } from "./natives/io.ts";
import type { OpenFile, ProcessPipe } from "./natives/io.ts";
import type { Natives } from "./natives/util.ts";
import { u8 } from "./natives/util.ts";

const drained = (output: Writable) => output.writableNeedDrain
  ? new Promise<void>((resolve) => { output.once("drain", resolve); output.once("close", resolve); })
  : undefined;

// execvp as the JDK's launcher does it: the parent's PATH, ":/bin:/usr/bin" when it has none,
// and EACCES in place of ENOENT when a match was not executable.
function findProgram(command: string, cwd: string, parentPath: string | undefined): string | NodeJS.ErrnoException {
  if (command === "") return Object.assign(new Error("ENOENT"), { code: "ENOENT", errno: -2 });
  if (command.includes("/")) return command;
  let denied = false;
  for (const dir of (parentPath ?? ":/bin:/usr/bin").split(":")) {
    const candidate = dir ? `${dir}/${command}` : `./${command}`;
    const full = path.resolve(cwd, candidate);
    try {
      if (fs.statSync(full).isDirectory()) denied = true;
      else {
        fs.accessSync(full, fs.constants.X_OK);
        return candidate;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EACCES") denied = true;
    }
  }
  return Object.assign(new Error(denied ? "EACCES" : "ENOENT"), { code: denied ? "EACCES" : "ENOENT", errno: denied ? -13 : -2 });
}

class Pipe implements ProcessPipe {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private ended = false;
  private inputs: Readable[] = [];
  private pendingInputs = 0;
  private output: Writable | null;
  private forwarding = false;
  private wake: (() => void)[] = [];
  constructor(input: Readable | null, output: Writable | null) {
    this.output = output;
    if (input) this.attach(input);
    output?.on("error", () => {});
  }
  attach(input: Readable) {
    this.inputs.push(input);
    this.pendingInputs++;
    input.on("data", (chunk: Buffer) => {
      this.chunks.push(new Uint8Array(chunk));
      this.length += chunk.length;
      if (this.length >= 65536) for (const stream of this.inputs) stream.pause();
      this.notify();
    });
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      if (--this.pendingInputs === 0) this.ended = true;
      this.notify();
    };
    input.once("end", end);
    input.once("error", end);
  }
  private notify() { for (const wake of this.wake.splice(0)) wake(); }
  async read(dst: Uint8Array, off: number, len: number): Promise<number> {
    while (!this.length && !this.ended) await new Promise<void>((resolve) => this.wake.push(resolve));
    if (!this.length) return -1;
    const n = Math.min(len, this.length);
    let copied = 0;
    while (copied < n) {
      const chunk = this.chunks[0];
      const take = Math.min(n - copied, chunk.length);
      dst.set(chunk.subarray(0, take), off + copied);
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
      copied += take;
    }
    this.length -= n;
    if (this.length < 32768) for (const stream of this.inputs) stream.resume();
    return n;
  }
  write(bytes: Uint8Array): Promise<string | null> {
    if (!this.output || this.output.destroyed) return Promise.resolve("Stream closed");
    return new Promise((resolve) => this.output!.write(bytes.slice(), (error) => resolve(error ? error.message : null)));
  }
  available() {
    if (!this.length) for (const input of this.inputs) input.read();
    return this.length;
  }
  forward(output: Writable) {
    this.forwarding = true;
    output.on("error", () => {});
    void (async () => {
      const buffer = new Uint8Array(65536);
      try {
        while (!output.destroyed) {
          const n = await this.read(buffer, 0, buffer.length);
          if (n < 0) break;
          const error = await new Promise<Error | null | undefined>((resolve) => output.write(buffer.slice(0, n), resolve));
          if (error) break;
          await drained(output);
        }
        output.end();
      } finally {
        this.forwarding = false;
        this.close();
      }
    })();
  }
  close() {
    if (this.forwarding) return;
    for (const input of this.inputs) input.destroy();
    this.output?.end();
    this.ended = true;
    this.notify();
  }
}

// Both child descriptors must share one stream to preserve write order.
function mergedPipe(): Promise<{ reader: Socket; writer: Socket }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "java-web-process-"));
  const name = path.join(dir, "pipe");
  const server = createServer();
  let writer: Socket | undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      try { server.close(); } catch { /* not listening */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already removed */ }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      writer?.destroy();
      cleanup();
      reject(error);
    };
    server.once("error", fail);
    server.once("connection", (reader) => {
      if (settled) { reader.destroy(); return; }
      settled = true;
      cleanup();
      writer!.off("error", fail);
      writer!.on("error", () => {});
      reader.on("error", () => {});
      resolve({ reader, writer: writer! });
    });
    try {
      server.listen(name, () => {
        writer = createConnection(name);
        writer.once("error", fail);
      });
    } catch (error) { fail(error as Error); }
  });
}

type Child = { process: ChildProcess; start: bigint; exited: Promise<number>; code: number | null; command: string; args: string[]; java: boolean };
const decode = (a: JArray | null) => a ? new TextDecoder().decode(u8(a)).replace(/\0$/, "") : "";
const block = (a: JArray | null) => a && a.a.length ? decode(a).split("\0") : [];

export function processNatives(entry: string, jdk: string, packaged: boolean, hostInput: boolean): Natives {
  const children = new Map<number, Child>();
  let boot: bigint | null = null;
  try { boot = BigInt(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))![1]) * 1000n; } catch { /* no procfs */ }
  const processInfo = (pid: bigint | number) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || boot === null) return null;
      // Linux x64 and arm64 report process start times in 1/100-second ticks.
      return { parent: BigInt(fields[1]), start: boot + BigInt(fields[19]) * 10n,
        cpu: (BigInt(fields[11]) + BigInt(fields[12])) * 10000000n };
    } catch { return null; }
  };
  return {
    "java/lang/ProcessImpl.forkAndExec(I[B[B[BI[BI[B[IZ)I": function* (t, [, , , prog, argBlock, , envBlock, , dir, fds, redirectError]): NativeGen {
      let command = decode(prog);
      let args = block(argBlock);
      const testJdk = t.vm.props.get("test.jdk");
      const java = command === "java" || command === "/jdk/bin/java" || command === `${jdk}/bin/java` || !!(testJdk && command === `${testJdk}/bin/java`);
      if (java) {
        command = process.execPath;
        args = [entry, "--java-child", ...(packaged ? [] : ["--jdk", jdk]), ...args];
      }
      const env = envBlock === null ? t.vm.opts.env : Object.fromEntries(block(envBlock).map((s) => {
        const i = s.indexOf("=", 1);
        return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
      }));
      const descriptors = (fds as JArray).a as Int32Array;
      const opened: number[] = [];
      const stdio: (number | "pipe" | Socket)[] = [];
      let merged: { reader: Socket; writer: Socket } | undefined;
      let pipelineInput: Pipe | undefined;
      let imageInput: OpenFile | undefined;
      try {
        for (let i = 0; i < 3; i++) {
          const fd = descriptors[i];
          if (i === 0 && fd === 0 && hostInput) stdio.push(0);
          else if (fd < 0 || fd <= 2) stdio.push("pipe");
          else if (i === 0 && processPipe(t, fd) instanceof Pipe) {
            pipelineInput = processPipe(t, fd) as Pipe;
            stdio.push("pipe");
          } else {
            const file = fileOf(t, fd);
            flushOrThrow(t, file);
            if (i === 0 && file.path.startsWith(`${t.vm.opts.javaHome}/`)) {
              imageInput = file;
              stdio.push("pipe");
            } else {
              const hostFd = fs.openSync(file.path, i === 0 ? fs.constants.O_RDONLY : fs.constants.O_WRONLY | (file.append ? fs.constants.O_APPEND : 0));
              opened.push(hostFd);
              stdio.push(hostFd);
            }
          }
        }
        if (redirectError && stdio[1] === "pipe") {
          const result: { reader: Socket; writer: Socket } | Error = yield t.block(mergedPipe().catch((error: Error) => error));
          if (result instanceof Error) throw result;
          merged = result;
          stdio[1] = stdio[2] = merged.writer;
        } else if (redirectError) stdio[2] = stdio[1];
        const cwd = dir ? decode(dir) : t.vm.opts.cwd;
        const program = java ? command : findProgram(command, cwd ?? process.cwd(), (t.vm.opts.env ?? process.env).PATH);
        if (typeof program !== "string") {
          throw new PendingThrow("java/io/IOException", program.code === "EACCES" ? "error=13, Permission denied" : "error=2, No such file or directory");
        }
        const child = spawn(program, args, { cwd, env, stdio: stdio as [any, any, any] });
        merged?.writer.destroy();
        const status = (code: number | null, signal: NodeJS.Signals | null) =>
          code ?? 128 + ((os.constants.signals as Record<string, number>)[signal ?? ""] ?? 0);
        const exited = new Promise<number>((resolve) => child.once("exit", (code, signal) => resolve(status(code, signal))));
        const created: number[] = [];
        for (let i = 0; i < 3; i++) {
          if (i === 2 && redirectError) {
            descriptors[i] = -1;
          } else if (descriptors[i] < 0) {
            const pipe = new Pipe(i === 0 ? null : i === 1 && merged ? merged.reader : child.stdio[i] as Readable, i === 0 ? child.stdio[i] as Writable : null);
            descriptors[i] = addProcessPipe(t, pipe);
            created.push(descriptors[i]);
          } else {
            if (descriptors[i] <= 2 && i !== 0) {
              const output = descriptors[i] === 1 ? t.vm.opts.stdout : t.vm.opts.stderr;
              const stream = i === 1 && merged ? merged.reader : child.stdio[i] as Readable;
              stream?.on("error", () => {});
              stream?.on("data", (data: Buffer) => { try { output(new Uint8Array(data)); } catch { /* output closed */ } });
            }
            if (i === 0 && descriptors[i] === 0 && stdio[i] === "pipe") {
              const input = child.stdio[i] as Writable;
              input.on("error", () => {});
              void (async () => {
                while (!input.destroyed) {
                  const chunk = await t.vm.opts.stdin?.();
                  if (!chunk) break;
                  if (!input.write(chunk)) await new Promise<void>((resolve) => input.once("drain", resolve));
                }
                input.end();
              })();
            }
            descriptors[i] = -1;
          }
        }
        const error: NodeJS.ErrnoException | null = yield t.block(new Promise((resolve) => {
          child.once("spawn", () => resolve(null));
          child.once("error", resolve);
        }));
        if (error) {
          for (const fd of created) closeFd(t, fd);
          const errno = Math.abs(error.errno ?? 5);
          const reason = error.code === "ENOENT" ? "No such file or directory" : error.code === "EACCES" ? "Permission denied" : error.message;
          throw new PendingThrow("java/io/IOException", `error=${errno}, ${reason}`);
        }
        const pid = child.pid!;
        const record: Child = { process: child, start: processInfo(pid)?.start ?? BigInt(Date.now()), code: null, command: decode(prog), args: block(argBlock), java, exited: null! };
        record.exited = exited.then((code) => {
          record.code = code;
          // lets inherited output that came in with the exit reach the VM first;
          // waiting for the streams to close would hang while a grandchild holds them
          return new Promise<number>((resolve) => setImmediate(() => resolve(code)));
        });
        children.set(pid, record);
        if (pipelineInput) pipelineInput.forward(child.stdin!);
        if (imageInput) {
          const input = imageInput, output = child.stdin!;
          output.on("error", () => {});
          void (async () => {
            const buffer = new Uint8Array(65536);
            try {
              while (!output.destroyed) {
                const n = input.read(buffer, 0, buffer.length);
                if (n < 0) break;
                const error = await new Promise<Error | null | undefined>((resolve) => output.write(buffer.slice(0, n), resolve));
                if (error) break;
                await drained(output);
              }
            } finally { output.end(); }
          })().catch(() => {});
        }
        return pid;
      } catch (e) {
        merged?.writer.destroy();
        merged?.reader.destroy();
        if (e instanceof PendingThrow) throw e;
        const error = e as NodeJS.ErrnoException;
        throw new PendingThrow("java/io/IOException", `error=${Math.abs(error.errno ?? 5)}, ${error.message}`);
      } finally {
        for (const fd of opened) fs.closeSync(fd);
      }
    },
    "java/lang/ProcessHandleImpl.getCurrentPid0()J": () => BigInt(process.pid),
    "java/lang/ProcessHandleImpl.isAlive0(J)J": (_t, [pid]) => {
      const child = children.get(Number(pid));
      if (child) return child.code === null ? child.start : -1n;
      if (Number(pid) === process.pid && boot === null) return 0n;
      return pid > 0n ? processInfo(pid)?.start ?? -1n : -1n;
    },
    "java/lang/ProcessHandleImpl.parent0(JJ)J": (_t, [pid, start]) => {
      const child = children.get(Number(pid));
      if (child) return child.code === null && (start === 0n || start === child.start) ? BigInt(process.pid) : -1n;
      const info = pid > 0n ? processInfo(pid) : null;
      return info && (start === 0n || start === info.start) ? info.parent : -1n;
    },
    "java/lang/ProcessHandleImpl.waitForProcessExit0(JZ)I": function* (t, [pid, reap]): NativeGen {
      const child = children.get(Number(pid));
      if (!child) return -2;
      const code = yield t.block(child.exited);
      if (reap) children.delete(Number(pid));
      return code;
    },
    "java/lang/ProcessHandleImpl.destroy0(JJZ)Z": (_t, [pid, start, force]) => {
      if (pid <= 0n || pid === BigInt(process.pid)) return 0;
      const child = children.get(Number(pid));
      if (child) return child.code === null && (start === 0n || start === child.start) && child.process.kill(force ? "SIGKILL" : "SIGTERM") ? 1 : 0;
      const info = processInfo(pid);
      if (!info || (start !== 0n && start !== info.start)) return 0;
      try { process.kill(Number(pid), force ? "SIGKILL" : "SIGTERM"); return 1; } catch { return 0; }
    },
    "java/lang/ProcessHandleImpl.getProcessPids0(J[J[J[J)I": (_t, [pid, pids, ppids, starts]) => {
      if (boot === null) {
        const live = [...children.entries()].filter(([, child]) => child.code === null && (pid === 0n || pid === BigInt(process.pid)));
        for (let i = 0; i < Math.min(live.length, pids.a.length); i++) {
          pids.a[i] = BigInt(live[i][0]);
          if (ppids) ppids.a[i] = BigInt(process.pid);
          if (starts) starts.a[i] = live[i][1].start;
        }
        return live.length;
      }
      let count = 0;
      let names: string[];
      try { names = fs.readdirSync("/proc"); } catch { names = []; }
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const info = processInfo(Number(name));
        if (!info || (pid !== 0n && info.parent !== pid)) continue;
        if (count < pids.a.length) {
          pids.a[count] = BigInt(name);
          if (ppids) ppids.a[count] = info.parent;
          if (starts) starts.a[count] = info.start;
        }
        count++;
      }
      return count;
    },
    "java/lang/ProcessHandleImpl$Info.initIDs()V": () => undefined,
    "java/lang/ProcessHandleImpl$Info.info0(J)V": (t, [self, pid]) => {
      const child = children.get(Number(pid));
      const info = processInfo(pid);
      if (!info || (child && child.code !== null)) return;
      try {
        const command = child?.java ? (child.command === "java" ? "/jdk/bin/java" : child.command) : fs.readlinkSync(`/proc/${pid}/exe`);
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0$/, "").split("\0").slice(1);
        t.vm.setField(self, "java/lang/ProcessHandleImpl$Info", "startTime", info.start);
        t.vm.setField(self, "java/lang/ProcessHandleImpl$Info", "totalTime", info.cpu);
        t.vm.setField(self, "java/lang/ProcessHandleImpl$Info", "command", t.vm.str(command));
        t.vm.setField(self, "java/lang/ProcessHandleImpl$Info", "arguments", t.vm.newObjectArray("java/lang/String", (child?.args ?? argv).map((arg) => t.vm.str(arg))));
        if (fs.statSync(`/proc/${pid}`).uid === process.getuid?.())
          t.vm.setField(self, "java/lang/ProcessHandleImpl$Info", "user", t.vm.str(os.userInfo().username));
      } catch { /* process exited or is inaccessible */ }
    },
  };
}
