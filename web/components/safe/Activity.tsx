"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex, formatUnits, zeroAddress } from "viem";
import { chainById, publicClient } from "@/lib/chains";
import { short } from "@/lib/format";
import type { Asset } from "@/lib/types";
import { callsOf, relayFee } from "@/lib/safe/describe";
import { type Move, chainHistory, moved, moves } from "clear-signing-safe-kit";
import { Eject, Money, useName } from "../bits";
import { explainCalls, intents } from "./WhatItDoes";

type Row = { chainId: number; at: string; link?: string; pay: Move[]; get: Move[]; words?: string; from?: string; failed?: boolean };
const SHOW = 6;

/**
 * Home: the last few things this wallet did and got, on every network it's on, newest first. From the chain itself
 * (clear-signing-safe-kit chainHistory, as wedgie.dev's Activity): runs, and money in from the main tokens only (a
 * 0-value or unknown-token "transfer" is address poisoning). Each run leads with what it was for, in clear signing's
 * words (Austin 10-30: red and green alone don't say why); what it moved (its receipt, the fee apart) sits small under it.
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
            </span>
            {r.link && <Eject href={r.link} title="Open in the explorer" />}
          </div>
          {(r.from || r.words) && <span style={{ fontSize: 17, fontWeight: 700 }}>{r.from ? <>Received from <From a={r.from} chainId={r.chainId} /></> : r.words}</span>}
          {r.failed && <span style={{ fontSize: 15, color: "#c62828", fontWeight: 600 }}>⚠️ Failed: nothing moved</span>}
          {(r.pay.length > 0 || r.get.length > 0) && (
            <div className="row" style={{ gap: "2px 12px", flexWrap: "wrap" }}>
              {r.pay.map((m, j) => <Money key={`p${j}`} amount={m.amount} symbol={m.symbol} usd={usd(r.chainId, m)} size={r.from || r.words ? 14 : 17} />)}
              {r.get.map((m, j) => <Money key={`g${j}`} amount={m.amount} symbol={m.symbol} usd={usd(r.chainId, m)} size={r.from || r.words ? 14 : 17} get />)}
            </div>
          )}
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
      // what it ran: known when the Safe logged it (Safe L2) or was called directly; what for, in clear signing's words
      const calls = t.to ? callsOf({ to: t.to as Address, value: BigInt(t.value), data: t.data as Hex, operation: t.operation as 0 | 1 }) : [];
      const words = intents(chainId, safe, calls, await explainCalls(chainId, safe, calls), true).join(" · ") || undefined;
      const row: Row = { chainId, at: t.executionDate, link: link(t.transactionHash), pay: [], get: [], words };
      if (!t.isSuccessful) return { ...row, failed: true };
      const fees: Record<string, bigint> = {};
      for (const c of calls) {
        const f = relayFee(chainId, c);
        if (f) fees[f.token] = (fees[f.token] ?? 0n) + f.amount;
      }
      const out = calls.reduce((s, c) => s + c.value, 0n);
      const m = moves(await moved(rpc, safe, t.transactionHash, out, native, token), fees);
      // nothing moved and nothing to say (a call it didn't log): it changed the wallet
      return { ...row, pay: m.pay, get: m.get, words: words ?? (!m.pay.length && !m.get.length ? "Changed the wallet" : undefined) };
    }),
  );
}


function From({ a, chainId }: { a: string; chainId: number }) {
  const { name } = useName(a, chainId);
  return <>{name ?? short(a)}</>;
}
