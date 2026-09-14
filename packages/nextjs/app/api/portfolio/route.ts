import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { portfolio } from "~~/services/zerion";

export const dynamic = "force-dynamic";

/** `GET /api/portfolio?address=` — Zerion on Base with a key, else the wallet's token balance. */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address || !isAddress(address))
    return NextResponse.json({ error: "address query param required" }, { status: 400 });
  try {
    return NextResponse.json(await portfolio(getAddress(address)));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 502 });
  }
}
