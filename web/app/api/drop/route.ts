import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { type Signed, authorize } from "@/lib/alerts";
import { DropRefused, byCode, claim, claimedCount, closed, decimals, usedCard, walletClaimed } from "@/lib/drops";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // waits for the transfer to land (Ethereum ~12 s), so a failed one gives the code back

/**
 * Drops (lib/drops.ts), the claimer's side.
 *   GET  ?code=GWEI[&wallet=0x…]             → { name, chainId, token, amount, decimals, kind, claimed, cap, closed }
 *        closed: why it can't pay now (with `wallet`: also "already claimed" for a crowd code), or null
 *   POST { code, wallet, sig }               → { hash }   sig: the wallet's passkey over "claim <CODE>" (scope "drops")
 */
export async function GET(req: NextRequest) {
  const f = await byCode(req.nextUrl.searchParams.get("code") ?? "");
  if (!f) return NextResponse.json({ error: "That code isn't one of ours. Check it and try again." }, { status: 404 });
  const { drop: d, code } = f;
  const claimed = await claimedCount(d.id);
  let why = closed(d, claimed);
  if (!why && d.kind === "cards" && (await usedCard(code))) why = "This card was claimed already.";
  const w = req.nextUrl.searchParams.get("wallet") ?? "";
  if (!why && d.kind === "crowd" && isAddress(w) && (await walletClaimed(d.id, w))) why = "This wallet already claimed this one.";
  return NextResponse.json({
    code,
    name: d.name,
    chainId: d.chainId,
    token: d.token,
    amount: d.amount,
    decimals: decimals(d.token),
    kind: d.kind,
    claimed,
    cap: d.cap,
    closesAt: d.closesAt ?? null,
    closed: why,
  });
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.code !== "string" || !isAddress(b.wallet) || !b.sig) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const f = await byCode(b.code);
    if (!f) throw new DropRefused("That code isn't one of ours.", 404);
    const wallet = getAddress(b.wallet);
    const bad = await authorize(wallet, `claim ${f.code}`, b.sig as Signed, "drops");
    if (bad) throw new DropRefused(bad, 403);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";
    return NextResponse.json(await claim(f.code, f.drop, wallet, ip));
  } catch (e: any) {
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: e instanceof DropRefused ? e.status : 500 });
  }
}
