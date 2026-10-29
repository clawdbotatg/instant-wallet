"use client";

import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { short } from "@/lib/format";
import { createPasskey } from "@/lib/passkey";
import { signerAddress } from "@/lib/safe/core";
import { loadAccount } from "@/lib/safe/state";
import { Blockie } from "../bits";
import { friendly } from "../Welcome";
import { signIn } from "./SafeWelcome";

type Invite = { safe: Address; from?: string; answer?: { x: Hex; y: Hex } };

/**
 * /join#<id>: a friend answers an invite to be a signer (docs/MULTI-SIGNER.md). Their passkey's public key goes
 * back to the wallet's owner, who adds them. Their own Instant Wallet passkey works, or a new one.
 */
export function Join() {
  const [id, setId] = useState("");
  const [inv, setInv] = useState<Invite | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Address | null>(null);
  const mine = typeof window !== "undefined" ? loadAccount() : null;

  useEffect(() => {
    const i = location.hash.slice(1);
    setId(i);
    fetch(`/api/safe/invite?id=${encodeURIComponent(i)}`)
      .then(r => r.json())
      .then(j => (j.error ? setError(j.error) : setInv(j)))
      .catch(e => setError(friendly(e)));
  }, []);

  async function answer(how: "mine" | "signin" | "new") {
    setBusy(how);
    setError(null);
    try {
      let x: Hex, y: Hex;
      if (how === "mine" && mine) [x, y] = [mine.qx, mine.qy];
      else if (how === "new") {
        const pk = await createPasskey("Instant Wallet signer");
        [x, y] = [pk.qx, pk.qy];
      } else {
        const r = await signIn();
        const a = "account" in r ? r.account : r.confirm.account;
        [x, y] = [a.qx, a.qy];
      }
      const r = await fetch("/api/safe/invite", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, x, y, name: name.trim() || undefined }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `invite: ${r.status}`);
      setDone(signerAddress(x, y));
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  if (done)
    return (
      <div className="stack center">
        <h2>Sent</h2>
        <Blockie address={done} size={64} />
        <p>
          Your signer is <span className="mono">{short(done)}</span>. {inv?.from ?? "The wallet's owner"} adds it next. After that, you sign from the links they send
          you, with this Face ID.
        </p>
      </div>
    );

  return (
    <div className="stack">
      <h2>Be a signer</h2>
      {inv ? (
        <>
          <p className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {inv.from ? <b>{inv.from}</b> : "Someone"} invites you to sign for <Blockie address={inv.safe} size={22} />
            <span className="mono">{short(inv.safe)}</span>
          </p>
          <p className="fine">
            Your passkey stays on your phone. Only its public key goes to them. Then they can ask you to sign.
          </p>
          <div className="input">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name (so they know it's you)" maxLength={40} />
          </div>
          {inv.answer ? (
            <p className="fine">Someone already answered this invite. Ask for a new one.</p>
          ) : (
            <>
              {mine && (
                <button className="btn btn-green wide" onClick={() => answer("mine")} disabled={!!busy}>
                  {busy === "mine" ? "Sending…" : "Use this phone's Instant Wallet key"}
                </button>
              )}
              <button className={`btn wide ${mine ? "" : "btn-green"}`} onClick={() => answer("signin")} disabled={!!busy}>
                {busy === "signin" ? "Check Face ID…" : "Use my passkey (Face ID)"}
              </button>
              <button className="btn wide" onClick={() => answer("new")} disabled={!!busy}>
                {busy === "new" ? "Making it…" : "Make a new passkey for this"}
              </button>
            </>
          )}
        </>
      ) : (
        !error && <p className="fine">Loading…</p>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
