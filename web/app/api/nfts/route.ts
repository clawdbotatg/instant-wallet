import { NextRequest, NextResponse } from "next/server";
import { type Address, getAddress, isAddress } from "viem";
import { CHAINS } from "@/lib/chains";
import { alchemyNetwork } from "@/lib/rpcServer";
import type { Nft } from "@/lib/types";

export const dynamic = "force-dynamic";

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; v: Nft[] }>();

/**
 * `GET /api/nfts?address=0x…` — the NFTs a wallet holds on every enabled chain (Alchemy NFT API, first page per
 * chain). Alchemy's spam and airdrop flags drop a little; anything without an image is dropped too (almost
 * always spam). HyperEVM has no NFT API yet and comes back empty.
 */
export async function GET(req: NextRequest) {
  const a = req.nextUrl.searchParams.get("address");
  if (!a || !isAddress(a)) return NextResponse.json({ error: "address required" }, { status: 400 });
  const wallet = getAddress(a);
  const hit = cache.get(wallet);
  if (hit && Date.now() - hit.at < CACHE_MS) return NextResponse.json({ nfts: hit.v });
  const late = () => new Promise<Nft[]>(r => setTimeout(() => r([]), 8_000));
  const perChain = await Promise.all(CHAINS.map(c => Promise.race([chainNfts(c.id, wallet).catch(() => [] as Nft[]), late()])));
  const nfts = perChain.flat();
  cache.set(wallet, { at: Date.now(), v: nfts });
  return NextResponse.json({ nfts });
}

async function chainNfts(chainId: number, wallet: Address): Promise<Nft[]> {
  const key = process.env.ALCHEMY_API_KEY;
  const net = alchemyNetwork(chainId);
  if (!key || !net) return [];
  const q = `owner=${wallet}&pageSize=100&withMetadata=true&excludeFilters[]=SPAM&excludeFilters[]=AIRDROPS`;
  const j = await fetch(`https://${net}.g.alchemy.com/nft/v3/${key}/getNFTsForOwner?${q}`, { cache: "no-store" }).then(r => r.json());
  const out: Nft[] = [];
  for (const x of j?.ownedNfts ?? []) {
    const thumb = x.image?.thumbnailUrl || x.image?.cachedUrl;
    if (!thumb || x.contract?.isSpam) continue;
    const collection = x.contract?.openSeaMetadata?.collectionName || x.contract?.name || "Unknown";
    out.push({
      chainId,
      contract: getAddress(x.contract.address),
      tokenId: String(x.tokenId),
      type: String(x.tokenType ?? ""),
      balance: String(x.balance ?? "1"),
      name: x.name || `${collection} #${x.tokenId}`,
      collection,
      thumb,
      image: x.image?.cachedUrl || thumb,
    });
  }
  return out;
}
