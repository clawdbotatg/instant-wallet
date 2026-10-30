"use client";

import { useState } from "react";
import { type Address, encodeFunctionData } from "viem";
import { chainById, explorerAddress } from "@/lib/chains";
import { short } from "@/lib/format";
import { abi } from "@/lib/safe/core";
import { type Prepared, Shared, finishOwners, ownerSigners, prepareOwners } from "@/lib/safe/send";
import type { ChainState, RecoveryOn, SafeAccount } from "@/lib/safe/state";
import { SAFE_SVC } from "@/lib/safe/share";
import { Eject, Who } from "../bits";
import { friendly } from "../Welcome";
import { ErrorLine } from "./WedgieButton";

/** A recovery is running on this wallet: say so loudly, with the date it lands and a Cancel. */
export function RecoveryAlert({
  account,
  state,
  rec,
  feeToken,
  onDone,
}: {
  account: SafeAccount;
  state: ChainState;
  rec: RecoveryOn; // the module it runs on (with the wedgie, yours and the DAO's are two)
  feeToken: "usdc" | "eth";
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = rec.request!;
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
          calls: [{ to: rec.module, value: 0n, data: encodeFunctionData({ abi: abi.recovery, functionName: "cancelRecovery" }) }],
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
      if (e instanceof Shared) return setReady(null); // its page has the sheet now
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
      {error && <ErrorLine text={error} />}
    </div>
  );
}

/** Something this app didn't add can control the wallet: a module (moves money with no signatures) or a guard (can
 * block every transaction). Read on every network (state.ts strangers, guard); wedgie.dev lists these as Add-ons. */
export function AddonAlert({ safe, state }: { safe: Address; state: ChainState }) {
  const c = SAFE_SVC[state.chainId];
  return (
    <div className="card alert stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <b>⚠️ Something else controls your wallet on {chainById(state.chainId)?.name}</b>
        {c && (
          <Eject href={`https://app.safe.global/settings/modules?safe=${c.app ?? c.key}:${safe}`} title="Open in Safe{Wallet}">
            Safe
          </Eject>
        )}
      </div>
      {state.strangers.map(m => (
        <div key={m} className="stack" style={{ gap: 2 }}>
          <Who address={m} chain={state.chainId} link={explorerAddress(state.chainId, m) ?? undefined} />
          <span className="fine">Can move your money with no signatures. If you didn&apos;t add it, move your money out now.</span>
        </div>
      ))}
      {state.guard && (
        <div className="stack" style={{ gap: 2 }}>
          <Who address={state.guard} chain={state.chainId} link={explorerAddress(state.chainId, state.guard) ?? undefined} />
          <span className="fine">Can block every transaction from this wallet.</span>
        </div>
      )}
    </div>
  );
}
