"use client";

import { callsOf } from "@/lib/safe/describe";
import { WhatItDoes } from "./WhatItDoes";
import { GreenButton } from "../bits";
import { useCallback, useEffect, useState } from "react";
import { type Hash } from "viem";
import { chainById } from "@/lib/chains";
import { type Pending, cancelPending, getPending } from "@/lib/safe/pending";
import { type Stage, finishPending } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import { friendly } from "../Welcome";
import { TxPicture, WedgieIcon, ErrorLine } from "./WedgieButton";
import { Progress } from "./Progress";

const STAGE: Partial<Record<Stage, React.ReactNode>> = { "signing-wedgie": <>Press <GreenButton /> on the wedgie…</>, sending: "Executing…", confirming: "Confirming…" };

/** A big move signed on the phone, waiting for the wedgie: on the phone it says so; on a computer, one tap + the green button sends it. */
export function PendingCards({ account, states, onDone, toast }: { account: SafeAccount; states: ChainState[]; onDone: () => void; toast: (m: string) => void }) {
  const [list, setList] = useState<Pending[]>([]);
  const chains = states.filter(s => s.hasWedgie).map(s => s.chainId);
  const key = chains.join();

  const load = useCallback(async () => {
    const got = await Promise.all(key ? key.split(",").map(c => getPending(Number(c), account.address).catch(() => null)) : []);
    setList(got.filter((p): p is Pending => !!p));
  }, [key, account.address]);

  // with every wallet refresh (every 12 s, and when a sheet closes)
  useEffect(() => {
    load();
  }, [load, states]);

  return (
    <>
      {list.map(p => (
        <One
          key={`${p.chainId}:${p.hash}`}
          p={p}
          account={account}
          onGone={() => {
            load();
            onDone();
          }}
          toast={toast}
        />
      ))}
    </>
  );
}

function One({ p, account, onGone, toast }: { p: Pending; account: SafeAccount; onGone: () => void; toast: (m: string) => void }) {
  const [stage, setStage] = useState<Stage | null>(null);
  const [hash, setHash] = useState<Hash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const here = wedgieSupported();
  const what = p.label || `A transaction on ${chainById(p.chainId)?.name}`;

  async function sign() {
    setError(null);
    let w: Wedgie | null = null;
    try {
      w = await Wedgie.connect(); // first, straight from the tap (the port picker needs one)
      await finishPending(p, w, account.wedgie, (s, h) => {
        setStage(s);
        if (h) setHash(h);
      });
      toast("Executed");
      onGone();
    } catch (e: any) {
      setError(/fee too low|Gas went up/i.test(e?.message || "") ? "Gas went up while it waited. Cancel it and execute it again." : friendly(e));
    } finally {
      setStage(null);
      setHash(null);
      await w?.close();
    }
  }

  return (
    <div className="card alert stack" style={{ gap: 10 }}>
      <div className="row">
        <WedgieIcon size={44} />
        <div className="grow">
          <b>{here ? "Sign with your wedgie" : "Waiting for your wedgie"}</b>
          <p className="fine">{what}</p>
        </div>
      </div>
      <div className="recess stack" style={{ gap: 6 }}>
        <WhatItDoes chainId={p.chainId} safe={p.safe} calls={callsOf(p.tx)} tx={p.tx} />
      </div>
      <TxPicture hash={p.hash} />
      {!here && <p className="fine">Open Instant Wallet on your computer with the wedgie plugged in. It&apos;s there, ready to send.</p>}
      {error && <ErrorLine text={error} />}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn btn-red btn-sm"
          style={{ flex: "none", width: 52, padding: 0, fontSize: 18 }}
          aria-label="Remove"
          title="Remove"
          disabled={!!stage}
          onClick={async () => {
            await cancelPending(p);
            toast("Removed");
            onGone();
          }}
        >
          ✕
        </button>
        {here && (
          <button className="btn btn-green btn-sm" style={{ flex: 1, minWidth: 0 }} onClick={sign} disabled={!!stage}>
            {stage ? STAGE[stage] ?? "…" : "Sign and execute"}
          </button>
        )}
      </div>
      <Progress stage={stage} chainId={p.chainId} hash={hash} />
    </div>
  );
}
