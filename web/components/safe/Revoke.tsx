"use client";

import { useEffect, useRef, useState } from "react";
import { type Hash, formatUnits, zeroAddress } from "viem";
import { chainById, explorerTx, nativeSymbol } from "@/lib/chains";
import { amount as fmtAmount, usd, feeText } from "@/lib/format";
import { type Approval, PERMIT2, Unchecked, findApprovals, revokeCall } from "@/lib/safe/approvals";
import { UNISWAP } from "@/lib/safe/describe";
import { hotAvailable } from "@/lib/safe/hot";
import { type FeeToken, type Prepared, type Stage, Shared, feeMoved, finishOwners, getQuote, ownerSigners, prepareOwners, sendKind, usesWedgie } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { friendly } from "@/lib/friendly";
import { callsOf } from "@/lib/safe/describe";
import { DoneBar, ExecutedLine, Net, RemoveX, TokenIcon, Who, stageLabel } from "../bits";
import { Progress } from "./Progress";
import { ErrorLine } from "./WedgieButton";
import { WhatItDoes } from "./WhatItDoes";

// each revoke is one small call (approve 0): this much gas on top of the Safe tx
const PER_CALL_GAS = 35_000n;
// at most this many in one tx: the wedgie reads every call of a batch, and a real one has little memory (EXPECTATIONS #0)
const MAX_BATCH = 8;

type Row = {
  stage: "idle" | "preparing" | "ready" | "busy" | "done";
  pick?: string[]; // the approvals this tx takes back (keys)
  prepared?: Prepared;
  hash?: Hash;
  error?: string;
  send?: Stage;
};

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const UNCHECKED = "unchecked"; // found[]: a network with no way to list them (named once, gray, at the bottom)
const spenderLabel = (a: string) => (UNISWAP.some(u => eq(u, a)) ? "Uniswap" : eq(a, PERMIT2) ? "Permit2" : undefined);

/**
 * Revoke: every app that can still spend this wallet's coins (or move its collectibles), on every network it's on,
 * read from the chain (lib/safe/approvals.ts). ✕ on a row takes that one back; the green button takes them all
 * back on that network, one tx (up to MAX_BATCH at a time). First tap gets the fee, the next one signs.
 */
export function Revoke({ account, assets, states, onDone }: { account: SafeAccount; assets: Asset[]; states: ChainState[]; onDone: () => void }) {
  const chains = states.filter(s => s.deployed).map(s => s.chainId);
  const [found, setFound] = useState<Record<number, Approval[] | string>>({}); // a string: why that network couldn't be read
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [mine, setMine] = useState(false);
  const [canMine, setCanMine] = useState(false);
  useEffect(() => setCanMine(hotAvailable()), []);
  const set = (chainId: number, r: Row) => setRows(x => ({ ...x, [chainId]: r }));
  // who each approval is to, in a word or two (/api/spender): "CoW Protocol", "Aave DAO"
  const [names, setNames] = useState<Record<string, { name: string | null; sure: boolean }>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const [id, l] of Object.entries(found))
      if (Array.isArray(l))
        for (const a of l) {
          const k = `${id}:${a.spender.toLowerCase()}`;
          if (asked.current.has(k)) continue;
          asked.current.add(k);
          fetch(`/api/spender?chain=${id}&address=${a.spender}`)
            .then(r => (r.ok ? r.json() : null))
            .then(j => j && setNames(x => ({ ...x, [k]: { name: j.name ?? null, sure: !!j.sure } })))
            .catch(() => {});
        }
  }, [found]);
  // a name its deployer picked (Sourcify) could be a scam calling itself Uniswap: it says "unchecked"
  const whoIs = (chainId: number, spender: string) => {
    const n = names[`${chainId}:${spender.toLowerCase()}`];
    if (n?.name) return n.sure ? n.name : `${n.name} (unchecked)`;
    return spenderLabel(spender) ?? (n ? "Unknown app" : undefined);
  };

  const look = (chainId: number) =>
    findApprovals(chainId, account.address)
      .then(list => setFound(x => ({ ...x, [chainId]: list })))
      .catch(e => setFound(x => ({ ...x, [chainId]: e instanceof Unchecked ? UNCHECKED : friendly(e) })));
  const key = chains.join(",");
  useEffect(() => {
    for (const id of chains) if (!(id in found)) look(id);
  }, [key, account.address]); // eslint-disable-line react-hooks/exhaustive-deps

  async function prepare(chainId: number, pick: string[], prev?: Prepared) {
    const st = states.find(s => s.chainId === chainId);
    const list = found[chainId];
    if (!st || typeof list === "string" || !list) return;
    const put = (r: Row) => (prev ? setRows(x => (x[chainId]?.stage === "ready" && x[chainId]?.prepared === prev ? { ...x, [chainId]: r } : x)) : set(chainId, r));
    if (!prev) set(chainId, { stage: "preparing", pick });
    try {
      const calls = list.filter(a => pick.includes(a.key)).map(revokeCall);
      const signers = ownerSigners(st, account);
      const dappGas = PER_CALL_GAS * BigInt(calls.length);
      if (mine) {
        if (prev) return; // no fee to follow
        const prepared = await prepareOwners({ account, state: st, calls, signers, feeToken: "usdc", self: true, label: "Revoke" });
        set(chainId, { stage: "ready", pick, prepared });
        return;
      }
      const kind = await sendKind(account, st, "owners", signers, { dappGas });
      const q = await getQuote(chainId, kind, dappGas);
      if (prev && !feeMoved(prev.fee, q)) return;
      const held = (a: string) => BigInt(assets.find(x => x.chainId === chainId && eq(x.asset, a))?.balance ?? "0");
      const usdcAddr = chainById(chainId)?.usdc;
      const feeToken: FeeToken | null =
        usdcAddr && held(usdcAddr) > BigInt(q.feeUsdc) ? "usdc" : held(zeroAddress) > BigInt(q.feeEth) ? "eth" : null;
      if (!feeToken) throw new Error(`Not enough USDC or ${nativeSymbol(chainId)} on ${chainById(chainId)?.name} for the fee.`);
      const prepared = await prepareOwners({ account, state: st, calls, signers, feeToken, quote: q, dappGas, nonce: prev?.t.nonce, label: "Revoke" });
      put({ stage: "ready", pick, prepared });
    } catch (e: any) {
      if (!prev) set(chainId, { stage: "idle", error: friendly(e) });
    }
  }

  // the fee follows gas while a tx waits to be signed (EXPECTATIONS #6)
  const again = useRef<() => void>(() => {});
  again.current = () => {
    if (document.hidden) return;
    for (const [id, r] of Object.entries(rows)) if (r.stage === "ready" && r.prepared && r.pick && !r.prepared.opts.self) prepare(Number(id), r.pick, r.prepared);
  };
  useEffect(() => {
    const t = setInterval(() => again.current(), 15_000);
    return () => clearInterval(t);
  }, []);

  async function sign(chainId: number) {
    const r = rows[chainId];
    if (!r?.prepared) return;
    set(chainId, { ...r, stage: "busy", error: undefined });
    let wedgie: Wedgie | null = null;
    try {
      if (usesWedgie(r.prepared.opts.account, r.prepared.opts.state, r.prepared.opts.signers) && wedgieSupported()) {
        wedgie = await Wedgie.connect();
        r.prepared.opts.wedgie = wedgie;
      }
      r.prepared.opts.onStage = (s, h) => setRows(x => ({ ...x, [chainId]: { ...x[chainId], send: s, hash: h ?? x[chainId]?.hash } }));
      const hash = await finishOwners(r.prepared);
      set(chainId, { ...r, stage: "done", hash });
      // gone from the list at once, then read again from the chain
      setFound(x => ({ ...x, [chainId]: Array.isArray(x[chainId]) ? (x[chainId] as Approval[]).filter(a => !r.pick?.includes(a.key)) : x[chainId] }));
      look(chainId);
    } catch (e: any) {
      if (e instanceof Shared) set(chainId, { stage: "idle" }); // its page has the sheet now
      else set(chainId, { stage: "idle", error: friendly(e) });
    } finally {
      await wedgie?.close();
    }
  }

  const read = chains.filter(id => id in found).length;
  const all = chains.flatMap(id => (Array.isArray(found[id]) ? (found[id] as Approval[]) : []));
  const shown = chains.filter(id => (Array.isArray(found[id]) && (found[id] as Approval[]).length > 0) || (typeof found[id] === "string" && found[id] !== UNCHECKED) || rows[id]?.stage === "done");

  return (
    <div className="stack">
      <h2>Revoke</h2>
      {read < chains.length && (
        <div className="progress" aria-label="Looking">
          <div style={{ width: `${Math.round((100 * (read + 0.3)) / Math.max(1, chains.length))}%`, transitionDuration: "400ms" }} />
        </div>
      )}
      {read === chains.length && all.length === 0 && !shown.length && <p className="fine">No app can spend your coins.</p>}
      {canMine && all.length > 0 && (
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={mine} onChange={e => (setMine(e.target.checked), setRows({}))} />
          Execute from my wallet (no fee, I pay gas)
        </label>
      )}
      {shown.map(chainId => {
        const list = found[chainId];
        const r = rows[chainId] ?? { stage: "idle" };
        const busy = r.stage === "preparing" || r.stage === "busy";
        const fee = r.prepared && !r.prepared.opts.self && feeText(r.prepared.fee, r.prepared.opts.feeToken, nativeSymbol(chainId));
        const url = r.hash && explorerTx(chainId, r.hash);
        const ran = r.stage === "ready" || r.stage === "busy" ? r.prepared?.t : null;
        if (typeof list === "string")
          return (
            <div key={chainId} className="card stack">
              <b><Net chainId={chainId} /></b>
              <ErrorLine text={list} />
            </div>
          );
        // what you hold most of first (the most at risk), then any amount, then the rest
        const worth = (a: Approval) => (a.kind === "nft" ? 0 : (assets.find(x => x.chainId === chainId && eq(x.asset, a.token))?.usd ?? 0));
        const items = [...((list ?? []) as Approval[])].sort((a, b) => worth(b) - worth(a));
        const next = items.slice(0, MAX_BATCH).map(a => a.key);
        return (
          <div key={chainId} className="card stack">
            <b><Net chainId={chainId} /></b>
            {items.map(a => {
              const coin = a.kind !== "nft" ? assets.find(x => x.chainId === chainId && eq(x.asset, a.token)) : undefined;
              const picked = r.pick?.includes(a.key) && r.stage !== "idle" && r.stage !== "done";
              return (
                <div key={a.key} className="row" style={{ gap: 10, opacity: picked || !r.pick || r.stage === "idle" || r.stage === "done" ? 1 : 0.4 }}>
                  <TokenIcon symbol={a.symbol} asset={a.token} chainId={chainId} logo={coin?.logo} size={36} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <Who address={a.spender} chain={chainId} size={18} label={whoIs(chainId, a.spender)} />
                    <div className="fine">
                      can spend{" "}
                      {a.kind === "nft"
                        ? `any of your ${a.name || a.symbol}`
                        : a.any
                          ? `any amount of your ${a.symbol}`
                          : `up to ${fmtAmount(formatUnits(a.amount, a.decimals))} ${a.symbol}`}
                      {coin?.usd ? ` · you have ${usd(coin.usd)}` : ""}
                    </div>
                  </div>
                  <RemoveX label="Revoke" disabled={busy || r.stage === "ready"} busy={picked && r.stage === "preparing"} onClick={() => prepare(chainId, [a.key])} />
                </div>
              );
            })}
            {ran && <WhatItDoes chainId={chainId} safe={account.address} calls={callsOf(ran)} tx={ran} />}
            {fee && r.stage === "ready" && <span className="fine">Fee {fee}</span>}
            {r.prepared?.opts.self && r.stage === "ready" && <span className="fine">No fee. Your browser wallet executes it and pays the gas.</span>}
            {r.error && <ErrorLine text={r.error} />}
            {r.stage === "done" && <ExecutedLine href={url} />}
            {r.stage === "ready" || r.stage === "busy" ? (
              <div className="row" style={{ gap: 8 }}>
                {r.stage === "ready" && <button className="btn wide" onClick={() => set(chainId, { stage: "idle" })}>Cancel</button>}
                <button className="btn btn-green wide" disabled={r.stage === "busy"} onClick={() => sign(chainId)}>
                  {r.stage === "busy" ? stageLabel(r.send ?? "sending") : "Sign to revoke"}
                </button>
              </div>
            ) : (
              items.length > 0 && (
                <button className="btn btn-green wide" disabled={busy} onClick={() => prepare(chainId, next)}>
                  {r.stage === "preparing" ? stageLabel("quote") : items.length > MAX_BATCH ? <>Revoke {MAX_BATCH} on <Net chainId={chainId} /></> : <>Revoke all on <Net chainId={chainId} /></>}
                </button>
              )
            )}
            {r.stage === "busy" && <Progress stage={r.send ?? null} chainId={chainId} hash={r.hash} />}
          </div>
        );
      })}
      {read === chains.length && chains.some(id => found[id] === UNCHECKED) && (
        <p className="fine">
          Not checked:{" "}
          {chains
            .filter(id => found[id] === UNCHECKED)
            .map((id, i) => (
              <span key={id}>
                {i > 0 && ", "}
                <Net chainId={id} />
              </span>
            ))}
        </p>
      )}
      {Object.values(rows).some(r => r?.stage === "done") && !Object.values(rows).some(r => r?.stage === "busy" || r?.stage === "preparing") && <DoneBar onDone={onDone} />}
    </div>
  );
}
