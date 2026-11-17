import { NextRequest, NextResponse } from "next/server";
import { nodeOf } from "@/lib/local";
import { isOnion } from "@/lib/tor";
import { torFetch } from "@/lib/torServer";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * Your .onion node, for the page of a copy on your own computer: the page posts its JSON-RPC here with the node in
 * x-iw-node, and this server sends it over Tor (tor-js, direct TCP). The page needs no gateway and no Tor of its
 * own (lib/tor.ts). Never on our site (404), and only to a .onion.
 */
export async function POST(req: NextRequest) {
  const node = nodeOf(req);
  if (!node) return NextResponse.json({ error: "not here" }, { status: 404 });
  if (!isOnion(node)) return NextResponse.json({ error: "not a .onion" }, { status: 400 });
  try {
    const r = await torFetch(node, { method: "POST", headers: { "content-type": "application/json" }, body: await req.text() });
    return new NextResponse(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch (e: any) {
    return NextResponse.json({ error: `No answer over Tor: ${e?.message || e}` }, { status: 502 });
  }
}
