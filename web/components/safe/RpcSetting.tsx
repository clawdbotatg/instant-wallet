"use client";

import { useEffect, useState } from "react";
import { chainById, ownRpc, setOwnRpc } from "@/lib/chains";
import { PROVER } from "@/lib/safe/light";
import { canLight, lightOn, lightProver, setLight } from "@/lib/safe/sim";

/** Settings → Your node: where this browser reads the picked network and sends its transactions (lib/chains.ts). */
export function RpcSetting({ chainId, toast }: { chainId: number; toast: (m: string) => void }) {
  const name = chainById(chainId)?.name ?? "this network";
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [light, setLightOn] = useState(false);
  const [prover, setProver] = useState("");
  useEffect(() => {
    setUrl(ownRpc(chainId) ?? "");
    setLightOn(lightOn(chainId));
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
      <p className="fine">Use your own RPC. Empty uses ours.</p>
      <div className="row" style={{ gap: 8 }}>
        <input className="grow" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" inputMode="url" autoCapitalize="off" autoCorrect="off" />
        <button className="btn btn-sm" onClick={save} disabled={busy}>
          {busy ? "Checking…" : "Save"}
        </button>
      </div>
      {canLight(chainId) && (
        <>
          <label className="row fine" style={{ gap: 8 }}>
            <input type="checkbox" checked={light} onChange={e => saveLight(e.target.checked)} />
            Run a light client. Simulates here, not on our server.
          </label>
          {light && (
            <div className="stack" style={{ gap: 4 }}>
              <span className="fine">Colibri prover:</span>
              <div className="row" style={{ gap: 8 }}>
                <input className="grow" value={prover} onChange={e => setProver(e.target.value)} placeholder={PROVER[chainId]} inputMode="url" autoCapitalize="off" autoCorrect="off" />
                <button className="btn btn-sm" onClick={() => (saveLight(true), toast(prover.trim() ? "Using your prover" : "Using Colibri's prover"))}>
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
