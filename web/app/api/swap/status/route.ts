import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** A cross-chain swap's progress: `GET /api/swap/status?hash=0x…&fromChain=8453&toChain=1` → LI.FI's status, trimmed. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const hash = q.get("hash") || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return NextResponse.json({ error: "hash?" }, { status: 400 });
  const url = `https://li.quest/v1/status?txHash=${hash}&fromChain=${Number(q.get("fromChain"))}&toChain=${Number(q.get("toChain"))}`;
  const key = process.env.LIFI_API_KEY;
  try {
    const j = await fetch(url, { headers: key ? { "x-lifi-api-key": key } : {}, cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(r => r.json());
    // NOT_FOUND / PENDING / DONE / FAILED; substatus says COMPLETED, PARTIAL (got another token) or REFUNDED
    return NextResponse.json({ status: j.status ?? "NOT_FOUND", substatus: j.substatus, receiving: j.receiving?.txHash, amount: j.receiving?.amount });
  } catch (e: any) {
    return NextResponse.json({ status: "NOT_FOUND", error: e?.message }, { status: 200 });
  }
}
