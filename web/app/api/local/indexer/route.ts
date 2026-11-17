import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { isLocalHost } from "@/lib/local";

export const dynamic = "force-dynamic";

/**
 * Settings → Balances and prices, on a copy running on your own computer: your own indexer (clawdbotatg/iw-indexer,
 * started by run-local.sh) or Alchemy. Never on our site (404).
 *
 *   GET  /api/local/indexer → { setUp, on, up, chains: [{ id, name, wallets, scanned }], networks, nodes: { id: url } }
 *   POST /api/local/indexer { on } → kept in this copy's store (app/api/portfolio reads it)
 *   POST /api/local/indexer { chain, node } → the node the indexer reads that network from (null: none); it checks
 *        the node answers as that network, keeps it and restarts on it
 */
const local = (req: NextRequest) => !process.env.VERCEL && isLocalHost((req.headers.get("host") || "").split(":")[0]);
const OFF_KEY = "local:indexer:off";

export async function GET(req: NextRequest) {
  if (!local(req)) return NextResponse.json({ error: "not here" }, { status: 404 });
  const url = process.env.INDEXER_URL;
  const on = (await kv(["GET", OFF_KEY]).catch(() => null)) !== "1";
  if (!url) return NextResponse.json({ setUp: false, on, up: false, chains: [] });
  const ask = (path: string) =>
    fetch(`${url}${path}`, { signal: AbortSignal.timeout(3000), cache: "no-store" })
      .then(r => r.json())
      .catch(() => null);
  const [st, nd] = await Promise.all([ask("/status"), ask("/node")]);
  const chains = (st?.chains ?? []).map((c: { id: number; name: string; wallets: { done: boolean }[] }) => ({
    id: c.id,
    name: c.name,
    wallets: c.wallets.length,
    scanned: c.wallets.filter(w => w.done).length,
  }));
  return NextResponse.json({ setUp: true, on, up: !!st, chains, networks: nd?.networks ?? [], nodes: nd?.nodes ?? {} });
}

export async function POST(req: NextRequest) {
  if (!local(req)) return NextResponse.json({ error: "not here" }, { status: 404 });
  // JSON only: another site can't send that here without asking first (and nothing here says yes), so no page you
  // visit can point your indexer at its own node
  if (!(req.headers.get("content-type") || "").startsWith("application/json")) return NextResponse.json({ error: "JSON only" }, { status: 415 });
  const b = await req.json().catch(() => ({}));
  if (b.chain !== undefined) {
    const url = process.env.INDEXER_URL;
    if (!url) return NextResponse.json({ error: "Your indexer isn't running. Start ./run-local.sh again." }, { status: 400 });
    const r = await fetch(`${url}/node`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain: Number(b.chain), url: b.node || null }), signal: AbortSignal.timeout(10_000) })
      .then(async r => ({ status: r.status, j: await r.json() }))
      .catch(() => ({ status: 502, j: { error: "Your indexer didn't answer." } }));
    return NextResponse.json(r.j, { status: r.status });
  }
  const { on } = b;
  await kv(on ? ["DEL", OFF_KEY] : ["SET", OFF_KEY, "1"]);
  return NextResponse.json({ on: !!on });
}
