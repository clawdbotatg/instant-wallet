/// <reference lib="webworker" />
import { toHex } from "viem";
import { commitOf, pqMessage, type WorkerReq, type WorkerRes } from "./message";
import { C11, keygen, sign } from "./sphincs";

// SPHINCS- work off the main thread (~1 s on a laptop, more on a phone). See hybrid.ts.
self.onmessage = (e: MessageEvent<WorkerReq>) => {
  const post = (r: WorkerRes) => (self as unknown as Worker).postMessage(r);
  try {
    const req = e.data;
    let t = performance.now();
    if (req.kind === "pub") {
      const k = keygen(C11, req.material);
      return post({ ok: true, pkSeed: toHex(k.pkSeed), pkRoot: toHex(k.pkRoot), ms: { key: performance.now() - t } });
    }
    const n = keygen(C11, req.nextMaterial);
    const next = commitOf(toHex(n.pkSeed), toHex(n.pkRoot));
    const msNext = performance.now() - t;
    t = performance.now();
    const k = keygen(C11, req.material);
    const msKey = performance.now() - t;
    t = performance.now();
    const sig = sign(C11, k, toBytes32(pqMessage(req.chainId, req.signer, BigInt(req.index), req.safeTxHash, next)));
    post({ ok: true, pkSeed: toHex(k.pkSeed), pkRoot: toHex(k.pkRoot), next, sig: toHex(sig), ms: { next: msNext, key: msKey, sign: performance.now() - t } });
  } catch (err) {
    post({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

function toBytes32(h: `0x${string}`): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return b;
}
