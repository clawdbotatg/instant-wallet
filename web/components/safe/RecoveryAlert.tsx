"use client";

import { useState } from "react";
import { encodeFunctionData } from "viem";
import { chainById } from "@/lib/chains";
import { short } from "@/lib/format";
import { RECOVERY_7D } from "@/lib/safe/config";
import { abi } from "@/lib/safe/core";
import { type Prepared, finishOwners, ownerSigners, prepareOwners } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { friendly } from "../Welcome";

/** A recovery is running on this wallet: say so loudly, with the date it lands and a Cancel. */
export function RecoveryAlert({
  account,
  state,
  feeToken,
  onDone,
}: {
  account: SafeAccount;
  state: ChainState;
  feeToken: "usdc" | "eth";
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = state.recovery!;
  const when = new Date(r.executeAfter);
  // only "mine" when it hands the wallet to exactly this phone (a recovery to [this phone, someone else] is not)
  const mine = !!account.recovered && r.newOwners.length === 1 && r.newOwners[0].toLowerCase() === account.burnerSigner.toLowerCase();
  const [ready, setReady] = useState<Prepared | null>(null);
  // two taps: get it ready, then sign (Face ID must start straight from a tap)
  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      setReady(
        await prepareOwners({
          account,
          state,
          calls: [{ to: RECOVERY_7D, value: 0n, data: encodeFunctionData({ abi: abi.recovery, functionName: "cancelRecovery" }) }],
          signers: ownerSigners(state, account),
          feeToken,
        }),
      );
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await finishOwners(ready);
      setReady(null);
      onDone();
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card alert">
      <b>{mine ? "Your recovery is running" : "Someone is recovering this wallet"}</b>
      <p className="fine">
        On {chainById(state.chainId)?.name}, your keys get replaced by {r.newOwners.map(short).join(", ")}
        {r.newOwners.length > 1 ? ` (any ${r.newThreshold} of them)` : ""} on {when.toLocaleString()}.{" "}
        {mine ? "That's this phone." : "If that isn't you, cancel it now."}
      </p>
      {!mine && state.owners.some(o => o.toLowerCase() === account.burnerSigner.toLowerCase()) && (
        <button className="btn btn-red wide" onClick={ready ? cancel : prepare} disabled={busy}>
          {busy ? (ready ? "Cancelling…" : "Getting ready…") : ready ? "Sign to cancel it" : "Cancel it"}
        </button>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
