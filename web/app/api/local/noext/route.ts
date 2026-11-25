import { NextRequest, NextResponse } from "next/server";
import { fromLocalCopy } from "@/lib/local";
import { noExternal, setNoExternal } from "@/lib/noext";

export const dynamic = "force-dynamic";

/**
 * Settings → No external traffic (lib/noext.ts), a copy on your own computer only (404 on our site).
 *   GET  → { on, chains, beacon }: chains = the networks you have a node for (the only ones shown while it's on),
 *          beacon = the ones whose node proves by itself (BEACON_URL_<chainId>, app/api/beacon)
 *   POST { on } (JSON only: no other site can flip it) → the same, and the cookie that makes the page strict too
 */
async function nodes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("RPC_URL_") && v && !/alchemy\.com/.test(v)) out[k.slice(8)] = v;
  if (process.env.INDEXER_URL) {
    const j = await fetch(`${process.env.INDEXER_URL}/node`, { signal: AbortSignal.timeout(3000), cache: "no-store" })
      .then(r => r.json())
      .catch(() => null);
    for (const [k, v] of Object.entries((j?.nodes ?? {}) as Record<string, string>)) if (v && !/alchemy\.com/.test(v)) out[k] = v;
  }
  return out;
}

function answer(on: boolean, n: Record<string, string>) {
  const beacon = Object.keys(process.env).filter(k => k.startsWith("BEACON_URL_") && process.env[k]).map(k => Number(k.slice(11)));
  const res = NextResponse.json({ on, chains: Object.keys(n).map(Number), beacon });
  res.cookies.set("iw_noext", on ? "1" : "", { path: "/", sameSite: "strict", maxAge: on ? 10 * 365 * 86400 : 0 });
  return res;
}

export async function GET(req: NextRequest) {
  if (!fromLocalCopy(req)) return NextResponse.json({ error: "not here" }, { status: 404 });
  const n = await nodes();
  const on = !!noExternal();
  // a node set or dropped since: kept up to date
  if (on && JSON.stringify(n) !== JSON.stringify(noExternal()?.nodes) && Object.keys(n).length) setNoExternal({ nodes: n });
  return answer(on, n);
}

export async function POST(req: NextRequest) {
  if (!fromLocalCopy(req)) return NextResponse.json({ error: "not here" }, { status: 404 });
  if (!(req.headers.get("content-type") || "").startsWith("application/json")) return NextResponse.json({ error: "JSON only" }, { status: 415 });
  const { on } = await req.json().catch(() => ({}));
  const n = await nodes();
  if (on && !Object.keys(n).length) return NextResponse.json({ error: "Set your node first." }, { status: 400 });
  setNoExternal(on ? { nodes: n } : null);
  return answer(!!on, n);
}
