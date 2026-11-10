import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse, after } from "next/server";
import { refresh, totals } from "@/lib/dash";
import { kv } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FRESH = 5 * 60; // seconds

/**
 * The private dashboard (/dashboard, lib/dash.ts).
 *   GET                → { ok, at }   reads the chains again if the totals are over 5 minutes old (or a chain is still being read from its start). Open to anyone and
 *                        answers no numbers: it only keeps them fresh (.github/workflows/dash.yaml, every 10 minutes).
 *   POST { password }  → { token }   the shared password (DASH_PASSWORD; unset = nobody gets in). 30-day session.
 *                        20 wrong tries in 10 minutes and logging in stops for the rest of them.
 *   POST { token }     → { totals, refreshing }   the saved totals at once; if they're old a new read starts behind the
 *                        answer, and the page asks again.
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

const same = (a: string, b: string) => {
  const [x, y] = [createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest()];
  return timingSafeEqual(x, y);
};

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (typeof b?.password === "string") {
    const want = process.env.DASH_PASSWORD;
    await kv(["SET", "dash:fail", 0, "EX", 600, "NX"]);
    if (Number(await kv(["GET", "dash:fail"])) >= 20) return NextResponse.json({ error: "Too many wrong tries. Wait 10 minutes." }, { status: 429 });
    if (!want || !same(b.password.trim(), want)) {
      await kv(["INCR", "dash:fail"]);
      return NextResponse.json({ error: "Wrong password." }, { status: 403 });
    }
    const token = randomBytes(24).toString("hex");
    await kv(["SET", `dash:s:${token}`, 1, "EX", 30 * 86_400]);
    return NextResponse.json({ token });
  }
  if (typeof b?.token !== "string" || !/^[0-9a-f]{48}$/.test(b.token) || !(await kv(["GET", `dash:s:${b.token}`]))) return NextResponse.json({ error: "Log in again." }, { status: 401 });
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
