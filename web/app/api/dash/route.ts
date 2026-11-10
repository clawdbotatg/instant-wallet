import { NextRequest, NextResponse, after } from "next/server";
import { refresh, totals } from "@/lib/dash";
import { sessionWallet } from "@/lib/drops";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FRESH = 5 * 60; // seconds

/**
 * The private dashboard (/dashboard, lib/dash.ts).
 *   GET                → { ok, at }   reads the chains again if the totals are over 5 minutes old (or a chain is still being read from its start). Open to anyone and
 *                        answers no numbers: it only keeps them fresh (.github/workflows/dash.yaml, every 10 minutes).
 *   POST { token }     → { totals, refreshing }   an admin's session (the /drops login). The saved totals at once; if
 *                        they're old a new read starts behind the answer, and the page asks again.
 */
export async function GET() {
  try {
    const t = await totals();
    const now = Math.floor(Date.now() / 1000);
    const next = t && now - t.at < FRESH && !t.behind.length ? t : await refresh();
    return NextResponse.json({ ok: true, at: next?.at ?? null });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!(await sessionWallet(b?.token))) return NextResponse.json({ error: "Log in again." }, { status: 401 });
  try {
    const t = await totals();
    if (!t) return NextResponse.json({ totals: await refresh(), refreshing: false });
    const old = Math.floor(Date.now() / 1000) - t.at >= FRESH || t.behind.length > 0; // behind: a chain still being read from its start
    if (old) after(refresh().catch(() => null));
    return NextResponse.json({ totals: t, refreshing: old });
  } catch (e: any) {
    return NextResponse.json({ error: e?.shortMessage || "Couldn't read the totals. Try again." }, { status: 500 });
  }
}
