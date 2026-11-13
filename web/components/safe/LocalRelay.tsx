"use client";

import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import { chainById, nativeSymbol } from "@/lib/chains";
import { isLocal } from "@/lib/local";
import { CopyAddress, Net, Who } from "../bits";
import { ErrorLine } from "./WedgieButton";

type Info = { address: string | null; balances?: { chainId: number; wei: string | null }[] };

/**
 * Settings → Your relay, only on a copy running on your own computer (lib/local.ts). Our site's relay pays the gas
 * there; here you make your own (app/api/local/relay), send it a little of each network's coin, and each send's fee
 * comes back to it.
 */
export function LocalRelay() {
  const [show, setShow] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    fetch("/api/local/relay")
      .then(r => r.json())
      .then(setInfo, e => setErr(String(e?.message || e)));
  }, []);
  useEffect(() => {
    if (!isLocal()) return;
    setShow(true);
    load();
  }, [load]);
  if (!show) return null;

  const make = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/local/relay", { method: "POST" }).then(r => r.json());
      if (r.error) throw new Error(r.error);
      load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const funded = (info?.balances ?? []).filter(b => b.wei && b.wei !== "0");
  const empty = (info?.balances ?? []).filter(b => b.wei === "0");
  return (
    <div id="relay" className="card stack" style={{ gap: 10 }}>
      <b>Your relay</b>
      <p className="fine">
        It pays the gas for your sends on this computer. Send it a little of each network&apos;s coin (Base: $1, Ethereum:
        about $5). Each send&apos;s fee comes back to it.
      </p>
      {info && !info.address && (
        <button className="btn btn-green wide" onClick={make} disabled={busy}>
          {busy ? "Making…" : "Make my relay"}
        </button>
      )}
      {info?.address && (
        <>
          <div className="keyrow" style={{ padding: 0 }}>
            <Who flat plain address={info.address} />
            <CopyAddress address={info.address} label={null} />
          </div>
          {funded.map(b => (
            <div key={b.chainId} className="row" style={{ justifyContent: "space-between" }}>
              <Net chainId={b.chainId} />
              <span className="mono">
                {Number(formatEther(BigInt(b.wei!))).toPrecision(3)} {nativeSymbol(b.chainId)}
              </span>
            </div>
          ))}
          {empty.length > 0 && <p className="fine">Empty on {empty.map(b => chainById(b.chainId)?.name).join(", ")}.</p>}
        </>
      )}
      {err && <ErrorLine text={err} />}
    </div>
  );
}
