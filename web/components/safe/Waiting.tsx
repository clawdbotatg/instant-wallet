"use client";

import { useEffect, useState } from "react";
import { chainById } from "@/lib/chains";
import { callsOf, relayFee } from "@/lib/safe/describe";
import { type FeeToken, type Prepared, Shared, finishOwners, ownerSigners, prepareOwners } from "@/lib/safe/send";
import { passkeySign } from "@/lib/safe/sign";
import {
  type Waiting,
  deleteHash,
  dropTx,
  openTx,
  safeAppTxLink,
  readWaiting,
  txLink,
} from "@/lib/safe/share";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { ErrorLine } from "./WedgieButton";
import { friendly } from "../Welcome";
import { CopyLink, Eject, RemoveX } from "../bits";
import { WhatItDoes } from "./WhatItDoes";

/** Home: transactions waiting for signatures, on every network where this wallet needs more than one. */
export function WaitingCards({
  account,
  states,
  feeTokenOn,
}: {
  account: SafeAccount;
  states: ChainState[];
  feeTokenOn: (chainId: number) => FeeToken;
}) {
  const [list, setList] = useState<{ w: Waiting; need: number; next: bigint }[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  // Reject: a transaction of just the fee, at the same number, so the waiting one can never run (wedgie.dev's Reject).
  // Two taps: get it ready, then sign (Face ID must start straight from a tap).
  const [rejecting, setRejecting] = useState<{ hash: string; ready?: Prepared } | null>(null);
  const reject = async (w: Waiting) => {
    const st = states.find(s => s.chainId === w.chainId);
    if (!st) return;
    setError(null);
    if (rejecting?.hash !== w.hash || !rejecting.ready) {
      setRejecting({ hash: w.hash });
      try {
        const ready = await prepareOwners({ account, state: st, calls: [], signers: ownerSigners(st, account), feeToken: feeTokenOn(w.chainId), label: `Reject: ${w.label ?? "transaction"}`, nonce: w.tx.nonce });
        setRejecting({ hash: w.hash, ready });
      } catch (e: any) {
        setRejecting(null);
        setError(friendly(e));
      }
      return;
    }
    try {
      await finishOwners(rejecting.ready);
      setList(l => l.filter(x => !(x.w.chainId === w.chainId && x.w.tx.nonce === w.tx.nonce)));
    } catch (e: any) {
      // signed here; its page is open for the other signers
      if (!(e instanceof Shared)) setError(friendly(e));
    } finally {
      setRejecting(null);
    }
  };
  const isReject = (w: Waiting) => {
    const cs = callsOf(w.tx);
    return cs.length > 0 && cs.every(c => relayFee(w.chainId, c));
  };
  const [error, setError] = useState<string | null>(null);
  // Remove: this phone's Face ID signs Safe's delete message (it's an owner on every wallet it opens)
  const remove = async (w: Waiting) => {
    setRemoving(w.hash);
    setError(null);
    try {
      await dropTx(w, await passkeySign(account.credentialId, account.burnerSigner, deleteHash(w)));
      setList((l) => l.filter((x) => x.w.hash !== w.hash));
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setRemoving(null);
    }
  };
  const multi = states.filter((s) => s.deployed && s.threshold > 1);
  const key = `${account.address}|${multi.map((s) => `${s.chainId}:${s.nonce}`).join()}`;
  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all(
        multi.map((s) =>
          readWaiting(s.chainId, account.address, s.nonce, { svc: false })
            .then((ws) => ws.map((w) => ({ w, need: s.threshold, next: s.nonce })))
            .catch(() => []),
        ),
      )
        .then((r) => live && setList(r.flat()))
        .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60_000);
    // removed on its own page (TxPage): gone here too, no wait for the next load
    const dropped = (e: Event) => setList(l => l.filter(x => x.w.hash.toLowerCase() !== (e as CustomEvent<string>).detail));
    window.addEventListener("iw:txdropped", dropped);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener("iw:txdropped", dropped);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.length) return null;
  // one Execute: the wallet runs them in order, so only the first in line can go; the rest say they're next
  const canRun = ({ w, need, next }: (typeof list)[number]) => w.sigs.length >= need && w.tx.nonce === next;
  const lead = list.find(canRun)?.w.hash;
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <b>{lead ? "Ready: press Execute" : "Waiting for signatures"}</b>
      {list.map(({ w, need, next }) => {
        const enough = w.sigs.length >= need;
        const behind = enough && w.tx.nonce > next;
        // nothing to reject: it is a Reject, or one is already waiting at its number
        const rejectable = !isReject(w) && !list.some(x => x.w.chainId === w.chainId && x.w.tx.nonce === w.tx.nonce && isReject(x.w));
        const r = rejecting?.hash === w.hash ? rejecting : null;
        const app = safeAppTxLink(w.chainId, w.safe, w.hash);
        return (
          <div key={w.hash} className="stack" style={{ gap: 8 }}>
            <div className="recess stack" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <span className="fine">
                  {w.label ?? `Transaction #${w.tx.nonce}`} · {chainById(w.chainId)?.name}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  {app && (
                    <Eject href={app} title="Open in Safe{Wallet}">
                      Safe
                    </Eject>
                  )}
                  <CopyLink link={txLink(w)} />
                </span>
              </div>
              <WhatItDoes chainId={w.chainId} safe={w.safe} calls={callsOf(w.tx)} tx={w.tx} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <RemoveX disabled={!!removing} busy={removing === w.hash} onClick={() => remove(w)} />
              {rejectable && (
                <button className="btn btn-sm" style={{ flex: "none" }} disabled={!!rejecting && !r?.ready} onClick={() => reject(w)}>
                  {r ? (r.ready ? "Sign to reject" : "…") : "Reject"}
                </button>
              )}
              <a
                href={txLink(w).replace(location.origin, "")}
                className={`btn btn-sm ${!enough || w.hash === lead ? "btn-green" : ""}`}
                style={{ flex: 1, minWidth: 0 }}
                onClick={(e) => {
                  e.preventDefault();
                  openTx(w);
                }}
              >
                {behind ? "Signed · next in line" : enough ? "Execute" : `Sign · ${w.sigs.length} of ${need}`}
              </a>
            </div>
          </div>
        );
      })}
      {error && <ErrorLine text={error} />}
    </div>
  );
}
