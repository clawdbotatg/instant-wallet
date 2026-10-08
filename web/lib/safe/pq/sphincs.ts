import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * SPHINCS- signer (keccak C-series, FIPS 205 uncompressed ADRS), ported from the byte-level spec in
 * lattice-safe/sphincsminus docs/SPEC.md, which transcribes nconsigny/SPHINCS-. Verified byte-for-byte against
 * that repo's test vectors (web/tools/pq-check.mts) and its Solidity verifier (forge test/safe/PQ*).
 * RESEARCH CODE, unaudited: experimental post-quantum signer only (docs/PQ-HYBRID.md).
 *
 * Node values are 32-byte words with the top 16 bytes significant ("masked"); on the wire only 16 bytes.
 */

export type Params = { name: string; h: number; d: number; a: number; k: number; w: number; l: number; target: number };

// C11 is our default: rolling keys means each key signs about once, well inside its 128-bit window (2^14), and
// it signs ~30x faster than C13 (≈0.3M hashes), which matters on a phone.
export const C11: Params = { name: "C11", h: 16, d: 2, a: 11, k: 13, w: 8, l: 43, target: 203 };
export const C13: Params = { name: "C13", h: 22, d: 2, a: 19, k: 7, w: 8, l: 43, target: 208 };

const N = 16;
export const sigSize = (p: Params) => N + p.k * N + (p.k - 1) * p.a * N + p.d * (p.l * N + 4 + (p.h / p.d) * N);

export type Keys = { skSeed: Uint8Array; pkSeed: Uint8Array; pkRoot: Uint8Array }; // 32 bytes each, pk* masked

const enc = new TextEncoder();
const mask = (x: Uint8Array) => (x.fill(0, 16), x);
const kec = (b: Uint8Array) => keccak_256(b);

function adrs(layer: number, tree: bigint, type: number, w1: number, w2: number, w3: number): Uint8Array {
  const a = new Uint8Array(32);
  const v = new DataView(a.buffer);
  v.setUint32(0, layer);
  v.setBigUint64(8, tree);
  v.setUint32(16, type);
  v.setUint32(20, w1);
  v.setUint32(24, w2);
  v.setUint32(28, w3);
  return a;
}

// Tweakable hashes share one scratch buffer per call shape (single-threaded).
const b96 = new Uint8Array(96);
const b128 = new Uint8Array(128);
function th(seed: Uint8Array, ad: Uint8Array, x: Uint8Array): Uint8Array {
  b96.set(seed, 0); b96.set(ad, 32); b96.set(x, 64);
  return mask(kec(b96));
}
function thPair(seed: Uint8Array, ad: Uint8Array, l: Uint8Array, r: Uint8Array): Uint8Array {
  b128.set(seed, 0); b128.set(ad, 32); b128.set(l, 64); b128.set(r, 96);
  return mask(kec(b128));
}
function thMulti(seed: Uint8Array, ad: Uint8Array, v: Uint8Array[]): Uint8Array {
  const b = new Uint8Array(64 + 32 * v.length);
  b.set(seed, 0); b.set(ad, 32);
  v.forEach((x, i) => b.set(x, 64 + 32 * i));
  return mask(kec(b));
}
const be4 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const be32 = (n: bigint) => { const b = new Uint8Array(32); new DataView(b.buffer).setBigUint64(24, n); return b; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const toBig = (b: Uint8Array) => BigInt("0x" + Array.from(b, x => x.toString(16).padStart(2, "0")).join(""));

const WOTS = enc.encode("wots"), FORS = enc.encode("fors"), RG = enc.encode("R_grind");
const wotsSecret = (sk: Uint8Array, layer: number, tree: bigint, kp: number, c: number) =>
  mask(kec(cat(sk, WOTS, be4(layer), be32(tree), be4(kp), be4(c))));
const forsSecret = (sk: Uint8Array, ht: number, t: number, j: number) => mask(kec(cat(sk, FORS, be4(ht), be4(t), be4(j))));

// ---- WOTS+C
function chain(seed: Uint8Array, layer: number, tree: bigint, kp: number, i: number, x: Uint8Array, start: number, steps: number) {
  for (let pos = start; pos < start + steps; pos++) x = th(seed, adrs(layer, tree, 0, kp, i, pos), x);
  return x;
}
function wotsPk(p: Params, k: Keys, layer: number, tree: bigint, kp: number): Uint8Array {
  const pk: Uint8Array[] = [];
  for (let i = 0; i < p.l; i++) pk.push(chain(k.pkSeed, layer, tree, kp, i, wotsSecret(k.skSeed, layer, tree, kp, i), 0, p.w - 1));
  return thMulti(k.pkSeed, adrs(layer, tree, 1, kp, 0, 0), pk);
}
function wotsSign(p: Params, k: Keys, layer: number, tree: bigint, kp: number, m: Uint8Array): Uint8Array {
  const pre = cat(k.pkSeed, adrs(layer, tree, 0, kp, 0, 0), m);
  for (let count = 0; ; count++) {
    const D = toBig(kec(cat(pre, be32(BigInt(count)))));
    const digits: number[] = [];
    let sum = 0;
    for (let i = 0; i < p.l; i++) { const d = Number((D >> BigInt(3 * i)) & 7n); digits.push(d); sum += d; }
    if (sum !== p.target) continue;
    const out = new Uint8Array(p.l * N + 4);
    digits.forEach((d, i) => out.set(chain(k.pkSeed, layer, tree, kp, i, wotsSecret(k.skSeed, layer, tree, kp, i), 0, d).subarray(0, N), i * N));
    out.set(be4(count), p.l * N);
    return out;
  }
}

// ---- Merkle helpers: all levels of a tree from its leaves (levels[0] = leaves)
function levels(leaves: Uint8Array[], node: (hh: number, i: number, l: Uint8Array, r: Uint8Array) => Uint8Array) {
  const out = [leaves];
  for (let hh = 1; out[hh - 1]!.length > 1; hh++) {
    const prev = out[hh - 1]!, cur: Uint8Array[] = [];
    for (let i = 0; i < prev.length / 2; i++) cur.push(node(hh, i, prev[2 * i]!, prev[2 * i + 1]!));
    out.push(cur);
  }
  return out;
}
const authPath = (lv: Uint8Array[][], idx: number) => lv.slice(0, -1).map((level, hh) => level[(idx >> hh) ^ 1]!);

function subtree(p: Params, k: Keys, layer: number, tree: bigint) {
  const sh = p.h / p.d, leaves: Uint8Array[] = [];
  for (let kp = 0; kp < 1 << sh; kp++) leaves.push(wotsPk(p, k, layer, tree, kp));
  return levels(leaves, (hh, i, l, r) => thPair(k.pkSeed, adrs(layer, tree, 2, 0, hh, i), l, r));
}

/** Keys from 32 bytes of secret material (for us: a passkey PRF output). Deterministic. */
export function keygen(p: Params, material: Uint8Array): Keys {
  const entropy = kec(cat(enc.encode("sphincs_signer_v1"), material));
  const pkSeed = mask(kec(cat(enc.encode("pk_seed"), entropy)));
  const skSeed = kec(cat(enc.encode("sk_seed"), entropy));
  const k: Keys = { skSeed, pkSeed, pkRoot: new Uint8Array(32) };
  const top = subtree(p, k, p.d - 1, 0n);
  k.pkRoot = top[top.length - 1]![0]!;
  return k;
}

/** Sign a 32-byte message. Returns the raw signature (sigSize(p) bytes). */
export function sign(p: Params, k: Keys, msg: Uint8Array): Uint8Array {
  const sh = p.h / p.d;
  // R grinding until the last FORS index is zero (FORS+C)
  let R!: Uint8Array, dig = 0n;
  for (let nonce = 0n; ; nonce++) {
    R = mask(kec(cat(k.skSeed, RG, msg, be32(nonce))));
    dig = toBig(kec(cat(k.pkSeed, k.pkRoot, R, msg, new Uint8Array(32).fill(0xff))));
    if (((dig >> BigInt((p.k - 1) * p.a)) & BigInt((1 << p.a) - 1)) === 0n) break;
  }
  const forsIdx = Array.from({ length: p.k }, (_, i) => Number((dig >> BigInt(i * p.a)) & BigInt((1 << p.a) - 1)));
  const htIdx = Number((dig >> BigInt(p.k * p.a)) & BigInt(2 ** p.h - 1));
  const leaf0 = htIdx & ((1 << sh) - 1), tree0 = BigInt(Math.floor(htIdx / 2 ** sh));

  const sig = new Uint8Array(sigSize(p));
  sig.set(R.subarray(0, N), 0);
  const authStart = N + p.k * N;
  const roots: Uint8Array[] = [];
  for (let t = 0; t < p.k; t++) {
    const leaves: Uint8Array[] = [];
    for (let j = 0; j < 1 << p.a; j++) leaves.push(th(k.pkSeed, adrs(0, tree0, 3, leaf0, 0, (t << p.a) | j), forsSecret(k.skSeed, htIdx, t, j)));
    const lv = levels(leaves, (hh, i, l, r) => thPair(k.pkSeed, adrs(0, tree0, 3, leaf0, hh, (t << (p.a - hh)) | i), l, r));
    const root = lv[lv.length - 1]![0]!;
    if (t < p.k - 1) {
      sig.set(forsSecret(k.skSeed, htIdx, t, forsIdx[t]!).subarray(0, N), N + t * N);
      authPath(lv, forsIdx[t]!).forEach((x, hh) => sig.set(x.subarray(0, N), authStart + (t * p.a + hh) * N));
      roots.push(root);
    } else {
      sig.set(root.subarray(0, N), N + t * N);
      roots.push(th(k.pkSeed, adrs(0, tree0, 3, leaf0, 0, t << p.a), root));
    }
  }
  let cur = thMulti(k.pkSeed, adrs(0, tree0, 4, leaf0, 0, 0), roots);

  const htStart = authStart + (p.k - 1) * p.a * N, layerSize = p.l * N + 4 + sh * N;
  let idxTree = BigInt(htIdx);
  for (let layer = 0; layer < p.d; layer++) {
    const idxLeaf = Number(idxTree & BigInt((1 << sh) - 1));
    idxTree >>= BigInt(sh);
    const off = htStart + layer * layerSize;
    sig.set(wotsSign(p, k, layer, idxTree, idxLeaf, cur), off);
    const lv = subtree(p, k, layer, idxTree);
    authPath(lv, idxLeaf).forEach((x, hh) => sig.set(x.subarray(0, N), off + p.l * N + 4 + hh * N));
    cur = lv[lv.length - 1]![0]!;
  }
  if (!cur.every((b, i) => b === k.pkRoot[i])) throw new Error("SPHINCS-: root mismatch");
  return sig;
}
