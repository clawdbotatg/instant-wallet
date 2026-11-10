"use client";

import { useEffect, useState } from "react";
import { toHex } from "viem";
import { dropSig } from "@/lib/dropClient";
import { bio } from "@/lib/passkey";
import { type SafeAccount, loadAccount } from "@/lib/safe/state";
import { friendly } from "./Welcome";

/** The admin session (12 hours), for /drops. */
export const SESSION = "iw.dropAdmin";

async function post(op: string, body: object = {}) {
  const r = await fetch("/api/drop/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `error ${r.status}`);
  return j;
}

/** The log-in screen of an admin page: this device's passkey, or any wallet. Only DROP_ADMINS wallets get in. */
export function AdminLogin({ title, blurb, onDone }: { title: string; blurb: string; onDone: () => void }) {
  const [account, setAccount] = useState<SafeAccount | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setAccount(loadAccount()), []);

  async function run(login: () => Promise<{ token: string; wallet: string }>) {
    setBusy(true);
    setError(null);
    try {
      const j = await login();
      localStorage.setItem(SESSION, JSON.stringify({ token: j.token, wallet: j.wallet }));
      onDone();
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  const passkey = () => run(async () => post("login", { wallet: account!.address, sig: await dropSig(account!, "login") }));

  function wallet() {
    const eth = (window as any).ethereum;
    if (!eth) return setError("No wallet in this browser. Open this page in your wallet's browser, or on a computer with MetaMask or Rabby.");
    return run(async () => {
      const [w] = await eth.request({ method: "eth_requestAccounts" });
      const { message } = await post("challenge");
      const signature = await eth.request({ method: "personal_sign", params: [toHex(message), w] });
      return post("login", { wallet: w, message, signature });
    });
  }

  if (account === undefined) return null;
  return (
    <div className="app">
      <div className="welcome">
        <h1>{title}</h1>
        <p className="fine">{blurb}</p>
        {account ? (
          <button className="btn btn-green wide" onClick={passkey} disabled={busy}>
            {busy ? "…" : `Log in with ${bio()}`}
          </button>
        ) : (
          <>
            <p>Make your Instant Wallet first, on this device.</p>
            <a className="btn btn-green wide" href="/">Open Instant Wallet</a>
          </>
        )}
        <button className="btn wide" onClick={wallet} disabled={busy}>
          Log in with a wallet
        </button>
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  );
}
