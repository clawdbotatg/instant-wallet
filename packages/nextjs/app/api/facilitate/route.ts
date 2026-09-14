import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress, isHex } from "viem";
import { isDeployed } from "~~/services/chain";
import { META_FUNCTIONS, type MetaFunction, normalizeMeta, relayMeta } from "~~/services/relay";
import { setLabel } from "~~/services/store";
import { chainId } from "~~/utils/chain";

export const dynamic = "force-dynamic";

/**
 * Passkey path (docs/PROTOCOL.md section 6):
 * `POST {wallet, chainId, functionName, args, signerId, deadline, signature}` -> simulate, send,
 * wait -> `{txHash}`. `functionName` must be one of the meta* functions; `args` are the function's
 * own arguments (before signerId/deadline/signature), JSON-encoded (bigints as decimal strings).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    const { wallet, functionName, args, signerId, deadline, signature } = body;
    if (Number(body.chainId) !== chainId)
      return NextResponse.json({ error: `wrong chainId (expected ${chainId})` }, { status: 400 });
    if (!isAddress(wallet) || !isAddress(signerId))
      return NextResponse.json({ error: "wallet and signerId must be addresses" }, { status: 400 });
    if (!META_FUNCTIONS.includes(functionName))
      return NextResponse.json({ error: `function not allowed: ${functionName}` }, { status: 400 });
    if (typeof signature !== "string" || !isHex(signature) || signature.length < 130) {
      return NextResponse.json({ error: "signature must be hex" }, { status: 400 });
    }
    if (!/^\d+$/.test(String(deadline)))
      return NextResponse.json({ error: "deadline must be a unix timestamp" }, { status: 400 });
    const dl = BigInt(deadline);
    if (dl < BigInt(Math.floor(Date.now() / 1000)))
      return NextResponse.json({ error: "deadline passed" }, { status: 400 });
    if (!(await isDeployed(getAddress(wallet))))
      return NextResponse.json({ error: "wallet is not deployed" }, { status: 400 });

    const norm = normalizeMeta(functionName, args);
    const result = await relayMeta(
      getAddress(wallet),
      functionName as MetaFunction,
      norm.args,
      getAddress(signerId),
      dl,
      signature,
    );
    if (result.status !== "success")
      return NextResponse.json({ error: "transaction reverted", ...result }, { status: 500 });

    if (functionName === "metaAddSigner" && typeof body.label === "string") {
      const { signerIdOf } = await import("~~/utils/digests");
      const [qx, qy] = norm.args as readonly [`0x${string}`, `0x${string}`, ...unknown[]];
      await setLabel(getAddress(wallet), signerIdOf(qx, qy), body.label);
    }
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
