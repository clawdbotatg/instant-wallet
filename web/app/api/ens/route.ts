import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress } from "viem";
import { mainnet } from "viem/chains";
import { avatarUrl, nameAddress, primaryName } from "clear-signing-safe-kit";
import { fullName, ourLabel } from "@/lib/names";
import { nameOwner, namesOf } from "@/lib/namesStore";
import { mustRpc } from "@/lib/rpcServer";

export const dynamic = "force-dynamic";

/**
 * `GET /api/ens?name=atg.eth` -> `{address}` · `GET /api/ens?address=0x…[&chain=8453]` -> `{name, avatar}`.
 * clear-signing-safe-kit's names (as wedgie.dev): through ENS's Universal Resolver, so *.base.eth and other gateway
 * names work; with chain, that chain's primary name first. Kept a day by the CDN.
 * Our own names (alice.inst.eth, lib/names.ts) are answered from our store: no chain, no gateway. A wallet's own ENS
 * name (its primary name onchain) comes first; its inst.eth name is what shows when it has none.
 */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const address = req.nextUrl.searchParams.get("address");
  const chain = Number(req.nextUrl.searchParams.get("chain") || 0) || undefined;
  const client = createPublicClient({ chain: mainnet, transport: http(mustRpc(1)) });
  const keep = { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } };
  try {
    if (name) {
      if (!/^[^\s.]+(\.[^\s.]+)+$/.test(name)) return NextResponse.json({ error: "not an ENS name" }, { status: 400 });
      const ours = ourLabel(name);
      if (ours) {
        // a held name never moves, so it keeps for a day; a free one may be taken any second
        const a = await nameOwner(ours);
        return NextResponse.json({ name, address: a }, a ? keep : { headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json({ name, address: await nameAddress(client as any, name) }, keep);
    }
    if (address && isAddress(address)) {
      const n = await primaryName(client as any, address, chain);
      // no name yet: kept 5 min, not a day, so a name just set shows up soon everywhere
      const brief = { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300" } };
      if (n) return NextResponse.json({ address, name: n, avatar: await avatarUrl(client as any, n) }, keep);
      // no ENS name of its own: its inst.eth name (it can be renamed, so brief)
      const mine = await namesOf(address).catch(() => null);
      return NextResponse.json({ address, name: mine ? fullName(mine.n) : null, avatar: null }, brief);
    }
    return NextResponse.json({ error: "name or address required" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: 502 });
  }
}
