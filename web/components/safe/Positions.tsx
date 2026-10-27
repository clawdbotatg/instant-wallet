"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { chainById } from "@/lib/chains";
import { usd } from "@/lib/format";
import type { Position } from "@/lib/types";

const TYPE: Record<string, string> = { deposit: "Deposit", staked: "Staked", reward: "Reward", loan: "Loan", locked: "Locked" };

/** DeFi positions (pools, vaults, stakes) under the coins, from Zerion. Tap one to open its app. Hidden when there are none. */
export function PositionList({ address }: { address: string }) {
  const [list, setList] = useState<Position[] | null>(null);
  useEffect(() => {
    const load = () =>
      fetch(`/api/positions?address=${address}`, { cache: "no-store" })
        .then(r => r.json())
        .then(j => j?.positions && setList(j.positions))
        .catch(() => {});
    load();
    window.addEventListener("instantwallet:refresh", load);
    return () => window.removeEventListener("instantwallet:refresh", load);
  }, [address]);
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
