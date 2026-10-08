"use client";

import { useState } from "react";
import type { Hex } from "viem";
import { hybridSign } from "@/lib/safe/pq/hybrid";

/**
 * EXPERIMENTAL lab page, not linked from the app (docs/PQ-HYBRID.md). One passkey tap makes a P-256 signature
 * and a post-quantum (SPHINCS- C11) signature over a dummy tx hash, and shows how long each step took here.
 * Nothing is sent anywhere.
 */
export default function PQLab() {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string[]>([]);
  const [err, setErr] = useState("");

  async function run() {
    setBusy(true);
    setErr("");
    try {
      const h = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("")}` as Hex;
      const t0 = performance.now();
      const a = await hybridSign(undefined, 8453, "0x000000000000000000000000000000000000dEaD", 0n, h);
      const total = performance.now() - t0;
      const s = (ms?: number) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(2)} s`);
      setOut([
        `Face ID: ${s(a.ms.tap)}`,
        `Next key: ${s(a.ms.next)}`,
        `This key: ${s(a.ms.key)}`,
        `Hash signature: ${s(a.ms.sign)}`,
        `Total: ${s(total)}`,
        `Signature: ${(a.pqSig.length - 2) / 2} bytes`,
        `Next key hash: ${a.next.slice(0, 18)}…`,
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <h1>Post-quantum lab</h1>
      <p className="fine">
        Experimental. One Face ID makes your normal passkey signature and a hash-only (post-quantum) signature. This times it on this
        device. Nothing is sent.
      </p>
      <button className="btn btn-green" disabled={busy} onClick={run}>
        {busy ? "Signing…" : "Tap to test"}
      </button>
      {err && <p className="err">{err}</p>}
      {out.length > 0 && (
        <div className="card kv">
          {out.map(l => {
            const [k, v] = l.split(": ");
            return (
              <div key={k}>
                <span>{k}</span>
                <b className="mono">{v}</b>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
