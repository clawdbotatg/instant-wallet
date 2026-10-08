"use client";

import { useEffect, useState } from "react";
import { type Address, parseUnits } from "viem";
import { CHAINS } from "@/lib/chains";
import { requestUri } from "@/lib/parse";
import { short } from "@/lib/format";
import type { Account } from "@/lib/types";
import { Blockie, CopyIcon, Qr, copy } from "./bits";
import { ChainSelect } from "./safe/Pick";

/**
 * One card: your address as a QR (blockie in the middle), the short address + a copy icon under it; a tap anywhere
 * copies it and says so. Request → an amount, token and network, and the QR becomes an EIP-681 payment request.
 */
export function Receive({ account }: { account: Account; toast?: (m: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<"USDC" | "ETH">("USDC");
  const [chainId, setChainId] = useState(CHAINS[0].id);
  const chain = CHAINS.find(c => c.id === chainId)!;
  let uri: string | null = null;
  if (asking && Number(amount) > 0) {
    try {
      uri =
        token === "ETH"
          ? requestUri(account.address, chainId, "eth", parseUnits(amount, 18))
          : chain.usdc
            ? requestUri(account.address, chainId, chain.usdc as Address, parseUnits(amount, 6))
            : null;
    } catch {}
  }
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const onTap = async () => {
    if (uri) (await copy(uri)) && setCopied("Request copied");
    else (await copy(account.address)) && setCopied("Copied");
  };
  return (
    <div className="stack">
      <h2>{asking ? "Request" : "Receive"}</h2>
      <div onClick={onTap} style={{ cursor: "pointer", position: "relative" }}>
        <Qr value={uri ?? account.address} center={account.address}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, color: "var(--ink)" }}>
            <span className="mono" style={{ fontSize: 17, fontWeight: 600 }}>{short(account.address)}</span>
            <CopyIcon />
          </div>
        </Qr>
        {copied && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px 10px 10px", borderRadius: 999, background: "var(--ink)", color: "#fff", boxShadow: "0 10px 30px -8px rgba(0,0,0,.5)", animation: "fade .15s" }}>
              <Blockie address={account.address} size={30} />
              <span className="mono" style={{ fontSize: 15 }}>{short(account.address)}</span>
              <b>{copied}</b>
            </div>
          </div>
        )}
      </div>
      {!asking ? (
        <button className="btn wide" onClick={() => setAsking(true)}>
          Request
        </button>
      ) : (
        <>
          <div className="input">
            <input inputMode="decimal" placeholder="0.0" autoFocus value={amount} onChange={e => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} />
            <div className="row">
              {(["USDC", "ETH"] as const).map(t => (
                <button key={t} className={`pill ${t === token ? "on" : ""}`} onClick={() => setToken(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <ChainSelect value={chainId} onChange={setChainId} />
          <button className="btn wide" onClick={() => (setAsking(false), setAmount(""))}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
