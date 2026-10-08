import type { Address, Hex } from "viem";
import { assertChallengePrf } from "../../passkey";
import { encodeWebAuthn } from "../core";
import { toWebAuthnSig } from "../sign";
import { type WorkerReq, type WorkerRes, commitOf, pqSalt } from "./message";

export { commitOf, pqMessage, pqSalt } from "./message";

/**
 * EXPERIMENTAL post-quantum hybrid owner (docs/PQ-HYBRID.md, contract packages/foundry/contracts/pq/HybridPQSigner.sol).
 * One passkey tap gives: the P-256 signature over the Safe tx hash, and two PRF secrets — hash key `index` (signs
 * now) and hash key `index + 1` (its commitment becomes the next key). Hash-key signing runs in a Web Worker.
 */

function runWorker(req: WorkerReq): Promise<Extract<WorkerRes, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerRes>) => {
      w.terminate();
      e.data.ok ? resolve(e.data) : reject(new Error(e.data.error));
    };
    w.onerror = e => {
      w.terminate();
      reject(new Error(e.message || "post-quantum signer crashed"));
    };
    w.postMessage(req);
  });
}

/** The commitment for hash key `index` (opt-in: the HybridPQSigner is deployed with commit(0)). */
export async function pqCommit(material: Uint8Array): Promise<Hex> {
  const r = await runWorker({ kind: "pub", material });
  return commitOf(r.pkSeed, r.pkRoot);
}

export type HybridApproval = {
  webauthn: Hex; // the Safe contract-signature payload (checked by the passkey's own signer)
  pkSeed: Hex;
  pkRoot: Hex;
  pqSig: Hex;
  next: Hex;
  ms: { tap: number; next?: number; key: number; sign?: number };
};

/** One Face ID → everything HybridPQSigner.approve + execTransaction need for `safeTxHash`. */
export async function hybridSign(
  credentialId: string | undefined,
  chainId: number,
  signer: Address,
  index: bigint,
  safeTxHash: Hex,
): Promise<HybridApproval> {
  const t0 = performance.now();
  const a = await assertChallengePrf(credentialId, safeTxHash, pqSalt(index), pqSalt(index + 1n));
  const tap = performance.now() - t0;
  if (!a.prf || !a.prfSecond) throw new Error("This passkey doesn't support PRF, so it can't make a post-quantum key.");
  const r = await runWorker({
    kind: "sign",
    material: a.prf,
    nextMaterial: a.prfSecond,
    chainId,
    signer,
    index: index.toString(),
    safeTxHash,
  });
  return {
    webauthn: encodeWebAuthn(toWebAuthnSig(a.authenticatorData, a.clientDataJSON, a.r, a.s, safeTxHash)),
    pkSeed: r.pkSeed,
    pkRoot: r.pkRoot,
    pqSig: r.sig!,
    next: r.next!,
    ms: { tap, ...r.ms },
  };
}

