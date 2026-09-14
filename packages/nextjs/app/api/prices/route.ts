import { NextRequest, NextResponse } from "next/server";
import { price } from "~~/services/zerion";

export const dynamic = "force-dynamic";

/** `GET /api/prices?symbols=ETH,USDC` */
export async function GET(req: NextRequest) {
  const symbols = (req.nextUrl.searchParams.get("symbols") || "ETH,USDC")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  try {
    return NextResponse.json(await Promise.all(symbols.map(price)));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 502 });
  }
}
