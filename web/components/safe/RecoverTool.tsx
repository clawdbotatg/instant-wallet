"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex, encodeFunctionData, getAddress, isAddress } from "viem";
import { CHAINS, chainById, explorerTx, publicClient } from "@/lib/chains";
import { short } from "@/lib/format";
import { DAO, RECOVERY_7D, SAFE_FACTORY } from "@/lib/safe/config";
import { abi, deploySafeCall, safeAddress } from "@/lib/safe/core";
import { Band, copy } from "../bits";
import { ChainSelect } from "./Pick";
import { friendly } from "../Welcome";

const eth = () => (typeof window === "undefined" ? undefined : (window as any).ethereum);

/** Send one transaction from the connected browser wallet (it pays the gas). */
async function sendFromWallet(chainId: number, to: Address, data: Hex): Promise<Hex> {
  if (!eth()) throw new Error("No browser wallet here. Open this page in a browser with a wallet extension.");
  const [from] = await eth().request({ method: "eth_requestAccounts" });
  const want = "0x" + chainId.toString(16);
  if ((await eth().request({ method: "eth_chainId" })) !== want) await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  return eth().request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
}

/**
 * The recovery address's tool. Three steps, each one transaction from the recovery address's own wallet:
 *   0. (only if the wallet was never deployed on this chain) deploy it from its first setup: needs the wallet card's burner signer
 *   1. start: confirmRecovery(wallet, [new key], 1, true) — the 7-day wait starts; the owner gets an alert and can cancel
 *   2. after 7 days, anyone: finalizeRecovery(wallet)
 * The DAO is a Safe: it pastes the calldata shown here into Safe{Wallet}'s transaction builder.
 */
export function RecoverTool() {
  const q = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const [chainId, setChainId] = useState(CHAINS[0].id);
  const [wallet, setWallet] = useState(q?.get("wallet") ?? "");
  const [newKey, setNewKey] = useState(q?.get("owner") ?? "");
  const [original, setOriginal] = useState("");
  const [info, setInfo] = useState<{ deployed: boolean; guardians: Address[]; executeAfter: number; newOwners: Address[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const w = isAddress(wallet.trim()) ? getAddress(wallet.trim()) : null;

  useEffect(() => {
    if (!w) return setInfo(null);
    const pc = publicClient(chainId);
    let live = true; // switching chain or wallet mid-read must not show the old one's state
    setInfo(null);
    (async () => {
      const code = await pc.getCode({ address: w }).catch(() => undefined);
      const deployed = !!code && code !== "0x";
      if (!deployed) return live && setInfo({ deployed, guardians: [DAO], executeAfter: 0, newOwners: [] });
      const [g, r] = await Promise.all([
        pc.readContract({ address: RECOVERY_7D, abi: abi.recovery, functionName: "getGuardians", args: [w] }).catch(() => []),
        pc.readContract({ address: RECOVERY_7D, abi: abi.recovery, functionName: "getRecoveryRequest", args: [w] }).catch(() => null),
      ]);
      if (live) setInfo({ deployed, guardians: [...(g as Address[])], executeAfter: r ? Number((r as any).executeAfter) * 1000 : 0, newOwners: r ? [...(r as any).newOwners] : [] });
    })();
    return () => {
      live = false;
    };
  }, [w, chainId, tick]);

  const startData = w && isAddress(newKey.trim()) ? encodeFunctionData({ abi: abi.recovery, functionName: "confirmRecovery", args: [w, [getAddress(newKey.trim())], 1n, true] }) : null;
  const finalizeData = w ? encodeFunctionData({ abi: abi.recovery, functionName: "finalizeRecovery", args: [w] }) : null;

  async function run(to: Address, data: Hex, what: string) {
    setError(null);
    setMsg(`${what}: confirm in your wallet…`);
    try {
      const hash = await sendFromWallet(chainId, to, data);
      setMsg(`${what}: sent. ${explorerTx(chainId, hash) ?? hash}`);
      await publicClient(chainId).waitForTransactionReceipt({ hash });
      setMsg(`${what}: done.`);
      setTick(t => t + 1);
    } catch (e: any) {
      setMsg(null);
      setError(friendly(e));
    }
  }

  const ready = info && info.executeAfter > 0 && Date.now() >= info.executeAfter;

  return (
    <div className="app">
      <h1>Recover a wallet</h1>
      <p className="fine">For a wallet&apos;s recovery address: the DAO, a paper seed opened in a wallet, a friend. You swap in the owner&apos;s new key; it lands after 7 days, and the owner can cancel it from any key they still have.</p>
      <Band />
      <ChainSelect value={chainId} onChange={setChainId} />
      <div className="field">
        <label>The wallet</label>
        <div className="input">
          <input value={wallet} onChange={e => setWallet(e.target.value)} placeholder="0x…" autoCapitalize="none" spellCheck={false} />
        </div>
      </div>
      {info && (
        <p className="fine">
          On {chainById(chainId)?.name}: {info.deployed ? "deployed" : "not deployed yet"}. Recovery address{info.guardians.length > 1 ? "es" : ""}:{" "}
          {info.guardians.map(g => (g.toLowerCase() === DAO.toLowerCase() ? "dao.buidlguidl.eth" : short(g))).join(", ")}.
          {info.executeAfter > 0 && ` A recovery to ${info.newOwners.map(short).join(", ")} is pending until ${new Date(info.executeAfter).toLocaleString()}.`}
        </p>
      )}

      {info && !info.deployed && (
        <div className="card stack">
          <b>0. Deploy it here first</b>
          <p className="fine">It was never used on {chainById(chainId)?.name}. Paste the &quot;Instant wallet key&quot; from the owner&apos;s wallet card.</p>
          <div className="input">
            <input value={original} onChange={e => setOriginal(e.target.value)} placeholder="0x… Instant wallet key" autoCapitalize="none" spellCheck={false} />
          </div>
          {isAddress(original.trim()) && w && safeAddress(getAddress(original.trim())) !== w && <p className="err">That signer doesn&apos;t make this wallet.</p>}
          <button
            className="btn wide"
            disabled={!w || !isAddress(original.trim()) || safeAddress(getAddress(original.trim())) !== w}
            onClick={() => run(SAFE_FACTORY, deploySafeCall(getAddress(original.trim())).data, "Deploy")}
          >
            Deploy it (your wallet pays the gas)
          </button>
        </div>
      )}

      <div className="card stack">
        <b>1. Start the recovery</b>
        <div className="input">
          <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="0x… the owner's new key (from their new phone)" autoCapitalize="none" spellCheck={false} />
        </div>
        <button className="btn btn-green wide" disabled={!startData || !info?.deployed} onClick={() => startData && run(RECOVERY_7D, startData, "Start")}>
          Start (from the recovery address)
        </button>
        {startData && (
          <button className="pill" onClick={() => copy(`chain ${chainById(chainId)?.name} (${chainId})\nto ${RECOVERY_7D}\nvalue 0\ndata ${startData}`)}>
            Copy as a Safe transaction (for the DAO)
          </button>
        )}
      </div>

      <div className="card stack">
        <b>2. Finish, after 7 days</b>
        <button className="btn wide" disabled={!ready || !finalizeData} onClick={() => finalizeData && run(RECOVERY_7D, finalizeData, "Finish")}>
          {info?.executeAfter ? (ready ? "Finish the recovery" : `Ready ${new Date(info.executeAfter).toLocaleString()}`) : "Nothing pending"}
        </button>
      </div>
      {msg && <p className="fine mono">{msg}</p>}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
