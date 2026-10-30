"use client";

import { useEffect, useState } from "react";
import { type Address, parseUnits } from "viem";
import { CHAINS } from "@/lib/chains";
import { requestLink, requestUri } from "@/lib/parse";
import { short } from "@/lib/format";
import { loadRequestLink, saveRequestLink } from "@/lib/store";
import type { Account } from "@/lib/types";
import { Blockie, CopyIcon, PencilIcon, Qr, SwitchIcon, copy } from "./bits";
import { ChainSelect } from "./safe/Pick";

/**
 * One card: your address as a QR (blockie in the middle), the short address + a copy icon under it; a tap anywhere
 * copies it and says so. Request → an amount, token and network, and the QR becomes an EIP-681 payment request.
 * "Include instantwallet.io link (any phone camera opens it)" (on by default, remembered) wraps it in a web link so any phone camera opens it
 * (/[...link]); off, it's the bare ethereum: request other wallets' scanners read.
 */
export function Receive({
  account,
  name,
  onName,
  onSignOut,
  onSwitch,
  onShare,
}: {
  account: Account;
  toast?: (m: string) => void;
  name?: string | null; // the wallet's name, as the title (tap to edit) when onName is given
  onName?: (name: string | null) => void; // null: back to the default name
  onSignOut?: () => void; // a "Sign out of this device" button at the bottom
  onSwitch?: () => void; // a "Switch account" button at the top (opens the passkey prompt)
  onShare?: () => void; // "Share Instant Wallet" (the app's link as a QR) and "Share crypto" at the bottom
}) {
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<"USDC" | "ETH">("USDC");
  const [chainId, setChainId] = useState(CHAINS[0].id);
  const chain = CHAINS.find(c => c.id === chainId)!;
  const [withLink, setWithLink] = useState(true);
  useEffect(() => setWithLink(loadRequestLink()), []);
  const toggleLink = (on: boolean) => (setWithLink(on), saveRequestLink(on));
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
  if (uri && withLink) uri = requestLink(window.location.origin, uri);
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
      {!onName && <h2>{asking ? "Request" : "Receive"}</h2>}
      <div onClick={onTap} style={{ cursor: "pointer", position: "relative" }}>
        <Qr
          value={uri ?? account.address}
          center={account.address}
          top={
            onName && (
              // a tap on the name edits it; anywhere else on the card copies
              <div onClick={e => e.stopPropagation()} style={{ cursor: "default", marginBottom: 10 }}>
                <NameTitle name={name ?? null} onSave={onName} />
              </div>
            )
          }
        >
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
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={withLink} onChange={e => toggleLink(e.target.checked)} />
            Include {window.location.host} link (any phone camera opens it)
          </label>
          <button className="btn btn-red wide" onClick={() => (setAsking(false), setAmount(""))}>
            Cancel
          </button>
        </>
      )}
      {onShare && !asking && APP_LINK && <ShareApp />}
      {onShare && !asking && (
        <button className="btn btn-green wide" onClick={onShare}>
          Share crypto
        </button>
      )}
      {onSwitch && !asking && (
        <button className="btn btn-dark wide" onClick={onSwitch}>
          <SwitchIcon />
          Switch account
        </button>
      )}
      {onSignOut && !asking && (
        <button className="btn btn-red wide" onClick={onSignOut}>
          Sign out of this device
        </button>
      )}
    </div>
  );
}

/** The wallet's name as the title; tap to edit, Save (empty = back to the default name). */
function NameTitle({ name, onSave }: { name: string | null; onSave: (name: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  if (!editing)
    return (
      <h2>
        <button
          aria-label={`Rename ${name ?? "this wallet"}`}
          onClick={() => (setV(name ?? ""), setEditing(true))}
          style={{ border: 0, padding: 0, background: "none", color: "inherit", font: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
        >
          {name ?? "…"}
          <span style={{ color: "var(--muted)", display: "flex" }}>
            <PencilIcon />
          </span>
        </button>
      </h2>
    );
  return (
    <form
      className="row"
      style={{ gap: 8 }}
      onSubmit={e => {
        e.preventDefault();
        onSave(v.trim().slice(0, 40) || null);
        setEditing(false);
      }}
    >
      <div className="input" style={{ flex: 1 }}>
        <input autoFocus maxLength={40} placeholder="Name this wallet" value={v} onChange={e => setV(e.target.value)} />
      </div>
      <button className="btn" type="submit">
        Save
      </button>
    </form>
  );
}

/** Where to get the app (the TestFlight link for now); "" hides Share Instant Wallet. */
const APP_LINK = "";

/** "Share Instant Wallet": opens the app's link as a QR; a tap on it copies the link. */
function ShareApp() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  if (!open)
    return (
      <button className="btn wide" onClick={() => setOpen(true)}>
        Share Instant Wallet
      </button>
    );
  return (
    <div onClick={async () => (await copy(APP_LINK)) && setCopied(true)} style={{ cursor: "pointer" }}>
      <Qr value={APP_LINK} top={<b style={{ marginBottom: 10 }}>Get Instant Wallet</b>}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, color: "var(--ink)" }}>
          <span className="fine">{copied ? "Copied" : "Tap to copy the link"}</span>
          <CopyIcon />
        </div>
      </Qr>
    </div>
  );
}
