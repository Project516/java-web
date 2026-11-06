// Off-heap memory for Unsafe.allocateMemory and direct buffers.
// One growable ArrayBuffer; address 0 is never handed out.

import { PendingThrow } from "./thread.ts";

const ALIGN = 16;
// Like a failed malloc in HotSpot, going past this throws OutOfMemoryError.
const LIMIT = 512 << 20;
const MIN_SHRINK = 2 << 20;

export class NativeMemory {
  buf: ArrayBuffer;
  u8: Uint8Array;
  dv: DataView;
  private top = ALIGN;
  private sizes = new Map<number, number>();
  // free blocks by size
  private free = new Map<number, number[]>();
  // end address to size, for the free blocks
  private freeEnds = new Map<number, number>();

  private initial: number;

  constructor(initial = 1 << 20) {
    this.initial = initial;
    this.buf = new ArrayBuffer(initial);
    this.u8 = new Uint8Array(this.buf);
    this.dv = new DataView(this.buf);
  }

  private resize(size: number) {
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.u8.subarray(0, Math.min(this.top, size)));
    this.buf = next;
    this.u8 = new Uint8Array(next);
    this.dv = new DataView(next);
  }

  private grow(need: number) {
    if (need > LIMIT) throw new PendingThrow("java/lang/OutOfMemoryError", `Unable to allocate ${need - this.buf.byteLength} bytes`);
    let size = this.buf.byteLength;
    while (size < need) size *= 2;
    size = Math.min(size, LIMIT);
    try { this.resize(size); }
    catch (e) {
      if (e instanceof RangeError) throw new PendingThrow("java/lang/OutOfMemoryError", `Unable to allocate ${size} bytes`);
      throw e;
    }
  }

  // The saved state of a snapshot: the bytes up to top and the block tables.
  restore(bytes: Uint8Array, top: number, sizes: Map<number, number>, free: Map<number, number[]>) {
    this.buf = new ArrayBuffer(Math.max(this.buf.byteLength, bytes.length));
    this.u8 = new Uint8Array(this.buf);
    this.dv = new DataView(this.buf);
    this.u8.set(bytes);
    this.top = top;
    this.sizes = sizes;
    this.free = free;
    this.freeEnds.clear();
    for (const [size, blocks] of free) for (const start of blocks) this.freeEnds.set(start + size, size);
  }

  malloc(n: number, alignment = ALIGN): number {
    const size = Math.max(ALIGN, Math.ceil(n / ALIGN) * ALIGN);
    const list = this.free.get(size);
    const reuse = list?.findIndex((addr) => addr % alignment === 0) ?? -1;
    if (list && reuse >= 0) {
      // the order of a free list does not matter, so the last block fills the gap
      const addr = list[reuse];
      list[reuse] = list[list.length - 1];
      list.pop();
      this.freeEnds.delete(addr + size);
      this.sizes.set(addr, size);
      return addr;
    }
    const addr = Math.ceil(this.top / alignment) * alignment;
    const top = addr + size;
    if (top > this.buf.byteLength) this.grow(top);
    this.top = top;
    this.sizes.set(addr, size);
    return addr;
  }

  freeBlock(addr: number) {
    const size = this.sizes.get(addr);
    if (size === undefined) return;
    this.sizes.delete(addr);
    if (addr + size < this.top) {
      let list = this.free.get(size);
      if (!list) this.free.set(size, (list = []));
      list.push(addr);
      this.freeEnds.set(addr + size, size);
      return;
    }
    // Lower top over this block and any free blocks that end where it starts.
    let top = addr;
    for (let below = this.freeEnds.get(top); below !== undefined; below = this.freeEnds.get(top)) {
      const list = this.free.get(below)!;
      const at = list.lastIndexOf(top - below);
      list[at] = list[list.length - 1];
      list.pop();
      if (!list.length) this.free.delete(below);
      this.freeEnds.delete(top);
      top -= below;
    }
    this.top = Math.max(top, ALIGN);
    if (this.buf.byteLength >= MIN_SHRINK && this.top <= this.buf.byteLength / 4) {
      const size = Math.max(this.initial, 2 ** Math.ceil(Math.log2(this.top)));
      if (size < this.buf.byteLength) this.resize(size);
    }
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
