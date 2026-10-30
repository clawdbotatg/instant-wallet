"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex, formatUnits, zeroAddress } from "viem";
import { chainById, publicClient } from "@/lib/chains";
import { short } from "@/lib/format";
import type { Asset } from "@/lib/types";
import { callsOf, describe, ours, relayFee } from "@/lib/safe/describe";
import { type Move, chainHistory, moved, moves } from "clear-signing-safe-kit";
import { Eject, Money, useName } from "../bits";

type Row = { chainId: number; at: string; link?: string; pay: Move[]; get: Move[]; words?: string; from?: string; failed?: boolean };
const SHOW = 6;

/**
 * Home: the last few things this wallet did and got, on every network it's on, newest first. From the chain itself
 * (clear-signing-safe-kit chainHistory, as wedgie.dev's Activity): runs, and money in from the main tokens only (a
 * 0-value or unknown-token "transfer" is address poisoning). Each run shows what it moved (its receipt), the fee apart.
 */
export function Activity({ safe, chains, assets }: { safe: Address; chains: number[]; assets: Asset[] }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const key = `${safe}|${chains.join()}`;
  useEffect(() => {
    let live = true;
    Promise.all(chains.map(c => rowsOn(c, safe).catch(() => [] as Row[])))
      .then(r => live && setRows(r.flat().sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, SHOW)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows?.length) return null;
  // dollars at today's price (what the home list uses)
  const usd = (chainId: number, m: Move) => {
    const a = assets.find(x => x.chainId === chainId && x.asset.toLowerCase() === (m.token === "eth" ? zeroAddress : m.token));
    return a?.price ? a.price * Number(m.amount) : undefined;
  };
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <b>Activity</b>
      {rows.map((r, i) => (
        <div key={i} className="recess stack" style={{ gap: 4 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
            <span className="fine">
              {new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {chainById(r.chainId)?.name}
              {r.from && <From a={r.from} chainId={r.chainId} />}
            </span>
            {r.link && <Eject href={r.link} title="Open in the explorer" />}
          </div>
          {r.failed && <span style={{ fontSize: 15, color: "#c62828", fontWeight: 600 }}>⚠️ Failed: nothing moved</span>}
          {r.pay.map((m, j) => <Money key={`p${j}`} amount={m.amount} symbol={m.symbol} usd={usd(r.chainId, m)} size={17} />)}
          {r.get.map((m, j) => <Money key={`g${j}`} amount={m.amount} symbol={m.symbol} usd={usd(r.chainId, m)} size={17} get />)}
          {r.words && <span style={{ fontSize: 15 }}>{r.words}</span>}
        </div>
      ))}
    </div>
  );
}

async function rowsOn(chainId: number, safe: Address): Promise<Row[]> {
  const info = chainById(chainId);
  const rpc = (method: string, params: unknown[]) => publicClient(chainId).request({ method: method as any, params: params as any });
  const usdc = info?.usdc?.toLowerCase();
  const tokens = new Map<string, Promise<{ symbol: string; decimals: number } | null>>();
  const token = (a: string) => {
    if (a === usdc) return Promise.resolve({ symbol: "USDC", decimals: 6 });
    if (!tokens.has(a)) tokens.set(a, rpc("alchemy_getTokenMetadata", [a]).then((m: any) => (m && typeof m.decimals === "number" ? { symbol: m.symbol || "?", decimals: m.decimals } : null)));
    return tokens.get(a)!;
  };
  const native = info?.native.symbol ?? "ETH";
  const link = (h: string) => (info?.explorer ? `${info.explorer}/tx/${h}` : undefined);
  const list = await chainHistory(rpc, chainId, safe, info?.usdc, SHOW);
  return Promise.all(
    list.map(async (t: any): Promise<Row> => {
      if (t.txType !== "MULTISIG_TRANSACTION") {
        const get = (t.transfers as any[]).map(x => {
          const sym = x.type === "ETHER_TRANSFER" ? native : x.tokenInfo.symbol;
          const dec = x.type === "ETHER_TRANSFER" ? 18 : x.tokenInfo.decimals;
          return { token: x.type === "ETHER_TRANSFER" ? "eth" : String(x.tokenAddress).toLowerCase(), symbol: sym, amount: formatUnits(BigInt(x.value), dec) };
        });
        return { chainId, at: t.executionDate, link: link(t.txHash), pay: [], get, from: t.transfers[0]?.from };
      }
      const row: Row = { chainId, at: t.executionDate, link: link(t.transactionHash), pay: [], get: [] };
      if (!t.isSuccessful) return { ...row, failed: true };
      // what it ran: known when the Safe logged it (Safe L2) or was called directly
      const calls = t.to ? callsOf({ to: t.to as Address, value: BigInt(t.value), data: t.data as Hex, operation: t.operation as 0 | 1 }) : [];
      const fees: Record<string, bigint> = {};
      for (const c of calls) {
        const f = relayFee(chainId, c);
        if (f) fees[f.token] = (fees[f.token] ?? 0n) + f.amount;
      }
      const out = calls.reduce((s, c) => s + c.value, 0n);
      const m = moves(await moved(rpc, safe, t.transactionHash, out, native, token), fees);
      // nothing moved (a signer, a limit): say what it did
      const step = calls.find(c => !ours(chainId, c)?.startsWith("Network fee"));
      const words = !m.pay.length && !m.get.length ? (step ? describe(chainId, safe, step) : "Changed the wallet") : undefined;
      return { ...row, pay: m.pay, get: m.get, words };
    }),
  );
}


function From({ a, chainId }: { a: string; chainId: number }) {
  const { name } = useName(a, chainId);
  return <> · from {name ?? short(a)}</>;
}
