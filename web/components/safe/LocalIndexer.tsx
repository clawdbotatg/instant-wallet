"use client";

import { useCallback, useEffect, useState } from "react";
import { isLocal } from "@/lib/local";

type Info = { setUp: boolean; on: boolean; up: boolean; chains: { id: number; name: string; wallets: number; scanned: number }[] };

/**
 * Settings → Balances and prices, only on a copy running on your own computer (lib/local.ts): from your own indexer
 * (clawdbotatg/iw-indexer, reading your node) or from Alchemy, as on our site. app/api/local/indexer.
 */
export function LocalIndexer({ toast }: { toast: (m: string) => void }) {
  const [show, setShow] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const load = useCallback(() => {
    fetch("/api/local/indexer", { cache: "no-store" })
      .then(r => r.json())
      .then(setInfo, () => null);
  }, []);
  useEffect(() => {
    if (!isLocal()) return;
    setShow(true);
    load();
  }, [load]);
  if (!show || !info) return null;

  const set = async (on: boolean) => {
    setInfo({ ...info, on });
    await fetch("/api/local/indexer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });
    toast(on ? "Balances from your indexer" : "Balances from Alchemy");
    load();
  };

  if (!info.setUp)
    return (
      <div className="stack" style={{ gap: 6 }}>
        <span>From Alchemy.</span>
        <span className="fine">
          For your own: add your node to web/.env.local as RPC_URL_1=http://127.0.0.1:8545 (one line per network) and run
          ./run-local.sh again. It starts iw-indexer.
        </span>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 8 }}>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={info.on} onChange={e => set(e.target.checked)} />
        From my indexer
      </label>
      {info.on && !info.up && <span className="fine">Your indexer isn&apos;t answering: Alchemy for now.</span>}
      {info.on &&
        info.up &&
        info.chains.map(c => (
          <span key={c.id} className="fine">
            {c.name}: {c.scanned < c.wallets ? `reading history, ${c.scanned} of ${c.wallets} wallets done` : "ready"}
          </span>
        ))}
      {info.on && info.up && <span className="fine">Other networks: Alchemy.</span>}
      {!info.on && <span className="fine">From Alchemy, as on instantwallet.io.</span>}
    </div>
  );
}
