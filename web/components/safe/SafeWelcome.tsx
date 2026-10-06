"use client";

/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { type Address, getAddress, isAddress } from "viem";
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

/** Safes this signer owns, from Safe's Transaction Service (a phone that took over a wallet by recovery). */
async function ownedBy(signer: Address): Promise<Address | undefined> {
  for (const net of ["base", "eth"]) {
    const j = await fetch(`https://api.safe.global/tx-service/${net}/api/v1/owners/${getAddress(signer)}/safes/`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
    if (j?.safes?.length) return getAddress(j.safes[0]);
  }
  return undefined;
}

export function SafeWelcome({ onReady }: { onReady: (a: SafeAccount) => void }) {
  const [busy, setBusy] = useState<"create" | "login" | "recover" | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [wallet, setWallet] = useState("");
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
      // a key that took over another wallet by recovery: its own address is empty, Safe's index knows the wallet
      for (const c of pick ? [pick] : accts) {
        if (await used(c)) break;
        const w = await ownedBy(c.burnerSigner);
        if (w) {
          pick = accountFor(credentialId, c.qx, c.qy, w);
          break;
        }
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

  async function recover() {
    if (!isAddress(wallet.trim())) return setError("Paste the wallet's address (0x…).");
    setBusy("recover");
    setError(null);
    try {
      const pk = await createPasskey("Instant Wallet (recovered)");
      onReady(accountFor(pk.credentialId, pk.qx, pk.qy, getAddress(wallet.trim())));
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  if (recovering)
    return (
      <div className="app">
        <div className="welcome">
          <div className="stack">
            <h1>Recover a wallet</h1>
            <p>Lost your phone? This makes a new Face ID key here. Your recovery address (the DAO, or your paper seed) then swaps it in; it takes 7 days, and you can cancel it from any key you still have.</p>
          </div>
          <div className="input">
            <input value={wallet} onChange={e => setWallet(e.target.value)} placeholder="0x… your wallet's address" autoCapitalize="none" spellCheck={false} />
          </div>
          <button className="btn btn-green wide" onClick={recover} disabled={!!busy}>
            {busy === "recover" ? "Making the new key…" : "Make my new key"}
          </button>
          <button className="btn wide" onClick={() => setRecovering(false)}>
            Back
          </button>
          {error && <p className="err">{error}</p>}
        </div>
      </div>
    );

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
            <button className="pill" style={{ justifySelf: "center" }} onClick={() => setRecovering(true)}>
              Lost my phone: recover a wallet
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
