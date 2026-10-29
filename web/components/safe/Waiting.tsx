"use client";

import { useEffect, useState } from "react";
import { chainById } from "@/lib/chains";
import { type Waiting, readWaiting, safeAppTxLink, txLink } from "@/lib/safe/share";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { copy, useToast } from "../bits";

/** After a send that needs other signers: its link to pass on (and Safe{Wallet}, which has it too). */
export function SharedDone({ w, need, onDone }: { w: Waiting; need: number; onDone: () => void }) {
  const [toast, setToast] = useToast();
  const link = txLink(w);
  const app = safeAppTxLink(w.chainId, w.safe, w.hash);
  return (
    <div className="stack center">
      <h2>Signed. Now the others.</h2>
      <p>
        {w.label ?? "This transaction"} needs {need - w.sigs.length} more signature{need - w.sigs.length === 1 ? "" : "s"}. Send them this link.
      </p>
      <button
        className="btn btn-green wide"
        onClick={async () => {
          if (navigator.share) return navigator.share({ url: link, title: w.label ?? "Sign this" }).catch(() => {});
          setToast((await copy(link)) ? "Link copied" : "Couldn't copy");
        }}
      >
        Share the link
      </button>
      <button className="btn wide" onClick={async () => setToast((await copy(link)) ? "Link copied" : "Couldn't copy")}>
        Copy the link
      </button>
      {app && (
        <a className="btn btn-sm" href={app} target="_blank" rel="noreferrer">
          Open in Safe&#123;Wallet&#125; ↗
        </a>
      )}
      <button className="btn btn-sm" onClick={onDone}>
        OK
      </button>
      {toast && <div className="toast">{toast}</div>}
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
