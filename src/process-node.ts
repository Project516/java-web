import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Readable, Writable } from "node:stream";
import { JArray } from "./runtime.ts";
import { PendingThrow } from "./thread.ts";
import type { NativeGen } from "./thread.ts";
import { addProcessPipe, fileOf, flushOrThrow } from "./natives/io.ts";
import type { ProcessPipe } from "./natives/io.ts";
import type { Natives } from "./natives/util.ts";
import { u8 } from "./natives/util.ts";

class Pipe implements ProcessPipe {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private ended = false;
  private inputs: Readable[] = [];
  private pendingInputs = 0;
  private wake: (() => void)[] = [];
  constructor(input: Readable | null, private output: Writable | null) {
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
  close() {
    for (const input of this.inputs) input.destroy();
    this.output?.end();
    this.ended = true;
    this.notify();
  }
}

type Child = { process: ChildProcess; start: bigint; exited: Promise<number>; code: number | null; command: string; args: string[] };
const decode = (a: JArray | null) => a ? new TextDecoder().decode(u8(a)).replace(/\0$/, "") : "";
const block = (a: JArray | null) => a && a.a.length ? decode(a).split("\0") : [];

export function processNatives(entry: string, jdk: string, packaged: boolean): Natives {
  const children = new Map<number, Child>();
  return {
    "java/lang/ProcessImpl.forkAndExec(I[B[B[BI[BI[B[IZ)I": function* (t, [, , , prog, argBlock, , envBlock, , dir, fds, redirectError]): NativeGen {
      let command = decode(prog);
      let args = block(argBlock);
      const testJdk = t.vm.props.get("test.jdk");
      if (command === "java" || command === "/jdk/bin/java" || command === `${jdk}/bin/java` || (testJdk && command === `${testJdk}/bin/java`)) {
        command = process.execPath;
        args = [entry, "--java-child", ...(packaged ? [] : ["--jdk", jdk]), ...args];
      }
      const env = envBlock === null ? t.vm.opts.env : Object.fromEntries(block(envBlock).map((s) => {
        const i = s.indexOf("=");
        return [s.slice(0, i), s.slice(i + 1)];
      }));
      const descriptors = (fds as JArray).a as Int32Array;
      const opened: number[] = [];
      const stdio: (number | "pipe")[] = [];
      try {
        for (let i = 0; i < 3; i++) {
          const fd = descriptors[i];
          if (fd < 0 || fd <= 2) stdio.push("pipe");
          else {
            const file = fileOf(t, fd);
            flushOrThrow(t, file);
            const hostFd = fs.openSync(file.path, i === 0 ? fs.constants.O_RDONLY : fs.constants.O_WRONLY | (file.pos > 0 ? fs.constants.O_APPEND : 0));
            opened.push(hostFd);
            stdio.push(hostFd);
          }
        }
        if (redirectError && typeof stdio[1] === "number") stdio[2] = stdio[1];
        const child = spawn(command, args, { cwd: dir ? decode(dir) : t.vm.opts.cwd, env, stdio: stdio as [any, any, any] });
        const exited = new Promise<number>((resolve) => child.once("exit", (code, signal) => {
          resolve(code ?? 128 + ((os.constants.signals as Record<string, number>)[signal ?? ""] ?? 0));
        }));
        const error: NodeJS.ErrnoException | null = yield t.block(new Promise((resolve) => {
          child.once("spawn", () => resolve(null));
          child.once("error", resolve);
        }));
        if (error) {
          const errno = Math.abs(error.errno ?? 5);
          const reason = error.code === "ENOENT" ? "No such file or directory" : error.code === "EACCES" ? "Permission denied" : error.message;
          throw new PendingThrow("java/io/IOException", `error=${errno}, ${reason}`);
        }
        const pid = child.pid!;
        const record: Child = { process: child, start: BigInt(Date.now()), code: null, command: decode(prog), args: block(argBlock), exited: null! };
        record.exited = exited.then((code) => (record.code = code));
        children.set(pid, record);
        let stdoutPipe: Pipe | undefined;
        for (let i = 0; i < 3; i++) {
          if (i === 2 && redirectError) {
            if (stdoutPipe) stdoutPipe.attach(child.stdio[2] as Readable);
            else if (stdio[2] === "pipe") (child.stdio[2] as Readable).on("data", (data: Buffer) => t.vm.opts.stdout(new Uint8Array(data)));
            descriptors[i] = -1;
          } else if (descriptors[i] < 0) {
            const pipe = new Pipe(i === 0 ? null : child.stdio[i] as Readable, i === 0 ? child.stdio[i] as Writable : null);
            if (i === 1) stdoutPipe = pipe;
            descriptors[i] = addProcessPipe(t, pipe);
          } else {
            if (descriptors[i] <= 2 && i !== 0) (child.stdio[i] as Readable)?.on("data", (data: Buffer) => (i === 1 ? t.vm.opts.stdout : t.vm.opts.stderr)(new Uint8Array(data)));
            if (descriptors[i] === 0) (child.stdio[i] as Writable)?.end();
            descriptors[i] = -1;
          }
        }
        return pid;
      } catch (e) {
        if (e instanceof PendingThrow) throw e;
        const error = e as NodeJS.ErrnoException;
        throw new PendingThrow("java/io/IOException", `error=${Math.abs(error.errno ?? 5)}, ${error.message}`);
      } finally {
        for (const fd of opened) fs.closeSync(fd);
      }
    },
    "java/lang/ProcessHandleImpl.getCurrentPid0()J": () => BigInt(process.pid),
    "java/lang/ProcessHandleImpl.isAlive0(J)J": (_t, [pid]) => {
      if (Number(pid) === process.pid) return 0n;
      const child = children.get(Number(pid));
      return child && child.code === null ? child.start : -1n;
    },
    "java/lang/ProcessHandleImpl.parent0(JJ)J": (_t, [pid]) => children.has(Number(pid)) ? BigInt(process.pid) : -1n,
    "java/lang/ProcessHandleImpl.waitForProcessExit0(JZ)I": function* (t, [pid, reap]): NativeGen {
      const child = children.get(Number(pid));
      if (!child) return -2;
      const code = yield t.block(child.exited);
      if (reap) children.delete(Number(pid));
      return code;
    },
    "java/lang/ProcessHandleImpl.destroy0(JJZ)Z": (_t, [pid, start, force]) => {
      const child = children.get(Number(pid));
      return child && child.code === null && (start === 0n || start === child.start) && child.process.kill(force ? "SIGKILL" : "SIGTERM") ? 1 : 0;
    },
    "java/lang/ProcessHandleImpl.getProcessPids0(J[J[J[J)I": (_t, [pid, pids, ppids, starts]) => {
      const live = [...children.entries()].filter(([, child]) => child.code === null && (pid === 0n || pid === BigInt(process.pid)));
      for (let i = 0; i < Math.min(live.length, pids.a.length); i++) {
        pids.a[i] = BigInt(live[i][0]);
        if (ppids) ppids.a[i] = BigInt(process.pid);
        if (starts) starts.a[i] = live[i][1].start;
      }
      return live.length;
    },
    "java/lang/ProcessHandleImpl$Info.initIDs()V": () => undefined,
    "java/lang/ProcessHandleImpl$Info.info0(J)V": (t, [self, pid]) => {
      const child = children.get(Number(pid));
      if (!child || child.code !== null) return;
      t.vm.setField(self, "java/lang/ProcessHandleImpl$Info", "startTime", child.start);
      t.vm.setField(self, "java/lang/ProcessHandleImpl$Info", "command", t.vm.str(child.command));
      t.vm.setField(self, "java/lang/ProcessHandleImpl$Info", "arguments", t.vm.newObjectArray("java/lang/String", child.args.map((arg) => t.vm.str(arg))));
    },
  };
}
