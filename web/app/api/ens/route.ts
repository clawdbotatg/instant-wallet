import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { upstreamRpc } from "@/lib/rpcServer";

export const dynamic = "force-dynamic";

/** `GET /api/ens?name=atg.eth` -> `{address}` · `GET /api/ens?address=0x…` -> `{name}` (mainnet ENS). */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const address = req.nextUrl.searchParams.get("address");
  const client = createPublicClient({ chain: mainnet, transport: http(upstreamRpc(1)) });
  try {
    if (name) {
      if (!/^[^\s.]+(\.[^\s.]+)+$/.test(name)) return NextResponse.json({ error: "not an ENS name" }, { status: 400 });
      return NextResponse.json({ name, address: await client.getEnsAddress({ name: normalize(name) }) });
    }
    if (address && isAddress(address)) return NextResponse.json({ address, name: await client.getEnsName({ address }) });
    return NextResponse.json({ error: "name or address required" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: 502 });
  }
}
