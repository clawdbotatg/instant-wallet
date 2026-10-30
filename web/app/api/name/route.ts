import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";

export const dynamic = "force-dynamic";

/**
 * A wallet's name, shared by every device its passkey syncs to (lib/walletName.ts). The browser encrypts it with a
 * key from the passkey's credential id, which never leaves the user's devices, and stores it under an id made the
 * same way: we only ever see an opaque id and ciphertext.
 *   GET  ?id        → { box } or { box: null }
 *   PUT  { id, box } → { ok }
 */
const ID = /^0x[0-9a-f]{64}$/;
const BOX = /^[A-Za-z0-9_-]{20,600}$/;
const key = (id: string) => `iws:name:${id}`;
const YEAR = 365 * 86400;

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!ID.test(id)) return NextResponse.json({ error: "id?" }, { status: 400 });
  return NextResponse.json({ box: await kv(["GET", key(id)]) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.id !== "string" || !ID.test(b.id) || typeof b.box !== "string" || !BOX.test(b.box)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  await kv(["SET", key(b.id), b.box, "EX", YEAR]);
  return NextResponse.json({ ok: true });
}
