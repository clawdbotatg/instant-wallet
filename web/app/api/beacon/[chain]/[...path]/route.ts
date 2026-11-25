import { NextRequest, NextResponse } from "next/server";
import { fromLocalCopy } from "@/lib/local";

export const dynamic = "force-dynamic";

/**
 * Your node's consensus side (its beacon API: BEACON_URL_<chainId>, found by run-local.sh), for the light client in
 * this browser (lib/safe/light.ts): with it the browser builds its own proofs from your node and asks no prover.
 * A copy on your own computer only (404 on our site). Reads only, and only what the light client asks for: the
 * sync committee to start from, the newest checkpoint, and blocks.
 */
const ALLOW = /^eth\/v[12]\/beacon\/(light_client\/(bootstrap\/0x[0-9a-f]{64}|updates|finality_update|optimistic_update)|states\/(head|finalized)\/finality_checkpoints|blocks\/(head|finalized|\d+|0x[0-9a-f]{64})|headers(\/(head|finalized|\d+|0x[0-9a-f]{64}))?)$/i;

const beaconUrl = (chainId: number) => process.env[`BEACON_URL_${chainId}`]?.replace(/\/$/, "");

export async function GET(req: NextRequest, { params }: { params: Promise<{ chain: string; path: string[] }> }) {
  const { chain, path } = await params;
  const base = fromLocalCopy(req) ? beaconUrl(Number(chain)) : undefined;
  if (!base) return NextResponse.json({ error: "not here" }, { status: 404 });
  const p = path.join("/");
  if (!ALLOW.test(p)) return NextResponse.json({ error: "not allowed" }, { status: 403 });
  const res = await fetch(`${base}/${p}${req.nextUrl.search}`, { headers: { accept: req.headers.get("accept") || "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) return NextResponse.json({ error: "Your node didn't answer." }, { status: 504 });
  const h = new Headers({ "content-type": res.headers.get("content-type") || "application/json" });
  const v = res.headers.get("eth-consensus-version");
  if (v) h.set("eth-consensus-version", v);
  return new NextResponse(await res.arrayBuffer(), { status: res.status, headers: h });
}
