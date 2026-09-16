import { NextRequest, NextResponse } from "next/server";
import { type Hex } from "viem";
import { isDeployed } from "~~/services/chain";
import { ensureDeployed, predictWallet, registerFirstKey } from "~~/services/factory";
import { isBytes32 } from "~~/services/relay";
import { getFirstKey } from "~~/services/store";
import { chainId } from "~~/utils/chain";
import { ZERO_BYTES32, signerIdOf } from "~~/utils/digests";
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

export const dynamic = "force-dynamic";

/** Predict the CREATE2 address (the wallet's address from the moment the key exists). */
export async function GET(req: NextRequest) {
  try {
    const qx = req.nextUrl.searchParams.get("qx");
    const qy = req.nextUrl.searchParams.get("qy");
    if (!isBytes32(qx) || !isBytes32(qy))
      return NextResponse.json({ error: "qx and qy must be bytes32" }, { status: 400 });
    const wallet = await predictWallet(qx, qy);
    const [deployed, known] = await Promise.all([isDeployed(wallet), getFirstKey(wallet)]);
    return NextResponse.json({ wallet, signerId: signerIdOf(qx, qy), chainId, deployed, registered: !!known });
  } catch (e) {
    return NextResponse.json({ error: getParsedError(e) }, { status: 500 });
  }
}

/**
 * `POST {qx, qy, kind, credentialIdHash}` -> explicit Factory.createWallet (idempotent). The UI never
 * needs this: the facilitator deploys on the fly before the first meta call. Kept for an explicit
 * deploy (e.g. before pairing a device) and for tests. Also registers the key like /api/register.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { qx, qy } = body;
    if (!isBytes32(qx) || !isBytes32(qy))
      return NextResponse.json({ error: "qx and qy must be bytes32" }, { status: 400 });
    const kind = Number(body.kind ?? 0);
    if (kind !== 0 && kind !== 1)
      return NextResponse.json({ error: "kind must be 0 (passkey) or 1 (raw)" }, { status: 400 });
    const credentialIdHash: Hex = isBytes32(body.credentialIdHash) ? body.credentialIdHash : ZERO_BYTES32;
    const key = { qx, qy, kind, credentialIdHash };
    const { wallet, deployed } = await registerFirstKey(key);
    const signerId = signerIdOf(qx, qy);
    if (deployed) return NextResponse.json({ wallet, signerId, chainId, alreadyDeployed: true });
    const { txHash } = await ensureDeployed(wallet, key);
    return NextResponse.json({ wallet, signerId, chainId, txHash });
  } catch (e) {
    return NextResponse.json({ error: getParsedError(e) }, { status: 500 });
  }
}
