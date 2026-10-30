import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress } from "viem";
import { mainnet } from "viem/chains";
import { avatarUrl, nameAddress, primaryName } from "clear-signing-safe-kit";
import { upstreamRpc } from "@/lib/rpcServer";

export const dynamic = "force-dynamic";

/**
 * `GET /api/ens?name=atg.eth` -> `{address}` · `GET /api/ens?address=0x…[&chain=8453]` -> `{name, avatar}`.
 * clear-signing-safe-kit's names (as wedgie.dev): through ENS's Universal Resolver, so *.base.eth and other gateway
 * names work; with chain, that chain's primary name first. Kept a day by the CDN.
 */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const address = req.nextUrl.searchParams.get("address");
  const chain = Number(req.nextUrl.searchParams.get("chain") || 0) || undefined;
  const client = createPublicClient({ chain: mainnet, transport: http(upstreamRpc(1)) });
  const keep = { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } };
  try {
    if (name) {
      if (!/^[^\s.]+(\.[^\s.]+)+$/.test(name)) return NextResponse.json({ error: "not an ENS name" }, { status: 400 });
      return NextResponse.json({ name, address: await nameAddress(client as any, name) }, keep);
    }
    if (address && isAddress(address)) {
      const n = await primaryName(client as any, address, chain);
      return NextResponse.json({ address, name: n, avatar: n ? await avatarUrl(client as any, n) : null }, keep);
    }
    return NextResponse.json({ error: "name or address required" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: 502 });
  }
}
