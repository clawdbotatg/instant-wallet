import type { Hash, Hex } from "viem";
import { relayJson } from "./relayFund";
import { callsOf } from "./describe";
import { selfFirst, waitFor } from "./send";
import { execData } from "./core";
import { hotSend } from "./hot";
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
    const signatures = allSignatures({ ...w, sigs });
    let hash: Hash;
    if (await selfFirst(w.chainId)) hash = await hotSend(w.chainId, w.safe, execData(w.tx, signatures));
    else {
      const { ok, status, j } = await relayJson(w.chainId, "/api/safe/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId: w.chainId, kind: "exec", safe: w.safe, tx: w.tx, signatures, wedgie }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      if (!ok) throw new Error(j.error || `relay: ${status}`);
      hash = j.hash;
    }
    sentOut(w.hash, hash);
    out.hash(hash);
    onStage("confirming", hash);
    await waitFor(w.chainId, hash);
    return hash;
  } finally {
    out.done();
  }
}
