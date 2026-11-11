"use client";

import { useEffect, useRef, useState } from "react";
import { type Address, type Hex, formatUnits, zeroAddress } from "viem";
import { chainById, publicClient } from "@/lib/chains";
import type { Asset } from "@/lib/types";
import { callsOf, relayFee } from "@/lib/safe/describe";
import { type Sending, onSending, sendingNow } from "@/lib/safe/sending";
import { type Move, chainHistory, moved, moves, safeLogs } from "clear-signing-safe-kit";
import { ChainIcon, Eject, Money, WhatFor, Who } from "../bits";
import { type Line, Lines, explainCalls, intents } from "./WhatItDoes";

type Row = { chainId: number; at: string; hash?: string; link?: string; pay: Move[]; get: Move[]; words?: Line[]; from?: string; failed?: boolean };
const SHOW = 6;

/**
 * Home: the last few things this wallet did and got, on every network it's on, newest first. From the chain itself
 * (clear-signing-safe-kit chainHistory, as wedgie.dev's Activity): runs, and money in from the main tokens only (a
 * 0-value or unknown-token "transfer" is address poisoning). Each run leads with what it was for, in clear signing's
 * words (Austin 10-30: red and green alone don't say why); what it moved (its receipt, the fee apart) sits small under it.
 * Read again, past the kit's minute-long cache, on every `tick` (Home's refresh: a sheet closed, a pull, back to the
 * app) and when something this page sent lands. What it's still sending sits on top, "Sending…" (lib/safe/sending.ts).
 */
export function Activity({ safe, chains, assets, tick }: { safe: Address; chains: number[]; assets: Asset[]; tick?: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [out, setOut] = useState<Sending[]>(() => sendingNow());
  const [landed, setLanded] = useState(0);
  const key = `${safe}|${chains.join()}`;
  const seen = useRef("");
  useEffect(() => {
    let later: ReturnType<typeof setTimeout> | undefined;
    const off = onSending(l => {
      setOut(sendingNow());
      if (!l) return;
      // read the chain now, and again a beat later (a node can answer the receipt a block before its logs)
      setLanded(n => n + 1);
      clearTimeout(later);
      later = setTimeout(() => setLanded(n => n + 1), 5_000);
    });
    return () => {
      off();
      clearTimeout(later);
    };
  }, []);
  useEffect(() => {
    let live = true;
    // the first read may use the kit's cache; every later one goes to the chain
    const fresh = seen.current === key;
    seen.current = key;
    Promise.all(chains.map(c => rowsOn(c, safe, fresh).catch(() => [] as Row[])))
      .then(r => live && setRows(r.flat().sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, SHOW)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, tick, landed]); // eslint-disable-line react-hooks/exhaustive-deps
  // still on its way: this wallet's, and not already in the chain's list
  const ours = out.filter(s => s.safe.toLowerCase() === safe.toLowerCase() && !rows?.some(r => s.hash && r.hash === s.hash.toLowerCase()));
  if (!rows?.length && !ours.length) return null;
  // dollars at today's price (what the home list uses)
  const usd = (chainId: number, m: Move) => {
    const a = assets.find(x => x.chainId === chainId && x.asset.toLowerCase() === (m.token === "eth" ? zeroAddress : m.token));
    return a?.price ? a.price * Number(m.amount) : undefined;
  };
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <b>Activity</b>
      {ours.map(s => (
        <SendingRow key={`s${s.id}`} s={s} assets={assets} usd={usd} />
      ))}
      {(rows ?? []).map((r, i) => (
        <div key={i} className="recess stack" style={{ gap: 4 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
            <span className="fine row" style={{ gap: 5 }}>
              {new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · <ChainIcon chainId={r.chainId} size={14} /> {chainById(r.chainId)?.name}
            </span>
            {r.link && <Eject href={r.link} title="Open in the explorer" />}
          </div>
          {(r.from || r.words) && <WhatFor>{r.from ? <>Received from <From a={r.from} chainId={r.chainId} /></> : <Lines lines={r.words!} chain={r.chainId} />}</WhatFor>}
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

/** One this page sent that isn't on chain yet: a dashed card, a spinner and "Sending…" where the date goes, its words
 * (clear signing's, as the rows under it) and what it sends out, read from its own calls. */
function SendingRow({ s, assets, usd }: { s: Sending; assets: Asset[]; usd: (chainId: number, m: Move) => number | undefined }) {
  const [words, setWords] = useState<Line[] | undefined>();
  useEffect(() => {
    let live = true;
    explainCalls(s.chainId, s.safe, s.calls)
      .then(t => live && setWords(intents(s.chainId, s.safe, s.calls, t, true)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [s]);
  const pay = paysOut(s, assets);
  const link = s.hash && chainById(s.chainId)?.explorer ? `${chainById(s.chainId)!.explorer}/tx/${s.hash}` : undefined;
  return (
    <div className="recess stack" style={{ gap: 4, outline: "2px dashed rgba(31,166,65,.55)", outlineOffset: -2 }} aria-label="Sending, not on chain yet">
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <span className="fine row" style={{ gap: 5 }}>
          <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
          <b>{s.landed ? "Sent" : s.hash ? "Sending…" : "Sending to the network…"}</b> · <ChainIcon chainId={s.chainId} size={14} /> {chainById(s.chainId)?.name}
        </span>
        {link && <Eject href={link} title="Open in the explorer" />}
      </div>
      {words && words.length > 0 && <WhatFor><Lines lines={words} chain={s.chainId} /></WhatFor>}
      {pay.length > 0 && (
        <div className="row" style={{ gap: "2px 12px", flexWrap: "wrap" }}>
          {pay.map((m, j) => <Money key={j} amount={m.amount} symbol={m.symbol} usd={usd(s.chainId, m)} size={words?.length ? 14 : 17} />)}
        </div>
      )}
    </div>
  );
}

/** What a send pays out, from its calls alone (the receipt says it once it lands): the chain's coin and plain token
 * transfers of coins this wallet holds; never the relay's fee. */
function paysOut(s: Sending, assets: Asset[]): Move[] {
  const sum = new Map<string, bigint>();
  for (const c of s.calls) {
    if (relayFee(s.chainId, c)) continue;
    if (c.value > 0n) sum.set("eth", (sum.get("eth") ?? 0n) + c.value);
    if (c.data.slice(0, 10).toLowerCase() === "0xa9059cbb" && c.data.length >= 138) {
      const t = c.to.toLowerCase();
      sum.set(t, (sum.get(t) ?? 0n) + BigInt("0x" + c.data.slice(74, 138)));
    }
  }
  const out: Move[] = [];
  for (const [token, v] of sum) {
    const a = assets.find(x => x.chainId === s.chainId && x.asset.toLowerCase() === (token === "eth" ? zeroAddress : token));
    const usdc = chainById(s.chainId)?.usdc?.toLowerCase();
    const sym = token === "eth" ? (chainById(s.chainId)?.native.symbol ?? "ETH") : token === usdc ? "USDC" : a?.symbol;
    const dec = token === "eth" ? 18 : token === usdc ? 6 : a?.decimals;
    if (sym && dec !== undefined) out.push({ token, symbol: sym, amount: formatUnits(v, dec) } as Move);
  }
  return out;
}

async function rowsOn(chainId: number, safe: Address, fresh = false): Promise<Row[]> {
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
  // fresh: read the Safe's logs again now (chainHistory then uses them), not the kit's copy from up to a minute ago
  if (fresh) await safeLogs(rpc, chainId, safe, SHOW + 5, true);
  const list = await chainHistory(rpc, chainId, safe, info?.usdc, SHOW);
  return Promise.all(
    list.map(async (t: any): Promise<Row> => {
      if (t.txType !== "MULTISIG_TRANSACTION") {
        const get = (t.transfers as any[]).map(x => {
          const sym = x.type === "ETHER_TRANSFER" ? native : x.tokenInfo.symbol;
          const dec = x.type === "ETHER_TRANSFER" ? 18 : x.tokenInfo.decimals;
          return { token: x.type === "ETHER_TRANSFER" ? "eth" : String(x.tokenAddress).toLowerCase(), symbol: sym, amount: formatUnits(BigInt(x.value), dec) };
        });
        return { chainId, at: t.executionDate, hash: String(t.txHash).toLowerCase(), link: link(t.txHash), pay: [], get, from: t.transfers[0]?.from };
      }
      // what it ran: known when the Safe logged it (Safe L2) or was called directly; what for, in clear signing's words
      const calls = t.to ? callsOf({ to: t.to as Address, value: BigInt(t.value), data: t.data as Hex, operation: t.operation as 0 | 1 }) : [];
      const w = intents(chainId, safe, calls, await explainCalls(chainId, safe, calls), true);
      const words = w.length ? w : undefined;
      const row: Row = { chainId, at: t.executionDate, hash: String(t.transactionHash).toLowerCase(), link: link(t.transactionHash), pay: [], get: [], words };
      if (!t.isSuccessful) return { ...row, failed: true };
      const fees: Record<string, bigint> = {};
      for (const c of calls) {
        const f = relayFee(chainId, c);
        if (f) fees[f.token] = (fees[f.token] ?? 0n) + f.amount;
      }
      const out = calls.reduce((s, c) => s + c.value, 0n);
      const m = moves(await moved(rpc, safe, t.transactionHash, out, native, token), fees);
      // nothing moved and nothing to say (a call it didn't log): it changed the wallet
      return { ...row, pay: m.pay, get: m.get, words: words ?? (!m.pay.length && !m.get.length ? [{ text: "Changed the wallet", src: "raw" as const }] : undefined) };
    }),
  );
}


function From({ a, chainId }: { a: string; chainId: number }) {
  return <Who address={a} chain={chainId} size={18} inline />;
}
