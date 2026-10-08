import { NextRequest, NextResponse } from "next/server";
import { type Address, decodeFunctionResult, encodeFunctionData, getAddress, isAddress, parseAbi, zeroAddress } from "viem";
import { chainById } from "@/lib/chains";
import { rpc } from "@/lib/rpcServer";
import { POPULAR } from "@/lib/safe/swap";

export const dynamic = "force-dynamic";

/**
 * Token search for the swap's "To" box (docs/SWAP.md):
 *   GET /api/swap/tokens?chain=8453&q=brett   (or q=0x… for one contract)
 * Two sources: LI.FI's token list (the known ones, with decimals) and DexScreener's pair search (anything with a
 * pool, however new). Ranked by pool liquidity, so the real coin beats its copies. A token using a popular
 * symbol (USDC, ETH, …) at another address is dropped: that's a copy, never what you meant.
 */
type Found = { chainId: number; address: Address; symbol: string; name: string; decimals: number; logo?: string; priceUsd?: number; liquidityUsd?: number };

const MAX = 20;
const MIN_LIQ = 1_000;

const lists = new Map<number, { at: number; tokens: any[] }>();
async function lifiList(chainId: number): Promise<any[]> {
  const c = lists.get(chainId);
  if (c && Date.now() - c.at < 3_600_000) return c.tokens;
  const key = process.env.LIFI_API_KEY;
  const r = await fetch(`https://li.quest/v1/tokens?chains=${chainId}`, { headers: key ? { "x-lifi-api-key": key } : {}, signal: AbortSignal.timeout(8_000) });
  const tokens = r.ok ? ((await r.json()).tokens?.[chainId] ?? []) : [];
  if (tokens.length) lists.set(chainId, { at: Date.now(), tokens });
  return tokens.length ? tokens : (c?.tokens ?? []);
}

async function dexSearch(chainId: number, q: string): Promise<any[]> {
  const url = isAddress(q) ? `https://api.dexscreener.com/latest/dex/tokens/${q}` : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(6_000) });
  const j = r.ok ? await r.json() : {};
  return (j.pairs ?? []).filter((p: any) => p.chainId === chainById(chainId)?.dex);
}

const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function name() view returns (string)"]);
async function read(chainId: number, address: Address, fn: "decimals" | "symbol" | "name") {
  const data = encodeFunctionData({ abi: erc20, functionName: fn });
  const out = await rpc<`0x${string}`>(chainId, "eth_call", [{ to: address, data }, "latest"]);
  return decodeFunctionResult({ abi: erc20, functionName: fn, data: out });
}

export async function GET(req: NextRequest) {
  const chainId = Number(req.nextUrl.searchParams.get("chain"));
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  try {
    if (!chainById(chainId)) throw new Error("chain not enabled");
    if (q.length < 2) return NextResponse.json({ tokens: [] });
    const f = q.toLowerCase();
    const [list, pairs] = await Promise.all([lifiList(chainId).catch(() => []), dexSearch(chainId, q).catch(() => [])]);

    const found = new Map<string, Found>();
    const add = (t: Partial<Found> & { address: string }, liq = 0) => {
      if (!isAddress(t.address)) return;
      const k = t.address.toLowerCase();
      const had = found.get(k);
      if (had) {
        had.liquidityUsd = (had.liquidityUsd ?? 0) + liq;
        had.logo ??= t.logo;
        had.priceUsd ??= t.priceUsd;
        if (had.decimals < 0 && t.decimals !== undefined) had.decimals = t.decimals;
      } else
        found.set(k, {
          chainId,
          address: getAddress(t.address),
          symbol: t.symbol ?? "?",
          name: t.name ?? "",
          decimals: t.decimals ?? -1,
          logo: t.logo,
          priceUsd: t.priceUsd,
          liquidityUsd: liq,
        });
    };

    for (const t of list) {
      const hit = isAddress(q) ? t.address.toLowerCase() === f : t.symbol.toLowerCase().includes(f) || t.name.toLowerCase().includes(f);
      if (hit) add({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, logo: t.logoURI, priceUsd: Number(t.priceUSD) || undefined });
    }
    for (const p of pairs) {
      const liq = Number(p.liquidity?.usd) || 0;
      // the token searched for is usually the pair's base; the quote side (WETH, USDC) is only counted if it matches too
      for (const [t, price] of [
        [p.baseToken, Number(p.priceUsd) || undefined],
        [p.quoteToken, undefined],
      ] as const) {
        if (!t?.address) continue;
        const hit = isAddress(q) ? t.address.toLowerCase() === f : `${t.symbol} ${t.name}`.toLowerCase().includes(f);
        if (hit) add({ address: t.address, symbol: t.symbol, name: t.name, logo: t === p.baseToken ? p.info?.imageUrl : undefined, priceUsd: price }, liq);
      }
    }

    if (isAddress(q) && !found.size) add({ address: q }); // no pool anywhere: the chain still knows what it is

    // copies of the well-known tokens out; the native ETH placeholder too (the popular list has it)
    const popular = POPULAR[chainId] ?? [];
    const copy = (t: Found) => popular.some(p => p.symbol.toLowerCase() === t.symbol.toLowerCase() && p.address.toLowerCase() !== t.address.toLowerCase());
    const known = new Set(list.map((t: any) => t.address.toLowerCase()));
    let tokens = [...found.values()]
      .filter(t => t.address !== zeroAddress && !copy(t))
      .filter(t => known.has(t.address.toLowerCase()) || (t.liquidityUsd ?? 0) >= MIN_LIQ || isAddress(q))
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, MAX);

    // DexScreener doesn't say decimals (or anything, for an address with no pool): ask the chain
    tokens = (
      await Promise.all(
        tokens.map(async t => {
          if (t.decimals >= 0 && t.symbol !== "?") return t;
          try {
            const [decimals, symbol, name] = await Promise.all([read(chainId, t.address, "decimals"), t.symbol !== "?" ? t.symbol : read(chainId, t.address, "symbol"), t.name || read(chainId, t.address, "name").catch(() => "")]);
            return { ...t, decimals: Number(decimals), symbol: String(symbol), name: String(name) };
          } catch {
            return null; // not an ERC-20
          }
        }),
      )
    ).filter((t): t is Found => !!t);
    return NextResponse.json({ tokens }, { headers: { "cache-control": "public, max-age=30" } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
