"use client";

import { useEffect, useState } from "react";
import { type Address, parseUnits } from "viem";
import { CHAINS } from "@/lib/chains";
import { NAME_PARENT, labelIn, labelProblem } from "@/lib/names";
import { bio } from "@/lib/passkey";
import { requestLink, requestUri } from "@/lib/parse";
import { nativeUsd } from "@/lib/price";
import { loadRequestLink, saveRequestLink } from "@/lib/store";
import type { Account } from "@/lib/types";
import { AmountBox, CopyIcon, Money, Net, PencilIcon, Qr, SwitchIcon, WhatFor, Who, copy, stageLabel } from "./bits";
import { ChainSelect } from "./safe/Pick";

/**
 * One card: your address as a QR (blockie in the middle), the short address + a copy icon under it; a tap anywhere
 * copies it and says so. The title is the wallet's name; a tap on it takes a public one, alice.inst.eth (lib/names.ts).
 * The QR always holds the address: other wallets can't read a name. Request → an amount, token and network, and the QR becomes an EIP-681 payment request.
 * "Include instantwallet.io link (any phone camera opens it)" (on by default, remembered) wraps it in a web link so any phone camera opens it
 * (/[...link]); off, it's the bare ethereum: request other wallets' scanners read.
 * `got`: money that landed while this is up: "Received" and the amount over the code, until a tap (`onSeen`).
 */
export function Receive({
  account,
  got = [],
  onSeen,
  name,
  start,
  onClaim,
  onSignOut,
  onSwitch,
}: {
  account: Account;
  toast?: (m: string) => void;
  got?: { id: number; chainId: number; get: { amount: string; symbol: string }; usd?: number }[];
  onSeen?: () => void;
  name?: string | null; // the wallet's name, as the title. One name, the one every screen shows (docs/NAMES.md)
  start?: string; // what the name box opens with: its inst.eth label, or its old private name tidied into one
  onClaim?: (label: string) => Promise<void>; // the title gets a pencil: take or rename its inst.eth name (Face ID; throws with why not). None when the name is its own ENS name: that's changed in ENS
  onSignOut?: () => void; // a "Sign out of this device" button at the bottom
  onSwitch?: () => void; // a "Switch account" button at the top (opens the passkey prompt); also shows "Share Instant Wallet" (the app's link as a QR)
}) {
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<"USDC" | "ETH">("USDC");
  const [chainId, setChainId] = useState(CHAINS[0].id);
  const chain = CHAINS.find(c => c.id === chainId)!;
  const [withLink, setWithLink] = useState(true);
  useEffect(() => setWithLink(loadRequestLink()), []);
  const toggleLink = (on: boolean) => (setWithLink(on), saveRequestLink(on));
  // the coin pill is this network's own coin (POL, xDAI…), and USDC only where the network has it
  const tokens = chain.usdc ? (chain.nativeIsUsdc ? (["USDC"] as const) : (["USDC", "ETH"] as const)) : (["ETH"] as const);
  const tok = (tokens as readonly string[]).includes(token) ? token : tokens[0];
  // the network's coin in dollars, so a request is typed in dollars like every other amount
  const [coinUsd, setCoinUsd] = useState<Record<number, number>>({});
  useEffect(() => {
    if (asking) nativeUsd(chainId).then(p => p && setCoinUsd(m => ({ ...m, [chainId]: p })));
  }, [asking, chainId]);
  let uri: string | null = null;
  if (asking && Number(amount) > 0) {
    try {
      uri =
        tok === "ETH"
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
    if (got.length) return onSeen?.();
    if (uri) (await copy(uri)) && setCopied("Request copied");
    else (await copy(account.address)) && setCopied("Address copied");
  };
  return (
    <div className="stack">
      {name === undefined && <h2>{asking ? "Request" : "Receive"}</h2>}
      <div onClick={onTap} style={{ cursor: "pointer", position: "relative" }}>
        <Qr
          value={uri ?? account.address}
          center={account.address}
          top={
            name !== undefined && (
              // a tap on the name edits it; anywhere else on the card copies
              <div onClick={e => e.stopPropagation()} style={{ cursor: "default", marginBottom: 10 }}>
                <NameTitle name={name} start={start ?? ""} address={account.address} onClaim={onClaim} />
              </div>
            )
          }
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, color: "var(--ink)" }}>
            <span style={{ fontSize: 17, fontWeight: 600 }}><Who flat plain address={account.address} /></span>
            <CopyIcon />
          </div>
        </Qr>
        {got.length > 0 && (
          <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", alignContent: "center", gap: 8, borderRadius: 22, background: "#fff", animation: "fade .15s" }}>
            <WhatFor>Received</WhatFor>
            {got.map(g => (
              <span key={g.id} className="stack center" style={{ gap: 2 }}>
                <Money amount={g.get.amount} symbol={g.get.symbol} usd={g.usd} size={28} get />
                <span className="fine"><Net chainId={g.chainId} /></span>
              </span>
            ))}
          </div>
        )}
        {copied && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px 10px 10px", borderRadius: 999, background: "var(--ink)", color: "#fff", boxShadow: "0 10px 30px -8px rgba(0,0,0,.5)", animation: "fade .15s" }}>
              <span style={{ fontSize: 15 }}><Who flat plain address={account.address} size={30} /></span>
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
          <AmountBox
            key={`${chainId}:${tok}`}
            autoFocus
            value={amount}
            onChange={setAmount}
            symbol={tok === "ETH" ? chain.native.symbol : tok}
            decimals={tok === "ETH" ? 18 : 6}
            price={tok === "ETH" ? coinUsd[chainId] : 1}
            right={
              tokens.length > 1 && (
                <span className="row" style={{ gap: 6 }}>
                  {tokens.map(t => (
                    <button key={t} className={`pill ${t === tok ? "on" : ""}`} onClick={() => (setToken(t), setAmount(""))}>
                      {t === "ETH" ? chain.native.symbol : t}
                    </button>
                  ))}
                </span>
              )
            }
          />
          <ChainSelect value={chainId} onChange={id => (setChainId(id), setAmount(""))} />
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={withLink} onChange={e => toggleLink(e.target.checked)} />
            Include {window.location.host} link (any phone camera opens it)
          </label>
          <button className="btn wide" onClick={() => (setAsking(false), setAmount(""))}>
            Cancel
          </button>
        </>
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

/**
 * The wallet's name as the title. With onClaim it has a pencil: a tap opens the box for its inst.eth name,
 * [alice].inst.eth, free or taken as you type, Save → Face ID → it's this wallet's (a name it already holds can be
 * picked again). Without, it's the name alone.
 */
function NameTitle({ name, start, address, onClaim }: { name: string | null; start: string; address: Address; onClaim?: (label: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  const [seen, setSeen] = useState<{ label: string; ok: boolean; problem: string | null } | null>(null); // the server's word on a label
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const local = labelProblem(v);
  useEffect(() => {
    if (!editing || !v || local) return;
    let live = true; // a late answer for an older label must never land on a newer one
    const t = setTimeout(async () => {
      const j = await fetch(`/api/names?name=${v}&address=${address}`).then(r => r.json()).catch(() => null);
      if (live && j?.label === v) setSeen({ label: v, ok: !!(j.free || j.yours), problem: j.problem ?? null });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [editing, v, local, address]);
  const now = seen?.label === v ? seen : null;
  const problem = local ?? now?.problem ?? null;
  if (!onClaim) return name ? <h2>{name}</h2> : null; // its own ENS name, or view only: nothing to edit here
  if (!editing)
    return (
      <h2>
        <button
          aria-label={name ? `Rename ${name}` : "Add a name"}
          onClick={() => (setV(start), setErr(null), setEditing(true))}
          style={{ border: 0, padding: 0, background: "none", color: "inherit", font: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
        >
          {name ?? <span style={{ color: "var(--muted)" }}>Add a name</span>}
          <span style={{ color: "var(--muted)", display: "flex" }}>
            <PencilIcon />
          </span>
        </button>
      </h2>
    );
  return (
    <form
      className="stack"
      onSubmit={async e => {
        e.preventDefault();
        if (busy || !now?.ok) return;
        setErr(null);
        setBusy(true);
        try {
          await onClaim(v);
          setEditing(false);
        } catch (e: any) {
          setErr(e?.name === "NotAllowedError" ? "Cancelled." : e?.message || "Try again");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="input">
        <input autoFocus maxLength={32} placeholder="name" value={v} onChange={e => (setV(labelIn(e.target.value)), setErr(null))} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        <span className="unit" style={{ paddingRight: 8 }}>.{NAME_PARENT}</span>
      </div>
      {(err || problem) && <span className="err">{err || problem}</span>}
      <button className="btn btn-green wide" type="submit" disabled={busy || !now?.ok}>
        {busy ? stageLabel("signing") : "Save"}
      </button>
      <button className="btn wide" type="button" disabled={busy} onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}
