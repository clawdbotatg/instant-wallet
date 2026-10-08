"use client";

import { useState } from "react";
import { type Address, parseUnits } from "viem";
import { CHAINS } from "@/lib/chains";
import { requestUri } from "@/lib/parse";
import type { Account } from "@/lib/types";
import { Blockie, ChainIcon, CopyIcon, Qr, copy } from "./bits";

/**
 * Your address as a QR (blockie in the middle); tap the QR or the address to copy it. Request → an amount,
 * token and network, and the QR becomes an EIP-681 payment request.
 */
export function Receive({ account, toast }: { account: Account; toast: (m: string) => void }) {
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
  const copyAddr = async () => (await copy(account.address)) && toast("Address copied");
  return (
    <div className="stack">
      <h2>{asking ? "Request" : "Receive"}</h2>
      <div onClick={uri ? async () => (await copy(uri!)) && toast("Request copied") : copyAddr} style={{ cursor: "pointer" }}>
        <Qr value={uri ?? account.address} center={account.address} />
      </div>
      <button className="pill" style={{ justifyContent: "center", height: "auto", padding: "10px 14px" }} onClick={copyAddr}>
        <Blockie address={account.address} size={22} />
        <span className="mono" style={{ fontSize: 14 }}>{account.address}</span>
        <CopyIcon />
      </button>
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
          <div className="row" style={{ justifyContent: "center" }}>
            {CHAINS.map(c => (
              <button key={c.id} className={`pill ${c.id === chainId ? "on" : ""}`} onClick={() => setChainId(c.id)}>
                <ChainIcon chainId={c.id} /> {c.name}
              </button>
            ))}
          </div>
          <button className="btn wide" onClick={() => (setAsking(false), setAmount(""))}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
