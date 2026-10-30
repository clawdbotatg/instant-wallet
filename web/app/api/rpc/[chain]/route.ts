import { NextRequest, NextResponse } from "next/server";
import { upstreamRpc } from "@/lib/rpcServer";
import { chainById } from "@/lib/chains";

export const dynamic = "force-dynamic";

/**
 * JSON-RPC passthrough for the enabled chains, so the RPC key stays on the server. Not an open relay on our Alchemy key
 * (as wedgie.dev's api/rpc.ts): only the reads (and gas/fee asks, 4337 bundler calls) the wallet makes, single or
 * batched, and a per-IP limit (kept per instance: each Vercel instance counts on its own).
 */
const ALLOW = new Set([
  "eth_call", "eth_getCode", "eth_getBalance", "eth_getStorageAt", "eth_getLogs", "eth_blockNumber", "eth_chainId",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getTransactionCount",
  "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "net_version",
  "eth_sendUserOperation", "eth_estimateUserOperationGas", "eth_getUserOperationReceipt", "eth_getUserOperationByHash", "eth_supportedEntryPoints",
  "alchemy_getTokenBalances", "alchemy_getTokenMetadata", "alchemy_getAssetTransfers",
]);
// a page that waits reads every second or two; past these, the IP waits (the key costs money)
const PER_MIN = 600;
const PER_DAY = 20_000;
let min = "";
let day = "";
const m = new Map<string, number>();
const d = new Map<string, number>();
function over(ip: string, n: number) {
  const t = new Date().toISOString();
  if (t.slice(0, 16) !== min) (min = t.slice(0, 16)), m.clear();
  if (t.slice(0, 10) !== day) (day = t.slice(0, 10)), d.clear();
  const a = (m.get(ip) ?? 0) + n;
  const b = (d.get(ip) ?? 0) + n;
  m.set(ip, a);
  d.set(ip, b);
  return a > PER_MIN || b > PER_DAY;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ chain: string }> }) {
  const chainId = Number((await params).chain);
  const url = chainById(chainId) && upstreamRpc(chainId);
  if (!url) return NextResponse.json({ error: "chain not enabled" }, { status: 404 });
  const body = await req.text();
  if (body.length > 256_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const list = Array.isArray(j) ? j : [j];
  if (!list.length || list.length > 50 || list.some(x => !ALLOW.has(x?.method))) return NextResponse.json({ error: "not allowed" }, { status: 403 });
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
  if (over(ip, list.length)) return NextResponse.json({ error: "Too many reads. Wait a minute." }, { status: 429 });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store" });
  return new NextResponse(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
