import { NextRequest, NextResponse } from "next/server";
import {
  type Hex,
  createPublicClient,
  getAddress,
  hexToBigInt,
  http,
  isAddress,
  isHex,
  parseAbi,
  recoverAddress,
  recoverMessageAddress,
  slice,
} from "viem";
import { upstreamRpc } from "@/lib/rpcServer";
import { drop, stash, unstash } from "@/lib/safe/relayGuard";

export const dynamic = "force-dynamic";

/**
 * A Safe transaction queue any Safe UI can share (wedgie.dev/safe first), so a slow or down Safe Transaction Service
 * doesn't stop a multisig. Any Safe tx, many per Safe; every signature is checked on chain before it's kept.
 *   POST   { chainId, safe, tx, sigs: [{ owner, signature }], origin? } → merged into the Safe's queue
 *   GET    ?chainId&safe                                                 → { txs } still ahead of the Safe's nonce
 * A signature here is one owner's Safe signature: 65 bytes (ECDSA / eth_sign), or a contract signature (v = 0)
 * with its data right after (s = 65), the way Safe's API takes one.
 */
const TTL = 30 * 24 * 3600;
const MAX = 30;
const key = (chainId: number, safe: string) => `queue:${chainId}:${safe.toLowerCase()}`;
const ORIGINS = ["https://wedgie.dev", "https://www.wedgie.dev", "https://instantwallet.io", "http://localhost:5173", "http://localhost:4173"];
const ZERO = "0x0000000000000000000000000000000000000000";
const safeAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function checkNSignatures(bytes32 dataHash, bytes data, bytes signatures, uint256 requiredSignatures) view",
  "function encodeTransactionData(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
]);

type Tx = { to: string; value: string; data: Hex; operation: number; safeTxGas: string; baseGas: string; gasPrice: string; gasToken: string; refundReceiver: string; nonce: string };
type Entry = { tx: Tx; hash: Hex; sigs: { owner: string; signature: Hex }[]; origin?: string; at: number };
type Queue = Record<string, Entry>;

function client(chainId: number) {
  const url = upstreamRpc(chainId);
  if (!url) throw new Error("chain not enabled");
  return createPublicClient({ transport: http(url) });
}

const cors = (req: NextRequest) => {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
};
const out = (req: NextRequest, v: unknown, status = 200) => NextResponse.json(v, { status, headers: cors(req) });

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(req) });
}

/** Drop what the Safe's nonce has passed; null once nothing is left. */
function live(q: Queue, nonce: bigint): Queue {
  return Object.fromEntries(Object.entries(q).filter(([, e]) => BigInt(e.tx.nonce) >= nonce));
}

export async function GET(req: NextRequest) {
  try {
    const chainId = Number(req.nextUrl.searchParams.get("chainId"));
    const safe = req.nextUrl.searchParams.get("safe") || "";
    if (!isAddress(safe)) throw new Error("safe?");
    const q = await unstash<Queue>(key(chainId, safe));
    if (!q) return out(req, { txs: [] });
    const n = await client(chainId).readContract({ address: getAddress(safe), abi: safeAbi, functionName: "nonce" });
    const left = live(q, n);
    if (!Object.keys(left).length) await drop(key(chainId, safe));
    const txs = Object.values(left).sort((a, b) => Number(BigInt(a.tx.nonce) - BigInt(b.tx.nonce)) || a.at - b.at);
    return out(req, { txs });
  } catch (e: any) {
    return out(req, { error: e?.shortMessage || e?.message || String(e) }, 400);
  }
}

/** Who signed: the owner in r for a contract signature (v = 0), else the key that signed the hash. */
async function signerOf(hash: Hex, sig: Hex): Promise<string> {
  const v = Number(BigInt(slice(sig, 64, 65)));
  if (v === 0) return getAddress(slice(sig, 12, 32));
  if (v > 30) return recoverMessageAddress({ message: { raw: hash }, signature: (slice(sig, 0, 64) + (v - 4).toString(16)) as Hex });
  if (v === 27 || v === 28) return recoverAddress({ hash, signature: sig });
  throw new Error("that kind of signature isn't kept here");
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    if (raw.length > 200_000) throw new Error("too big");
    const b = JSON.parse(raw);
    const chainId = Number(b.chainId);
    if (!isAddress(b.safe)) throw new Error("safe?");
    const safe = getAddress(b.safe);
    const t = b.tx || {};
    const addr = (a: unknown) => (typeof a === "string" && isAddress(a) ? getAddress(a) : ZERO);
    if (!isAddress(t.to) || !isHex(t.data) || ![0, 1].includes(Number(t.operation))) throw new Error("tx?");
    const big = (v: unknown) => BigInt(String(v ?? 0));
    const args = [getAddress(t.to), big(t.value), t.data as Hex, Number(t.operation), big(t.safeTxGas), big(t.baseGas), big(t.gasPrice), addr(t.gasToken), addr(t.refundReceiver), big(t.nonce)] as const;
    const pc = client(chainId);
    const [n, hash, data] = await Promise.all([
      pc.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
      pc.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args }),
      pc.readContract({ address: safe, abi: safeAbi, functionName: "encodeTransactionData", args }),
    ]);
    if (args[9] < n) throw new Error("that nonce is already used");
    const tx: Tx = { to: args[0], value: String(args[1]), data: args[2], operation: args[3], safeTxGas: String(args[4]), baseGas: String(args[5]),
      gasPrice: String(args[6]), gasToken: args[7], refundReceiver: args[8], nonce: String(args[9]) };
    const given: { owner: string; signature: Hex }[] = [];
    for (const s of Array.isArray(b.sigs) ? b.sigs.slice(0, 10) : []) {
      if (!isHex(s?.signature) || (s.signature.length - 2) / 2 < 65) throw new Error("sig?");
      const owner = await signerOf(hash, s.signature);
      // a real owner's signature of exactly this transaction, or it isn't kept
      await pc.readContract({ address: safe, abi: safeAbi, functionName: "checkNSignatures", args: [hash, data, s.signature, 1n] }).catch(() => {
        throw new Error(`the signature from ${owner} doesn't check out`);
      });
      given.push({ owner, signature: s.signature });
    }
    if (!given.length) throw new Error("sigs?");
    const q = live((await unstash<Queue>(key(chainId, safe))) || {}, n);
    const h = hash.toLowerCase();
    const e: Entry = q[h] || { tx, hash, sigs: [], origin: typeof b.origin === "string" ? b.origin.slice(0, 100) : undefined, at: Date.now() };
    for (const s of given) if (!e.sigs.some((x) => x.owner.toLowerCase() === s.owner.toLowerCase())) e.sigs.push(s);
    q[h] = e;
    if (Object.keys(q).length > MAX) throw new Error("this Safe's queue is full");
    await stash(key(chainId, safe), q, TTL);
    return out(req, { ok: true, hash, sigs: e.sigs.length });
  } catch (e: any) {
    return out(req, { error: e?.shortMessage || e?.message || String(e) }, 400);
  }
}
