import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { CHAINS } from "@/lib/chains";
import type { Position } from "@/lib/types";

export const dynamic = "force-dynamic";

// Zerion's chain names for ours
const ZERION: Record<number, string> = {
  8453: "base",
  1: "ethereum",
  42161: "arbitrum",
  10: "optimism",
  4663: "robinhood",
  137: "polygon",
  43114: "avalanche",
  56: "binance-smart-chain",
  100: "xdai",
  42220: "celo",
  146: "sonic",
  999: "hyperevm",
  9745: "plasma",
  5042: "arc",
};

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; v: Position[] }>();

/**
 * `GET /api/positions?address=0x…` — DeFi positions (pools, vaults, stakes, loans) on our chains, from Zerion,
 * one row per position with its tokens summed. Empty without ZERION_API_KEY. `&fresh=1` skips the 60 s cache (after a move).
 */
export async function GET(req: NextRequest) {
  const a = req.nextUrl.searchParams.get("address");
  if (!a || !isAddress(a)) return NextResponse.json({ error: "address required" }, { status: 400 });
  const wallet = getAddress(a);
  const key = process.env.ZERION_API_KEY;
  if (!key) return NextResponse.json({ positions: [] });
  const hit = cache.get(wallet);
  if (hit && Date.now() - hit.at < CACHE_MS && !req.nextUrl.searchParams.get("fresh")) return NextResponse.json({ positions: hit.v });
  const byZerion = new Map(CHAINS.filter(c => ZERION[c.id]).map(c => [ZERION[c.id], c.id]));
  const q = new URLSearchParams({
    "filter[positions]": "only_complex",
    "filter[trash]": "only_non_trash",
    "filter[chain_ids]": [...byZerion.keys()].join(","),
    currency: "usd",
    sort: "value",
  });
  const r = await fetch(`https://api.zerion.io/v1/wallets/${wallet}/positions/?${q}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const j = r?.ok ? await r.json().catch(() => null) : null;
  if (!j?.data) return NextResponse.json({ error: "Zerion didn't answer" }, { status: 502 });
  const groups = new Map<string, Position & { top: number }>();
  for (const x of j.data) {
    const at = x.attributes ?? {};
    const chainId = byZerion.get(x.relationships?.chain?.data?.id);
    if (!chainId || !at.flags?.displayable) continue;
    const v = Number(at.value) || 0;
    const usd = at.position_type === "loan" ? -v : v;
    const id = at.group_id || x.id;
    const g = groups.get(id);
    const sym = at.fungible_info?.symbol;
    // the token held for it (aBasUSDC for an Aave deposit), on this chain
    const receipt: string | undefined = at.receipt?.fungible_info?.implementations
      ?.find((i: { chain_id?: string; address?: string }) => i.chain_id === x.relationships?.chain?.data?.id)
      ?.address?.toLowerCase();
    if (g) {
      g.usd += usd;
      if (sym && !g.tokens.includes(sym)) g.tokens.push(sym);
      if (receipt && !g.receipts!.includes(receipt)) g.receipts!.push(receipt);
      if (v > g.top) Object.assign(g, { top: v, type: at.position_type });
    } else
      groups.set(id, {
        id,
        chainId,
        name: at.name || at.protocol || "Position",
        protocol: at.protocol || "",
        type: at.position_type || "",
        usd,
        tokens: sym ? [sym] : [],
        receipts: receipt ? [receipt] : [],
        icon: at.application_metadata?.icon?.url,
        url: at.application_metadata?.url,
        top: v,
      });
  }
  const positions: Position[] = [...groups.values()]
    .map(({ top, ...p }) => p)
    .filter(p => Math.abs(p.usd) >= 1) // dust rewards and leftovers
    .sort((x, y) => y.usd - x.usd);
  cache.set(wallet, { at: Date.now(), v: positions });
  return NextResponse.json({ positions });
}
