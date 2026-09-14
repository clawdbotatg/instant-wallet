import { tokenBalance, tokenMeta } from "./chain";
import { readActivity } from "./wallet";
import { type Address, formatUnits } from "viem";
import { isBase } from "~~/utils/chain";

/**
 * Zerion (portfolio / activity / prices) when ZERION_API_KEY is set and the chain is Base;
 * otherwise the same shapes filled from local chain data so nothing upstream has to care.
 */
const KEY = process.env.ZERION_API_KEY || "";
export const zerionEnabled = () => !!KEY && isBase;

function headers() {
  return { Authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`, accept: "application/json" };
}

export type Asset = {
  blockchain: string;
  tokenName: string;
  tokenSymbol: string;
  positionType: string;
  protocol: string | null;
  balance: string;
  balanceUsd: string;
  tokenDecimals: number;
  contractAddress: string;
  thumbnail: string;
};

function mapPosition(p: any): Asset {
  const chain = p.relationships?.chain?.data?.id ?? "base";
  const info = p.attributes?.fungible_info ?? {};
  const impl = info.implementations?.find((i: any) => i.chain_id === chain);
  return {
    blockchain: chain,
    tokenName: info.name ?? "",
    tokenSymbol: info.symbol ?? "",
    positionType: p.attributes?.position_type ?? "wallet",
    protocol: p.attributes?.protocol ?? null,
    balance: String(p.attributes?.quantity?.float ?? 0),
    balanceUsd: (p.attributes?.value ?? 0).toFixed(2),
    tokenDecimals: impl?.decimals ?? 18,
    contractAddress: impl?.address ?? "",
    thumbnail: info.icon?.url ?? "",
  };
}

export async function portfolio(address: Address) {
  if (!zerionEnabled()) {
    const t = await tokenMeta();
    const bal = await tokenBalance(address);
    const asset: Asset = {
      blockchain: isBase ? "base" : "local",
      tokenName: t.symbol === "USDC" ? "USD Coin" : t.symbol,
      tokenSymbol: t.symbol,
      positionType: "wallet",
      protocol: null,
      balance: formatUnits(bal, t.decimals),
      balanceUsd: Number(formatUnits(bal, t.decimals)).toFixed(2),
      tokenDecimals: t.decimals,
      contractAddress: t.address,
      thumbnail: "",
    };
    return {
      source: "chain",
      totalBalanceUsd: asset.balanceUsd,
      assets: [asset],
      defiPositions: [] as Asset[],
      change1dUsd: "0",
      change1dPct: "0",
    };
  }
  const [walletRes, defiRes, portfolioRes] = await Promise.all([
    fetch(
      `https://api.zerion.io/v1/wallets/${address}/positions/?filter[positions]=only_simple&currency=usd&sort=-value&page[size]=100`,
      { headers: headers(), cache: "no-store" },
    ),
    fetch(
      `https://api.zerion.io/v1/wallets/${address}/positions/?filter[positions]=only_complex&currency=usd&sort=-value&page[size]=100`,
      { headers: headers(), cache: "no-store" },
    ),
    fetch(`https://api.zerion.io/v1/wallets/${address}/portfolio?currency=usd`, {
      headers: headers(),
      cache: "no-store",
    }),
  ]);
  if (!walletRes.ok) throw new Error(`Zerion ${walletRes.status}: ${await walletRes.text()}`);
  const assets: Asset[] = ((await walletRes.json()).data ?? [])
    .filter((p: any) => p.attributes?.flags?.displayable)
    .map(mapPosition);
  const defiPositions: Asset[] = defiRes.ok
    ? ((await defiRes.json()).data ?? []).filter((p: any) => p.attributes?.flags?.displayable).map(mapPosition)
    : [];
  let change1dUsd = "0";
  let change1dPct = "0";
  if (portfolioRes.ok) {
    const changes = (await portfolioRes.json())?.data?.attributes?.changes ?? {};
    change1dUsd = (changes.absolute_1d ?? 0).toFixed(2);
    change1dPct = (changes.percent_1d ?? 0).toFixed(2);
  }
  const totalBalanceUsd = assets.reduce((s, a) => s + parseFloat(a.balanceUsd), 0).toFixed(2);
  return { source: "zerion", totalBalanceUsd, assets, defiPositions, change1dUsd, change1dPct };
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
    const t = await tokenMeta();
    const local = await readActivity(address, 50);
    return {
      source: "chain",
      items: local.map(a => ({
        id: a.id,
        hash: a.txHash,
        chain: isBase ? "base" : "local",
        type: a.type,
        status: "confirmed",
        minedAt: a.timestamp ? new Date(a.timestamp * 1000).toISOString() : "",
        valueUsd: a.amount ? Number(formatUnits(BigInt(a.amount), t.decimals)) : null,
        out:
          a.type === "sent" && a.amount
            ? { symbol: t.symbol, amount: formatUnits(BigInt(a.amount), t.decimals) }
            : null,
        in:
          a.type === "received" && a.amount
            ? { symbol: t.symbol, amount: formatUnits(BigInt(a.amount), t.decimals) }
            : null,
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
