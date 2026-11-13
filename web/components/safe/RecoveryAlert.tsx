"use client";

import { useEffect, useState } from "react";
import { type Address, encodeFunctionData } from "viem";
import { chainById, explorerAddress } from "@/lib/chains";
import { abi } from "@/lib/safe/core";
import { DAO } from "@/lib/safe/config";
import { type Prepared, Shared, finishOwners, ownerSigners, prepareOwners } from "@/lib/safe/send";
import type { ChainState, RecoveryOn, SafeAccount } from "@/lib/safe/state";
import { SAFE_SVC } from "@/lib/safe/share";
import { Net, Eject, Who, stageLabel } from "../bits";
import { when as when_ } from "@/lib/format";
import { friendly } from "@/lib/friendly";
import { ErrorLine } from "./WedgieButton";
import { Progress, useSendProgress } from "./Progress";

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
  const canCancel = !mine && state.owners.some(o => o.toLowerCase() === account.burnerSigner.toLowerCase()); // only a signer can
  const [ready, setReady] = useState<Prepared | null>(null);
  const bar = useSendProgress();
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
      bar.watch(ready);
      await finishOwners(ready);
      setReady(null);
      onDone();
    } catch (e: any) {
      setReady(null); // its page has the sheet now (Shared), or it failed: the next tap gets a fresh fee and number
      if (e instanceof Shared) return;
      setError(friendly(e));
    } finally {
      bar.end();
      setBusy(false);
    }
  }
  return (
    <div className="card alert">
      <b>{mine ? "Your recovery is running" : "Someone is recovering this wallet"}</b>
      <p className="fine">
        On <Net chainId={state.chainId} />, on {when_(when)}, your keys get replaced by
        {r.newOwners.length > 1 ? ` any ${r.newThreshold} of these` : ""}:
      </p>
      {r.newOwners.map(o => (
        <Who key={o} address={o} chain={state.chainId} link={explorerAddress(state.chainId, o) ?? undefined} />
      ))}
      <p className="fine">{mine ? "That's this device." : canCancel ? "If that isn't you, cancel it now." : "If that isn't you, cancel it from a device that signs for this wallet. This one doesn't."}</p>
      {canCancel && (
        <button className="btn btn-red wide" onClick={ready ? cancel : prepare} disabled={busy}>
          {busy ? (ready ? stageLabel("sending") : stageLabel("quote")) : ready ? "Sign to cancel it" : "Cancel it"}
        </button>
      )}
      <Progress stage={bar.stage} chainId={state.chainId} hash={bar.hash} />
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
        <b>⚠️ Something else controls your wallet on <Net chainId={state.chainId} /></b>
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

const CHECK_DAYS = 90;
const checkKey = (safe: Address) => `iw3.recheck.${safe.toLowerCase()}`;

/** Count a recovery check as done now (Home's card, and adding or changing a recovery address in Keys). */
export function recoveryChecked(safe: Address) {
  try {
    localStorage.setItem(checkKey(safe), String(Date.now()));
  } catch {}
}

/**
 * The recovery check (WalletBeat's "guardian account check-up"): every 90 days, Home asks whether you can still use
 * your own recovery addresses, while there's still time to change them. Only yours: the DAO isn't yours to lose.
 * The clock starts the first time this browser sees them.
 */
export function RecoveryCheck({ safe, states, onChange }: { safe: Address; states: ChainState[]; onChange: () => void }) {
  const seen = new Map<string, Address>();
  for (const s of states) for (const r of s.recoveries) for (const g of r.guardians ?? []) if (g.toLowerCase() !== DAO.toLowerCase()) seen.set(g.toLowerCase(), g);
  const mine = [...seen.values()];
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (!mine.length) return;
    try {
      const at = Number(localStorage.getItem(checkKey(safe)));
      if (!at) recoveryChecked(safe);
      setDue(!!at && Date.now() - at > CHECK_DAYS * 86_400_000);
    } catch {}
  }, [safe, mine.length]);
  if (!due || !mine.length) return null;
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <b>Recovery check</b>
      <p className="fine">Can you still use {mine.length > 1 ? "these" : "this"}? If you lose this device, {mine.length > 1 ? "they get" : "it gets"} your wallet back.</p>
      {mine.map(g => (
        <Who key={g} address={g} />
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" style={{ flex: 1 }} onClick={onChange}>
          Change
        </button>
        <button className="btn btn-green" style={{ flex: 2 }} onClick={() => (recoveryChecked(safe), setDue(false))}>
          I still have {mine.length > 1 ? "them" : "it"}
        </button>
      </div>
    </div>
  );
}
