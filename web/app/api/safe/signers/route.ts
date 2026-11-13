import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress, isHex } from "viem";
import { kv } from "@/lib/kv";
import { tooMany } from "@/lib/limit";
import { passkeyOwner } from "@/lib/passkeyAuth";
import { friendChallenge, signerAddress } from "@/lib/safe/core";
import { withLock } from "@/lib/safe/relayGuard";

export const dynamic = "force-dynamic";

/**
 * A wallet's invited signers (docs/MULTI-SIGNER.md): on chain someone else's passkey looks exactly like a wedgie, so
 * the owner says which ones are people, signed with Face ID, and their other devices read it here.
 *   GET  ?safe                                                                    → { friends: [{ x, y, name? }] }
 *   POST { address, x, y, name?, ts, qx, qy, r, s, authenticatorData, clientDataJSON } → { ok }
 *        Face ID over friendChallenge(address, signer of x/y, name, ts), from a passkey that owns the wallet.
 * Public keys and a name, no secret. It can't change a wallet: a device only uses it to draw a signer that is
 * already an owner as a person (their wallet, their name) and to ask them by link, not as a wedgie.
 */
const MAX = 20;
type Friend = { x: string; y: string; name?: string; at: number };
const K = (safe: string) => `iws:friends:${safe.toLowerCase()}`;
const out = (v: unknown, status = 200) => NextResponse.json(v, { status, headers: { "Cache-Control": "no-store" } });
const clean = (s: unknown, n = 40) => (typeof s === "string" ? s.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n) : "");
const key32 = (v: unknown): v is `0x${string}` => isHex(v) && v.length === 66;

async function read(safe: string): Promise<Friend[]> {
  const v = await kv(["GET", K(safe)]);
  try {
    const l = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const safe = req.nextUrl.searchParams.get("safe") ?? "";
  if (!isAddress(safe)) return out({ error: "safe?" }, 400);
  try {
    return out({ friends: (await read(safe)).map(({ x, y, name }) => ({ x, y, name })) });
  } catch {
    return out({ error: "Try again" }, 503);
  }
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || !key32(b.x) || !key32(b.y)) return out({ error: "key?" }, 400);
  if (await tooMany(req, "friend", 60, 3600)) return out({ error: "Too many. Try again later." }, 429);
  const name = clean(b.name);
  const signer = signerAddress(b.x, b.y);
  const who = await passkeyOwner(req, b, "friend", (address, ts) => friendChallenge(address, signer, name, ts));
  if ("error" in who) return out({ error: who.error }, who.status);
  try {
    const safe = getAddress(who.address);
    await withLock(`lock:${K(safe)}`, async () => {
      const rest = (await read(safe)).filter(f => !(f.x.toLowerCase() === b.x.toLowerCase() && f.y.toLowerCase() === b.y.toLowerCase()));
      if (rest.length >= MAX) throw new Error("full");
      await kv(["SET", K(safe), JSON.stringify([...rest, { x: b.x, y: b.y, name: name || undefined, at: Math.floor(Date.now() / 1000) } satisfies Friend])]);
    });
    return out({ ok: true });
  } catch (e: any) {
    return e?.message === "full" ? out({ error: "Too many invited signers." }, 400) : out({ error: "Try again" }, 503);
  }
}
