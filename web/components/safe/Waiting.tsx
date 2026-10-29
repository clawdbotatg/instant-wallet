"use client";

import { useEffect, useState } from "react";
import { chainById } from "@/lib/chains";
import { type Waiting, readWaiting, safeAppTxLink, txLink } from "@/lib/safe/share";
import type { ChainState, SafeAccount } from "@/lib/safe/state";

/** After a send that needs other signers: its page is opening (finishOwners sent us there). */
export function SharedDone({ w }: { w: Waiting; need?: number; onDone?: () => void }) {
  useEffect(() => {
    if (!location.pathname.startsWith("/tx/")) location.assign(txLink(w));
  }, [w]);
  return (
    <div className="stack center">
      <h2>Signed</h2>
      <p className="fine">Opening the transaction…</p>
    </div>
  );
}

/** Home: transactions waiting for signatures, on every network where this wallet needs more than one. */
export function WaitingCards({ account, states }: { account: SafeAccount; states: ChainState[] }) {
  const [list, setList] = useState<{ w: Waiting; need: number }[]>([]);
  const multi = states.filter(s => s.deployed && s.threshold > 1);
  const key = `${account.address}|${multi.map(s => `${s.chainId}:${s.nonce}`).join()}`;
  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all(multi.map(s => readWaiting(s.chainId, account.address, s.nonce, { svc: false }).then(ws => ws.map(w => ({ w, need: s.threshold }))).catch(() => [])))
        .then(r => live && setList(r.flat()))
        .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.length) return null;
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <b>Waiting for signatures</b>
      {list.map(({ w, need }) => {
        const app = safeAppTxLink(w.chainId, w.safe, w.hash);
        return (
          <div key={w.hash} className="keyrow" style={{ padding: 0, gap: 8 }}>
            <a href={txLink(w).replace(location.origin, "")} className="grow" style={{ minWidth: 0 }}>
              <b>{w.label ?? `Transaction #${w.tx.nonce}`}</b>
              <div className="fine">
                {chainById(w.chainId)?.name} · {w.sigs.length} of {need} signed
              </div>
            </a>
            {app && (
              <a className="pill" href={app} target="_blank" rel="noreferrer" title="Open in Safe{Wallet}">
                Safe ↗
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
