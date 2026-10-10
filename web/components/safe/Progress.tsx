"use client";

import { useEffect, useState } from "react";
import { type Hash, formatGwei } from "viem";
import { chainById, publicClient } from "@/lib/chains";
import type { Stage } from "@/lib/safe/send";

// rough seconds to land: Ethereum's ~12 s blocks (often 2), ~2 s on the rest
const LAND_S: Record<number, number> = { 1: 20 };
const landS = (chainId: number) => LAND_S[chainId] ?? 4;

/**
 * Under the button while a send is on its way: a bar toward the chain's usual time, what's happening, the explorer
 * link once there's a hash, and when it's slow, why (not seen yet / waiting in the mempool at what tip).
 */
export function Progress({ stage, chainId, hash }: { stage: Stage | string | null; chainId: number; hash?: Hash | null }) {
  const on = stage === "sending" || stage === "confirming";
  const [t0, setT0] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [why, setWhy] = useState<string | null>(null);
  const info = chainById(chainId);
  const expect = landS(chainId);
  const secs = t0 ? Math.max(0, Math.round((now - t0) / 1000)) : 0;
  const slow = secs > expect * 2;

  useEffect(() => {
    if (!on) return setT0(null);
    setT0(t => t ?? Date.now());
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [on]);

  useEffect(() => {
    if (!on || !slow) return setWhy(null);
    if (!hash) return setWhy("The relay hasn't answered yet. It gives up at 60 s.");
    let live = true;
    const look = async () => {
      const pc = publicClient(chainId);
      const [tx, block] = await Promise.all([pc.getTransaction({ hash }).catch(() => null), pc.getBlock().catch(() => null)]);
      if (!live) return;
      if (!tx) return setWhy("The network hasn't seen it yet. It may still be spreading.");
      if (tx.blockNumber) return setWhy("It's in a block. Checking the result…");
      const tip = tx.maxPriorityFeePerGas ?? 0n;
      const base = block?.baseFeePerGas;
      const cap = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
      if (base && cap < base) return setWhy(`Waiting: gas went up past what it pays (${formatGwei(cap)} vs ${formatGwei(base)} gwei).`);
      setWhy(`Waiting in line for a block. Tip ${formatGwei(tip)} gwei${base ? `, base fee ${formatGwei(base)} gwei` : ""}.`);
    };
    look();
    const i = setInterval(look, 6000);
    return () => {
      live = false;
      clearInterval(i);
    };
  }, [on, slow, hash, chainId]);

  if (!on) return null;
  const name = info?.name ?? "the network";
  // fills toward 90% over the usual time, then creeps
  const p = Math.min(0.97, 0.9 * (1 - Math.exp((-2.3 * secs) / expect)) + (secs > expect ? 0.07 * (1 - Math.exp(-(secs - expect) / (expect * 4))) : 0));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="progress">
        <div style={{ width: `${Math.max(3, p * 100)}%`, transitionDuration: "500ms" }} />
      </div>
      <p className="fine" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span>{stage === "sending" ? `The relay is sending it to ${name}…` : `Waiting for ${name} to include it (usually ~${expect} s)`}</span>
        <span>{secs} s</span>
      </p>
      {why && <p className="fine">{why}</p>}
      {hash && info?.explorer && (
        <a className="fine" href={`${info.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
          See it on {new URL(info.explorer).hostname} ↗
        </a>
      )}
    </div>
  );
}
