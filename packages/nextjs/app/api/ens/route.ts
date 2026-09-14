import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, isAddress } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

export const dynamic = "force-dynamic";

function mainnetRpc(): string {
  if (process.env.MAINNET_RPC_URL) return process.env.MAINNET_RPC_URL;
  const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  return key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : "https://cloudflare-eth.com";
}

/** `GET /api/ens?name=atg.eth` -> `{address}` · `GET /api/ens?address=0x…` -> `{name}` (mainnet ENS). */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const address = req.nextUrl.searchParams.get("address");
  const client = createPublicClient({ chain: mainnet, transport: http(mainnetRpc()) });
  try {
    if (name) {
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name))
        return NextResponse.json({ error: "not an ENS name" }, { status: 400 });
      const resolved = await client.getEnsAddress({ name: normalize(name) });
      return NextResponse.json({ name, address: resolved });
    }
    if (address && isAddress(address)) {
      const ens = await client.getEnsName({ address });
      return NextResponse.json({ address, name: ens });
    }
    return NextResponse.json({ error: "name or address required" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: 502 });
  }
}
