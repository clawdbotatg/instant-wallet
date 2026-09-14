import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { createRequest } from "~~/services/requests";
import { expireStale, listRequests } from "~~/services/store";

export const dynamic = "force-dynamic";

/** List requests. The device polls `?status=pending&signerId=0x…` (oldest first); the UI reads `?wallet=0x…`. */
export async function GET(req: NextRequest) {
  await expireStale();
  const q = req.nextUrl.searchParams;
  const status = q.get("status");
  const signerId = q.get("signerId");
  const wallet = q.get("wallet");
  let requests = await listRequests();
  if (status) requests = requests.filter(r => r.status === status);
  if (signerId && isAddress(signerId))
    requests = requests.filter(r => r.signerId.toLowerCase() === signerId.toLowerCase());
  if (wallet && isAddress(wallet)) requests = requests.filter(r => r.wallet.toLowerCase() === wallet.toLowerCase());
  if (status === "pending") requests = [...requests].sort((a, b) => a.createdAt - b.createdAt);
  return NextResponse.json({ requests });
}

/** Browser: create a request for a signer. The server recomputes and cross-checks the digest. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    const request = await createRequest(body);
    return NextResponse.json({ request }, { status: 201 });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const status = /mismatch/.test(msg) ? 500 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
