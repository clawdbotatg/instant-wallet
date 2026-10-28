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
 * chain). Alchemy's spam and airdrop flags drop only a little, so `spammy` does the rest; anything without an
 * image is dropped too. HyperEVM has no NFT API yet and comes back empty.
 * `&all=1` (xdai.io's sweep of an old Burner key): also the Burner's own badges, which Alchemy files as airdrops and
 * which often have no image. Everything else passes the same checks as always.
 */
export async function GET(req: NextRequest) {
  const a = req.nextUrl.searchParams.get("address");
  if (!a || !isAddress(a)) return NextResponse.json({ error: "address required" }, { status: 400 });
  const wallet = getAddress(a);
  const all = req.nextUrl.searchParams.get("all") === "1";
  const ck = `${wallet}:${all}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_MS) return NextResponse.json({ nfts: hit.v });
  const late = () => new Promise<Nft[]>(r => setTimeout(() => r([]), 8_000));
  const perChain = await Promise.all(CHAINS.map(c => Promise.race([chainNfts(c.id, wallet, all).catch(() => [] as Nft[]), late()])));
  const nfts = perChain.flat();
  cache.set(ck, { at: Date.now(), v: nfts });
  return NextResponse.json({ nfts });
}

/** The old Burner Wallet's badges on Gnosis: never spam, often no image. */
const BURNER_BADGES = "0xcf964c89f509a8c0ac36391c5460df94b91daba5";

async function chainNfts(chainId: number, wallet: Address, all = false): Promise<Nft[]> {
  const key = process.env.ALCHEMY_API_KEY;
  const net = alchemyNetwork(chainId);
  if (!key || !net) return [];
  const q = `owner=${wallet}&pageSize=100&withMetadata=true&excludeFilters[]=SPAM${all ? "" : "&excludeFilters[]=AIRDROPS"}`;
  const j = await fetch(`https://${net}.g.alchemy.com/nft/v3/${key}/getNFTsForOwner?${q}`, { cache: "no-store" }).then(r => r.json());
  const out: Nft[] = [];
  for (const x of j?.ownedNfts ?? []) {
    const thumb = x.image?.thumbnailUrl || x.image?.cachedUrl;
    const badge = String(x.contract?.address).toLowerCase() === BURNER_BADGES;
    if (!badge && (!thumb || x.contract?.isSpam || spammy(x))) continue;
    const collection = x.contract?.openSeaMetadata?.collectionName || x.contract?.name || "Unknown";
    out.push({
      chainId,
      contract: getAddress(x.contract.address),
      tokenId: String(x.tokenId),
      type: String(x.tokenType ?? ""),
      balance: String(x.balance ?? "1"),
      name: x.name || `${collection} #${x.tokenId}`,
      collection,
      thumb: thumb ?? "",
      image: x.image?.cachedUrl || thumb || "",
    });
  }
  return out;
}

// links, bait words, and the fake letters spam uses to dodge filters (𝗯𝗼𝗹𝗱 math letters, ｆｕｌｌｗｉｄｔｈ, zero-width spaces)
const BAIT =
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(win|io|xyz|com|net|org|app|fun|gift|top|live|site|online|club|vip|pro|cc|me|gg|lol|bet)\b|claim|voucher|reward|airdrop|visit|casino|bonus|deposit|giveaway|exclusive|seed phrase|vault|website|portal|\$\d|[\u{1D400}-\u{1D7FF}\uFF01-\uFF5E\u200B]/iu;

/** Spam Alchemy doesn't flag. A collection OpenSea verified or approved is never spam. */
function spammy(x: any): boolean {
  const o = x.contract?.openSeaMetadata ?? {};
  if (o.safelistRequestStatus === "verified" || o.safelistRequestStatus === "approved") return false;
  // a $0 floor and no supply: a one-off dropped on thousands of wallets
  if (o.floorPrice === 0 && !x.contract?.totalSupply) return true;
  return BAIT.test([x.name, x.description, x.contract?.name, o.collectionName].filter(Boolean).join(" "));
}
