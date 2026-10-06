"use client";

import { useState } from "react";
import { encodeFunctionData } from "viem";
import { chainById } from "@/lib/chains";
import { short } from "@/lib/format";
import { RECOVERY_7D } from "@/lib/safe/config";
import { abi } from "@/lib/safe/core";
import { ownerSigners, ownersSend } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { friendly } from "../Welcome";

/** A recovery is running on this wallet: say so loudly, with the date it lands and a Cancel. */
export function RecoveryAlert({ account, state, onDone }: { account: SafeAccount; state: ChainState; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = state.recovery!;
  const when = new Date(r.executeAfter);
  const mine = r.newOwners.some(o => o.toLowerCase() === account.burnerSigner.toLowerCase());
  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await ownersSend({
        account,
        state,
        calls: [{ to: RECOVERY_7D, value: 0n, data: encodeFunctionData({ abi: abi.recovery, functionName: "cancelRecovery" }) }],
        signers: ownerSigners(state),
        feeToken: "usdc",
      });
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
        On {chainById(state.chainId)?.name}, your keys get replaced by {r.newOwners.map(short).join(", ")} on {when.toLocaleString()}.{" "}
        {mine ? "That's this phone." : "If that isn't you, cancel it now."}
      </p>
      {!mine && (
        <button className="btn btn-red wide" onClick={cancel} disabled={busy}>
          {busy ? "Cancelling…" : "Cancel it"}
        </button>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
