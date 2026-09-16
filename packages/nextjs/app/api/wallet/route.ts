import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { onchainNonce, walletSnapshot } from "~~/services/wallet";
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

export const dynamic = "force-dynamic";

/** `GET /api/wallet?address=0x…` -> portfolio (ETH + tokens, USD), signers (+per-asset limits), nonce, recovery, activity. Works before deployment. */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address || !isAddress(address))
    return NextResponse.json({ error: "address query param required" }, { status: 400 });
  try {
    if (req.nextUrl.searchParams.get("nonce")) {
      return NextResponse.json({ nonce: (await onchainNonce(getAddress(address))).toString() });
    }
    return NextResponse.json(await walletSnapshot(getAddress(address)));
  } catch (e) {
    return NextResponse.json({ error: getParsedError(e) }, { status: 500 });
  }
}
