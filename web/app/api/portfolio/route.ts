import { NextRequest, NextResponse, after } from "next/server";
import { type Address, createPublicClient, erc20Abi, formatUnits, getAddress, http, isAddress } from "viem";
import { CHAINS, ETH, chainById } from "@/lib/chains";
import { alchemyNetwork, rpc, upstreamRpc } from "@/lib/rpcServer";
import type { Asset, Portfolio } from "@/lib/types";
import { POPULAR } from "@/lib/safe/swap";

/** The well-known tokens per chain (Swap's list), lowercase: read first, so spam can't push them out. */
const known = (chainId: number) => new Set((POPULAR[chainId] ?? []).map(t => t.address.toLowerCase()));
const STABLE = /^(USDC|USDT|DAI|USDBC|USDS|PYUSD)$/i;

export const dynamic = "force-dynamic";

/**
 * `GET /api/portfolio?address=0x…` — the native coin + every ERC-20 with a balance, on every enabled chain, with USD.
 * Alchemy token balances + metadata + Prices API; DexScreener fills the long tail Alchemy has no logo
 * or price for (most small Base tokens). Local: ETH + LOCAL_TOKENS / NEXT_PUBLIC_LOCAL_TOKENS (also on a
 * fork of a real chain when LOCAL_TOKENS_ONLY is set, since Alchemy only sees the real chain).
 */
export async function GET(req: NextRequest) {
  const a = req.nextUrl.searchParams.get("address");
  if (!a || !isAddress(a)) return NextResponse.json({ error: "address required" }, { status: 400 });
  const wallet = getAddress(a);
  // a slow chain shows nothing this round rather than holding up the other thirteen
  // (it keeps running after the reply, so its scan is cached for the next poll; `late` tells the page to keep its last rows)
  const LATE = Symbol();
  const timer = () => new Promise<typeof LATE>(r => setTimeout(() => r(LATE), 6_000));
  const work = CHAINS.map(c => chainAssets(c.id, wallet).catch(() => [] as Asset[]));
  after(Promise.allSettled(work));
  const perChain = await Promise.all(work.map(w => Promise.race([w, timer()])));
  const late = CHAINS.filter((_, i) => perChain[i] === LATE).map(c => c.id);
  const assets = perChain.flatMap(x => (x === LATE ? [] : x));
  await price(assets);
  assets.sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1) || Number(y.formatted) - Number(x.formatted));
  const priced = assets.filter(x => x.usd !== null);
  const body: Portfolio = {
    totalUsd: priced.length ? priced.reduce((s, x) => s + (x.usd ?? 0), 0) : null,
    assets,
    ...(late.length ? { late } : {}),
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
  const info = chainById(chainId)!;
  const eth = await client.getBalance({ address: wallet });
  // Arc's native balance is its USDC token's balance again: list it once, as the token
  const out: Asset[] = info.nativeIsUsdc ? [] : [row(chainId, ETH, info.native.symbol, info.native.name, 18, eth, info.native.logo)];
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
  const held = await heldTokens(chainId, wallet);
  // 25 at a time: a thousand at once gets rate-limited. A failed read isn't cached (it would hide a real coin for good).
  const metas = await pool(held, 25, async t => {
    const k = `${chainId}:${t.address}`;
    const hit = metaCache.get(k);
    if (hit) return hit;
    const m = await rpc<Meta>(chainId, "alchemy_getTokenMetadata", [t.address]).catch(() => null);
    if (m) metaCache.set(k, m);
    return m ?? { decimals: null, logo: null, name: null, symbol: null };
  });
  const dex = await dexscreener(chainId, held.filter((_, i) => !metas[i].logo).map(t => t.address));
  held.forEach((t, i) => {
    const m = metas[i];
    if (!m.symbol || m.decimals === null) return; // unreadable, usually spam
    out.push(row(chainId, t.address, m.symbol, m.name ?? m.symbol, m.decimals, t.balance, m.logo ?? dex.get(t.address.toLowerCase())?.image));
  });
  return out;
}

/** `fn` over `items`, at most `n` at once, results in order. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const SCAN_MS = 5 * 60_000;
const scans = new Map<string, { at: number; tokens: Address[]; busy?: boolean }>();

/** Every ERC-20 the wallet holds: all of Alchemy's pages (100 each). */
async function fullScan(chainId: number, wallet: Address) {
  const all: { contractAddress: Address; tokenBalance: string | null }[] = [];
  let pageKey: string | undefined;
  let pages = 0;
  for (; pages < 30; pages++) {
    const tb = await rpc<{ tokenBalances: typeof all; pageKey?: string }>(chainId, "alchemy_getTokenBalances", [wallet, "erc20", ...(pageKey ? [{ pageKey }] : [])]);
    all.push(...tb.tokenBalances);
    if (!(pageKey = tb.pageKey)) break;
  }
  const held = all.map(t => ({ address: getAddress(t.contractAddress), balance: t.tokenBalance ? BigInt(t.tokenBalance) : 0n })).filter(t => t.balance > 0n);
  // a one-page wallet (nearly everyone) just scans again on every poll; a big one is cached
  if (pages > 0) scans.set(`${chainId}:${wallet}`, { at: Date.now(), tokens: held.map(t => t.address) });
  return held;
}

/**
 * The wallet's tokens with a balance, all of them: any cap cuts real coins once spam outnumbers it (atg.eth's FOLD was
 * #157 of 278 on Ethereum; it holds 1,061 on Base). A wallet with more than one page is scanned in full every 5 min
 * (15 pages = 7 s); polls in between re-read just those tokens + the well-known ones, 100 per call, in parallel.
 */
async function heldTokens(chainId: number, wallet: Address): Promise<{ address: Address; balance: bigint }[]> {
  const s = scans.get(`${chainId}:${wallet}`);
  if (!s) return fullScan(chainId, wallet);
  if (Date.now() - s.at > SCAN_MS && !s.busy) {
    s.busy = true;
    after(fullScan(chainId, wallet).catch(() => void (s.busy = false)));
  }
  const list = [...new Set([...s.tokens, ...[...known(chainId)].filter(a => a !== ETH.toLowerCase()).map(a => getAddress(a))])];
  const chunks = Array.from({ length: Math.ceil(list.length / 100) }, (_, i) => list.slice(i * 100, i * 100 + 100));
  const res = await Promise.all(chunks.map(c => rpc<{ tokenBalances: { contractAddress: Address; tokenBalance: string | null }[] }>(chainId, "alchemy_getTokenBalances", [wallet, c])));
  return res
    .flatMap(r => r.tokenBalances)
    .map(t => ({ address: getAddress(t.contractAddress), balance: t.tokenBalance ? BigInt(t.tokenBalance) : 0n }))
    .filter(t => t.balance > 0n);
}

const PRICE_MS = 60_000;
const NO_PRICE_MS = 30 * 60_000; // spam has no price; don't ask again every minute
const priceCache = new Map<string, { at: number; v: number | null }>();

async function price(assets: Asset[]) {
  const key = process.env.ALCHEMY_API_KEY;
  const todo: Asset[] = [];
  for (const a of assets) {
    // $1 only for the real USDC: on BNB or Polygon anyone can mint a token called USDT
    // (by address: any token can call itself USDT, and one priced at $1 made a wallet worth $55B)
    if (a.asset.toLowerCase() === chainById(a.chainId)?.usdc?.toLowerCase() || (STABLE.test(a.symbol) && known(a.chainId).has(a.asset.toLowerCase()))) a.price = 1;
    else {
      const hit = priceCache.get(`${a.chainId}:${a.asset}`);
      if (hit && Date.now() - hit.at < (hit.v === null ? NO_PRICE_MS : PRICE_MS)) a.price = hit.v;
      else todo.push(a);
    }
  }
  if (key && todo.length) {
    try {
      // native coins by symbol (ETH, POL, BNB, …)
      const syms = [...new Set(todo.filter(a => a.asset === ETH).map(a => a.symbol))];
      const nativeP = new Map<string, number>();
      if (syms.length) {
        const j = await fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-symbol?${syms.map(s => `symbols=${s}`).join("&")}`, { cache: "no-store" }).then(r => r.json());
        for (const d of j?.data ?? []) {
          const v = Number(d?.prices?.find((p: any) => p.currency === "usd")?.value);
          if (Number.isFinite(v)) nativeP.set(String(d.symbol).toUpperCase(), v);
        }
      }
      // Alchemy takes 25 per request
      const toks = todo.filter(a => a.asset !== ETH && alchemyNetwork(a.chainId));
      const byAddr = new Map<string, number>();
      const answered = new Set<string>(); // a failed request isn't "no price": don't cache it
      await pool(
        Array.from({ length: Math.ceil(toks.length / 25) }, (_, i) => i),
        5,
        async i => {
          const j = await fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-address`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ addresses: toks.slice(i * 25, i * 25 + 25).map(a => ({ network: alchemyNetwork(a.chainId), address: a.asset })) }),
            cache: "no-store",
          })
            .then(r => r.json())
            .catch(() => null);
          for (const d of j?.data ?? []) {
            answered.add(`${d.network}:${String(d.address).toLowerCase()}`);
            const v = Number(d?.prices?.find((p: any) => p.currency === "usd")?.value);
            if (Number.isFinite(v)) byAddr.set(`${d.network}:${String(d.address).toLowerCase()}`, v);
          }
        },
      );
      for (const a of todo) {
        const k = `${alchemyNetwork(a.chainId)}:${a.asset.toLowerCase()}`;
        const v = a.asset === ETH ? nativeP.get(a.symbol.toUpperCase()) ?? null : byAddr.get(k) ?? null;
        a.price = v;
        if (v !== null || answered.has(k)) priceCache.set(`${a.chainId}:${a.asset}`, { at: Date.now(), v });
      }
    } catch {
      // no prices this round
    }
  }
  // long tail: DexScreener's most liquid pair
  const missing = assets.filter(a => a.price === null && a.asset !== ETH && alchemyNetwork(a.chainId));
  await Promise.all(
    [...new Set(missing.map(a => a.chainId))].map(async chainId => {
      const dex = await dexscreener(chainId, missing.filter(a => a.chainId === chainId).map(a => a.asset));
      for (const a of missing.filter(x => x.chainId === chainId)) {
        const v = dex.get(a.asset.toLowerCase())?.priceUsd ?? null;
        a.price = v;
        if (v !== null || dexCache.has(`${chainId}:${a.asset.toLowerCase()}`)) priceCache.set(`${a.chainId}:${a.asset}`, { at: Date.now(), v });
      }
    }),
  );
  for (const a of assets) a.usd = a.price === null ? null : Number(a.formatted) * a.price;
}

const DEX_MS = 5 * 60_000;
const dexCache = new Map<string, { at: number; v: { image?: string; priceUsd: number | null } | null }>();

/** DexScreener token info (logo + USD price of the most liquid pair), 30 tokens per request, cached 5 min. */
async function dexscreener(chainId: number, tokens: Address[]): Promise<Map<string, { image?: string; priceUsd: number | null }>> {
  const out = new Map<string, { image?: string; priceUsd: number | null }>();
  const slug = chainById(chainId)?.dex;
  if (!slug) return out;
  const todo: string[] = [];
  for (const t of tokens.map(x => x.toLowerCase())) {
    const hit = dexCache.get(`${chainId}:${t}`);
    if (hit && Date.now() - hit.at < (hit.v ? DEX_MS : NO_PRICE_MS)) {
      if (hit.v) out.set(t, hit.v);
    } else todo.push(t);
  }
  const batches = Array.from({ length: Math.ceil(todo.length / 30) }, (_, i) => todo.slice(i * 30, i * 30 + 30));
  await Promise.all(batches.map(async batch => {
    const pairs: any[] | null = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${batch.join(",")}`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!pairs) return; // failed: not "no pair", so nothing cached
    for (const t of batch) {
      const mine = (Array.isArray(pairs) ? pairs : [])
        .filter(p => String(p?.baseToken?.address).toLowerCase() === t)
        .sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
      // a pool with almost nothing in it says any price (a spam token at $24 from a $0 pool): no price then
      const price = (mine[0]?.liquidity?.usd ?? 0) >= 1_000 ? Number(mine[0]?.priceUsd) : NaN;
      const v = mine.length
        ? { image: mine.find(p => p?.info?.imageUrl)?.info.imageUrl as string | undefined, priceUsd: Number.isFinite(price) ? price : null }
        : null;
      dexCache.set(`${chainId}:${t}`, { at: Date.now(), v });
      if (v) out.set(t, v);
    }
  }));
  return out;
}
