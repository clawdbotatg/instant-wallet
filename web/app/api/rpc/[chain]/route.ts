import { NextRequest, NextResponse } from "next/server";
import { upstreamRpc } from "@/lib/rpcServer";
import { chainById } from "@/lib/chains";

export const dynamic = "force-dynamic";

/** JSON-RPC passthrough for the enabled chains, so the RPC key stays on the server. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ chain: string }> }) {
  const chainId = Number((await params).chain);
  const url = chainById(chainId) && upstreamRpc(chainId);
  if (!url) return NextResponse.json({ error: "chain not enabled" }, { status: 404 });
  const body = await req.text();
  if (body.length > 256_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store" });
  return new NextResponse(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
