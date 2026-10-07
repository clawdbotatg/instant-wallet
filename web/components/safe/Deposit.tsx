"use client";

import { useState } from "react";
import type { Address } from "viem";
import { TokenIcon } from "../bits";

/** Buy USDC or ETH on Base with Apple Pay (or a card), straight into this wallet: Coinbase Pay, through /api/onramp. */
export function Deposit({ address }: { address: Address }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(asset: "USDC" | "ETH") {
    setErr(null);
    setBusy(asset);
    const w = window.open("", "_blank"); // opened now, inside the tap, or Safari blocks it
    try {
      const j = await fetch(`/api/onramp?address=${address}&asset=${asset}`).then(r => r.json());
      if (!j.url) throw new Error(j.error || "Coinbase didn't answer");
      if (w) w.location.href = j.url;
      else window.location.href = j.url;
    } catch (e: any) {
      w?.close();
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="stack">
      <h2>Deposit</h2>
      <p className="fine">Apple Pay or card, via Coinbase. Lands on Base.</p>
      {(["USDC", "ETH"] as const).map(a => (
        <button key={a} className="btn wide" disabled={!!busy} onClick={() => go(a)}>
          <TokenIcon symbol={a} asset={a === "ETH" ? "0x0000000000000000000000000000000000000000" : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"} chainId={8453} size={24} />
          {busy === a ? "Opening…" : `Buy ${a}`}
        </button>
      ))}
      {err && <span className="err">{err}</span>}
    </div>
  );
}
