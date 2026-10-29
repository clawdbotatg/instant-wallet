"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useRef, useState } from "react";
import { chainById } from "@/lib/chains";
import { usd } from "@/lib/format";
import type { Asset, Position } from "@/lib/types";

const TYPE: Record<string, string> = { deposit: "Deposit", staked: "Staked", reward: "Reward", loan: "Loan", locked: "Locked" };

// after a balance moves (a deposit or withdraw landed), Zerion is asked again at these times: it lags the chain
const AFTER_MOVE_MS = [5_000, 10_000, 15_000, 30_000, 60_000];

/**
 * DeFi positions (pools, vaults, stakes) under the coins, from Zerion; their sum goes into the big total. Tap one to open its app.
 * Hidden when there are none. `onReceipts` gets the tokens the positions stand for (aBasUSDC for an Aave deposit), so the coin
 * list drops them instead of showing the same money twice.
 *
 * Zerion lags the chain by up to a minute; the coins (`assets`, Alchemy, every 3 s) don't. So a position with a receipt
 * token is valued by that token's balance now: Zerion's value × (balance now / balance when Zerion last changed). A
 * withdraw shows at once (all of it gone: the position goes), and Zerion is asked again 5, 10, 15, 30, 60 s after.
 * `assets` is undefined until the fresh portfolio lands (the saved one may be old).
 */
export function PositionList({
  address,
  assets,
  onTotal,
  onReceipts,
}: {
  address: string;
  assets?: Asset[];
  onTotal: (usd: number) => void;
  onReceipts: (keys: string[]) => void;
}) {
  const [list, setList] = useState<Position[] | null>(null);
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  // per position: Zerion's value and the receipt balance on chain when that value last changed
  // (null: the fresh coins hadn't landed yet)
  const base = useRef(new Map<string, { p: Position; usd: number; held: bigint | null }>());
  const seen = useRef(new Set<string>()); // receipt tokens seen in the coins this visit: gone from them later = withdrawn
  const loadRef = useRef<(fresh?: boolean) => void>(() => {});

  useEffect(() => {
    base.current.clear();
    seen.current.clear();
    // a failed load retries in 15 s: the passkey rename waits for the positions total (SafeApp)
    let retry: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    const load = (fresh?: boolean) => {
      clearTimeout(retry);
      fetch(`/api/positions?address=${address}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" })
        .then(r => r.json())
        .then(j => {
          if (gone) return;
          if (!j?.positions) throw new Error("no positions");
          for (const p of j.positions as Position[]) {
            const was = base.current.get(p.id);
            // Zerion's value unchanged = it hasn't seen the latest move yet: keep the balance it was right about
            if (was && Math.abs(p.usd - was.usd) <= Math.max(0.01, Math.abs(was.usd) * 0.005)) continue;
            base.current.set(p.id, { p, usd: p.usd, held: assetsRef.current ? held(p, assetsRef.current) : null });
          }
          setList(j.positions);
        })
        .catch(() => gone || (retry = setTimeout(load, 15_000)));
    };
    loadRef.current = load;
    load();
    const pull = () => load(true);
    window.addEventListener("instantwallet:refresh", pull);
    return () => {
      gone = true;
      clearTimeout(retry);
      window.removeEventListener("instantwallet:refresh", pull);
    };
  }, [address]);

  // any balance change in the coins: ask Zerion again a few times. Balances are rounded to 6 digits: interest
  // (aBasUSDC grows every block) would otherwise count as a move every 3 s and keep pushing the re-asks back
  const sig = assets?.map(a => `${a.chainId}:${a.asset}:${Number(a.formatted).toPrecision(6)}`).join(",");
  const lastSig = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (sig === undefined) return;
    for (const b of base.current.values()) if (b.held === null) b.held = held(b.p, assets);
    const prev = lastSig.current;
    lastSig.current = sig;
    if (prev === undefined || prev === sig) return;
    const ts = AFTER_MOVE_MS.map(ms => setTimeout(() => loadRef.current(true), ms));
    return () => ts.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const shown = useMemo(() => {
    if (!list) return null;
    for (const a of assets ?? []) seen.current.add(`${a.chainId}:${a.asset}`.toLowerCase());
    return list
      .map(p => {
        if (!assets || !p.receipts?.length) return p;
        const now = held(p, assets);
        const b = base.current.get(p.id);
        if (b?.held) return { ...p, usd: (p.usd * Number(now)) / Number(b.held) };
        // none held now, but some were earlier this visit: withdrawn, Zerion hasn't caught up
        if (now === 0n && p.receipts.some(r => seen.current.has(`${p.chainId}:${r}`))) return { ...p, usd: 0 };
        return p;
      })
      .filter(p => Math.abs(p.usd) >= 1);
  }, [list, assets]);

  useEffect(() => {
    if (!shown || !list) return;
    onReceipts(list.flatMap(p => (p.receipts ?? []).map(a => `${p.chainId}:${a}`.toLowerCase())));
    onTotal(shown.reduce((t, p) => t + p.usd, 0));
  }, [shown, list, onTotal, onReceipts]);

  if (!shown?.length) return null;
  return (
    <div className="card assets">
      {shown.map(p => (
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

/** The wallet's balance (base units) of a position's receipt tokens, from the coins. */
function held(p: Position, assets?: Asset[]): bigint {
  const r = new Set((p.receipts ?? []).map(x => x.toLowerCase()));
  return (assets ?? []).filter(a => a.chainId === p.chainId && r.has(a.asset.toLowerCase())).reduce((t, a) => t + BigInt(a.balance), 0n);
}
