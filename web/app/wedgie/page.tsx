"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address, getAddress, isAddress, parseUnits } from "viem";
import { Band, Qr, copy } from "@/components/bits";
import { Safety } from "@/components/Safety";
import { friendly } from "@/components/Welcome";
import { DEFAULT_CHAIN } from "@/lib/chains";
import { rawPublicKey, rawSigner, standInKey } from "@/lib/cold";
import type { Account } from "@/lib/types";
import { sendCalls, transferCall } from "@/lib/wallet";

/**
 * The stand-in wedgie (testing): a raw P-256 key kept in THIS browser, signing exactly like a wedgie's Trust M
 * chip (raw digest, low-s r ‖ s). Open it in a second browser or on a laptop, paste its key into the wallet's
 * "Set up cold storage", then act as the cold key: big sends (they wait), cancel, freeze, skip a wait.
 */
export default function StandInWedgie() {
  const [sk, setSk] = useState<`0x${string}` | null>(null);
  const [wallet, setWallet] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setSk(standInKey());
    try {
      setWallet(localStorage.getItem("iw3.standin-wallet") || "");
    } catch {}
  }, []);
  const pub = useMemo(() => (sk ? rawPublicKey(sk) : null), [sk]);
  const keyText = pub ? `wedgie:${pub.qx}:${pub.qy}` : "";
  const acct: Account | null =
    pub && isAddress(wallet)
      ? { address: getAddress(wallet) as Address, signerId: pub.id, credentialId: "", credentialIdHash: `0x${"0".repeat(64)}`, qx: pub.qx, qy: pub.qy }
      : null;

  return (
    <div className="app">
      <div className="top">
        <div className="brand">🔑 Stand-in wedgie</div>
      </div>
      <Band />
      <p className="fine">Testing only. A key in this browser that signs like a wedgie. Real wedgie app: coming.</p>
      {pub && (
        <div className="card stack">
          <b>This wedgie's public key</b>
          <Qr value={keyText} />
          <button className="pill" style={{ height: "auto", padding: 10 }} onClick={async () => (await copy(keyText)) && setMsg("Copied")}>
            <span className="mono" style={{ fontSize: 11 }}>{keyText}</span>
          </button>
          <span className="fine">Paste it into Wallet → Safety → Set up cold storage.</span>
        </div>
      )}
      <div className="field">
        <label>Wallet address</label>
        <div className="input">
          <input
            value={wallet}
            onChange={e => {
              setWallet(e.target.value.trim());
              try {
                localStorage.setItem("iw3.standin-wallet", e.target.value.trim());
              } catch {}
            }}
            placeholder="0x…"
            spellCheck={false}
          />
        </div>
      </div>
      {acct && sk && (
        <>
          <div className="card stack">
            <b>Send USDC (as the wedgie: it waits)</b>
            <div className="input">
              <input value={to} onChange={e => setTo(e.target.value.trim())} placeholder="to 0x…" spellCheck={false} />
            </div>
            <div className="input">
              <input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="USDC" />
            </div>
            <button
              className="btn btn-green wide"
              disabled={busy || !isAddress(to) || !amount}
              onClick={async () => {
                setBusy(true);
                setMsg(null);
                try {
                  await sendCalls(DEFAULT_CHAIN.id, acct, [transferCall(DEFAULT_CHAIN.usdc!, getAddress(to), parseUnits(amount, 6))], {
                    signer: rawSigner(sk),
                  });
                  setMsg("Queued. It runs after the wait unless someone cancels it.");
                } catch (e) {
                  setMsg(friendly(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Signing…" : "Press A (sign)"}
            </button>
          </div>
          <Safety account={acct} signer={rawSigner(sk)} who="wedgie" />
        </>
      )}
      {msg && <p className="fine">{msg}</p>}
    </div>
  );
}
