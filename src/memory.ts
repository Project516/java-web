// Off-heap memory for Unsafe.allocateMemory and direct buffers.
// One growable ArrayBuffer; address 0 is never handed out.

import { PendingThrow } from "./thread.ts";

const ALIGN = 16;
// Like a failed malloc in HotSpot, going past this throws OutOfMemoryError.
const LIMIT = 512 << 20;

export class NativeMemory {
  buf: ArrayBuffer;
  u8: Uint8Array;
  dv: DataView;
  private top = ALIGN;
  private sizes = new Map<number, number>();
  // free blocks by size
  private free = new Map<number, number[]>();

  constructor(initial = 1 << 20) {
    this.buf = new ArrayBuffer(initial);
    this.u8 = new Uint8Array(this.buf);
    this.dv = new DataView(this.buf);
  }

  private grow(need: number) {
    if (need > LIMIT) throw new PendingThrow("java/lang/OutOfMemoryError", `Unable to allocate ${need - this.buf.byteLength} bytes`);
    let size = this.buf.byteLength;
    while (size < need) size *= 2;
    size = Math.min(size, LIMIT);
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.u8);
    this.buf = next;
    this.u8 = new Uint8Array(next);
    this.dv = new DataView(next);
  }

  malloc(n: number): number {
    const size = Math.max(ALIGN, Math.ceil(n / ALIGN) * ALIGN);
    const list = this.free.get(size);
    if (list && list.length > 0) {
      const addr = list.pop()!;
      this.sizes.set(addr, size);
      return addr;
    }
    const addr = this.top;
    this.top += size;
    if (this.top > this.buf.byteLength) this.grow(this.top);
    this.sizes.set(addr, size);
    return addr;
  }

  freeBlock(addr: number) {
    const size = this.sizes.get(addr);
    if (size === undefined) return;
    this.sizes.delete(addr);
    let list = this.free.get(size);
    if (!list) this.free.set(size, (list = []));
    list.push(addr);
  }

  realloc(addr: number, n: number): number {
    if (addr === 0) return this.malloc(n);
    const old = this.sizes.get(addr) ?? 0;
    if (n <= old) return addr;
    const next = this.malloc(n);
    this.u8.copyWithin(next, addr, addr + old);
    this.freeBlock(addr);
    return next;
  }
}
