"use client";

import { useEffect, useRef, useState } from "react";
import { type Address, type Hex, formatUnits, zeroAddress } from "viem";
import { chainById, publicClient } from "@/lib/chains";
import type { Asset } from "@/lib/types";
import { callsOf, relayFee } from "@/lib/safe/describe";
import { type Sending, onSending, sendingNow } from "@/lib/safe/sending";
import { type Move, chainHistory, inTokens, moved, moves } from "clear-signing-safe-kit";
import { ChainIcon, Eject, Money, WhatFor, Who } from "../bits";
import { type Line, Lines, explainCalls, intents } from "./WhatItDoes";

type Row = { chainId: number; at: string; hash?: string; link?: string; pay: Move[]; get: Move[]; words?: Line[]; from?: string; failed?: boolean };
const SHOW = 6;
/** Money that just came in, seen in the balance (read every few seconds) before the chain's history has been read. */
type Just = { id: number; chainId: number; at: number; get: Move };
let justId = 1;

/** The last list this browser showed for a wallet, so Activity is there the moment Home opens (the chain read takes 2–3 s). */
const KEPT = "iws:activity:";
function kept(key: string): Row[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEPT + key) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function keep(key: string, rows: Row[]) {
  try {
    localStorage.setItem(KEPT + key, JSON.stringify(rows));
  } catch {}
}

/**
 * Home: the last few things this wallet did and got, on every network it's on, newest first. From the chain itself
 * (clear-signing-safe-kit chainHistory, as wedgie.dev's Activity): runs, and money in from the main tokens only (a
 * 0-value or unknown-token "transfer" is address poisoning). Each run leads with what it was for, in clear signing's
 * words (Austin 10-30: red and green alone don't say why); what it moved (its receipt, the fee apart) sits small under it.
 * Read again on every `tick` (Home's refresh: a sheet closed, a pull, back to the app), when something this page sent
 * lands, and when a balance goes up. A read after the first asks the chain only for the blocks since (the kit keeps
 * the rest) and a row once made is kept, so it costs a call or two. What it's still sending sits on top, "Sending…"
 * (lib/safe/sending.ts). Money in shows the moment the balance has it (`live`: a balance read now, not last open's),
 * who from when the chain read lands. `undeployed`: networks with no Safe yet, so no logs: money in there is asked of
 * Alchemy's transfers.
 */
export function Activity({ safe, chains, undeployed = [], assets, late, live, tick }: { safe: Address; chains: number[]; undeployed?: number[]; assets: Asset[]; late?: number[]; live?: boolean; tick?: number }) {
  const [by, setBy] = useState<{ key: string; rows: Record<number, Row[]> }>({ key: "", rows: {} });
  const [out, setOut] = useState<Sending[]>(() => sendingNow());
  const [just, setJust] = useState<Just[]>([]);
  const [landed, setLanded] = useState(0);
  // networks with no Safe that hold something: the only ones worth asking
  const bare = undeployed.filter(c => assets.some(a => a.chainId === c));
  const key = `${safe}|${chains.join()}|${bare.join()}`;
  const later = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // read the chain now, and again a beat later (a node can answer the receipt, or the balance, a block before its logs)
  const read = () => {
    setLanded(n => n + 1);
    clearTimeout(later.current);
    later.current = setTimeout(() => setLanded(n => n + 1), 5_000);
  };
  useEffect(() => {
    const off = onSending(l => {
      setOut(sendingNow());
      if (l) read();
    });
    return () => {
      off();
      clearTimeout(later.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let on = true;
    // each network shows as it answers; one that fails keeps what it showed
    const put = (c: number, r: Row[]) => on && setBy(b => ({ key: safe, rows: { ...(b.key === safe ? b.rows : {}), [c]: r } }));
    for (const c of chains) rowsOn(c, safe).then(r => put(c, r), () => {});
    for (const c of bare) insOn(c, safe).then(r => put(c, r), () => {});
    return () => {
      on = false;
    };
  }, [key, tick, landed]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = by.key === safe ? Object.values(by.rows).flat().sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, SHOW) : [];

  // a balance went up between two reads of now: a row at once, then the chain is read for the rest. Only the coins
  // the chain's history shows (the network's own, the main tokens), never while this page's own send is landing there
  // (a swap's proceeds belong to its row), never a network that didn't answer this time or the last, never on coming back to the tab
  const was = useRef<{ safe: string; bal: Map<string, bigint>; late: number[] } | null>(null);
  const back = useRef(0);
  useEffect(() => {
    const h = () => document.hidden || (back.current = Date.now());
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, []);
  useEffect(() => {
    if (!live) return void (was.current = null);
    const prev = was.current?.safe === safe ? was.current : null;
    const now = { safe, bal: new Map(assets.map(a => [`${a.chainId}:${a.asset.toLowerCase()}`, BigInt(a.balance)])), late: late ?? [] };
    was.current = now;
    if (!prev) return;
    // just back from away (nothing was read meanwhile): what came in then isn't "now", Home's refresh reads the chain for it
    if (Date.now() - back.current < 10_000) return;
    const add: Just[] = [];
    for (const a of assets) {
      const tok = a.asset.toLowerCase();
      const info = chainById(a.chainId);
      const main = tok === zeroAddress ? { symbol: info?.native.symbol ?? "ETH", decimals: 18 } : inTokens(a.chainId, info?.usdc)[tok];
      if (!main || now.late.includes(a.chainId) || prev.late.includes(a.chainId)) continue;
      if (sendingNow().some(s => s.chainId === a.chainId && s.safe.toLowerCase() === safe.toLowerCase())) continue;
      const more = BigInt(a.balance) - (prev.bal.get(`${a.chainId}:${tok}`) ?? 0n);
      if (more > 0n) add.push({ id: justId++, chainId: a.chainId, at: Date.now(), get: { token: tok === zeroAddress ? "eth" : tok, symbol: main.symbol, amount: formatUnits(more, main.decimals) } as Move });
    }
    if (!add.length) return;
    setJust(j => [...add, ...j]);
    read();
  }, [assets, late, live, safe]); // eslint-disable-line react-hooks/exhaustive-deps
  // shown until the chain's own row for it is in the list (one on that network from about then), ten minutes at most
  const fresh = just.filter(j => Date.now() - j.at < 600_000 && !rows.some(r => r.chainId === j.chainId && Date.parse(r.at) >= j.at - 120_000));
  // still on its way: this wallet's, and not already in the chain's list
  const ours = out.filter(s => s.safe.toLowerCase() === safe.toLowerCase() && !rows.some(r => s.hash && r.hash === s.hash.toLowerCase()));
  if (!rows.length && !ours.length && !fresh.length) return null;
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
      {fresh.map(j => (
        <div key={`j${j.id}`} className="recess stack" style={{ gap: 4 }}>
          <span className="fine row" style={{ gap: 5 }}>
            {day(j.at)} · <ChainIcon chainId={j.chainId} size={14} /> {chainById(j.chainId)?.name}
          </span>
          <WhatFor>Received</WhatFor>
          <Money amount={j.get.amount} symbol={j.get.symbol} usd={usd(j.chainId, j.get)} size={14} get />
        </div>
      ))}
      {rows.map((r, i) => (
        <div key={r.hash ? `${r.chainId}:${r.hash}` : i} className="recess stack" style={{ gap: 4 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
            <span className="fine row" style={{ gap: 5 }}>
              {day(r.at)} · <ChainIcon chainId={r.chainId} size={14} /> {chainById(r.chainId)?.name}
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

const day = (at: string | number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** One this page sent that isn't on chain yet: a dashed card, a spinner and "Sending…" where the date goes, its words
 * (clear signing's, as the rows under it) and what it sends out, read from its own calls. Landed: the same card turns
 * solid where it is (the date, no dashes, no spinner) until the chain's own row takes its place. */
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
    <div className="recess stack" style={s.landed ? { gap: 4 } : { gap: 4, outline: "2px dashed rgba(31,166,65,.55)", outlineOffset: -2 }} aria-label={s.landed ? undefined : "Sending, not on chain yet"}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <span className="fine row" style={{ gap: 5 }}>
          {s.landed ? day(Date.now()) : <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /><b>{s.hash ? "Sending…" : "Sending to the network…"}</b></>} · <ChainIcon chainId={s.chainId} size={14} /> {chainById(s.chainId)?.name}
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

/** A row once made doesn't change (it's on chain): made once per page, however often the list is read. */
const made = new Map<string, Promise<Row>>();
function once(k: string, make: () => Promise<Row>) {
  let p = made.get(k);
  if (!p) {
    made.set(k, (p = make()));
    p.catch(() => made.delete(k));
  }
  return p;
}

/** Money in on a network where the Safe isn't made yet (nothing logs it there): Alchemy's transfers to the address,
 * the network's coin and the main tokens only, as the chain's history shows. */
async function insOn(chainId: number, safe: Address): Promise<Row[]> {
  const info = chainById(chainId);
  const toks = inTokens(chainId, info?.usdc);
  const r: any = await publicClient(chainId).request({
    method: "alchemy_getAssetTransfers" as any,
    params: [{ fromBlock: "0x0", toBlock: "latest", toAddress: safe, category: ["external", "erc20"], excludeZeroValue: true, withMetadata: true, order: "desc", maxCount: "0x32" }] as any,
  });
  const rows = new Map<string, Row>();
  for (const x of (r?.transfers ?? []) as any[]) {
    const tok = x.category === "external" ? null : toks[String(x.rawContract?.address).toLowerCase()];
    if (x.category !== "external" && !tok) continue;
    const v = BigInt(x.rawContract?.value ?? "0x0");
    if (v === 0n || !x.metadata?.blockTimestamp) continue;
    const hash = String(x.hash).toLowerCase();
    const row: Row = rows.get(hash) ?? { chainId, at: String(x.metadata.blockTimestamp).replace(".000Z", "Z"), hash, link: info?.explorer ? `${info.explorer}/tx/${hash}` : undefined, pay: [], get: [], from: x.from };
    row.get.push({ token: tok ? String(x.rawContract.address).toLowerCase() : "eth", symbol: tok ? tok.symbol : (info?.native.symbol ?? "ETH"), amount: formatUnits(v, tok ? tok.decimals : 18) } as Move);
    rows.set(hash, row);
  }
  return [...rows.values()].slice(0, SHOW);
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
  // the chain as it is now: the kit asks only for the blocks since its last read
  const list = await chainHistory(rpc, chainId, safe, info?.usdc, SHOW, true);
  return Promise.all(
    list.map((t: any) => once(`${chainId}:${safe}:${t.transactionHash ?? t.txHash}:${t.txType}`, async (): Promise<Row> => {
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
    })),
  );
}


function From({ a, chainId }: { a: string; chainId: number }) {
  return <Who address={a} chain={chainId} size={18} inline />;
}
