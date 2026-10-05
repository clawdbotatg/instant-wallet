import { NextRequest, NextResponse } from "next/server";
import { type Address, createPublicClient, erc20Abi, formatUnits, getAddress, http, isAddress } from "viem";
import { CHAINS, ETH, chainById } from "@/lib/chains";
import { alchemyNetwork, rpc, upstreamRpc } from "@/lib/rpcServer";
import type { Asset, Portfolio } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * `GET /api/portfolio?address=0x…` — ETH + every ERC-20 with a balance, on every enabled chain, with USD.
 * Base / Ethereum: Alchemy token balances + metadata + Prices API; DexScreener fills the long tail Alchemy has no logo
 * or price for (most small Base tokens). Local: ETH + LOCAL_TOKENS / NEXT_PUBLIC_LOCAL_TOKENS (also on a
 * fork of a real chain when LOCAL_TOKENS_ONLY is set, since Alchemy only sees the real chain).
 */
export async function GET(req: NextRequest) {
  const a = req.nextUrl.searchParams.get("address");
  if (!a || !isAddress(a)) return NextResponse.json({ error: "address required" }, { status: 400 });
  const wallet = getAddress(a);
  const perChain = await Promise.all(CHAINS.map(c => chainAssets(c.id, wallet).catch(() => [] as Asset[])));
  const assets = perChain.flat();
  await price(assets);
  assets.sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1) || Number(y.formatted) - Number(x.formatted));
  const priced = assets.filter(x => x.usd !== null);
  const body: Portfolio = {
    totalUsd: priced.length ? priced.reduce((s, x) => s + (x.usd ?? 0), 0) : null,
    assets,
  };
  return NextResponse.json(body);
}

type Meta = { decimals: number | null; logo: string | null; name: string | null; symbol: string | null };
const metaCache = new Map<string, Meta>();

function row(chainId: number, asset: Address, symbol: string, name: string, decimals: number, balance: bigint, logo?: string): Asset {
  return {
    chainId,
    asset,
    symbol,
    name,
    decimals,
    balance: balance.toString(),
    formatted: formatUnits(balance, decimals),
    price: null,
    usd: null,
    logo,
  };
}

async function chainAssets(chainId: number, wallet: Address): Promise<Asset[]> {
  const client = createPublicClient({ chain: chainById(chainId)!.chain, transport: http(upstreamRpc(chainId)) });
  const eth = await client.getBalance({ address: wallet });
  const out: Asset[] = [row(chainId, ETH, "ETH", "Ether", 18, eth)];
  if (!alchemyNetwork(chainId) || process.env.LOCAL_TOKENS_ONLY) {
    const local = (process.env.LOCAL_TOKENS || process.env.NEXT_PUBLIC_LOCAL_TOKENS || "").split(",").filter(x => isAddress(x)) as Address[];
    for (const t of local) {
      const [bal, symbol, decimals] = await Promise.all([
        client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
        client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }),
      ]);
      out.push(row(chainId, getAddress(t), symbol, symbol, decimals, bal));
    }
    return out;
  }
  const tb = await rpc<{ tokenBalances: { contractAddress: Address; tokenBalance: string | null }[] }>(
    chainId,
    "alchemy_getTokenBalances",
    [wallet, "erc20"],
  ).catch(() => ({ tokenBalances: [] }));
  const held = tb.tokenBalances
    .map(t => ({ address: getAddress(t.contractAddress), balance: t.tokenBalance ? BigInt(t.tokenBalance) : 0n }))
    .filter(t => t.balance > 0n)
    .slice(0, 60);
  const metas = await Promise.all(
    held.map(async t => {
      const k = `${chainId}:${t.address}`;
      if (!metaCache.has(k))
        metaCache.set(
          k,
          await rpc<Meta>(chainId, "alchemy_getTokenMetadata", [t.address]).catch(() => ({
            decimals: null,
            logo: null,
            name: null,
            symbol: null,
          })),
        );
      return metaCache.get(k)!;
    }),
  );
  const dex = await dexscreener(chainId, held.filter((_, i) => !metas[i].logo).map(t => t.address));
  held.forEach((t, i) => {
    const m = metas[i];
    if (!m.symbol || m.decimals === null) return; // unreadable, usually spam
    out.push(row(chainId, t.address, m.symbol, m.name ?? m.symbol, m.decimals, t.balance, m.logo ?? dex.get(t.address.toLowerCase())?.image));
  });
  return out;
}

const PRICE_MS = 60_000;
const priceCache = new Map<string, { at: number; v: number | null }>();

async function price(assets: Asset[]) {
  const key = process.env.ALCHEMY_API_KEY;
  const todo: Asset[] = [];
  for (const a of assets) {
    if (/^(USDC|USDT|DAI|USDBC|USDS|PYUSD)$/i.test(a.symbol)) a.price = 1;
    else {
      const hit = priceCache.get(`${a.chainId}:${a.asset}`);
      if (hit && Date.now() - hit.at < PRICE_MS) a.price = hit.v;
      else todo.push(a);
    }
  }
  if (key && todo.length) {
    try {
      const ethP = todo.some(a => a.asset === ETH)
        ? await fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-symbol?symbols=ETH`, { cache: "no-store" })
            .then(r => r.json())
            .then(j => Number(j?.data?.[0]?.prices?.find((p: any) => p.currency === "usd")?.value))
        : NaN;
      const toks = todo.filter(a => a.asset !== ETH && alchemyNetwork(a.chainId)).slice(0, 25);
      const byAddr = new Map<string, number>();
      if (toks.length) {
        const j = await fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-address`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ addresses: toks.map(a => ({ network: alchemyNetwork(a.chainId), address: a.asset })) }),
          cache: "no-store",
        }).then(r => r.json());
        for (const d of j?.data ?? []) {
          const v = Number(d?.prices?.find((p: any) => p.currency === "usd")?.value);
          if (Number.isFinite(v)) byAddr.set(`${d.network}:${String(d.address).toLowerCase()}`, v);
        }
      }
      for (const a of todo) {
        const v =
          a.asset === ETH
            ? Number.isFinite(ethP) ? ethP : null
            : byAddr.get(`${alchemyNetwork(a.chainId)}:${a.asset.toLowerCase()}`) ?? null;
        a.price = v;
        priceCache.set(`${a.chainId}:${a.asset}`, { at: Date.now(), v });
      }
    } catch {
      // no prices this round
    }
  }
  // long tail: DexScreener's most liquid pair
  const missing = assets.filter(a => a.price === null && a.asset !== ETH && alchemyNetwork(a.chainId));
  for (const chainId of new Set(missing.map(a => a.chainId))) {
    const dex = await dexscreener(chainId, missing.filter(a => a.chainId === chainId).map(a => a.asset));
    for (const a of missing.filter(x => x.chainId === chainId)) {
      const v = dex.get(a.asset.toLowerCase())?.priceUsd ?? null;
      a.price = v;
      priceCache.set(`${a.chainId}:${a.asset}`, { at: Date.now(), v });
    }
  }
  for (const a of assets) a.usd = a.price === null ? null : Number(a.formatted) * a.price;
}

const DEX_CHAIN: Record<number, string> = { 8453: "base", 1: "ethereum" };
const DEX_MS = 5 * 60_000;
const dexCache = new Map<string, { at: number; v: { image?: string; priceUsd: number | null } | null }>();

/** DexScreener token info (logo + USD price of the most liquid pair), 30 tokens per request, cached 5 min. */
async function dexscreener(chainId: number, tokens: Address[]): Promise<Map<string, { image?: string; priceUsd: number | null }>> {
  const out = new Map<string, { image?: string; priceUsd: number | null }>();
  const slug = DEX_CHAIN[chainId];
  if (!slug) return out;
  const todo: string[] = [];
  for (const t of tokens.map(x => x.toLowerCase())) {
    const hit = dexCache.get(`${chainId}:${t}`);
    if (hit && Date.now() - hit.at < DEX_MS) {
      if (hit.v) out.set(t, hit.v);
    } else todo.push(t);
  }
  for (let i = 0; i < todo.length; i += 30) {
    const batch = todo.slice(i, i + 30);
    const pairs: any[] = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${batch.join(",")}`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : []))
      .catch(() => []);
    for (const t of batch) {
      const mine = (Array.isArray(pairs) ? pairs : [])
        .filter(p => String(p?.baseToken?.address).toLowerCase() === t)
        .sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
      const price = Number(mine[0]?.priceUsd);
      const v = mine.length
        ? { image: mine.find(p => p?.info?.imageUrl)?.info.imageUrl as string | undefined, priceUsd: Number.isFinite(price) ? price : null }
        : null;
      dexCache.set(`${chainId}:${t}`, { at: Date.now(), v });
      if (v) out.set(t, v);
    }
  }
  return out;
}
