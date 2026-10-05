"use client";

/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { walletAddress, KIND_WEBAUTHN, signerIdOf } from "@/lib/address";
import { CHAINS, publicClient } from "@/lib/chains";
import { type Candidate, confirmKey, createPasskey, credentialIdHash, recoverKeys, webauthnAvailable } from "@/lib/passkey";
import type { Account } from "@/lib/types";
import { Band } from "./bits";

function accountFor(credentialId: string, c: Candidate): Account {
  const h = credentialIdHash(credentialId);
  return {
    credentialId,
    credentialIdHash: h,
    qx: c.qx,
    qy: c.qy,
    signerId: signerIdOf(c.qx, c.qy),
    address: walletAddress(c.qx, c.qy, KIND_WEBAUTHN, h),
  };
}

/** Does this address have code or money on any chain? (Picks the real key out of the recovered candidates.) */
async function used(address: `0x${string}`): Promise<boolean> {
  const checks = await Promise.all(
    CHAINS.map(async c => {
      const pc = publicClient(c.id);
      const [code, bal] = await Promise.all([pc.getCode({ address }).catch(() => undefined), pc.getBalance({ address }).catch(() => 0n)]);
      return (!!code && code !== "0x") || bal > 0n;
    }),
  );
  if (checks.some(Boolean)) return true;
  const p = await fetch(`/api/portfolio?address=${address}`).then(r => r.json()).catch(() => null);
  return !!p?.assets?.some((a: { balance: string }) => BigInt(a.balance) > 0n);
}

export function Welcome({ onReady }: { onReady: (a: Account) => void }) {
  const [busy, setBusy] = useState<"create" | "login" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof window === "undefined" || webauthnAvailable();

  async function create() {
    setBusy("create");
    setError(null);
    try {
      const pk = await createPasskey();
      const acct = accountFor(pk.credentialId, pk);
      onReady(acct);
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
      const accts = candidates.map(c => accountFor(credentialId, c));
      let pick: Account | undefined = accts.length === 1 ? accts[0] : undefined;
      if (!pick) {
        const flags = await Promise.all(accts.map(a => used(a.address)));
        const hits = accts.filter((_, i) => flags[i]);
        if (hits.length === 1) pick = hits[0];
      }
      if (!pick) {
        const c = await confirmKey(credentialId, candidates); // one more Face ID only when it's ambiguous
        pick = accountFor(credentialId, c);
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
          <p style={{ fontSize: 19, color: "#3b3d3b" }}>Your money, instantly. Face ID is the key. No seed phrase.</p>
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
          <p className="err">This browser can't use passkeys. Open this page in Safari or Chrome.</p>
        )}
        {error && <p className="err">{error}</p>}
        <p className="fine">Lives on {CHAINS.map(c => c.name).join(" and ")}. A wedgie can guard the big money later.</p>
      </div>
    </div>
  );
}

export function friendly(e: any): string {
  const m = String(e?.shortMessage || e?.message || e);
  if (/NotAllowedError|cancel|abort|timed out/i.test(m + (e?.name ?? ""))) return "Cancelled.";
  if (/insufficient funds/i.test(m)) return "Your gas key needs a little more ETH.";
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
}
