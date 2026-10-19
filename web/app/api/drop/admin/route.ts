import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { type Signed, authorize } from "@/lib/alerts";
import {
  DROP_CHAINS,
  DropRefused,
  cardCodes,
  claimedCount,
  claims,
  createDrop,
  ethUsd,
  getDrop,
  isAdmin,
  listDrops,
  newSession,
  potAddress,
  potBalances,
  sessionWallet,
  takeBack,
  updateDrop,
  usedCard,
  walletChallenge,
  walletLogin,
} from "@/lib/drops";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Drops, the giver's side (/drops). Face ID once to log in (an admin wallet's passkey over "login", scope "drops";
 * DROP_ADMINS lists the wallets), then a 12-hour session token.
 *   POST { op: "login", wallet, sig }        → { token }
 *   POST { op: "challenge" }                 → { message }  for a wallet login (atg.eth): sign it in any wallet
 *   POST { op: "login", wallet, message, signature } → { token }
 *   POST { op: "list", token }               → { drops: [{ ...drop, claimed, pot }], chains }
 *   POST { op: "get", token, id }            → { drop, claimed, pot: balances, codes: [{ code, used }], claims }
 *   POST { op: "create", token, drop }       → { drop }     NewDrop in lib/drops.ts
 *   POST { op: "set", token, id, paused?, ended?, minutes? } → { drop }
 *   POST { op: "price", token }              → { ethUsd }   Uniswap, Base
 *   POST { op: "takeback", token, id }       → { hashes }   everything left, to the logged-in wallet
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.op !== "string") return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    if (b.op === "challenge") return NextResponse.json({ message: await walletChallenge() });
    if (b.op === "login") {
      if (!isAddress(b.wallet)) throw new DropRefused("wallet?");
      const w = getAddress(b.wallet);
      if (typeof b.message === "string") {
        if (!(await walletLogin(w, b.message, b.signature))) throw new DropRefused("That signature didn't check out. Try again.", 403);
      } else {
        const bad = await authorize(w, "login", b.sig as Signed, "drops");
        if (bad) throw new DropRefused(bad, 403);
      }
      if (!isAdmin(w)) throw new DropRefused("This wallet can't make drops.", 403);
      return NextResponse.json({ token: await newSession(w), wallet: w });
    }
    const me = await sessionWallet(b.token);
    if (!me) throw new DropRefused("Log in again.", 401);
    const one = async () => {
      const d = typeof b.id === "string" && (await getDrop(b.id));
      if (!d) throw new DropRefused("No such drop.", 404);
      return d;
    };
    switch (b.op) {
      case "list": {
        const drops = await listDrops();
        return NextResponse.json({
          chains: DROP_CHAINS,
          drops: await Promise.all(drops.map(async d => ({ ...d, claimed: await claimedCount(d.id), pot: potAddress(d.id) }))),
        });
      }
      case "get": {
        const d = await one();
        const codes = d.kind === "cards" ? await cardCodes(d.id) : [];
        const [claimed, pot, log, used] = await Promise.all([
          claimedCount(d.id),
          potBalances(d),
          claims(d.id),
          Promise.all(codes.map(c => usedCard(c))),
        ]);
        return NextResponse.json({ drop: d, claimed, pot, claims: log, codes: codes.map((code, i) => ({ code, used: !!used[i] })) });
      }
      case "create":
        return NextResponse.json({ drop: await createDrop(me, b.drop ?? {}) });
      case "set":
        await one();
        return NextResponse.json({ drop: await updateDrop(b.id, { paused: b.paused, ended: b.ended, minutes: b.minutes }) });
      case "price":
        return NextResponse.json({ ethUsd: await ethUsd(8453) });
      case "takeback":
        return NextResponse.json({ hashes: await takeBack(await one(), me) });
    }
    throw new DropRefused("unknown op");
  } catch (e: any) {
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: e instanceof DropRefused ? e.status : 500 });
  }
}
