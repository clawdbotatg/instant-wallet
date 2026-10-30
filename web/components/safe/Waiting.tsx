"use client";

import { useEffect, useState } from "react";
import { chainById } from "@/lib/chains";
import { callsOf } from "@/lib/safe/describe";
import { passkeySign } from "@/lib/safe/sign";
import {
  type Waiting,
  deleteHash,
  dropTx,
  openTx,
  readWaiting,
  txLink,
} from "@/lib/safe/share";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { ErrorLine } from "./WedgieButton";
import { friendly } from "../Welcome";
import { WhatItDoes } from "./WhatItDoes";

/** After a send that needs other signers: its page is opening (finishOwners called openTx). */
export function SharedDone(_: {
  w: Waiting;
  need?: number;
  onDone?: () => void;
}) {
  return (
    <div className="stack center">
      <h2>Signed</h2>
      <p className="fine">Opening the transaction…</p>
    </div>
  );
}

/** Home: transactions waiting for signatures, on every network where this wallet needs more than one. */
export function WaitingCards({
  account,
  states,
}: {
  account: SafeAccount;
  states: ChainState[];
}) {
  const [list, setList] = useState<{ w: Waiting; need: number }[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
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
            .then((ws) => ws.map((w) => ({ w, need: s.threshold })))
            .catch(() => []),
        ),
      )
        .then((r) => live && setList(r.flat()))
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
        return (
          <div key={w.hash} className="stack" style={{ gap: 8 }}>
            <div className="recess stack" style={{ gap: 8 }}>
              <WhatItDoes chainId={w.chainId} safe={w.safe} calls={callsOf(w.tx)} />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              <button
                className="btn btn-red btn-sm"
                style={{ height: "auto", flex: "none", width: 52, padding: 0, fontSize: 20 }}
                aria-label="Remove"
                title="Remove"
                disabled={!!removing}
                onClick={() => remove(w)}
              >
                {removing === w.hash ? "…" : "✕"}
              </button>
              <a
                href={txLink(w).replace(location.origin, "")}
                className="btn btn-green btn-sm"
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: "auto",
                  minHeight: 52,
                  flexDirection: "column",
                  gap: 0,
                  padding: "8px 14px",
                  lineHeight: 1.2,
                }}
                onClick={(e) => {
                  e.preventDefault();
                  openTx(w);
                }}
              >
                <b>{w.label ?? `Transaction #${w.tx.nonce}`}</b>
                <span style={{ fontSize: 12, opacity: 0.85 }}>
                  {chainById(w.chainId)?.name} · {w.sigs.length} of {need}{" "}
                  signed
                </span>
              </a>
            </div>
          </div>
        );
      })}
      {error && <ErrorLine text={error} />}
    </div>
  );
}
