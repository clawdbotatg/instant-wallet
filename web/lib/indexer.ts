import { kv } from "@/lib/kv";

/** Your own indexer (INDEXER_URL, clawdbotatg/iw-indexer; the local copy only): which networks it reads, asked once a
 * minute. Empty when it isn't set up, or Settings → Balances and prices turned it off (Alchemy then, as on our site). */
let ixChains: { at: number; v: Promise<Set<number>> } | null = null;
export async function indexerChains(): Promise<Set<number>> {
  const url = process.env.INDEXER_URL;
  if (!url) return new Set();
  if ((await kv(["GET", "local:indexer:off"]).catch(() => null)) === "1") return new Set();
  if (ixChains && Date.now() - ixChains.at < 60_000) return ixChains.v;
  const v = fetch(`${url}/status`, { signal: AbortSignal.timeout(3000), cache: "no-store" })
    .then(r => r.json())
    .then(j => new Set<number>((j.chains ?? []).map((c: { id: number }) => c.id)))
    .catch(() => new Set<number>());
  ixChains = { at: Date.now(), v };
  return v;
}

const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);

/** An alchemy_getAssetTransfers ask answered with the indexer's token moves (ERC-20 logs): only the "erc20" part, in
 * Alchemy's shape. Null when it can't: not one of its networks, a filter it doesn't know, or its scan hasn't reached
 * the wallet's first block yet (part of a history would hide moves). ETH moves aren't in logs: the caller asks the
 * node for those. */
export async function indexerTransfers(chainId: number, p: any): Promise<any[] | null> {
  const to = p.toAddress?.toLowerCase();
  const from = p.fromAddress?.toLowerCase();
  if (!(to || from) || (to && from) || p.pageKey || (p.fromBlock && p.fromBlock !== "0x0") || (p.toBlock && p.toBlock !== "latest")) return null;
  if (!(await indexerChains()).has(chainId)) return null;
  const max = Math.min(Number(p.maxCount ?? "0x3e8"), 500);
  const only = Array.isArray(p.contractAddresses) ? new Set(p.contractAddresses.map((a: string) => a.toLowerCase())) : null;
  const j = await fetch(`${process.env.INDEXER_URL}/transfers?address=${to ?? from}&chain=${chainId}&limit=${max}${to ? "&in=1" : ""}`, { signal: AbortSignal.timeout(10_000), cache: "no-store" })
    .then(r => r.json())
    .catch(() => null);
  if (!j?.complete || !Array.isArray(j.transfers)) return null;
  const out = (j.transfers as any[])
    .filter(t => (to ? t.dst === to : t.src === from) && (!only || only.has(t.token)) && !(p.excludeZeroValue !== false && BigInt(t.value) === 0n))
    .slice(0, max)
    .map(t => ({
      blockNum: hex(t.block),
      uniqueId: `${t.tx}:log:${t.idx}`,
      hash: t.tx,
      from: t.src,
      to: t.dst,
      value: t.decimals == null ? null : Number(BigInt(t.value)) / 10 ** t.decimals,
      asset: t.symbol,
      category: "erc20",
      rawContract: { value: hex(BigInt(t.value)), address: t.token, decimal: t.decimals == null ? null : hex(t.decimals) },
      ...(p.withMetadata ? { metadata: { blockTimestamp: new Date(t.at * 1000).toISOString() } } : {}),
    }));
  return out;
}
