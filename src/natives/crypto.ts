// The methods HotSpot replaces with intrinsics for SHA digests and BigInteger
// arithmetic. As bytecode they run on Java longs, which are JS BigInts here,
// so a 64-bit step allocates; these do the same work on numbers, or on one
// BigInt for a whole multiplication.

import type { JArray, JObject } from "../runtime.ts";
import type { JThread } from "../thread.ts";
import type { JVM } from "../jvm.ts";
import type { Natives } from "./util.ts";

const SHA1 = "sun/security/provider/SHA";
const SHA2 = "sun/security/provider/SHA2";
const SHA5 = "sun/security/provider/SHA5";
const BI = "java/math/BigInteger";

// the `state` field's slot in each digest class
const stateSlots = new WeakMap<JVM, Map<string, number>>();
function state(t: JThread, self: JObject, cls: string): JArray {
  let m = stateSlots.get(t.vm);
  if (!m) stateSlots.set(t.vm, (m = new Map()));
  let slot = m.get(cls);
  if (slot === undefined) m.set(cls, (slot = t.vm.slotOf(cls, "state")));
  return self.f[slot] as JArray;
}

// big-endian 32-bit word of a byte array
function word(b: Int8Array, p: number): number {
  return (b[p] << 24) | ((b[p + 1] & 255) << 16) | ((b[p + 2] & 255) << 8) | (b[p + 3] & 255);
}

const w32 = new Int32Array(80);

function sha1(s: Int32Array, b: Int8Array, ofs: number) {
  const w = w32;
  for (let i = 0; i < 16; i++) w[i] = word(b, ofs + 4 * i);
  for (let i = 16; i < 80; i++) {
    const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
    w[i] = (x << 1) | (x >>> 31);
  }
  let a = s[0], bb = s[1], c = s[2], d = s[3], e = s[4];
  for (let i = 0; i < 80; i++) {
    let f: number, k: number;
    if (i < 20) { f = (bb & c) | (~bb & d); k = 0x5a827999; }
    else if (i < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
    else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8f1bbcdc | 0; }
    else { f = bb ^ c ^ d; k = 0xca62c1d6 | 0; }
    const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
    e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = tmp;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + bb) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0; s[4] = (s[4] + e) | 0;
}

const K256 = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(s: Int32Array, b: Int8Array, ofs: number) {
  const w = w32;
  for (let i = 0; i < 16; i++) w[i] = word(b, ofs + 4 * i);
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15], y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (s0 + s1 + w[i - 7] + w[i - 16]) | 0;
  }
  let a = s[0], bb = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + bb) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
  s[4] = (s[4] + e) | 0; s[5] = (s[5] + f) | 0; s[6] = (s[6] + g) | 0; s[7] = (s[7] + h) | 0;
}

// SHA-512 on 32-bit halves: hi and lo words in separate arrays
const K512 = (() => {
  const k = [
    "428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc", "3956c25bf348b538", "59f111f1b605d019",
    "923f82a4af194f9b", "ab1c5ed5da6d8118", "d807aa98a3030242", "12835b0145706fbe", "243185be4ee4b28c", "550c7dc3d5ffb4e2",
    "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235", "c19bf174cf692694", "e49b69c19ef14ad2", "efbe4786384f25e3",
    "0fc19dc68b8cd5b5", "240ca1cc77ac9c65", "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5",
    "983e5152ee66dfab", "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4", "c6e00bf33da88fc2", "d5a79147930aa725",
    "06ca6351e003826f", "142929670a0e6e70", "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed", "53380d139d95b3df",
    "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b", "a2bfe8a14cf10364", "a81a664bbc423001",
    "c24b8b70d0f89791", "c76c51a30654be30", "d192e819d6ef5218", "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8",
    "19a4c116b8d2d0c8", "1e376c085141ab53", "2748774cdf8eeb99", "34b0bcb5e19b48a8", "391c0cb3c5c95a63", "4ed8aa4ae3418acb",
    "5b9cca4f7763e373", "682e6ff3d6b2b8a3", "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec",
    "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b", "ca273eceea26619c", "d186b8c721c0c207",
    "eada7dd6cde0eb1e", "f57d4f7fee6ed178", "06f067aa72176fba", "0a637dc5a2c898a6", "113f9804bef90dae", "1b710b35131c471b",
    "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc", "431d67c49c100d4c", "4cc5d4becb3e42b6", "597f299cfc657e2a",
    "5fcb6fab3ad6faec", "6c44198c4a475817",
  ];
  const hi = new Int32Array(80), lo = new Int32Array(80);
  k.forEach((x, i) => { hi[i] = parseInt(x.slice(0, 8), 16) | 0; lo[i] = parseInt(x.slice(8), 16) | 0; });
  return { hi, lo };
})();
const wh = new Int32Array(80), wl = new Int32Array(80);
const sh = new Int32Array(8), sl = new Int32Array(8);

function sha512(s: BigInt64Array, b: Int8Array, ofs: number) {
  for (let i = 0; i < 16; i++) { wh[i] = word(b, ofs + 8 * i); wl[i] = word(b, ofs + 8 * i + 4); }
  for (let i = 16; i < 80; i++) {
    // s0 = rotr(x, 1) ^ rotr(x, 8) ^ (x >>> 7), s1 = rotr(y, 19) ^ rotr(y, 61) ^ (y >>> 6)
    const xh = wh[i - 15], xl = wl[i - 15], yh = wh[i - 2], yl = wl[i - 2];
    const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
    const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
    const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
    const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
    let l = (s0l >>> 0) + (s1l >>> 0) + (wl[i - 7] >>> 0) + (wl[i - 16] >>> 0);
    wl[i] = l | 0;
    wh[i] = (s0h + s1h + wh[i - 7] + wh[i - 16] + Math.floor(l / 4294967296)) | 0;
  }
  for (let i = 0; i < 8; i++) { const v = s[i]; sh[i] = Number(v >> 32n); sl[i] = Number(BigInt.asIntN(32, v)); }
  let ah = sh[0], al = sl[0], bh = sh[1], bl = sl[1], ch = sh[2], cl = sl[2], dh = sh[3], dl = sl[3];
  let eh = sh[4], el = sl[4], fh = sh[5], fl = sl[5], gh = sh[6], gl = sl[6], hh = sh[7], hl = sl[7];
  for (let i = 0; i < 80; i++) {
    // S1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41)
    const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
    let l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512.lo[i] >>> 0) + (wl[i] >>> 0);
    const t1l = l | 0;
    const t1h = (hh + S1h + chh + K512.hi[i] + wh[i] + Math.floor(l / 4294967296)) | 0;
    // S0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39)
    const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch), majl = (al & bl) ^ (al & cl) ^ (bl & cl);
    l = (S0l >>> 0) + (majl >>> 0);
    const t2l = l | 0;
    const t2h = (S0h + majh + Math.floor(l / 4294967296)) | 0;
    hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
    l = (dl >>> 0) + (t1l >>> 0);
    el = l | 0; eh = (dh + t1h + Math.floor(l / 4294967296)) | 0;
    dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
    l = (t1l >>> 0) + (t2l >>> 0);
    al = l | 0; ah = (t1h + t2h + Math.floor(l / 4294967296)) | 0;
  }
  const add = (i: number, h: number, lo: number) => {
    const l = (sl[i] >>> 0) + (lo >>> 0);
    const hi = (sh[i] + h + Math.floor(l / 4294967296)) | 0;
    s[i] = (BigInt(hi) << 32n) | BigInt(l >>> 0);
  };
  add(0, ah, al); add(1, bh, bl); add(2, ch, cl); add(3, dh, dl); add(4, eh, el); add(5, fh, fl); add(6, gh, gl); add(7, hh, hl);
}

// ---- BigInteger: big-endian int[] magnitudes as one BigInt -----------------

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function toBig(a: Int32Array, from: number, len: number): bigint {
  if (len === 0) return 0n;
  let s = "0x";
  for (let i = from; i < from + len; i++) {
    const w = a[i];
    s += HEX[w >>> 24] + HEX[(w >>> 16) & 255] + HEX[(w >>> 8) & 255] + HEX[w & 255];
  }
  return BigInt(s);
}

// writes x's low len words into a[from..from+len), big-endian
function fromBig(x: bigint, a: Int32Array, from: number, len: number) {
  const s = x.toString(16);
  // hex digits of word i end at e; digits before the string's start are zero
  for (let i = len - 1, e = s.length; i >= 0; i--, e -= 8) {
    let w = 0;
    for (let j = Math.max(0, e - 8); j < e; j++) {
      const c = s.charCodeAt(j);
      w = (w << 4) | (c <= 57 ? c - 48 : c - 87);
    }
    a[from + i] = w;
  }
}

// -n^-1 mod 2^(32 len) for Montgomery reduction, from inv = -n^-1 mod 2^64
const negInverses = new WeakMap<Int32Array, { n: bigint; bits: bigint; v: bigint }>();
function negInverse(nArr: Int32Array, n: bigint, bits: bigint, inv: bigint): bigint {
  const hit = negInverses.get(nArr);
  if (hit && hit.n === n && hit.bits === bits) return hit.v;
  // Newton's iteration doubles the correct low bits of n^-1 each step
  let y = BigInt.asUintN(64, -inv), have = 64n;
  while (have < bits) {
    have *= 2n;
    y = BigInt.asUintN(Number(have), y * (2n - n * y));
  }
  const v = BigInt.asUintN(Number(bits), -y);
  negInverses.set(nArr, { n, bits, v });
  return v;
}

function montgomery(a: bigint, b: bigint, nArr: Int32Array, len: number, inv: bigint, product: JArray): JArray {
  const n = toBig(nArr, 0, len);
  const bits = BigInt(32 * len);
  const T = a * b;
  const m = BigInt.asUintN(32 * len, BigInt.asUintN(32 * len, T) * negInverse(nArr, n, bits, inv));
  let r = (T + m * n) >> bits;
  if (r >= n) r -= n;
  const p = product.a as Int32Array;
  fromBig(r, p, 0, len);
  // the Java version leaves the rest of a 2 len product zero
  p.fill(0, len, Math.min(p.length, 2 * len));
  return product;
}

export const intrinsics: Natives = {
  [`${SHA1}.implCompress0([BI)V`]: (t, [self, buf, ofs]) =>
    sha1(state(t, self, SHA1).a as Int32Array, (buf as JArray).a as Int8Array, ofs),
  [`${SHA2}.implCompress0([BI)V`]: (t, [self, buf, ofs]) =>
    sha256(state(t, self, SHA2).a as Int32Array, (buf as JArray).a as Int8Array, ofs),
  [`${SHA5}.implCompress0([BI)V`]: (t, [self, buf, ofs]) =>
    sha512(state(t, self, SHA5).a as BigInt64Array, (buf as JArray).a as Int8Array, ofs),

  [`${BI}.implMontgomeryMultiply([I[I[IIJ[I)[I`]: (_t, [a, b, n, len, inv, product]) =>
    montgomery(toBig(a.a, 0, len), toBig(b.a, 0, len), n.a, len, inv, product),
  [`${BI}.implMontgomerySquare([I[IIJ[I)[I`]: (_t, [a, n, len, inv, product]) => {
    const x = toBig(a.a, 0, len);
    return montgomery(x, x, n.a, len, inv, product);
  },
  [`${BI}.implMultiplyToLen([II[II[I)[I`]: (_t, [x, xlen, y, ylen, z]) => {
    fromBig(toBig(x.a, 0, xlen) * toBig(y.a, 0, ylen), z.a, 0, xlen + ylen);
    return z;
  },
  [`${BI}.implSquareToLen([II[II)[I`]: (_t, [x, len, z, zlen]) => {
    const v = toBig(x.a, 0, len);
    fromBig(v * v, z.a, 0, zlen);
    return z;
  },
  // out[...] += in[0..len) * k, ending offset words from out's end; returns the carry
  [`${BI}.implMulAdd([I[IIII)I`]: (_t, [out, inp, offset, len, k]) => {
    const o = out.a as Int32Array;
    const end = o.length - offset;
    const sum = toBig(inp.a, 0, len) * BigInt(k >>> 0) + toBig(o, end - len, len);
    fromBig(sum, o, end - len, len);
    return Number(BigInt.asIntN(32, sum >> BigInt(32 * len)));
  },
};
