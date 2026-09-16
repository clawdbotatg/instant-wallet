import { type AssetMeta, assetBalance, assetMeta, localUsdc, publicClient, rpcUrl } from "./chain";
import { price as zerionPrice } from "./zerion";
import { type Address, formatUnits, getAddress } from "viem";
import { ETH_META, alchemyNetwork, isLocal } from "~~/utils/chain";
import { ETH_ASSET, isEth } from "~~/utils/digests";

/**
 * Everything the wallet holds: ETH plus every ERC-20 with a nonzero balance, with USD values when a
 * price source is reachable.
 *
 *  - Base / Ethereum: Alchemy `alchemy_getTokenBalances` + `alchemy_getTokenMetadata` (the same key as the
 *    RPC), USD from Alchemy's Prices API, else Zerion (ZERION_API_KEY), else no USD.
 *  - localhost: ETH + the MockUSDC from deployedContracts (USDC = $1; ETH priced via Zerion if a key is set).
 *
 * Cached briefly per wallet: the UI polls every 5 s and the device every 12 s.
 */

export type PortfolioAsset = {
  asset: Address; // 0x000…0 = ETH
  symbol: string;
  name: string;
  decimals: number;
  balance: string; // base units
  balanceFormatted: string;
  price: number | null;
  usd: number | null;
  logo?: string;
};

export type Portfolio = {
  source: "chain" | "alchemy";
  totalUsd: number | null;
  assets: PortfolioAsset[];
};

const CACHE_MS = Number(process.env.PORTFOLIO_CACHE_MS || 8000);
const cache = new Map<string, { at: number; value: Portfolio }>();
const ALCHEMY_KEY = () => process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "";

export async function portfolio(wallet: Address): Promise<Portfolio> {
  const k = wallet.toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = alchemyNetwork && ALCHEMY_KEY() ? await fromAlchemy(wallet) : await fromChain(wallet);
  cache.set(k, { at: Date.now(), value });
  return value;
}

/** Forget the cached view (after a transfer we relayed ourselves). */
export function invalidatePortfolio(wallet: Address) {
  cache.delete(wallet.toLowerCase());
}

function row(
  meta: AssetMeta & { name?: string; logo?: string },
  balance: bigint,
  price: number | null,
): PortfolioAsset {
  const balanceFormatted = formatUnits(balance, meta.decimals);
  return {
    asset: meta.address,
    symbol: meta.symbol,
    name: meta.name ?? meta.symbol,
    decimals: meta.decimals,
    balance: balance.toString(),
    balanceFormatted,
    price,
    usd: price === null ? null : Number(balanceFormatted) * price,
    logo: meta.logo,
  };
}

function finish(source: Portfolio["source"], assets: PortfolioAsset[]): Portfolio {
  assets.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || Number(b.balanceFormatted) - Number(a.balanceFormatted));
  const priced = assets.filter(a => a.usd !== null);
  return { source, totalUsd: priced.length ? priced.reduce((s, a) => s + (a.usd ?? 0), 0) : null, assets };
}

// ---------------------------------------------------------------- local / plain RPC
async function fromChain(wallet: Address): Promise<Portfolio> {
  const candidates: AssetMeta[] = [ETH_META, ...(localUsdc ? [localUsdc] : [])];
  const balances = await Promise.all(candidates.map(m => assetBalance(wallet, m.address)));
  const prices = await pricesFor(candidates.map(m => ({ asset: m.address, symbol: m.symbol })));
  const assets = candidates
    .map((m, i) => row(m, balances[i], prices[i]))
    // ETH always shows; on the local chain MockUSDC always shows too (it is the thing you can mint)
    .filter((a, i) => i === 0 || isLocal || BigInt(a.balance) > 0n);
  return finish("chain", assets);
}

// ---------------------------------------------------------------- alchemy
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

type AlchemyMeta = { decimals: number | null; logo: string | null; name: string | null; symbol: string | null };
const metaCache = new Map<string, AlchemyMeta>();
async function tokenMetadata(address: Address): Promise<AlchemyMeta> {
  const k = address.toLowerCase();
  const hit = metaCache.get(k);
  if (hit) return hit;
  const m = await rpc<AlchemyMeta>("alchemy_getTokenMetadata", [address]).catch(() => ({
    decimals: null,
    logo: null,
    name: null,
    symbol: null,
  }));
  metaCache.set(k, m);
  return m;
}

async function fromAlchemy(wallet: Address): Promise<Portfolio> {
  const [eth, tb] = await Promise.all([
    publicClient().getBalance({ address: wallet }),
    rpc<{ tokenBalances: { contractAddress: Address; tokenBalance: string | null }[] }>("alchemy_getTokenBalances", [
      wallet,
      "erc20",
    ]).catch(() => ({ tokenBalances: [] })),
  ]);
  const held = tb.tokenBalances
    .map(t => ({ address: getAddress(t.contractAddress), balance: t.tokenBalance ? BigInt(t.tokenBalance) : 0n }))
    .filter(t => t.balance > 0n)
    .slice(0, 80);
  const metas = await Promise.all(held.map(t => tokenMetadata(t.address)));
  const tokens = held
    .map((t, i) => ({ ...t, meta: metas[i] }))
    // no symbol or no decimals = unreadable (usually spam); skip
    .filter(t => t.meta.symbol && t.meta.decimals !== null);
  const list = [
    { asset: ETH_ASSET as Address, symbol: "ETH" },
    ...tokens.map(t => ({ asset: t.address, symbol: t.meta.symbol as string })),
  ];
  const prices = await pricesFor(list);
  const assets: PortfolioAsset[] = [
    row(ETH_META, eth, prices[0]),
    ...tokens.map((t, i) =>
      row(
        {
          address: t.address,
          symbol: t.meta.symbol as string,
          decimals: Number(t.meta.decimals),
          name: t.meta.name ?? undefined,
          logo: t.meta.logo ?? undefined,
        },
        t.balance,
        prices[i + 1],
      ),
    ),
  ];
  return finish("alchemy", assets);
}

// ---------------------------------------------------------------- prices
const PRICE_MS = 60_000;
const priceCache = new Map<string, { at: number; value: number | null }>();

/** USD price per asset, same order as `list`; Alchemy Prices API -> Zerion -> null. Stablecoins = 1. */
export async function pricesFor(list: { asset: Address; symbol: string }[]): Promise<(number | null)[]> {
  const out: (number | null)[] = list.map(() => null);
  const todo: number[] = [];
  list.forEach((a, i) => {
    if (/^(USDC|USDT|DAI|USDBC|USDS)$/i.test(a.symbol)) return void (out[i] = 1);
    const hit = priceCache.get(a.asset.toLowerCase());
    if (hit && Date.now() - hit.at < PRICE_MS) out[i] = hit.value;
    else todo.push(i);
  });
  if (!todo.length) return out;

  const found = new Map<number, number>();
  if (alchemyNetwork && ALCHEMY_KEY()) {
    try {
      const key = ALCHEMY_KEY();
      const ethIdx = todo.filter(i => isEth(list[i].asset));
      const tokIdx = todo.filter(i => !isEth(list[i].asset)).slice(0, 25);
      const reqs: Promise<void>[] = [];
      if (ethIdx.length)
        reqs.push(
          fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-symbol?symbols=ETH`, { cache: "no-store" })
            .then(r => (r.ok ? r.json() : null))
            .then(j => {
              const v = Number(j?.data?.[0]?.prices?.find((p: any) => p.currency === "usd")?.value);
              if (Number.isFinite(v)) for (const i of ethIdx) found.set(i, v);
            }),
        );
      if (tokIdx.length)
        reqs.push(
          fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-address`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ addresses: tokIdx.map(i => ({ network: alchemyNetwork, address: list[i].asset })) }),
            cache: "no-store",
          })
            .then(r => (r.ok ? r.json() : null))
            .then(j => {
              for (const d of j?.data ?? []) {
                const v = Number(d?.prices?.find((p: any) => p.currency === "usd")?.value);
                const i = tokIdx.find(x => list[x].asset.toLowerCase() === String(d.address).toLowerCase());
                if (i !== undefined && Number.isFinite(v)) found.set(i, v);
              }
            }),
        );
      await Promise.all(reqs);
    } catch {
      // fall through to Zerion
    }
  }
  if (process.env.ZERION_API_KEY) {
    const missing = todo.filter(i => !found.has(i)).slice(0, 10);
    await Promise.all(
      missing.map(async i => {
        const p = await zerionPrice(list[i].symbol).catch(() => null);
        if (p && p.price !== null) found.set(i, p.price);
      }),
    );
  }
  for (const i of todo) {
    const v = found.get(i) ?? null;
    out[i] = v;
    priceCache.set(list[i].asset.toLowerCase(), { at: Date.now(), value: v });
  }
  return out;
}

/** One asset's meta + price (for activity rows and request hints). */
export async function assetInfo(asset: Address): Promise<AssetMeta & { price: number | null }> {
  const m = await assetMeta(asset);
  const [p] = await pricesFor([{ asset: m.address, symbol: m.symbol }]);
  return { ...m, price: p };
}
