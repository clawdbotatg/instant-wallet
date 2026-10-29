import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress, isHex } from "viem";
import { drop, stash, unstash } from "@/lib/safe/relayGuard";

export const dynamic = "force-dynamic";

/**
 * Invite a signer (docs/MULTI-SIGNER.md): the wallet's owner makes an invite, a friend opens /join#<id> and answers
 * with their passkey's public key (not a secret), the owner sees it and adds them (an owners change everyone signs).
 * Nothing here can change a wallet: it only carries the key from one phone to the other.
 *   POST   { safe, from? }              → { id }
 *   PUT    { id, x, y, name? }          → the friend's answer (once)
 *   GET    ?id                          → { safe, from, answer? }
 *   DELETE ?id                          → gone (added, or not wanted)
 */
const TTL = 7 * 24 * 3600;
const k = (id: string) => `invite:${id}`;
type Invite = { safe: string; from?: string; at: number; answer?: { x: string; y: string; name?: string; at: number } };
const out = (v: unknown, status = 200) => NextResponse.json(v, { status, headers: { "Cache-Control": "no-store" } });
const clean = (s: unknown, n = 40) => (typeof s === "string" ? s.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n) : undefined) || undefined;
const idOk = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{16,32}$/.test(id);
const key32 = (v: unknown) => isHex(v) && v.length === 66;

export async function POST(req: NextRequest) {
  try {
    const b = JSON.parse((await req.text()).slice(0, 2000));
    if (!isAddress(b.safe)) throw new Error("safe?");
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(15))).toString("base64url");
    await stash(k(id), { safe: getAddress(b.safe), from: clean(b.from), at: Date.now() } satisfies Invite, TTL);
    return out({ id });
  } catch (e: any) {
    return out({ error: e?.message || String(e) }, 400);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const b = JSON.parse((await req.text()).slice(0, 2000));
    if (!idOk(b.id) || !key32(b.x) || !key32(b.y)) throw new Error("id or key?");
    const inv = await unstash<Invite>(k(b.id));
    if (!inv) throw new Error("That invite is gone. Ask for a new one.");
    if (inv.answer) throw new Error("Someone already answered this invite. Ask for a new one.");
    inv.answer = { x: b.x, y: b.y, name: clean(b.name), at: Date.now() };
    await stash(k(b.id), inv, TTL);
    return out({ ok: true });
  } catch (e: any) {
    return out({ error: e?.message || String(e) }, 400);
  }
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!idOk(id)) return out({ error: "id?" }, 400);
  const inv = await unstash<Invite>(k(id));
  return inv ? out(inv) : out({ error: "That invite is gone. Ask for a new one." }, 404);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!idOk(id)) return out({ error: "id?" }, 400);
  await drop(k(id));
  return out({ ok: true });
}
