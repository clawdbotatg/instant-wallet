"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { chainById } from "@/lib/chains";
import { usd } from "@/lib/format";
import type { Position } from "@/lib/types";

const TYPE: Record<string, string> = { deposit: "Deposit", staked: "Staked", reward: "Reward", loan: "Loan", locked: "Locked" };

/**
 * DeFi positions (pools, vaults, stakes) under the coins, from Zerion; their sum goes into the big total. Tap one to open its app.
 * Hidden when there are none. `onReceipts` gets the tokens the positions stand for (aBasUSDC for an Aave deposit), so the coin
 * list drops them instead of showing the same money twice.
 */
export function PositionList({ address, onTotal, onReceipts }: { address: string; onTotal: (usd: number) => void; onReceipts: (keys: string[]) => void }) {
  const [list, setList] = useState<Position[] | null>(null);
  useEffect(() => {
    // a failed load retries in 15 s: the passkey rename waits for the positions total (SafeApp)
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      clearTimeout(retry);
      fetch(`/api/positions?address=${address}`, { cache: "no-store" })
        .then(r => r.json())
        .then(j => {
          if (!j?.positions) throw new Error("no positions");
          setList(j.positions);
          onReceipts(j.positions.flatMap((p: Position) => (p.receipts ?? []).map(a => `${p.chainId}:${a}`.toLowerCase())));
          onTotal(j.positions.reduce((t: number, p: Position) => t + p.usd, 0));
        })
        .catch(() => (retry = setTimeout(load, 15_000)));
    };
    load();
    window.addEventListener("instantwallet:refresh", load);
    return () => {
      clearTimeout(retry);
      window.removeEventListener("instantwallet:refresh", load);
    };
  }, [address, onTotal, onReceipts]);
  if (!list?.length) return null;
  return (
    <div className="card assets">
      {list.map(p => (
        <a key={p.id} className="asset" href={p.url} target="_blank" rel="noopener noreferrer">
          <div className="logo">{p.icon ? <img src={p.icon} alt="" /> : p.protocol.slice(0, 2)}</div>
          <div className="grow">
            <div className="sym">{p.name}</div>
            <div className="fine">
              {[TYPE[p.type] ?? p.type, chainById(p.chainId)?.name, p.tokens.join(" + ")].filter(Boolean).join(" · ")}
            </div>
          </div>
          <div className="right">
            <div className="sym">{usd(p.usd)}</div>
          </div>
        </a>
      ))}
    </div>
  );
}
