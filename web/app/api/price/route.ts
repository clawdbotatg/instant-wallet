import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { alchemyNetwork } from "@/lib/rpcServer";
import { chainById } from "@/lib/chains";
import { nativeUsd } from "@/lib/safe/relayCore";

export const dynamic = "force-dynamic";

/** `GET /api/price?chain=<id>` -> `{usd}`: the chain's native coin in dollars (POL, BNB, xDAI, …), 0 when not known.
 * `&tokens=0x…,0x…` (25 at most) -> `{usd: {address: dollars}}` from Alchemy; a token it doesn't price is left out. */
export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("chain"));
  if (!chainById(id)) return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  const tokens = new URL(req.url).searchParams.get("tokens");
  if (tokens !== null) {
    const list = [...new Set(tokens.toLowerCase().split(",").filter(t => isAddress(t)))].slice(0, 25);
    const key = process.env.ALCHEMY_API_KEY;
    const network = alchemyNetwork(id);
    const out: Record<string, number> = {};
    if (key && network && list.length) {
      const j = await fetch(`https://api.g.alchemy.com/prices/v1/${key}/tokens/by-address`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addresses: list.map(address => ({ network, address })) }),
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      })
        .then(r => r.json())
        .catch(() => null);
      for (const d of j?.data ?? []) {
        const v = Number(d?.prices?.find((p: any) => p.currency === "usd")?.value);
        if (Number.isFinite(v) && v > 0) out[String(d.address).toLowerCase()] = v;
      }
    }
    return NextResponse.json({ usd: out }, { headers: { "Cache-Control": "public, max-age=60" } });
  }
  const usd = await nativeUsd(id).catch(() => 0);
  // a price we couldn't get (0) is never kept: the next ask tries again
  return NextResponse.json({ usd }, { headers: { "Cache-Control": usd > 0 ? "public, max-age=60" : "no-store" } });
}
