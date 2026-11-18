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

/** An alchemy_getAssetTransfers ask answered by your indexer, in Alchemy's shape, as far as it can:
 *   erc20              its token moves (logs), once its scan has reached the wallet's first block (part of a history
 *                      would hide moves)
 *   external, internal ETH moves, from an archive node of your own (iw-indexer src/eth.ts). "internal" only when it
 *                      knows which transaction paid each one (two contracts paying in one block: it doesn't)
 * Returns what it answered and the categories it answered for; the caller asks the node for the rest. Null when it
 * answered none: not one of its networks, or a filter it doesn't know. */
export async function indexerTransfers(chainId: number, p: any): Promise<{ transfers: any[]; done: string[] } | null> {
  const to = p.toAddress?.toLowerCase();
  const from = p.fromAddress?.toLowerCase();
  if (!(to || from) || (to && from) || p.pageKey || (p.fromBlock && p.fromBlock !== "0x0") || (p.toBlock && p.toBlock !== "latest")) return null;
  const cats: string[] = Array.isArray(p.category) ? p.category : [];
  if (!(await indexerChains()).has(chainId)) return null;
  const max = Math.min(Number(p.maxCount ?? "0x3e8"), 500);
  const only = Array.isArray(p.contractAddresses) ? new Set(p.contractAddresses.map((a: string) => a.toLowerCase())) : null;
  const zero = p.excludeZeroValue !== false;
  const meta = (at: number) => (p.withMetadata ? { metadata: { blockTimestamp: new Date(at * 1000).toISOString() } } : {});
  const ask = (path: string) =>
    fetch(`${process.env.INDEXER_URL}${path}`, { signal: AbortSignal.timeout(10_000), cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  const wantEth = !only && (cats.includes("external") || (to && cats.includes("internal")));
  const [tok, eth] = await Promise.all([
    cats.includes("erc20") ? ask(`/transfers?address=${to ?? from}&chain=${chainId}&limit=${max}${to ? "&in=1" : ""}`) : null,
    wantEth ? ask(`/eth?address=${to ?? from}&chain=${chainId}&dir=${to ? "in" : "out"}&limit=${max}`) : null,
  ]);
  const out: any[] = [];
  const done: string[] = [];
  if (tok?.complete && Array.isArray(tok.transfers)) {
    done.push("erc20");
    for (const t of tok.transfers as any[]) {
      if (!(to ? t.dst === to : t.src === from) || (only && !only.has(t.token)) || (zero && BigInt(t.value) === 0n)) continue;
      out.push({
        blockNum: hex(t.block),
        uniqueId: `${t.tx}:log:${t.idx}`,
        hash: t.tx,
        from: t.src,
        to: t.dst,
        value: t.decimals == null ? null : Number(BigInt(t.value)) / 10 ** t.decimals,
        asset: t.symbol,
        category: "erc20",
        rawContract: { value: hex(BigInt(t.value)), address: t.token, decimal: t.decimals == null ? null : hex(t.decimals) },
        ...meta(t.at),
      });
    }
  }
  if (eth?.complete && Array.isArray(eth.moves)) {
    const kinds = cats.filter(k => k === "external" || (k === "internal" && !eth.unresolved));
    done.push(...kinds);
    for (const m of eth.moves as any[]) {
      if (!kinds.includes(m.kind) || !m.hash || (zero && BigInt(m.value) === 0n)) continue;
      out.push({
        blockNum: hex(m.block),
        uniqueId: `${m.hash}:${m.kind}`,
        hash: m.hash,
        from: m.from,
        to: m.to,
        value: Number(BigInt(m.value)) / 1e18,
        asset: "ETH",
        category: m.kind,
        rawContract: { value: m.value, address: null, decimal: "0x12" },
        ...meta(m.ts),
      });
    }
  }
  return done.length ? { transfers: out, done } : null;
}
