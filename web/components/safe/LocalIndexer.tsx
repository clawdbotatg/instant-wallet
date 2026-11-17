"use client";

import { useCallback, useEffect, useState } from "react";
import { isLocal } from "@/lib/local";
import { chainById } from "@/lib/chains";
import { TimedBar } from "../bits";

type Info = { setUp: boolean; on: boolean; up: boolean; chains: { id: number; name: string; wallets: number; scanned: number }[]; networks: number[]; nodes: Record<string, string> };

/**
 * Settings → Balances and prices, only on a copy running on your own computer (lib/local.ts): from your own indexer
 * (clawdbotatg/iw-indexer, reading your node) or from Alchemy, as on our site. app/api/local/indexer.
 */
export function LocalIndexer({ chainId, toast }: { chainId: number; toast: (m: string) => void }) {
  const [show, setShow] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [node, setNode] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      fetch("/api/local/indexer", { cache: "no-store" })
        .then(r => r.json())
        .then((i: Info) => (setInfo(i), i), () => null),
    [],
  );
  useEffect(() => {
    if (!isLocal()) return;
    setShow(true);
    load();
  }, [load]);
  // the node box shows what the indexer reads the picked network from
  const had = info?.nodes?.[chainId] ?? "";
  useEffect(() => setNode(had), [had, chainId]);
  if (!show || !info) return null;
  const name = chainById(chainId)?.name ?? "this network";

  // the indexer checks the node answers as this network, keeps it, and restarts on it (a few seconds)
  const saveNode = async () => {
    const u = node.trim().replace(/\/$/, "");
    if (u && !/^https?:\/\//.test(u)) return toast("It starts with http:// or https://");
    setBusy(true);
    const r = await fetch("/api/local/indexer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain: chainId, node: u || null }) })
      .then(r => r.json())
      .catch(() => ({ error: "No answer." }));
    if (r.error) return setBusy(false), toast(r.error);
    for (let i = 0; i < 20; i++) {
      await new Promise(res => setTimeout(res, 1000));
      const n = await load();
      if (n?.up && !!n.nodes?.[chainId] === !!u) break;
    }
    setBusy(false);
    toast(u ? `Your indexer reads ${name} from your node` : `Your indexer stopped reading ${name}`);
  };

  const set = async (on: boolean) => {
    setInfo({ ...info, on });
    await fetch("/api/local/indexer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });
    toast(on ? "Balances from your indexer" : "Balances from Alchemy");
    load();
  };

  if (!info.setUp)
    return (
      <div className="stack" style={{ gap: 6 }}>
        <span>From Alchemy.</span>
        <span className="fine">Your indexer needs Node 22.18 or newer. Then run ./run-local.sh again.</span>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 8 }}>
      {info.up && info.networks?.includes(chainId) && (
        <>
          <div className="row" style={{ gap: 8 }}>
            <div className="input grow">
              <input value={node} onChange={e => setNode(e.target.value)} placeholder={`${name} node for your indexer`} inputMode="url" autoCapitalize="off" autoCorrect="off" />
            </div>
            <button className="btn btn-sm" onClick={saveNode} disabled={busy || node.trim().replace(/\/$/, "") === had}>
              {busy ? "Checking…" : "Save"}
            </button>
          </div>
          {busy && <TimedBar ms={8000} />}
        </>
      )}
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={info.on} onChange={e => set(e.target.checked)} />
        From my indexer
      </label>
      {info.on && !info.up && <span className="fine">Your indexer isn&apos;t answering: Alchemy for now.</span>}
      {info.on &&
        info.up &&
        info.chains.map(c => (
          <span key={c.id} className="fine">
            {c.name}: {c.scanned < c.wallets ? `reading history, ${c.scanned} of ${c.wallets} wallets done` : "ready"}
          </span>
        ))}
      {info.on && info.up && <span className="fine">Other networks: Alchemy.</span>}
      {!info.on && <span className="fine">From Alchemy, as on instantwallet.io.</span>}
    </div>
  );
}
