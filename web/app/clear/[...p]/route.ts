import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isLocalHost } from "@/lib/local";

export const dynamic = "force-dynamic";

/**
 * /clear/<path>.json: what the wedgie shows when it signs (wedgie.dev/clear/, made by wedgie-dev release.py), on a
 * copy of the wallet running on your own computer. From your own copy (WEDGIE_CLEAR_DIR: run-local.sh gets it), else
 * wedgie.dev. Each file carries its own proof to a root inside the wedgie, so where it comes from doesn't matter.
 * Never on our site: the page there reads wedgie.dev itself (lib/safe/wedgie.ts).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ p: string[] }> }) {
  const no = () => NextResponse.json({ error: "not here" }, { status: 404 });
  if (process.env.VERCEL || !isLocalHost((req.headers.get("host") || "").split(":")[0])) return no();
  const p = (await params).p;
  if (!p.length || p.some(s => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s)) || !p[p.length - 1].endsWith(".json")) return no();
  const dir = process.env.WEDGIE_CLEAR_DIR;
  const body = dir ? await readFile(join(dir, ...p), "utf8").catch(() => null) : null;
  if (body) return new NextResponse(body, { headers: { "content-type": "application/json" } });
  const r = await fetch(`https://wedgie.dev/clear/${p.join("/")}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r?.ok) return no();
  return new NextResponse(await r.text(), { headers: { "content-type": "application/json" } });
}
