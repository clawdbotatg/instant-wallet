import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { tooMany } from "@/lib/limit";
import { fullName, labelIn, labelProblem, nameChallenge } from "@/lib/names";
import { claimName, nameOwner, namesOf } from "@/lib/namesStore";
import { passkeyOwner } from "@/lib/passkeyAuth";

export const dynamic = "force-dynamic";

/**
 * A wallet's public name, alice.inst.eth (lib/names.ts). Free, first come.
 *   GET  ?name=alice[&address=0x…] → { label, name, free, yours, problem }   as someone types
 *   GET  ?address=0x…              → { name, names }                          the one it shows, and all it holds
 *   POST { label, address, ts, qx, qy, r, s, authenticatorData, clientDataJSON } → { name, names }
 *        Face ID over nameChallenge(address, label, ts), from the wallet's own passkey. Takes a free name, or
 *        switches back to one the wallet already holds. A name never moves to another wallet and is never freed.
 */
const none = { headers: { "Cache-Control": "no-store" } };

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const address = q.get("address") ?? "";
  if (q.has("name")) {
    if (await tooMany(req, "namecheck", 1200, 3600)) return NextResponse.json({ error: "Too many. Try again later." }, { status: 429 });
    const label = labelIn(q.get("name") ?? "");
    const problem = labelProblem(label);
    if (!label || problem) return NextResponse.json({ label, name: fullName(label), free: false, yours: false, problem }, none);
    const owner = await nameOwner(label);
    const yours = !!owner && isAddress(address) && owner.toLowerCase() === address.toLowerCase();
    return NextResponse.json({ label, name: fullName(label), free: !owner, yours, problem: owner && !yours ? "Taken" : null }, none);
  }
  if (!isAddress(address)) return NextResponse.json({ error: "name or address required" }, { status: 400 });
  const mine = await namesOf(address);
  return NextResponse.json({ name: mine ? fullName(mine.n) : null, names: (mine?.all ?? []).map(fullName) }, none);
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  const label = typeof b?.label === "string" ? b.label : "";
  // the label as signed must be the label as stored: no tidying here
  const problem = labelProblem(label);
  if (!label || problem) return NextResponse.json({ error: problem || "Name?" }, { status: 400 });
  // a room on one Wi-Fi shares an IP: far above what people do, well under what a name-grabbing script wants
  if (await tooMany(req, "nameclaim", 200, 86400)) return NextResponse.json({ error: "Too many. Try again later." }, { status: 429 });
  const who = await passkeyOwner(req, b, "name", (address, ts) => nameChallenge(address, label, ts));
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: who.status });
  try {
    const r = await claimName(label, who.address);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ name: fullName(r.mine.n), names: r.mine.all.map(fullName) }, none);
  } catch {
    return NextResponse.json({ error: "Try again" }, { status: 503 });
  }
}
