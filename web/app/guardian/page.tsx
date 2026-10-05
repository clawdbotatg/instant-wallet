"use client";

import { useCallback, useEffect, useState } from "react";
import { type Address, type Hex, createWalletClient, formatEther, getAddress, http, isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Band, copy } from "@/components/bits";
import { left, parseWedgieKey, useNow } from "@/components/Safety";
import { friendly } from "@/components/Welcome";
import { instantWalletAbi } from "@/lib/abi";
import { DEFAULT_CHAIN, publicClient, rpcPath } from "@/lib/chains";
import { type Safety, describeCall, readSafety } from "@/lib/cold";
import { short } from "@/lib/format";

/**
 * A test guardian (testing): a plain key kept in this browser. Put a little Base ETH on it, make it a guardian
 * in the wallet's cold-storage setup, then play the guardian: freeze, cancel a waiting action, replace a lost
 * key (the owner can cancel during the recovery wait), finalize.
 */
export default function TestGuardian() {
  const chainId = DEFAULT_CHAIN.id;
  const now = useNow();
  const [pk, setPk] = useState<Hex | null>(null);
  const [wallet, setWallet] = useState("");
  const [s, setS] = useState<Safety | null>(null);
  const [eth, setEth] = useState<bigint>(0n);
  const [replaces, setReplaces] = useState("");
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    try {
      let k = localStorage.getItem("iw3.test-guardian") as Hex | null;
      if (!k) {
        k = generatePrivateKey();
        localStorage.setItem("iw3.test-guardian", k);
      }
      setPk(k);
      setWallet(localStorage.getItem("iw3.standin-wallet") || "");
    } catch {}
  }, []);
  const me = pk ? privateKeyToAccount(pk) : null;

  const refresh = useCallback(() => {
    if (me) publicClient(chainId).getBalance({ address: me.address }).then(setEth).catch(() => {});
    if (isAddress(wallet)) readSafety(chainId, getAddress(wallet)).then(setS).catch(() => setS(null));
  }, [chainId, wallet, me?.address]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  async function tx(label: string, functionName: string, args: unknown[] = []) {
    if (!me || !isAddress(wallet)) return;
    setBusy(label);
    setMsg(null);
    try {
      const wc = createWalletClient({ account: me, chain: DEFAULT_CHAIN.chain, transport: http(rpcPath(chainId)) });
      const hash = await wc.writeContract({ address: getAddress(wallet), abi: instantWalletAbi as any, functionName, args } as any);
      await publicClient(chainId).waitForTransactionReceipt({ hash });
      setMsg(`${label}: done`);
      refresh();
    } catch (e) {
      setMsg(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  const wk = parseWedgieKey(newKey);
  const guardianHere = !!s && !!me && s.guardians.some(g => g.toLowerCase() === me.address.toLowerCase());

  return (
    <div className="app">
      <div className="top">
        <div className="brand">🛟 Test guardian</div>
      </div>
      <Band />
      <p className="fine">Testing only. A plain key in this browser acting as a guardian. Guardians can never spend.</p>
      {me && (
        <div className="card stack" style={{ gap: 6 }}>
          <b>Guardian address</b>
          <button className="pill" onClick={() => copy(me.address).then(() => setMsg("Copied"))}>
            <span className="mono" style={{ fontSize: 12 }}>{me.address}</span>
          </button>
          <span className="fine">Gas: {formatEther(eth)} ETH on {DEFAULT_CHAIN.name} (needs a few cents).</span>
        </div>
      )}
      <div className="field">
        <label>Wallet address</label>
        <div className="input">
          <input value={wallet} onChange={e => setWallet(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
        </div>
        {s && <span className="fine">{guardianHere ? "✓ This key is a guardian of that wallet." : "✗ Not a guardian of that wallet yet."}</span>}
      </div>
      {s && guardianHere && (
        <>
          <button className="btn wide" disabled={!!busy} onClick={() => tx("Freeze", "guardianFreeze")}>
            ❄️ Freeze {s.frozenUntil > now ? `(frozen ${left(s.frozenUntil, now)})` : ""}
          </button>
          {s.queue.map(q => (
            <div key={q.id} className="card stack" style={{ gap: 6 }}>
              <b>{q.executeAfter > now ? `Waits ${left(q.executeAfter, now)}` : "Ready"} · by {short(q.proposer)}</b>
              {q.calls.map((c, i) => (
                <span key={i} className="fine mono" style={{ fontSize: 12 }}>
                  {describeCall(getAddress(wallet), c)}
                </span>
              ))}
              <button className="pill" disabled={!!busy} onClick={() => tx("Cancel", "guardianCancel", [q.id])}>
                Cancel it
              </button>
            </div>
          ))}
          <div className="card stack">
            <b>Replace a lost key</b>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {s.signers.map(k => (
                <button key={k.id} className={`pill ${replaces === k.id ? "on" : ""}`} onClick={() => setReplaces(k.id)}>
                  {k.kind === 1 ? "wedgie" : "passkey"} {short(k.id)}
                </button>
              ))}
              <button className={`pill ${replaces === "" ? "on" : ""}`} onClick={() => setReplaces("")}>
                add (heir)
              </button>
            </div>
            <div className="input">
              <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="new wedgie key wedgie:0x…:0x…" spellCheck={false} />
            </div>
            <button
              className="btn btn-green wide"
              disabled={!!busy || !wk}
              onClick={() =>
                tx("Start recovery", "startRecovery", [
                  (replaces || "0x0000000000000000000000000000000000000000") as Address,
                  wk!.qx,
                  wk!.qy,
                  1,
                  `0x${"0".repeat(64)}`,
                ])
              }
            >
              Start recovery (waits {left(now + s.recoveryDelay, now)})
            </button>
            {s.recovery && (
              <>
                <span className="fine">
                  Pending: {short(s.recovery.newId)} · {s.recovery.executeAfter > now ? left(s.recovery.executeAfter, now) : "ready"}
                </span>
                <button className="btn wide" disabled={!!busy || s.recovery.executeAfter > now} onClick={() => tx("Finalize", "finalizeRecovery")}>
                  Finalize recovery
                </button>
              </>
            )}
          </div>
        </>
      )}
      {busy && <p className="fine">{busy}…</p>}
      {msg && <p className="fine">{msg}</p>}
    </div>
  );
}
