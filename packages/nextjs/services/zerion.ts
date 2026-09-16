import { readActivity } from "./wallet";
import { type Address, formatUnits } from "viem";
import { isBase } from "~~/utils/chain";

/**
 * Zerion (activity / prices) when ZERION_API_KEY is set and the chain is Base; otherwise the same
 * shapes filled from local chain data so nothing upstream has to care. Holdings live in
 * services/portfolio.ts (Alchemy first, Zerion only as a price fallback).
 */
const KEY = process.env.ZERION_API_KEY || "";
export const zerionEnabled = () => !!KEY && isBase;

function headers() {
  return { Authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`, accept: "application/json" };
}

export type ActivityRow = {
  id: string;
  hash: string;
  chain: string;
  type: string;
  status: string;
  minedAt: string;
  valueUsd: number | null;
  out: { symbol: string; amount: string } | null;
  in: { symbol: string; amount: string } | null;
};

export async function activity(address: Address): Promise<{ source: string; items: ActivityRow[] }> {
  if (!zerionEnabled()) {
    const local = await readActivity(address, 50);
    const fmt = (a: (typeof local)[number]) =>
      a.amount && a.decimals !== undefined
        ? { symbol: a.symbol ?? "?", amount: formatUnits(BigInt(a.amount), a.decimals) }
        : null;
    return {
      source: "chain",
      items: local.map(a => ({
        id: a.id,
        hash: a.txHash,
        chain: isBase ? "base" : "local",
        type: a.type,
        status: "confirmed",
        minedAt: a.timestamp ? new Date(a.timestamp * 1000).toISOString() : "",
        valueUsd: a.usd ?? null,
        out: a.type === "sent" ? fmt(a) : null,
        in: a.type === "received" ? fmt(a) : null,
      })),
    };
  }
  const res = await fetch(
    `https://api.zerion.io/v1/wallets/${address}/transactions/?currency=usd&page[size]=50&sort=-mined_at`,
    { headers: headers(), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Zerion ${res.status}`);
  const data = await res.json();
  const items: ActivityRow[] = (data.data ?? []).map((tx: any) => {
    const attrs = tx.attributes ?? {};
    const transfers = attrs.transfers ?? [];
    const o = transfers.find((t: any) => t.direction === "out");
    const i = transfers.find((t: any) => t.direction === "in");
    let valueUsd: number | null = null;
    for (const t of transfers) if (t.value != null) valueUsd = (valueUsd ?? 0) + Math.abs(Number(t.value) || 0);
    return {
      id: tx.id ?? attrs.hash,
      hash: attrs.hash ?? "",
      chain: tx.relationships?.chain?.data?.id ?? "base",
      type: attrs.operation_type ?? "unknown",
      status: attrs.status ?? "confirmed",
      minedAt: attrs.mined_at ?? "",
      valueUsd,
      out: o ? { symbol: o.fungible_info?.symbol ?? "?", amount: String(o.quantity?.float ?? 0) } : null,
      in: i ? { symbol: i.fungible_info?.symbol ?? "?", amount: String(i.quantity?.float ?? 0) } : null,
    };
  });
  return { source: "zerion", items };
}

const KNOWN: Record<string, string> = { ETH: "eth", BTC: "ee9702a0-c587-4c69-ac0c-ce820a50c95b" };

export async function price(
  symbol: string,
): Promise<{ symbol: string; price: number | null; change24h: number | null; source: string }> {
  const sym = symbol.toUpperCase();
  if (sym === "USDC" || sym === "USD") return { symbol: sym, price: 1, change24h: 0, source: "stable" };
  if (!KEY) return { symbol: sym, price: null, change24h: null, source: "none" };
  let id = KNOWN[sym];
  if (!id) {
    const s = await fetch(
      `https://api.zerion.io/v1/fungibles/?filter[search_query]=${encodeURIComponent(sym)}&page[size]=5`,
      { headers: headers(), cache: "no-store" },
    );
    if (s.ok) {
      const hit = ((await s.json()).data ?? []).find((f: any) => (f.attributes?.symbol ?? "").toUpperCase() === sym);
      id = hit?.id;
    }
  }
  if (!id) return { symbol: sym, price: null, change24h: null, source: "zerion" };
  const res = await fetch(`https://api.zerion.io/v1/fungibles/${id}?currency=usd`, {
    headers: headers(),
    cache: "no-store",
  });
  if (!res.ok) return { symbol: sym, price: null, change24h: null, source: "zerion" };
  const market = (await res.json())?.data?.attributes?.market_data;
  return {
    symbol: sym,
    price: market?.price ?? null,
    change24h: market?.changes?.percent_1d ?? null,
    source: "zerion",
  };
}
