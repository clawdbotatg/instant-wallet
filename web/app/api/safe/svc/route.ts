import { NextRequest } from "next/server";
import { kv } from "@/lib/kv";

export const dynamic = "force-dynamic";

/**
 * /api/safe/svc?u=<path>: Safe's Transaction Service (api.safe.global/tx-service/<path>) with our key (SAFE_API_KEY,
 * shared with wedgie.dev: Safe counts per account, so both draw on one quota, ~50K a month). Only what
 * lib/safe/share.ts needs: a Safe's waiting transactions, one transaction, a proposal, a signature. Reads are kept
 * a little while (in memory) so many open pages make few calls: a Safe's queue 100 s, the rest 20 s (as wedgie.dev's
 * api/safe.ts). Reads have a daily cap (DAY_CAP, counted in KV across instances): wedgie.dev takes up to 1,500 a day of
 * the same ~1,666, so past ours the page carries on with the chain and our own queue. Writes are never capped.
 */
const DAY_CAP = 150;
const BASE = "https://api.safe.global/tx-service/";
const PATH = /^[a-z0-9-]+\/api\/v1\/(safes\/0x[0-9a-fA-F]{40}\/multisig-transactions\/|multisig-transactions\/0x[0-9a-fA-F]{64}\/(confirmations\/)?)[\w\-.?=&]*$/;
const KEEP = (p: string) => (/executed=false/.test(p) ? 100_000 : 20_000);
const HIT = new Map<string, { at: number; status: number; body: string }>();

const headers = () => ({ "Content-Type": "application/json", ...(process.env.SAFE_API_KEY ? { Authorization: `Bearer ${process.env.SAFE_API_KEY}` } : {}) });
const pass = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const path = (req: NextRequest) => {
  const u = req.nextUrl.searchParams.get("u") || "";
  return PATH.test(u) && !u.includes("..") ? u : "";
};
// only this site's pages (a browser sends Origin on a POST; a same-origin GET may not)
const foreign = (req: NextRequest) => {
  const o = req.headers.get("origin");
  return !!o && o !== req.nextUrl.origin;
};

export async function GET(req: NextRequest) {
  const p = path(req);
  if (!p || foreign(req)) return pass(403, JSON.stringify({ error: "Not allowed." }));
  const hit = HIT.get(p);
  if (hit && Date.now() - hit.at < KEEP(p)) return pass(hit.status, hit.body);
  const n = await kv(["INCR", `safe_api:${new Date().toISOString().slice(0, 10)}`]).catch(() => 0);
  if (n === 1) kv(["EXPIRE", `safe_api:${new Date().toISOString().slice(0, 10)}`, 2 * 86_400]).catch(() => {});
  if (Number(n) > DAY_CAP) return pass(429, JSON.stringify({ error: "Safe's service: today's share is used." }));
  const r = await fetch(BASE + p, { headers: headers(), signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) return pass(502, JSON.stringify({ error: "Safe's service didn't answer." }));
  const body = await r.text();
  if (r.ok || r.status === 404) {
    if (HIT.size > 2000) HIT.clear();
    HIT.set(p, { at: Date.now(), status: r.status, body });
  }
  return pass(r.status === 429 ? 503 : r.status, body);
}

export async function POST(req: NextRequest) {
  const p = path(req);
  if (!p || foreign(req) || !/\/(multisig-transactions|confirmations)\/$/.test(p)) return pass(403, JSON.stringify({ error: "Not allowed." }));
  const text = await req.text();
  if (text.length > 200_000) return pass(413, JSON.stringify({ error: "Too big." }));
  const r = await fetch(BASE + p, { method: "POST", headers: headers(), body: text, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r) return pass(502, JSON.stringify({ error: "Safe's service didn't answer." }));
  for (const k of HIT.keys()) if (k.includes("multisig-transactions")) HIT.delete(k); // the next read sees it
  return pass(r.status, await r.text());
}
