import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress, isHex } from "viem";
import { type FirstKeyInput, ensureDeployed } from "~~/services/factory";
import { META_FUNCTIONS, type MetaFunction, isBytes32, normalizeMeta, relayMeta } from "~~/services/relay";
import { setLabel } from "~~/services/store";
import { chainId } from "~~/utils/chain";
import { ZERO_BYTES32, decodeAdminCalls, signerIdOf } from "~~/utils/digests";

export const dynamic = "force-dynamic";

function firstKeyFrom(body: any): FirstKeyInput | null {
  const k = body?.firstKey;
  if (!k || !isBytes32(k.qx) || !isBytes32(k.qy)) return null;
  const kind = Number(k.kind ?? 0);
  if (kind !== 0 && kind !== 1) return null;
  return {
    qx: k.qx,
    qy: k.qy,
    kind,
    credentialIdHash: isBytes32(k.credentialIdHash) ? k.credentialIdHash : ZERO_BYTES32,
  };
}

/**
 * Passkey path (docs/PROTOCOL.md section 6):
 * `POST {wallet, chainId, functionName, args, signerId, deadline, signature, firstKey?}` -> simulate,
 * send, wait -> `{txHash}`. `functionName` must be one of the meta* functions; `args` are the
 * function's own arguments (before signerId/deadline/signature), JSON-encoded (bigints as decimal
 * strings). If the wallet has no code yet, `Factory.createWallet` goes first (the first key comes
 * from the registry, or from `firstKey` when it predicts this address), then the meta call.
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

    const norm = normalizeMeta(functionName, args);
    const w = getAddress(wallet);
    const deploy = await ensureDeployed(w, firstKeyFrom(body));
    const result = await relayMeta(w, functionName as MetaFunction, norm.args, getAddress(signerId), dl, signature);
    if (result.status !== "success")
      return NextResponse.json({ error: "transaction reverted", ...result }, { status: 500 });

    if (functionName === "metaAddSigner" && typeof body.label === "string") {
      const [qx, qy] = norm.args as readonly [`0x${string}`, `0x${string}`, ...unknown[]];
      await setLabel(w, signerIdOf(qx, qy), body.label);
    }
    if (functionName === "metaExecute" && body.labels && typeof body.labels === "object") {
      for (const op of decodeAdminCalls(w, norm.args[0] as any) ?? []) {
        if (op.op !== "addSigner") continue;
        const id = signerIdOf(op.qx, op.qy);
        const label = body.labels[id] ?? body.labels[id.toLowerCase()];
        if (typeof label === "string") await setLabel(w, id, label);
      }
    }
    return NextResponse.json({ ...result, deployTxHash: deploy.txHash });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
