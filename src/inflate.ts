// Streaming DEFLATE decoder (RFC 1950/1951) for java.util.zip.Inflater.
// Each call gets whatever input Java has not consumed yet, so the decoder
// keeps its state between calls and backs out of a symbol whose bits have
// not all arrived.

const UNDERFLOW = Symbol("underflow");

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class DataFormatError extends Error {}

function adler(d: Uint8Array): number {
  let s1 = 1, s2 = 0;
  for (const b of d) {
    s1 = (s1 + b) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

// Lookup table indexed by the next maxBits bits: entry = symbol << 4 | length.
interface Table {
  t: Int32Array;
  bits: number;
}

function buildTable(lengths: ArrayLike<number>, n: number): Table {
  let max = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > max) max = lengths[i];
  const bits = Math.max(max, 1);
  const t = new Int32Array(1 << bits);
  const count = new Array(16).fill(0);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const next = new Array(16).fill(0);
  let code = 0;
  for (let len = 1; len <= 15; len++) {
    code = (code + count[len - 1]) << 1;
    next[len] = code;
  }
  for (let sym = 0; sym < n; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    let c = next[len]++, rev = 0;
    for (let i = 0; i < len; i++) { rev = (rev << 1) | (c & 1); c >>= 1; }
    for (let k = rev; k < t.length; k += 1 << len) t[k] = (sym << 4) | len;
  }
  return { t, bits };
}

let fixedLit: Table | null = null, fixedDist: Table | null = null;

function fixedTables(): [Table, Table] {
  if (!fixedLit) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    fixedLit = buildTable(l, 288);
    fixedDist = buildTable(new Uint8Array(30).fill(5), 30);
  }
  return [fixedLit, fixedDist!];
}

const Stage = { Header: 0, Dict: 1, Block: 2, Stored: 3, Huffman: 4, Trailer: 5, Done: 6 } as const;

export class Inflate {
  private stage: number;
  private bitbuf = 0;
  private bitcnt = 0;
  private last = false;
  private stored = 0;
  private lit: Table | null = null;
  private dist: Table | null = null;
  private copyLen = 0;
  private copyDist = 0;
  private win = new Uint8Array(32768);
  private wpos = 0;
  private s1 = 1;
  private s2 = 0;
  private readonly wrap: boolean;
  dictId = 0;
  needDict = false;
  // current call
  private in!: Uint8Array;
  private ip = 0;
  private out!: Uint8Array;
  private op = 0;
  private oe = 0;

  constructor(nowrap: boolean) {
    this.wrap = !nowrap;
    this.stage = nowrap ? Stage.Block : Stage.Header;
  }

  get finished() { return this.stage === Stage.Done; }
  // while a dictionary is needed, the id it must match (as zlib reports it)
  get adler() { return this.stage === Stage.Dict ? this.dictId : ((this.s2 << 16) | this.s1) >>> 0; }

  reset() {
    this.stage = this.wrap ? Stage.Header : Stage.Block;
    this.bitbuf = this.bitcnt = this.stored = this.copyLen = this.copyDist = this.wpos = 0;
    this.last = this.needDict = false;
    this.pending = new Uint8Array(0);
    this.s1 = 1;
    this.s2 = 0;
  }

  // false when the stream asked for a different dictionary
  setDictionary(d: Uint8Array): boolean {
    if (this.stage === Stage.Dict && adler(d) !== this.dictId) return false;
    for (const b of d) this.win[this.wpos++ & 32767] = b;
    this.needDict = false;
    if (this.stage === Stage.Dict) this.stage = Stage.Block;
    return true;
  }

  // input bytes of a symbol that was cut off at the end of the last call
  private pending = new Uint8Array(0);

  // Decodes from input into output[off, off+len). Returns [read, written].
  // Like zlib, all input is consumed unless the output fills up first.
  run(input: Uint8Array, output: Uint8Array, off: number, len: number): [number, number] {
    const held = this.pending.length;
    let data = input;
    if (held) {
      data = new Uint8Array(held + input.length);
      data.set(this.pending);
      data.set(input, held);
    }
    const [used, written] = this.decodeAll(data, output, off, len);
    const starved = this.stage !== Stage.Done && !this.needDict && written < len;
    if (starved) {
      this.pending = data.slice(used);
      return [input.length, written];
    }
    if (used >= held) {
      this.pending = new Uint8Array(0);
      return [used - held, written];
    }
    this.pending = this.pending.slice(used);
    return [0, written];
  }

  private decodeAll(input: Uint8Array, output: Uint8Array, off: number, len: number): [number, number] {
    this.in = input;
    this.ip = 0;
    this.out = output;
    this.op = off;
    this.oe = off + len;
    let ip = 0, buf = 0, cnt = 0;
    try {
      for (;;) {
        ip = this.ip; buf = this.bitbuf; cnt = this.bitcnt;
        if (this.stage === Stage.Huffman) {
          if (!this.huffman()) break;
        } else if (!this.step()) break;
      }
    } catch (e) {
      if (e !== UNDERFLOW) throw e;
      this.ip = ip; this.bitbuf = buf; this.bitcnt = cnt;
    }
    if (this.stage === Stage.Done) {
      // whole bytes still buffered belong to whatever follows the stream
      this.ip -= this.bitcnt >> 3;
      this.bitbuf = this.bitcnt = 0;
    }
    return [this.ip, this.op - off];
  }

  private need(n: number) {
    while (this.bitcnt < n) {
      if (this.ip >= this.in.length) throw UNDERFLOW;
      this.bitbuf |= this.in[this.ip++] << this.bitcnt;
      this.bitcnt += 8;
    }
  }

  private bits(n: number): number {
    if (n === 0) return 0;
    this.need(n);
    const v = this.bitbuf & ((1 << n) - 1);
    this.bitbuf >>>= n;
    this.bitcnt -= n;
    return v;
  }

  private decode(tab: Table): number {
    while (this.bitcnt < tab.bits && this.ip < this.in.length) {
      this.bitbuf |= this.in[this.ip++] << this.bitcnt;
      this.bitcnt += 8;
    }
    const e = tab.t[this.bitbuf & ((1 << tab.bits) - 1)];
    const len = e & 15;
    if (len === 0) {
      if (this.bitcnt < tab.bits) throw UNDERFLOW;
      throw new DataFormatError("invalid code");
    }
    if (len > this.bitcnt) throw UNDERFLOW;
    this.bitbuf >>>= len;
    this.bitcnt -= len;
    return e >> 4;
  }

  private adlerByte(b: number) {
    this.s1 = (this.s1 + b) % 65521;
    this.s2 = (this.s2 + this.s1) % 65521;
  }

  private emit(b: number) {
    this.out[this.op++] = b;
    this.win[this.wpos++ & 32767] = b;
    if (this.wrap) this.adlerByte(b);
  }

  private align() {
    const drop = this.bitcnt & 7;
    this.bitbuf >>>= drop;
    this.bitcnt -= drop;
  }

  // One non-Huffman step. False when the call must return.
  private step(): boolean {
    switch (this.stage) {
      case Stage.Header: {
        const cmf = this.bits(8), flg = this.bits(8);
        if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw new DataFormatError("incorrect header check");
        if (flg & 0x20) {
          this.dictId = this.u32be();
          this.stage = Stage.Dict;
        } else this.stage = Stage.Block;
        return true;
      }
      case Stage.Dict:
        this.needDict = true;
        return false;
      case Stage.Block: {
        if (this.last) {
          this.stage = this.wrap ? Stage.Trailer : Stage.Done;
          return true;
        }
        const last = this.bits(1), type = this.bits(2);
        if (type === 0) {
          this.align();
          const n = this.bits(16), nn = this.bits(16);
          if ((n ^ 0xffff) !== nn) throw new DataFormatError("invalid stored block lengths");
          this.stored = n;
          this.stage = Stage.Stored;
        } else if (type === 1) {
          [this.lit, this.dist] = fixedTables();
          this.stage = Stage.Huffman;
        } else if (type === 2) {
          this.dynamicHeader();
          this.stage = Stage.Huffman;
        } else throw new DataFormatError("invalid block type");
        this.last = last === 1;
        return true;
      }
      case Stage.Stored: {
        while (this.stored > 0) {
          if (this.op >= this.oe) return false;
          if (this.bitcnt >= 8) this.emit(this.bits(8));
          else if (this.ip < this.in.length) this.emit(this.in[this.ip++]);
          else return false;
          this.stored--;
        }
        this.stage = Stage.Block;
        return true;
      }
      case Stage.Trailer: {
        this.align();
        if (this.u32be() !== this.adler) throw new DataFormatError("incorrect data check");
        this.stage = Stage.Done;
        return false;
      }
      default:
        return false;
    }
  }

  private u32be() {
    const a = this.bits(8), b = this.bits(8), c = this.bits(8), d = this.bits(8);
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }

  private dynamicHeader() {
    const hlit = this.bits(5) + 257, hdist = this.bits(5) + 1, hclen = this.bits(4) + 4;
    const cl = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = this.bits(3);
    const clTab = buildTable(cl, 19);
    const lens = new Uint8Array(hlit + hdist);
    for (let i = 0; i < lens.length;) {
      const sym = this.decode(clTab);
      if (sym < 16) lens[i++] = sym;
      else {
        let rep: number, val = 0;
        if (sym === 16) {
          if (i === 0) throw new DataFormatError("invalid bit length repeat");
          val = lens[i - 1];
          rep = 3 + this.bits(2);
        } else if (sym === 17) rep = 3 + this.bits(3);
        else rep = 11 + this.bits(7);
        if (i + rep > lens.length) throw new DataFormatError("invalid bit length repeat");
        lens.fill(val, i, i + rep);
        i += rep;
      }
    }
    if (lens[256] === 0) throw new DataFormatError("invalid code -- missing end-of-block");
    this.lit = buildTable(lens.subarray(0, hlit), hlit);
    this.dist = buildTable(lens.subarray(hlit), hdist);
  }

  private huffman(): boolean {
    const win = this.win;
    while (this.copyLen > 0) {
      if (this.op >= this.oe) return false;
      this.emit(win[(this.wpos - this.copyDist) & 32767]);
      this.copyLen--;
    }
    for (;;) {
      if (this.op >= this.oe) return false;
      const ip = this.ip, buf = this.bitbuf, cnt = this.bitcnt;
      try {
        const sym = this.decode(this.lit!);
        if (sym < 256) {
          this.emit(sym);
          continue;
        }
        if (sym === 256) {
          this.stage = Stage.Block;
          return true;
        }
        const li = sym - 257;
        if (li >= 29) throw new DataFormatError("invalid literal/length code");
        const len = LEN_BASE[li] + this.bits(LEN_EXTRA[li]);
        const ds = this.decode(this.dist!);
        if (ds >= 30) throw new DataFormatError("invalid distance code");
        const dist = DIST_BASE[ds] + this.bits(DIST_EXTRA[ds]);
        if (dist > this.wpos) throw new DataFormatError("invalid distance too far back");
        this.copyLen = len;
        this.copyDist = dist;
      } catch (e) {
        if (e !== UNDERFLOW) throw e;
        this.ip = ip; this.bitbuf = buf; this.bitcnt = cnt;
        return false;
      }
      while (this.copyLen > 0) {
        if (this.op >= this.oe) return false;
        this.emit(win[(this.wpos - this.copyDist) & 32767]);
        this.copyLen--;
      }
    }
  }
}
