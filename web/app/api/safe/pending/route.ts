import { NextRequest, NextResponse } from "next/server";
import { type Hex, createPublicClient, getAddress, http, isAddress, isHex, parseAbi } from "viem";
import { chainById } from "@/lib/chains";
import { upstreamRpc } from "@/lib/rpcServer";
import { MULTISEND_CALL_ONLY } from "@/lib/safe/config";
import { type SafeTx, type Sig, encodeSignatures, safeTxHash } from "@/lib/safe/core";
import type { Pending } from "@/lib/safe/pending";
import { drop, stash, unstash } from "@/lib/safe/relayGuard";

export const dynamic = "force-dynamic";

/**
 * Transactions parked for the wedgie (lib/safe/pending.ts).
 *   POST   Pending (minus `at`)         → saved for 7 days, only if its signatures check out on chain
 *   GET    ?chainId&safe                → { pending } | { pending: null } (dropped once the Safe's nonce passed it)
 *   DELETE ?chainId&safe&hash           → forget it
 */
const TTL = 7 * 24 * 3600;
const key = (chainId: number, safe: string) => `pending:${chainId}:${safe.toLowerCase()}`;
const safeAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function checkNSignatures(bytes32 dataHash, bytes data, bytes signatures, uint256 requiredSignatures) view",
  "function encodeTransactionData(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";

function client(chainId: number) {
  const info = chainById(chainId);
  const url = info && upstreamRpc(chainId);
  if (!info || !url) throw new Error("chain not enabled");
  return createPublicClient({ chain: info.chain, transport: http(url) });
}

const out = (v: unknown, status = 200) =>
  NextResponse.json(JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))), { status });

export async function GET(req: NextRequest) {
  try {
    const chainId = Number(req.nextUrl.searchParams.get("chainId"));
    const safe = req.nextUrl.searchParams.get("safe") || "";
    if (!isAddress(safe)) throw new Error("safe?");
    const p = await unstash<Pending>(key(chainId, safe));
    if (!p) return out({ pending: null });
    const n = await client(chainId).readContract({ address: getAddress(safe), abi: safeAbi, functionName: "nonce" });
    if (n > BigInt(p.tx.nonce)) {
      await drop(key(chainId, safe)); // sent, or something else took its nonce
      return out({ pending: null });
    }
    return out({ pending: p });
  } catch (e: any) {
    return out({ error: e?.shortMessage || e?.message || String(e) }, 400);
  }
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    if (raw.length > 64_000) throw new Error("too big");
    const b = JSON.parse(raw);
    const chainId = Number(b.chainId);
    if (!isAddress(b.safe)) throw new Error("safe?");
    const safe = getAddress(b.safe);
    const t = b.tx;
    if (!t || !isAddress(t.to) || !isHex(t.data)) throw new Error("tx?");
    const tx: SafeTx = { to: getAddress(t.to), value: BigInt(t.value), data: t.data, operation: Number(t.operation) as 0 | 1, nonce: BigInt(t.nonce) };
    if (tx.to !== MULTISEND_CALL_ONLY || tx.operation !== 1 || tx.value !== 0n) throw new Error("only Instant Wallet batches");
    const sigs: Sig[] = (Array.isArray(b.sigs) ? b.sigs : []).map((s: any) => {
      if (!isAddress(s?.signer) || !isHex(s?.data) || !["contract", "ecdsa"].includes(s?.kind)) throw new Error("sig?");
      return { signer: getAddress(s.signer), data: s.data as Hex, kind: s.kind };
    });
    if (!sigs.length || sigs.length > 3) throw new Error("sigs?");
    if (!b.burner || !isHex(b.burner.x) || !isHex(b.burner.y)) throw new Error("burner?");
    const hash = safeTxHash(chainId, safe, tx);
    const pc = client(chainId);
    const n = await pc.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    if (tx.nonce < n) throw new Error("that nonce is already used");
    // the signatures must be real owners' signatures of exactly this transaction: nobody parks a fake for the wedgie
    const data = await pc.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "encodeTransactionData",
      args: [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, ZERO, ZERO, tx.nonce],
    });
    await pc
      .readContract({ address: safe, abi: safeAbi, functionName: "checkNSignatures", args: [hash, data, encodeSignatures(sigs), BigInt(sigs.length)] })
      .catch(() => {
        throw new Error("those signatures don't check out");
      });
    const p: Pending = {
      chainId,
      safe,
      tx,
      hash,
      sigs,
      burner: { x: b.burner.x, y: b.burner.y },
      label: typeof b.label === "string" ? b.label.slice(0, 200) : undefined,
      at: Date.now(),
    };
    await stash(key(chainId, safe), JSON.parse(JSON.stringify(p, (_, x) => (typeof x === "bigint" ? x.toString() : x))), TTL);
    return out({ ok: true, hash });
  } catch (e: any) {
    return out({ error: e?.shortMessage || e?.message || String(e) }, 400);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const chainId = Number(req.nextUrl.searchParams.get("chainId"));
    const safe = req.nextUrl.searchParams.get("safe") || "";
    const hash = (req.nextUrl.searchParams.get("hash") || "").toLowerCase();
    if (!isAddress(safe)) throw new Error("safe?");
    const p = await unstash<Pending>(key(chainId, safe));
    if (p && p.hash.toLowerCase() === hash) await drop(key(chainId, safe));
    return out({ ok: true });
  } catch (e: any) {
    return out({ error: e?.message || String(e) }, 400);
  }
}
