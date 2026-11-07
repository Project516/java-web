// Streaming DEFLATE encoder (RFC 1950/1951) for java.util.zip.Deflater.
// Hash chains over a 32 KB window find matches; levels 1-3 take the first
// match, 4-9 look one byte ahead. Blocks use dynamic or fixed Huffman codes,
// or are stored when that is smaller. Compressed bytes sit in a pending buffer
// that the caller drains, so memory stays bounded.

function adler32(adler: number, b: Uint8Array): number {
  let s1 = adler & 0xffff, s2 = adler >>> 16;
  for (let i = 0; i < b.length;) {
    const end = Math.min(b.length, i + 3800);
    for (; i < end; i++) { s1 += b[i]; s2 += s1; }
    s1 %= 65521;
    s2 %= 65521;
  }
  return ((s2 << 16) | s1) | 0;
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const WSIZE = 32768;
const WMASK = WSIZE - 1;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
const MAX_DIST = WSIZE - MIN_LOOKAHEAD;
const TOO_FAR = 4096;
const SYMS = 16383;
const STORED_MAX = 65535;
// largest block (fixed codes, 31 bits a symbol) or stored block, plus a flush marker and trailer
const PENDING = 65600;

const NO_FLUSH = 0, FINISH = 4, BLOCK = 5;
const SYNC_FLUSH = 2, FULL_FLUSH = 3;
const FILTERED = 1, HUFFMAN_ONLY = 2;

const NEED = 0, BLOCKED = 1, DONE = 2;

// good, lazy (longest match to insert, in levels 1-3), nice, chain
const CONFIG = [
  [0, 0, 0, 0], [4, 4, 8, 4], [4, 5, 16, 8], [4, 6, 32, 32], [4, 4, 16, 16],
  [8, 16, 32, 32], [8, 16, 128, 128], [8, 32, 128, 256], [32, 128, 258, 1024], [32, 258, 258, 4096],
];

const LCODE = new Uint8Array(256);
const DCODE = new Uint8Array(512);
const LBASE0 = LEN_BASE.map((b) => b - 3);
for (let c = 0; c < 28; c++) for (let k = 0; k < 1 << LEN_EXTRA[c]; k++) LCODE[LBASE0[c] + k] = c;
LCODE[255] = 28;
for (let c = 0; c < 30; c++) {
  for (let k = 0; k < 1 << DIST_EXTRA[c]; k++) {
    const d = DIST_BASE[c] + k - 1;
    DCODE[d < 256 ? d : 256 + (d >> 7)] = c;
  }
}

const CNT = new Uint16Array(16);
const NEXT = new Uint16Array(16);

// canonical codes, bit-reversed for the LSB-first bit order
function makeCodes(lens: Uint8Array, n: number, codes: Uint16Array) {
  CNT.fill(0);
  for (let i = 0; i < n; i++) CNT[lens[i]]++;
  CNT[0] = 0;
  let code = 0;
  for (let len = 1; len <= 15; len++) {
    code = (code + CNT[len - 1]) << 1;
    NEXT[len] = code;
  }
  for (let i = 0; i < n; i++) {
    const l = lens[i];
    if (!l) continue;
    let c = NEXT[l]++, r = 0;
    for (let k = 0; k < l; k++) { r = (r << 1) | (c & 1); c >>= 1; }
    codes[i] = r;
  }
}

const FIXED_LIT_LEN = new Uint8Array(288);
FIXED_LIT_LEN.fill(8, 0, 144);
FIXED_LIT_LEN.fill(9, 144, 256);
FIXED_LIT_LEN.fill(7, 256, 280);
FIXED_LIT_LEN.fill(8, 280, 288);
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);
const FIXED_LIT_CODE = new Uint16Array(288);
const FIXED_DIST_CODE = new Uint16Array(30);
makeCodes(FIXED_LIT_LEN, 288, FIXED_LIT_CODE);
makeCodes(FIXED_DIST_LEN, 30, FIXED_DIST_CODE);

// scratch for the code builders
const KEYS = new Uint32Array(288);
const IW = new Uint32Array(288);
const LPAR = new Uint16Array(288);
const IPAR = new Uint16Array(288);
const DEP = new Uint16Array(288);
const BLC = new Uint16Array(320);
const LIT_LEN = new Uint8Array(288);
const LIT_CODE = new Uint16Array(288);
const DIST_LEN = new Uint8Array(32);
const DIST_CODE = new Uint16Array(32);
const CL_LEN = new Uint8Array(19);
const CL_CODE = new Uint16Array(19);
const CL_FREQ = new Uint32Array(19);
const SEQ = new Uint8Array(320);
const RLE_SYM = new Uint8Array(320);
const RLE_X = new Uint8Array(320);

// Code lengths of at most maxBits for the symbols with a frequency. Every
// tree gets at least two codes, as zlib does, so decoders see a complete code.
function buildLengths(freq: Uint32Array, n: number, maxBits: number, lens: Uint8Array) {
  lens.fill(0, 0, n);
  let m = 0;
  for (let s = 0; s < n; s++) if (freq[s]) KEYS[m++] = (freq[s] << 9) | s;
  for (let s = 0; m < 2 && s < n; s++) if (!freq[s]) KEYS[m++] = (1 << 9) | s;
  KEYS.subarray(0, m).sort();
  // two-queue Huffman: leaves ascending, merged nodes created in ascending order
  let leaf = 0, q = 0;
  for (let made = 0; made < m - 1; made++) {
    let sum = 0;
    for (let k = 0; k < 2; k++) {
      if (leaf < m && (q >= made || KEYS[leaf] >>> 9 <= IW[q])) {
        sum += KEYS[leaf] >>> 9;
        LPAR[leaf++] = made;
      } else {
        sum += IW[q];
        IPAR[q++] = made;
      }
    }
    IW[made] = sum;
  }
  DEP[m - 2] = 0;
  for (let i = m - 3; i >= 0; i--) DEP[i] = DEP[IPAR[i]] + 1;
  BLC.fill(0);
  let maxDepth = 0;
  for (let i = 0; i < m; i++) {
    const d = DEP[LPAR[i]] + 1;
    BLC[d]++;
    if (d > maxDepth) maxDepth = d;
  }
  if (maxDepth > maxBits) {
    for (let d = maxBits + 1; d <= maxDepth; d++) {
      BLC[maxBits] += BLC[d];
      BLC[d] = 0;
    }
    let kraft = 0;
    for (let d = 1; d <= maxBits; d++) kraft += BLC[d] << (maxBits - d);
    // each step trades one longest code for a split of a shorter one
    for (; kraft > 1 << maxBits; kraft--) {
      BLC[maxBits]--;
      for (let i = maxBits - 1; i > 0; i--) {
        if (BLC[i]) {
          BLC[i]--;
          BLC[i + 1] += 2;
          break;
        }
      }
    }
  }
  let i = 0;
  for (let d = maxBits; d >= 1; d--) for (let c = BLC[d]; c > 0; c--) lens[KEYS[i++] & 511] = d;
}

function dataBits(ll: Uint8Array, dl: Uint8Array, lit: Uint32Array, dist: Uint32Array): number {
  let bits = 0;
  for (let s = 0; s < 286; s++) bits += lit[s] * ll[s];
  for (let c = 0; c < 29; c++) bits += lit[257 + c] * LEN_EXTRA[c];
  for (let d = 0; d < 30; d++) bits += dist[d] * (dl[d] + DIST_EXTRA[d]);
  return bits;
}

const EMPTY8 = new Uint8Array(0);
const EMPTY16 = new Uint16Array(0);

export class Deflate {
  private readonly wrap: boolean;
  private level: number;
  private strategy: number;
  private headerDone = false;
  private ended = false;
  private lastFlush = -2;
  private adler = 1;
  private dictId: number | null = null;
  // output waiting for room, and bits not yet a whole byte
  private pending = EMPTY8;
  private pendPos = 0;
  private pendLen = 0;
  private bitBuf = 0;
  private bitCnt = 0;
  // window: data at [0, strstart + lookahead); at level 0 it holds the stored block being filled
  private win = EMPTY8;
  private head = EMPTY16;
  private prev = EMPTY16;
  private strstart = 0;
  private lookahead = 0;
  private blockStart = 0;
  private hashed = 0;
  private matchStart = 0;
  private matchLen = MIN_MATCH - 1;
  private prevLen = MIN_MATCH - 1;
  private prevMatch = 0;
  private matchAvail = false;
  private heldLen = 0;
  // symbols of the block being built: distance (0 for a literal) and literal or length - 3
  private symD = EMPTY16;
  private symL = EMPTY8;
  private nsym = 0;
  private litFreq = new Uint32Array(0);
  private distFreq = new Uint32Array(0);
  // input of the current call
  private inp: Uint8Array = EMPTY8;
  private inPos = 0;

  constructor(level: number, strategy: number, nowrap: boolean) {
    this.wrap = !nowrap;
    this.level = level < 0 ? 6 : level;
    this.strategy = strategy;
  }

  get finished() { return this.ended && this.pendPos === this.pendLen; }
  get checksum() { return this.headerDone || this.dictId === null ? this.adler : this.dictId; }

  reset() {
    this.headerDone = this.ended = false;
    this.pendPos = this.pendLen = this.bitBuf = this.bitCnt = this.heldLen = 0;
    this.lastFlush = -2;
    this.adler = 1;
    this.dictId = null;
    if (this.win.length) this.resetHistory();
  }

  private alloc() {
    if (this.win.length) return;
    this.win = new Uint8Array(2 * WSIZE + MAX_MATCH + 8);
    this.head = new Uint16Array(1 << 15);
    this.prev = new Uint16Array(WSIZE);
    this.symD = new Uint16Array(SYMS + 1);
    this.symL = new Uint8Array(SYMS + 1);
    this.litFreq = new Uint32Array(286);
    this.distFreq = new Uint32Array(30);
    this.pending = new Uint8Array(PENDING);
  }

  private resetHistory() {
    this.strstart = this.lookahead = this.blockStart = this.hashed = this.nsym = 0;
    this.matchLen = this.prevLen = MIN_MATCH - 1;
    this.matchAvail = false;
    this.head.fill(0);
    this.litFreq.fill(0);
    this.distFreq.fill(0);
  }

  // false when a zlib stream can no longer take a dictionary
  setDictionary(d: Uint8Array): boolean {
    if (this.wrap && this.headerDone && !this.ended) return false;
    if (this.lookahead) return false;
    if (this.wrap && !this.headerDone) this.dictId = adler32(1, d) >>> 0;
    if (this.level === 0 || this.ended) return true;
    this.alloc();
    // symbols already taken keep their block; its bytes are overwritten, so it cannot be stored
    const pending = this.nsym > 0;
    this.head.fill(0);
    this.matchLen = this.prevLen = MIN_MATCH - 1;
    this.matchAvail = false;
    const t = d.length > WSIZE ? d.subarray(d.length - WSIZE) : d;
    this.win.set(t, 0);
    this.strstart = t.length;
    this.blockStart = pending ? -1 : t.length;
    let p = 0;
    for (; p + 2 < t.length; p++) this.insertAt(p);
    this.hashed = p;
    return true;
  }

  private put(...bytes: number[]) {
    for (const b of bytes) this.pending[this.pendLen++] = b;
  }

  private be32(v: number) {
    this.put(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }

  private putBits(v: number, n: number) {
    this.bitBuf |= v << this.bitCnt;
    this.bitCnt += n;
    while (this.bitCnt >= 8) {
      this.pending[this.pendLen++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }

  private align() {
    if (this.bitCnt > 0) {
      this.pending[this.pendLen++] = this.bitBuf & 0xff;
      this.bitBuf = this.bitCnt = 0;
    }
  }

  private drain(output: Uint8Array, at: number): number {
    const n = Math.min(output.length - at, this.pendLen - this.pendPos);
    output.set(this.pending.subarray(this.pendPos, this.pendPos + n), at);
    this.pendPos += n;
    if (this.pendPos === this.pendLen) this.pendPos = this.pendLen = 0;
    return n;
  }

  private header() {
    this.headerDone = true;
    if (!this.wrap) return;
    const flags = this.strategy >= HUFFMAN_ONLY || this.level < 2 ? 0 : this.level < 6 ? 1 : this.level === 6 ? 2 : 3;
    let h = 0x7800 | (flags << 6);
    if (this.dictId !== null) h |= 0x20;
    h += 31 - (h % 31);
    this.put(h >> 8, h & 0xff);
    if (this.dictId !== null) this.be32(this.dictId);
  }

  // Compresses what fits. flush: 0 none, 2 sync, 3 full, 4 finish.
  // Returns [read, written, retry]; retry means a parameter change is not done.
  run(input: Uint8Array, output: Uint8Array, flush: number, params: number): [number, number, boolean] {
    if (params & 1) return this.setParams(input, output, params >> 3, (params >> 1) & 3);
    const [read, written] = this.deflate(input, output, flush);
    return [read, written, false];
  }

  private setParams(input: Uint8Array, output: Uint8Array, level: number, strategy: number): [number, number, boolean] {
    if (level < 0) level = 6;
    const family = (l: number) => (l === 0 ? 0 : l < 4 ? 1 : 2);
    let read = 0, written = 0;
    // a different matcher ends the current block first, as zlib's deflateParams does
    if (this.lastFlush !== -2 && (strategy !== this.strategy || family(level) !== family(this.level))) {
      [read, written] = this.deflate(input, output, BLOCK);
      if (read < input.length || this.pendLen || !this.idle()) return [read, written, true];
    }
    const stored = (this.level === 0) !== (level === 0);
    this.level = level;
    this.strategy = strategy;
    if (stored && this.win.length) this.resetHistory();
    return [read, written, false];
  }

  private idle() {
    return this.lookahead === 0 && this.nsym === 0 && !this.matchAvail && this.strstart === this.blockStart && this.heldLen === 0;
  }

  private deflate(input: Uint8Array, output: Uint8Array, flush: number): [number, number] {
    if (output.length === 0) return [0, 0];
    let written = this.drain(output, 0);
    if (this.pendLen) {
      this.lastFlush = -1;
      return [0, written];
    }
    // a repeated flush with no new input adds nothing, so flush loops end
    if (input.length === 0 && flush !== BLOCK && flush !== FINISH && flush <= this.lastFlush) return [0, written];
    if (flush !== BLOCK) this.lastFlush = flush;
    this.alloc();
    this.inp = input;
    this.inPos = 0;
    let marked = false;
    for (;;) {
      written += this.drain(output, written);
      if (this.pendLen || this.ended) break;
      if (!this.headerDone) {
        this.header();
        continue;
      }
      const st = this.level === 0 ? this.storedStep(flush) : this.strategy === HUFFMAN_ONLY ? this.huff(flush)
        : this.level < 4 ? this.fast(flush) : this.lazy(flush);
      if (st === BLOCKED) continue;
      if (st === NEED || marked) break;
      marked = true;
      if (flush === FINISH) {
        if (this.wrap) this.be32(this.adler >>> 0);
        this.ended = true;
      } else if (flush === SYNC_FLUSH || flush === FULL_FLUSH) {
        this.putBits(0, 3);
        this.align();
        this.put(0, 0, 0xff, 0xff);
        if (flush === FULL_FLUSH && this.level !== 0) this.forget();
      } else break;
    }
    const read = this.inPos;
    this.inp = EMPTY8;
    return [read, written];
  }

  // a full flush drops the match history
  private forget() {
    this.head.fill(0);
    this.matchLen = this.prevLen = MIN_MATCH - 1;
    this.matchAvail = false;
    if (this.lookahead === 0) this.strstart = this.blockStart = this.hashed = 0;
    else this.hashed = this.strstart;
  }

  private storedStep(flush: number): number {
    while (this.inPos < this.inp.length) {
      const n = Math.min(STORED_MAX - this.heldLen, this.inp.length - this.inPos);
      const chunk = this.inp.subarray(this.inPos, this.inPos + n);
      this.win.set(chunk, this.heldLen);
      if (this.wrap) this.adler = adler32(this.adler, chunk);
      this.heldLen += n;
      this.inPos += n;
      if (this.heldLen === STORED_MAX) {
        this.writeStored(0, this.heldLen, false);
        this.heldLen = 0;
        return BLOCKED;
      }
    }
    if (flush === NO_FLUSH) return NEED;
    if (flush === FINISH || this.heldLen) {
      this.writeStored(0, this.heldLen, flush === FINISH);
      this.heldLen = 0;
    }
    return DONE;
  }

  private fill() {
    const win = this.win;
    while (this.lookahead < MIN_LOOKAHEAD && this.inPos < this.inp.length) {
      if (this.strstart >= WSIZE + MAX_DIST) this.slide();
      const at = this.strstart + this.lookahead;
      const n = Math.min(2 * WSIZE - at, this.inp.length - this.inPos);
      const chunk = this.inp.subarray(this.inPos, this.inPos + n);
      win.set(chunk, at);
      if (this.wrap) this.adler = adler32(this.adler, chunk);
      this.lookahead += n;
      this.inPos += n;
    }
  }

  private slide() {
    this.win.copyWithin(0, WSIZE, this.strstart + this.lookahead);
    this.matchStart -= WSIZE;
    this.strstart -= WSIZE;
    this.blockStart -= WSIZE;
    this.hashed = Math.max(0, this.hashed - WSIZE);
    const head = this.head, prev = this.prev;
    for (let i = 0; i < head.length; i++) head[i] = head[i] >= WSIZE ? head[i] - WSIZE : 0;
    for (let i = 0; i < prev.length; i++) prev[i] = prev[i] >= WSIZE ? prev[i] - WSIZE : 0;
  }

  // returns the previous head of the chain for the 3 bytes at p
  private insertAt(p: number): number {
    const w = this.win;
    const h = Math.imul(w[p] | (w[p + 1] << 8) | (w[p + 2] << 16), 0x9e3779b1) >>> 17;
    const old = this.head[h];
    this.prev[p & WMASK] = old;
    this.head[h] = p;
    return old;
  }

  private insertUpTo(end: number) {
    const dataEnd = this.strstart + this.lookahead;
    while (this.hashed < end && this.hashed + 2 < dataEnd) this.insertAt(this.hashed++);
  }

  // Longest match for the bytes at strstart among the chain from cand, longer than best.
  private longest(cand: number, best: number, chain: number, nice: number): number {
    const win = this.win, prev = this.prev, cur = this.strstart;
    const limit = cur > MAX_DIST ? cur - MAX_DIST : 0;
    const maxLen = this.lookahead < MAX_MATCH ? this.lookahead : MAX_MATCH;
    if (nice > maxLen) nice = maxLen;
    const c0 = win[cur], c1 = win[cur + 1];
    do {
      if (win[cand + best] === win[cur + best] && win[cand] === c0 && win[cand + 1] === c1
        && win[cand + best - 1] === win[cur + best - 1]) {
        let l = 2;
        while (l < maxLen && win[cand + l] === win[cur + l]) l++;
        if (l > best) {
          this.matchStart = cand;
          best = l;
          if (l >= nice) break;
        }
      }
      cand = prev[cand & WMASK];
    } while (cand > limit && --chain !== 0);
    return best > this.lookahead ? this.lookahead : best;
  }

  private tallyLit(c: number): boolean {
    const n = this.nsym++;
    this.symD[n] = 0;
    this.symL[n] = c;
    this.litFreq[c]++;
    return this.nsym === SYMS;
  }

  private tallyMatch(dist: number, len: number): boolean {
    const n = this.nsym++;
    this.symD[n] = dist;
    this.symL[n] = len - 3;
    this.litFreq[257 + LCODE[len - 3]]++;
    this.distFreq[dist <= 256 ? DCODE[dist - 1] : DCODE[256 + ((dist - 1) >> 7)]]++;
    return this.nsym === SYMS;
  }

  // the data is used up: close the block the flush mode asks for
  private tail(flush: number): number {
    if (this.matchAvail) {
      this.tallyLit(this.win[this.strstart - 1]);
      this.matchAvail = false;
    }
    if (flush === FINISH) this.flushBlock(true);
    else if (this.nsym) this.flushBlock(false);
    return DONE;
  }

  private huff(flush: number): number {
    const win = this.win;
    for (;;) {
      if (this.lookahead === 0) {
        this.fill();
        if (this.lookahead === 0) return flush === NO_FLUSH ? NEED : this.tail(flush);
      }
      const full = this.tallyLit(win[this.strstart]);
      this.lookahead--;
      this.hashed = ++this.strstart;
      if (full) {
        this.flushBlock(false);
        return BLOCKED;
      }
    }
  }

  private fast(flush: number): number {
    const win = this.win;
    const cfg = CONFIG[this.level], maxInsert = cfg[1], nice = cfg[2], chain = cfg[3];
    for (;;) {
      if (this.lookahead < MIN_LOOKAHEAD) {
        this.fill();
        if (this.lookahead < MIN_LOOKAHEAD && flush === NO_FLUSH) return NEED;
        if (this.lookahead === 0) return this.tail(flush);
      }
      if (this.hashed < this.strstart) this.insertUpTo(this.strstart);
      let hh = 0;
      if (this.lookahead >= MIN_MATCH) {
        hh = this.insertAt(this.strstart);
        this.hashed = this.strstart + 1;
      }
      let len = 0;
      if (hh !== 0 && this.strstart - hh <= MAX_DIST) len = this.longest(hh, MIN_MATCH - 1, chain, nice);
      let full: boolean;
      if (len >= MIN_MATCH) {
        full = this.tallyMatch(this.strstart - this.matchStart, len);
        this.lookahead -= len;
        const end = this.strstart + len;
        if (len <= maxInsert && this.lookahead >= MIN_MATCH) {
          for (let p = this.strstart + 1; p < end; p++) this.insertAt(p);
        }
        this.hashed = this.strstart = end;
      } else {
        full = this.tallyLit(win[this.strstart]);
        this.lookahead--;
        this.strstart++;
      }
      if (full) {
        this.flushBlock(false);
        return BLOCKED;
      }
    }
  }

  private lazy(flush: number): number {
    const win = this.win;
    const cfg = CONFIG[this.level], good = cfg[0], maxLazy = cfg[1], nice = cfg[2], chainMax = cfg[3];
    const filtered = this.strategy === FILTERED;
    for (;;) {
      if (this.lookahead < MIN_LOOKAHEAD) {
        this.fill();
        if (this.lookahead < MIN_LOOKAHEAD && flush === NO_FLUSH) return NEED;
        if (this.lookahead === 0) return this.tail(flush);
      }
      if (this.hashed < this.strstart) this.insertUpTo(this.strstart);
      let hh = 0;
      if (this.lookahead >= MIN_MATCH) {
        hh = this.insertAt(this.strstart);
        this.hashed = this.strstart + 1;
      }
      this.prevLen = this.matchLen;
      this.prevMatch = this.matchStart;
      this.matchLen = MIN_MATCH - 1;
      if (hh !== 0 && this.prevLen < maxLazy && this.strstart - hh <= MAX_DIST) {
        let len = this.longest(hh, this.prevLen, this.prevLen >= good ? chainMax >> 2 : chainMax, nice);
        if (len <= 5 && (filtered || (len === MIN_MATCH && this.strstart - this.matchStart > TOO_FAR))) len = MIN_MATCH - 1;
        this.matchLen = len;
      }
      if (this.prevLen >= MIN_MATCH && this.matchLen <= this.prevLen) {
        // the match found one byte back is the better one
        const dataEnd = this.strstart + this.lookahead;
        const full = this.tallyMatch(this.strstart - 1 - this.prevMatch, this.prevLen);
        this.lookahead -= this.prevLen - 1;
        const end = this.strstart - 1 + this.prevLen;
        let p = this.strstart + 1;
        for (; p < end && p + 2 < dataEnd; p++) this.insertAt(p);
        this.hashed = p;
        this.matchAvail = false;
        this.matchLen = MIN_MATCH - 1;
        this.strstart = end;
        if (full) {
          this.flushBlock(false);
          return BLOCKED;
        }
      } else if (this.matchAvail) {
        const full = this.tallyLit(win[this.strstart - 1]);
        if (full) this.flushBlock(false);
        this.strstart++;
        this.lookahead--;
        if (full) return BLOCKED;
      } else {
        this.matchAvail = true;
        this.strstart++;
        this.lookahead--;
      }
    }
  }

  private writeStored(start: number, len: number, last: boolean) {
    do {
      const n = Math.min(len, STORED_MAX);
      len -= n;
      this.putBits(last && len === 0 ? 1 : 0, 3);
      this.align();
      this.put(n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff);
      this.pending.set(this.win.subarray(start, start + n), this.pendLen);
      this.pendLen += n;
      start += n;
    } while (len > 0);
  }

  private emit(litCode: Uint16Array, litLen: Uint8Array, distCode: Uint16Array, distLen: Uint8Array) {
    const symD = this.symD, symL = this.symL, pend = this.pending, n = this.nsym;
    let bb = this.bitBuf, bc = this.bitCnt, pl = this.pendLen;
    for (let i = 0; i < n; i++) {
      const d = symD[i], l = symL[i];
      if (d === 0) {
        bb |= litCode[l] << bc;
        bc += litLen[l];
      } else {
        const lc = LCODE[l], sym = 257 + lc;
        bb |= (litCode[sym] | ((l - LBASE0[lc]) << litLen[sym])) << bc;
        bc += litLen[sym] + LEN_EXTRA[lc];
      }
      while (bc >= 8) {
        pend[pl++] = bb & 0xff;
        bb >>>= 8;
        bc -= 8;
      }
      if (d !== 0) {
        const dc = d <= 256 ? DCODE[d - 1] : DCODE[256 + ((d - 1) >> 7)];
        bb |= distCode[dc] << bc;
        bc += distLen[dc];
        while (bc >= 8) {
          pend[pl++] = bb & 0xff;
          bb >>>= 8;
          bc -= 8;
        }
        const eb = DIST_EXTRA[dc];
        if (eb) {
          bb |= (d - DIST_BASE[dc]) << bc;
          bc += eb;
          while (bc >= 8) {
            pend[pl++] = bb & 0xff;
            bb >>>= 8;
            bc -= 8;
          }
        }
      }
    }
    bb |= litCode[256] << bc;
    bc += litLen[256];
    while (bc >= 8) {
      pend[pl++] = bb & 0xff;
      bb >>>= 8;
      bc -= 8;
    }
    this.bitBuf = bb;
    this.bitCnt = bc;
    this.pendLen = pl;
  }

  private flushBlock(last: boolean) {
    const lit = this.litFreq, dist = this.distFreq;
    lit[256] = 1;
    buildLengths(lit, 286, 15, LIT_LEN);
    buildLengths(dist, 30, 15, DIST_LEN);
    let nlit = 286, ndist = 30;
    while (nlit > 257 && LIT_LEN[nlit - 1] === 0) nlit--;
    while (ndist > 1 && DIST_LEN[ndist - 1] === 0) ndist--;
    SEQ.set(LIT_LEN.subarray(0, nlit), 0);
    SEQ.set(DIST_LEN.subarray(0, ndist), nlit);
    const nrle = this.runLengths(nlit + ndist);
    buildLengths(CL_FREQ, 19, 7, CL_LEN);
    let hclen = 19;
    while (hclen > 4 && CL_LEN[CL_ORDER[hclen - 1]] === 0) hclen--;
    let dynBits = 14 + 3 * hclen + dataBits(LIT_LEN, DIST_LEN, lit, dist);
    for (let s = 0; s < 19; s++) dynBits += CL_FREQ[s] * (CL_LEN[s] + (s === 16 ? 2 : s === 17 ? 3 : s === 18 ? 7 : 0));
    const fixBits = dataBits(FIXED_LIT_LEN, FIXED_DIST_LEN, lit, dist);
    const dynBytes = (dynBits + 10) >> 3, fixBytes = (fixBits + 10) >> 3;
    const storedLen = this.strstart - this.blockStart;
    if (this.blockStart >= 0 && storedLen + 4 <= Math.min(dynBytes, fixBytes)) {
      this.writeStored(this.blockStart, storedLen, last);
    } else if (fixBytes <= dynBytes) {
      this.putBits((last ? 1 : 0) | 2, 3);
      this.emit(FIXED_LIT_CODE, FIXED_LIT_LEN, FIXED_DIST_CODE, FIXED_DIST_LEN);
    } else {
      makeCodes(LIT_LEN, 286, LIT_CODE);
      makeCodes(DIST_LEN, 30, DIST_CODE);
      makeCodes(CL_LEN, 19, CL_CODE);
      this.putBits((last ? 1 : 0) | 4, 3);
      this.putBits(nlit - 257, 5);
      this.putBits(ndist - 1, 5);
      this.putBits(hclen - 4, 4);
      for (let i = 0; i < hclen; i++) this.putBits(CL_LEN[CL_ORDER[i]], 3);
      for (let i = 0; i < nrle; i++) {
        const s = RLE_SYM[i];
        this.putBits(CL_CODE[s], CL_LEN[s]);
        if (s === 16) this.putBits(RLE_X[i], 2);
        else if (s === 17) this.putBits(RLE_X[i], 3);
        else if (s === 18) this.putBits(RLE_X[i], 7);
      }
      this.emit(LIT_CODE, LIT_LEN, DIST_CODE, DIST_LEN);
    }
    if (last) this.align();
    lit.fill(0);
    dist.fill(0);
    this.nsym = 0;
    this.blockStart = this.strstart;
  }

  // run-length codes (16, 17, 18) for the n code lengths in SEQ; fills CL_FREQ
  private runLengths(n: number): number {
    CL_FREQ.fill(0);
    let k = 0;
    const out = (s: number, x: number) => {
      RLE_SYM[k] = s;
      RLE_X[k++] = x;
      CL_FREQ[s]++;
    };
    for (let i = 0; i < n;) {
      const v = SEQ[i];
      let run = 1;
      while (i + run < n && SEQ[i + run] === v) run++;
      i += run;
      if (v === 0) {
        while (run >= 11) {
          const t = Math.min(run, 138);
          out(18, t - 11);
          run -= t;
        }
        if (run >= 3) {
          out(17, run - 3);
          run = 0;
        }
        while (run-- > 0) out(0, 0);
      } else {
        out(v, 0);
        run--;
        while (run >= 3) {
          const t = Math.min(run, 6);
          out(16, t - 3);
          run -= t;
        }
        while (run-- > 0) out(v, 0);
      }
    }
    return k;
  }
}
