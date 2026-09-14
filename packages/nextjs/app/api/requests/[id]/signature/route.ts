import { NextRequest, NextResponse } from "next/server";
import { p256 } from "@noble/curves/nist.js";
import { type Hex } from "viem";
import { isBytes32, isValidSignature, normalizeMeta, relayMeta } from "~~/services/relay";
import { metaArgsOf } from "~~/services/requests";
import { findRequest, listRequests, patchRequest } from "~~/services/store";
import { readSigner } from "~~/services/wallet";
import { bigintToHex32, encodeRawSignature, hexToBytes, toLowS } from "~~/utils/webauthn";

export const dynamic = "force-dynamic";

/** Off-chain P-256 check of (r, s) over the 32-byte digest against the signer's stored key. */
function verifyRaw(qx: Hex, qy: Hex, digest: Hex, r: Hex, s: Hex): boolean {
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(hexToBytes(qx), 1);
  pub.set(hexToBytes(qy), 33);
  const sig = new Uint8Array(64);
  sig.set(hexToBytes(r), 0);
  sig.set(hexToBytes(s), 32);
  try {
    return p256.verify(sig, hexToBytes(digest), pub, { prehash: false, lowS: false });
  } catch {
    return false;
  }
}

/**
 * The device posts `{r, s}`. We verify off chain (noble) AND on chain (`isValidSignature`), then
 * the facilitator relays the matching meta* call with the 64-byte `r ‖ s` signature.
 * Status: pending -> signed -> relaying -> confirmed | failed.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await findRequest(id);
  if (!request) return NextResponse.json({ error: "unknown request" }, { status: 404 });
  if (request.status !== "pending") {
    return NextResponse.json(
      { error: `request is ${request.status}`, status: request.status, txHash: request.txHash },
      { status: 409 },
    );
  }
  const body = await req.json().catch(() => ({}));
  if (!isBytes32(body.r) || !isBytes32(body.s))
    return NextResponse.json({ error: "r and s must be 0x-prefixed 32-byte hex" }, { status: 400 });
  const r = body.r as Hex;
  const s = bigintToHex32(toLowS(BigInt(body.s)));

  if (request.deadline < Math.floor(Date.now() / 1000)) {
    await patchRequest(id, { status: "expired", error: "signed after the deadline" });
    return NextResponse.json({ error: "deadline passed", status: "expired" }, { status: 410 });
  }

  const signer = await readSigner(request.wallet, request.signerId).catch(() => undefined);
  if (!signer) {
    await patchRequest(id, { status: "failed", error: "signer is no longer on the wallet" });
    return NextResponse.json({ error: "unknown signer", status: "failed" }, { status: 400 });
  }
  if (signer.kind !== 1) {
    return NextResponse.json(
      { error: "this signer is a passkey; the device queue only takes raw P-256 signatures" },
      { status: 400 },
    );
  }
  if (!verifyRaw(signer.qx, signer.qy, request.digest, r, s)) {
    await patchRequest(id, {
      status: "failed",
      error: "signature does not verify against the signer's key",
      signature: { r, s },
    });
    return NextResponse.json({ error: "bad signature", status: "failed" }, { status: 400 });
  }
  const signature = encodeRawSignature(r, s);
  const onchainOk = await isValidSignature(request.wallet, request.signerId, request.digest, signature).catch(
    () => false,
  );
  if (!onchainOk) {
    await patchRequest(id, {
      status: "failed",
      error: "contract rejected the signature (isValidSignature)",
      signature: { r, s },
    });
    return NextResponse.json({ error: "bad signature (on chain)", status: "failed" }, { status: 400 });
  }

  await patchRequest(id, { status: "signed", signature: { r, s }, signedAt: Date.now() });
  try {
    await patchRequest(id, { status: "relaying" });
    const { fn, args } = metaArgsOf(request);
    const norm = normalizeMeta(fn, args);
    const result = await relayMeta(
      request.wallet,
      fn,
      norm.args,
      request.signerId,
      BigInt(request.deadline),
      signature,
    );
    const done = await patchRequest(id, {
      status: result.status === "success" ? "confirmed" : "failed",
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      relayer: result.relayer,
      error: result.status === "success" ? undefined : "transaction reverted",
    });
    return NextResponse.json({
      status: done.status,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      request: done,
    });
  } catch (e: any) {
    const error = e?.message || String(e);
    await patchRequest(id, { status: "failed", error });
    // Later requests for this wallet were built on a nonce that will now never happen — fail them too.
    const later = (await listRequests()).filter(
      r2 =>
        r2.wallet.toLowerCase() === request.wallet.toLowerCase() &&
        ["pending", "signed"].includes(r2.status) &&
        BigInt(r2.nonce) > BigInt(request.nonce),
    );
    for (const r2 of later) {
      await patchRequest(r2.id, { status: "failed", error: `queued behind request ${id}, which failed` }).catch(
        () => {},
      );
    }
    return NextResponse.json({ error, status: "failed" }, { status: 500 });
  }
}
