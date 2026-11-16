import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { isLocalHost } from "@/lib/local";

export const dynamic = "force-dynamic";

/**
 * Settings → Balances and prices, on a copy running on your own computer: your own indexer (clawdbotatg/iw-indexer,
 * started by run-local.sh when web/.env.local has an RPC_URL_<chainId>) or Alchemy. Never on our site (404).
 *
 *   GET  /api/local/indexer → { setUp, on, up, chains: [{ id, name, wallets, scanned }] }
 *   POST /api/local/indexer { on } → kept in this copy's store (app/api/portfolio reads it)
 */
const local = (req: NextRequest) => !process.env.VERCEL && isLocalHost((req.headers.get("host") || "").split(":")[0]);
const OFF_KEY = "local:indexer:off";

export async function GET(req: NextRequest) {
  if (!local(req)) return NextResponse.json({ error: "not here" }, { status: 404 });
  const url = process.env.INDEXER_URL;
  const on = (await kv(["GET", OFF_KEY]).catch(() => null)) !== "1";
  if (!url) return NextResponse.json({ setUp: false, on, up: false, chains: [] });
  const st = await fetch(`${url}/status`, { signal: AbortSignal.timeout(3000), cache: "no-store" })
    .then(r => r.json())
    .catch(() => null);
  const chains = (st?.chains ?? []).map((c: { id: number; name: string; wallets: { done: boolean }[] }) => ({
    id: c.id,
    name: c.name,
    wallets: c.wallets.length,
    scanned: c.wallets.filter(w => w.done).length,
  }));
  return NextResponse.json({ setUp: true, on, up: !!st, chains });
}

export async function POST(req: NextRequest) {
  if (!local(req)) return NextResponse.json({ error: "not here" }, { status: 404 });
  const { on } = await req.json().catch(() => ({}));
  await kv(on ? ["DEL", OFF_KEY] : ["SET", OFF_KEY, "1"]);
  return NextResponse.json({ on: !!on });
}
