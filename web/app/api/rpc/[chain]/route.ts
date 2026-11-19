import { rpcCheck } from "@/lib/rpcWatch";
import { NextRequest, NextResponse } from "next/server";
import { upstreamRpc } from "@/lib/rpcServer";
import { chainById } from "@/lib/chains";
import { indexerTokenMeta, indexerTransfers } from "@/lib/indexer";
import { noExternal } from "@/lib/noext";

export const dynamic = "force-dynamic";

/**
 * JSON-RPC passthrough for the enabled chains, so the RPC key stays on the server. Not an open relay on our Alchemy key
 * (as wedgie.dev's api/rpc.ts): only the reads (and gas/fee asks, and signed txs: a claim card or old key pays its own gas) the wallet makes, single or
 * batched, with per-IP limits (lib/rpcWatch.ts).
 */
const ALLOW = new Set([
  "eth_call", "eth_getCode", "eth_getBalance", "eth_getStorageAt", "eth_getLogs", "eth_blockNumber", "eth_chainId",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getTransactionCount",
  "eth_estimateGas", "eth_gasPrice", "eth_sendRawTransaction", "eth_maxPriorityFeePerGas", "eth_feeHistory", "net_version",
  "eth_getProof", "eth_createAccessList", // the light client (lib/safe/light.ts): the proofs it checks
  "alchemy_getTokenBalances", "alchemy_getTokenMetadata", "alchemy_getAssetTransfers",
]);
// per IP per minute, hour and day, and the site watched: lib/rpcWatch.ts. Plus a few seconds' memory of the reads
// every page asks again and again, so a rush of people doesn't mean a rush of Alchemy calls.
const SHORT: Record<string, number> = { eth_chainId: 3600_000, net_version: 3600_000, eth_blockNumber: 2000, eth_gasPrice: 4000, eth_maxPriorityFeePerGas: 4000 };
const recent = new Map<string, { at: number; text: string }>();

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
  const no = await rpcCheck(req, list.map(x => x.method));
  if (no) return NextResponse.json({ error: no }, { status: 429 });
  const ttl = !Array.isArray(j) ? SHORT[j.method] : undefined;
  const ck = `${chainId}:${j.method}`;
  const hit = ttl ? recent.get(ck) : undefined;
  if (hit && Date.now() - hit.at < ttl!) return new NextResponse(hit.text.replace(/^\{"jsonrpc":"2.0","id":[^,]*,/, `{"jsonrpc":"2.0","id":${JSON.stringify(j.id ?? null)},`), { headers: { "content-type": "application/json" } });
  // the local copy with your indexer: what it can answer (token moves; ETH moves from an archive node of your own)
  // comes from it, only the rest from the node
  // (Settings → No external traffic: only what it answers; your node knows no alchemy_ method)
  const shut = !!noExternal();
  if (shut && !Array.isArray(j) && j.method === "alchemy_getTokenMetadata") {
    const m = await indexerTokenMeta(chainId, String(j.params?.[0] ?? "")).catch(() => null);
    return NextResponse.json(m ? { jsonrpc: "2.0", id: j.id ?? null, result: m } : { jsonrpc: "2.0", id: j.id ?? null, error: { code: -32000, message: "Your indexer doesn't know this coin." } });
  }
  if (!Array.isArray(j) && j.method === "alchemy_getAssetTransfers") {
    const p = j.params?.[0] ?? {};
    const cats: string[] = Array.isArray(p.category) ? p.category : [];
    const ix = (await indexerTransfers(chainId, p).catch(() => null)) ?? (shut ? { transfers: [], done: cats } : null);
    if (ix) {
      const rest = shut ? [] : cats.filter(c => !ix.done.includes(c));
      let more: any[] = [];
      if (rest.length) {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: j.id ?? null, method: j.method, params: [{ ...p, category: rest }] }), cache: "no-store", signal: AbortSignal.timeout(15_000) })
          .then(r => r.json())
          .catch(() => null);
        if (!r?.result) return NextResponse.json(r ?? { error: "The network didn't answer." }, { status: r ? 200 : 504 });
        more = r.result.transfers ?? [];
      }
      const up = p.order === "asc" ? 1 : -1;
      const transfers = [...more, ...ix.transfers].sort((a, b) => up * (Number(a.blockNum) - Number(b.blockNum))).slice(0, Number(p.maxCount ?? "0x3e8"));
      return NextResponse.json({ jsonrpc: "2.0", id: j.id, result: { transfers } });
    }
  }
  // what was checked is what goes: rebuilt, never the raw text ({"method":"eth_call","method":"x"} parses to one
  // method here and maybe the other upstream: audit 11-13, IW-5)
  const clean = list.map(x => ({ jsonrpc: "2.0", id: x.id ?? null, method: x.method, params: Array.isArray(x.params) ? x.params : [] }));
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Array.isArray(j) ? clean : clean[0]), cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) return NextResponse.json({ error: "The network didn't answer." }, { status: 504 });
  const text = await res.text();
  if (ttl && res.ok && /"result"/.test(text)) {
    const r = JSON.parse(text);
    if (r?.result !== undefined && !r.error) recent.set(ck, { at: Date.now(), text: JSON.stringify({ jsonrpc: "2.0", id: null, result: r.result }) });
  }
  return new NextResponse(text, { status: res.status, headers: { "content-type": "application/json" } });
}
