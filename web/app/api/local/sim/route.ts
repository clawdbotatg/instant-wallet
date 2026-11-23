import { NextRequest, NextResponse } from "next/server";
import { isLocalHost } from "@/lib/local";

export const dynamic = "force-dynamic";

/**
 * Your own simulator (clawdbotatg/iw-sim, started by run-local.sh on SIM_URL), passed through as it is: the page
 * checks its signed answer (lib/safe/sim.ts). Never on our site (404). On with Settings → No external traffic too:
 * it then reads only your nodes, and prices from your indexer (run-local.sh: PRICES_URL, NO_EXTERNAL_FILE).
 */
const local = (req: NextRequest) =>
  !process.env.VERCEL &&
  !!process.env.SIM_URL &&
  isLocalHost((req.headers.get("host") || "").split(":")[0]);
const pass = (r: Response) =>
  new NextResponse(r.body, {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
const down = () =>
  NextResponse.json({ error: "your simulator isn't running" }, { status: 502 });

export async function GET(req: NextRequest) {
  if (!local(req))
    return NextResponse.json({ error: "not here" }, { status: 404 });
  return fetch(process.env.SIM_URL!, {
    signal: AbortSignal.timeout(3000),
    cache: "no-store",
  }).then(pass, down);
}

export async function POST(req: NextRequest) {
  if (!local(req))
    return NextResponse.json({ error: "not here" }, { status: 404 });
  // JSON only, like the other local routes: another site can't send that here without asking first
  if (!(req.headers.get("content-type") || "").startsWith("application/json"))
    return NextResponse.json({ error: "JSON only" }, { status: 415 });
  const body = await req.text();
  return fetch(process.env.SIM_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  }).then(pass, down);
}
