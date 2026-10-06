"use client";

/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { CHAINS, publicClient } from "@/lib/chains";
import { type Candidate, confirmKey, createPasskey, recoverKeys, webauthnAvailable } from "@/lib/passkey";
import { type SafeAccount, accountFor } from "@/lib/safe/state";
import { Band } from "../bits";
import { friendly } from "../Welcome";

/** Has this address got code or money anywhere? (Picks the real key out of a login's candidates.) */
async function used(a: SafeAccount): Promise<boolean> {
  const checks = await Promise.all(
    CHAINS.map(async c => {
      const pc = publicClient(c.id);
      const [code, bal] = await Promise.all([pc.getCode({ address: a.address }).catch(() => undefined), pc.getBalance({ address: a.address }).catch(() => 0n)]);
      return (!!code && code !== "0x") || bal > 0n;
    }),
  );
  if (checks.some(Boolean)) return true;
  const p = await fetch(`/api/portfolio?address=${a.address}`).then(r => r.json()).catch(() => null);
  return !!p?.assets?.some((x: { balance: string }) => BigInt(x.balance) > 0n);
}

export function SafeWelcome({ onReady }: { onReady: (a: SafeAccount) => void }) {
  const [busy, setBusy] = useState<"create" | "login" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof window === "undefined" || webauthnAvailable();

  async function create() {
    setBusy("create");
    setError(null);
    try {
      const pk = await createPasskey("Instant Wallet");
      onReady(accountFor(pk.credentialId, pk.qx, pk.qy));
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  async function login() {
    setBusy("login");
    setError(null);
    try {
      const { credentialId, candidates } = await recoverKeys();
      const accts = candidates.map((c: Candidate) => accountFor(credentialId, c.qx, c.qy));
      let pick = accts.length === 1 ? accts[0] : undefined;
      if (!pick) {
        const flags = await Promise.all(accts.map(used));
        const hits = accts.filter((_, i) => flags[i]);
        if (hits.length === 1) pick = hits[0];
      }
      if (!pick) {
        const c = await confirmKey(credentialId, candidates); // one more Face ID only when it's ambiguous
        pick = accountFor(credentialId, c.qx, c.qy);
      }
      onReady(pick);
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="app">
      <div className="welcome">
        <img className="mark" src="/mark.png" alt="" />
        <div className="stack">
          <h1>Instant Wallet</h1>
          <p style={{ fontSize: 19, color: "#3b3d3b" }}>A wallet right now. Face ID is the key. Grow it into full self-custody when you&apos;re ready.</p>
        </div>
        <Band />
        {supported ? (
          <div className="stack">
            <button className="btn btn-green wide" onClick={create} disabled={!!busy}>
              {busy === "create" ? "Making your wallet…" : "Create wallet"}
            </button>
            <button className="btn wide" onClick={login} disabled={!!busy}>
              {busy === "login" ? "Opening…" : "I already have one"}
            </button>
          </div>
        ) : (
          <p className="err">This browser can&apos;t use passkeys. Open this page in Safari or Chrome.</p>
        )}
        {error && <p className="err">{error}</p>}
        <p className="fine">
          A Safe on {CHAINS.map(c => c.name).join(" and ")}, the same address on each. It exists the moment you make it; it&apos;s
          deployed on a chain the first time you send there (you pay a few cents, in USDC or ETH).
        </p>
      </div>
    </div>
  );
}
