"use client";

import { useState } from "react";
import { assertChallenge } from "@/lib/passkey";
import { onrampChallenge } from "@/lib/onramp";
import type { SafeAccount } from "@/lib/safe/state";
import { TokenIcon } from "../bits";

/**
 * Buy USDC or ETH on Base with Apple Pay (or a card), straight into this wallet: Coinbase Pay, through /api/onramp.
 * Face ID signs the request (the server only mints a link for the wallet's own passkey), then a second tap opens
 * Coinbase: a fresh tap, so Safari doesn't block the new tab.
 */
export function Deposit({ account }: { account: SafeAccount }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState<{ asset: string; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(asset: "USDC" | "ETH") {
    setErr(null);
    setReady(null);
    setBusy(asset);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const a = await assertChallenge(account.credentialId, onrampChallenge(account.address, asset, ts));
      const hex = (u: Uint8Array) => "0x" + Array.from(u, b => b.toString(16).padStart(2, "0")).join("");
      const j = await fetch("/api/onramp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: account.address,
          asset,
          ts,
          qx: account.qx,
          qy: account.qy,
          r: a.r,
          s: a.s,
          authenticatorData: hex(a.authenticatorData),
          clientDataJSON: new TextDecoder().decode(a.clientDataJSON),
        }),
      }).then(r => r.json());
      if (!j.url) throw new Error(j.error || "Coinbase didn't answer");
      setReady({ asset, url: j.url });
    } catch (e: any) {
      setErr(e.name === "NotAllowedError" ? "Cancelled" : e.message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="stack">
      <h2>Deposit</h2>
      <p className="fine">Apple Pay or card, via Coinbase. Lands on Base.</p>
      {ready ? (
        <a className="btn wide" href={ready.url} target="_blank" rel="noopener noreferrer" onClick={() => setReady(null)}>
          Continue to Coinbase ({ready.asset})
        </a>
      ) : (
        (["USDC", "ETH"] as const).map(a => (
          <button key={a} className="btn wide" disabled={!!busy} onClick={() => go(a)}>
            <TokenIcon symbol={a} asset={a === "ETH" ? "0x0000000000000000000000000000000000000000" : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"} chainId={8453} size={24} />
            {busy === a ? "Face ID…" : `Buy ${a}`}
          </button>
        ))
      )}
      {err && <span className="err">{err}</span>}
    </div>
  );
}
