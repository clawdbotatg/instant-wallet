import { NextResponse } from "next/server";
import { chainById } from "@/lib/chains";
import { nativeUsd } from "@/lib/safe/relayCore";

export const dynamic = "force-dynamic";

/** `GET /api/price?chain=<id>` -> `{usd}`: the chain's native coin in dollars (POL, BNB, xDAI, …), 0 when not known. */
export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("chain"));
  if (!chainById(id)) return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  const usd = await nativeUsd(id).catch(() => 0);
  return NextResponse.json({ usd }, { headers: { "Cache-Control": "public, max-age=60" } });
}
