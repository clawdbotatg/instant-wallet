import { NextResponse } from "next/server";
import { channels } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/**
 * `GET /api/features` → which parts this server can run, by the keys it has. Our site has them all; a copy on your
 * own computer (run-local.sh) or a fork may not, and then the app hides that part instead of showing it broken.
 */
export async function GET() {
  const c = channels();
  return NextResponse.json({
    deposit: !!process.env.CDP_API_KEY_ID && !!process.env.CDP_API_KEY_SECRET,
    alerts: c.email || c.telegram || c.push,
    names: !!process.env.NAME_SIGNER_KEY,
  });
}
