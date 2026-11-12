import { NextRequest, NextResponse } from "next/server";
import { tooMany } from "@/lib/limit";
import { gateway } from "@/lib/nameGateway";

export const dynamic = "force-dynamic";

/**
 * `GET /api/ens/gw/{sender}/{data}.json` → `{ data }`: where inst.eth's resolver sends every wallet and app that
 * looks up a name under it (CCIP-read; lib/nameGateway.ts). Any site may ask: a browser wallet calls this itself.
 */
const cors = { "Access-Control-Allow-Origin": "*" };

export async function GET(req: NextRequest, { params }: { params: Promise<{ sender: string; data: string }> }) {
  const { sender, data } = await params;
  if (await tooMany(req, "namegw", 6000, 3600)) return NextResponse.json({ message: "Too many. Try again later." }, { status: 429, headers: cors });
  const r = await gateway(sender, data.replace(/\.json$/, ""));
  if ("error" in r) return NextResponse.json({ message: r.error }, { status: r.status, headers: cors });
  // a held name never moves, a free one may be taken any second: a short keep, well inside the signature's five minutes
  return NextResponse.json(r, { headers: { ...cors, "Cache-Control": "public, s-maxage=30" } });
}

export const OPTIONS = () => new NextResponse(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "*" } });
