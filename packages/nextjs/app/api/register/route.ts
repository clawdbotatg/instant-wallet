import { NextRequest, NextResponse } from "next/server";
import { type Hex } from "viem";
import { registerFirstKey } from "~~/services/factory";
import { isBytes32 } from "~~/services/relay";
import { chainId } from "~~/utils/chain";
import { ZERO_BYTES32, signerIdOf } from "~~/utils/digests";
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

export const dynamic = "force-dynamic";

/**
 * `POST {qx, qy, kind, credentialIdHash}` -> `{wallet, signerId, chainId, deployed}`.
 * Registers the first key of the counterfactual wallet it predicts (no transaction). From here the
 * wallet UI works: the key is its sole owner, the nonce is 0, and the facilitator deploys the
 * wallet right before its first outbound action (docs/PROTOCOL.md section 6).
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
    const { wallet, deployed } = await registerFirstKey({ qx, qy, kind, credentialIdHash });
    return NextResponse.json({ wallet, signerId: signerIdOf(qx, qy), chainId, deployed });
  } catch (e) {
    return NextResponse.json({ error: getParsedError(e) }, { status: 500 });
  }
}
