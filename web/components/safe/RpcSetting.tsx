"use client";

import { useEffect, useState } from "react";
import { createPublicClient } from "viem";
import { chainById, ownRpc, rpcTransport, setOwnRpc } from "@/lib/chains";
import { isOnion, onTor, type TorState } from "@/lib/tor";
import { PROVER } from "@/lib/safe/light";
import { canLight, lightOn, lightProver, lightSoft, setLight } from "@/lib/safe/sim";
import { provenOn, setProven } from "@/lib/safe/proven";
import { ownBeacon } from "@/lib/local";
import { TimedBar } from "../bits";

/** Settings → Your node: where this browser reads the picked network and sends its transactions (lib/chains.ts). */
export function RpcSetting({ chainId, toast }: { chainId: number; toast: (m: string) => void }) {
  const name = chainById(chainId)?.name ?? "this network";
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [light, setLightOn] = useState(false);
  const [prover, setProver] = useState("");
  const [proven, setProvenOn] = useState(false);
  const [torState, setTorState] = useState<TorState>("off");
  useEffect(() => onTor(setTorState), []);
  useEffect(() => {
    setUrl(ownRpc(chainId) ?? "");
    setLightOn(lightOn(chainId) || lightSoft(chainId));
    setProvenOn(provenOn(chainId));
    setProver(canLight(chainId) && lightProver(chainId) !== PROVER[chainId] ? lightProver(chainId) : "");
  }, [chainId]);
  const saveLight = (on: boolean, p = prover) => (setLight(chainId, on, p), setLightOn(on));
  const save = async () => {
    const u = url.trim().replace(/\/$/, "");
    if (!u) {
      setOwnRpc(chainId, null);
      return toast(`Using our node on ${name}`);
    }
    if (!/^https?:\/\//.test(u)) return toast("It starts with http:// or https://");
    setBusy(true);
    if (isOnion(u)) {
      // over Tor, from this browser: the first start takes up to a minute
      const prev = ownRpc(chainId);
      setOwnRpc(chainId, u); // rpcTransport reads the saved address
      const id = await createPublicClient({ chain: chainById(chainId)!.chain, transport: rpcTransport(chainId) })
        .getChainId()
        .catch(() => null);
      setBusy(false);
      if (id === chainId) return toast(`Using your node on ${name} over Tor`);
      setOwnRpc(chainId, prev ?? null);
      return toast(id === null ? "No answer over Tor. Check the address." : `That isn't ${name}`);
    }
    // it must answer, from this page, as this network, or it isn't kept
    const id = await fetch(u, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(8000),
    })
      .then(r => r.json())
      .then(j => Number(j?.result))
      .catch(() => null);
    setBusy(false);
    if (id === null) return toast("No answer. The node must allow this site (CORS).");
    if (id !== chainId) return toast(`That isn't ${name}`);
    setOwnRpc(chainId, u);
    toast(`Using your node on ${name}`);
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <div className="input grow"><input value={url} onChange={e => setUrl(e.target.value)} placeholder="Default node" inputMode="url" autoCapitalize="off" autoCorrect="off" /></div>
        <button className="btn btn-sm" onClick={save} disabled={busy}>
          {busy ? (isOnion(url) && torState === "starting" ? "Starting Tor…" : "Checking…") : "Save"}
        </button>
      </div>
      {busy && <TimedBar ms={isOnion(url) ? 60000 : 8000} />}
      {canLight(chainId) && (
        <>
          <label className="row fine" style={{ gap: 8 }}>
            <input type="checkbox" checked={proven} onChange={e => (setProven(chainId, e.target.checked), setProvenOn(e.target.checked))} />
            Prove balances
          </label>
          <label className="row fine" style={{ gap: 8 }}>
            <input type="checkbox" checked={light} onChange={e => saveLight(e.target.checked)} />
            Run a light client
          </label>
          {light && (
            <div className="stack" style={{ gap: 4 }}>
              <div className="row" style={{ gap: 8 }}>
                <div className="input grow"><input value={prover} onChange={e => setProver(e.target.value)} placeholder={ownBeacon(chainId) ? "Your node" : PROVER[chainId]} inputMode="url" autoCapitalize="off" autoCorrect="off" /></div>
                <button className="btn btn-sm" onClick={() => (saveLight(true), toast(prover.trim() ? "Using your prover" : ownBeacon(chainId) ? "Your node proves it" : "Using Colibri's prover"))}>
                  Save
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
