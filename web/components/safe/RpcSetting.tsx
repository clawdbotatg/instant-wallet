"use client";

import { useEffect, useState } from "react";
import { chainById, ownRpc, setOwnRpc } from "@/lib/chains";

/** Settings → Your node: where this browser reads the picked network and sends its transactions (lib/chains.ts). */
export function RpcSetting({ chainId, toast }: { chainId: number; toast: (m: string) => void }) {
  const name = chainById(chainId)?.name ?? "this network";
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setUrl(ownRpc(chainId) ?? ""), [chainId]);
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
      <p className="fine">
        Reads {name} and sends your transactions through your own node from this browser. If it stops answering, nothing falls back to ours. Your list of coins, prices and
        token names still come from us.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <input className="grow" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" inputMode="url" autoCapitalize="off" autoCorrect="off" />
        <button className="btn btn-sm" onClick={save} disabled={busy}>
          {busy ? "Checking…" : "Save"}
        </button>
      </div>
    </div>
  );
}
