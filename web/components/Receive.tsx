"use client";

import { useState } from "react";
import { CHAINS } from "@/lib/chains";
import { payLink } from "@/lib/parse";
import type { Account } from "@/lib/types";
import { Blockie, Qr, copy } from "./bits";

/** Your address as a QR (blockie in the middle), plus a payment-request link with an amount. */
export function Receive({ account, toast }: { account: Account; toast: (m: string) => void }) {
  const [amount, setAmount] = useState("");
  const [chainId, setChainId] = useState(CHAINS[0].id);
  const link = typeof window === "undefined" ? "" : payLink(window.location.origin, account.address, chainId, amount || undefined);
  return (
    <div className="stack">
      <h2>Receive</h2>
      <Qr value={amount ? link : account.address} center={account.address} />
      <button className="pill" style={{ justifyContent: "center", height: "auto", padding: "10px 14px" }} onClick={async () => (await copy(account.address)) && toast("Address copied")}>
        <Blockie address={account.address} size={22} />
        <span className="mono" style={{ fontSize: 14 }}>{account.address}</span>
      </button>
      <p className="fine center">Same address on {CHAINS.map(c => c.name).join(" and ")}. Send any token.</p>
      <div className="field">
        <label>Ask for an amount (optional, in ETH)</label>
        <div className="input">
          <input inputMode="decimal" placeholder="0.0" value={amount} onChange={e => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} />
          <div className="row">
            {CHAINS.map(c => (
              <button key={c.id} className={`pill ${c.id === chainId ? "on" : ""}`} onClick={() => setChainId(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        </div>
      </div>
      {amount && (
        <button className="btn wide" onClick={async () => (await copy(link)) && toast("Link copied")}>
          Copy payment link
        </button>
      )}
    </div>
  );
}
