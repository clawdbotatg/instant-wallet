"use client";

import { useEffect, useState } from "react";
import { type Features, useFeatures } from "@/lib/features";
import { isLocal } from "@/lib/local";

// each part a copy can be missing: what it needs in web/.env.local, and where to get it (null: only our site can)
const PARTS: { k: keyof Features; what: string; keys: string; get: string | null }[] = [
  { k: "deposit", what: "Deposit with Coinbase", keys: "CDP_API_KEY_ID, CDP_API_KEY_SECRET", get: "portal.cdp.coinbase.com" },
  { k: "positions", what: "Earn and borrow positions", keys: "ZERION_API_KEY", get: "developers.zerion.io" },
  { k: "safeService", what: "Shared transactions in Safe{Wallet} too", keys: "SAFE_API_KEY", get: "developer.safe.global" },
  { k: "alerts", what: "Recovery alerts", keys: "ALERT_MAIL_USER, ALERT_MAIL_PASS (a Gmail app password)", get: null },
  { k: "names", what: "New names (alice.inst.eth)", keys: "", get: null },
];

/** Settings, on a copy running on your own computer: what's off here, and the key that turns it on. */
export function LocalOff() {
  const f = useFeatures();
  const [local, setLocal] = useState(false);
  useEffect(() => setLocal(isLocal()), []);
  const off = PARTS.filter(p => !f[p.k]);
  if (!local || !off.length) return null;
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <b>Off on this copy</b>
      <p className="fine">Add the key to web/.env.local and run ./run-local.sh again. All free.</p>
      {off.map(p => (
        <div key={p.k} className="stack" style={{ gap: 2 }}>
          <span>{p.what}</span>
          <span className="fine">
            {p.k === "names" ? "Only instantwallet.io can sign new names." : p.get ? <>{p.keys}: {p.get}</> : p.keys}
          </span>
        </div>
      ))}
    </div>
  );
}
