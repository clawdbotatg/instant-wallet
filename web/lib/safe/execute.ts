import type { Hash, Hex } from "viem";
import { callsOf } from "./describe";
import { waitFor } from "./send";
import { startSending } from "./sending";
import { type Waiting, allSignatures } from "./share";

/** Tell the page a waiting tx went out (Home drops its card, Activity shows it executing). */
export const sentOut = (safeTx: Hex, hash: Hash) => window.dispatchEvent(new CustomEvent("iw:txsent", { detail: { safeTx, hash } }));

/**
 * Execute a waiting tx that has enough signatures: the relay sends it, and this waits until it's in a block.
 * One function for Home's card and the tx's own page, so Execute does the same thing in both.
 * `wedgie`: a second passkey signer is among the owners (its signature costs more gas to check).
 */
export async function executeWaiting(w: Waiting, sigs: Waiting["sigs"], wedgie: boolean, onStage: (s: "sending" | "confirming", hash?: Hash) => void): Promise<Hash> {
  onStage("sending");
  const out = startSending(w.chainId, w.safe, callsOf(w.tx));
  try {
    const r = await fetch("/api/safe/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: w.chainId, kind: "exec", safe: w.safe, tx: w.tx, signatures: allSignatures({ ...w, sigs }), wedgie }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `relay: ${r.status}`);
    sentOut(w.hash, j.hash);
    out.hash(j.hash);
    onStage("confirming", j.hash);
    await waitFor(w.chainId, j.hash);
    return j.hash;
  } finally {
    out.done();
  }
}
