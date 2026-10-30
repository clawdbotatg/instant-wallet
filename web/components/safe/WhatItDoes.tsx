"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex, formatUnits } from "viem";
import { amount, short } from "@/lib/format";
import { Money } from "../bits";
import { WARN, describe, ours, relayFee } from "@/lib/safe/describe";
import type { Call } from "@/lib/safe/core";
import { type Sim, asSafeTx, moves, simulate } from "@/lib/safe/sim";
import { MULTISEND_CALL_ONLY } from "@/lib/safe/config";

type SafeTxLike = { to: Address; value: bigint; data: Hex; operation: 0 | 1 };
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Field = { label: string; value: string; address?: string };
type Told = { what: string; fields: Field[]; swap?: { pay: Move & { most?: boolean }; get: Move & { least?: boolean } } } | null;
type Move = { symbol: string; amount: string; usd?: number };
type Got = { calls: Told[] | null; sim: Sim };

// one ask per set of calls, kept for the page's life
const got = new Map<string, Promise<Got>>();
function ask(chainId: number, safe: Address, calls: Call[], tx?: SafeTxLike) {
  const body = JSON.stringify({ chain: chainId, safe, calls: calls.map(c => ({ to: c.to, value: String(c.value), data: c.data })), op: tx?.operation, to: tx?.to });
  if (!got.has(body)) {
    // the words from our server; the coins from clear-sim, asked from here (lib/safe/sim.ts: the user's own simulator if set)
    const words = (calls.length ? fetch("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body })
      .then(r => (r.ok ? r.json() : null))
      .then(j => (Array.isArray(j?.calls) ? (j.calls as Told[]) : null))
      .catch(() => null) : Promise.resolve(null));
    const fees: Record<string, bigint> = {};
    for (const c of calls) {
      const f = relayFee(chainId, c);
      if (f) fees[f.token] = (fees[f.token] ?? 0n) + f.amount;
    }
    // the Safe tx itself when we have it (a delegatecall must run as one), else these calls as the batch we'd send
    const coins = simulate(chainId, safe, tx ?? asSafeTx(calls))
      .then(a => (a ? moves(a, fees) : null))
      .catch(() => null);
    got.set(
      body,
      Promise.all([words, coins]).then(([w, s]) => ({ calls: w, sim: s })),
    );
  }
  return got.get(body)!;
}

/** What a Safe tx does: first what it does to your coins (clear-sim runs it on the latest block: you pay, you get),
 * the fee (read from its own call to the relay), then each step in words: ours (describe.ts `ours`: fee, approvals, swaps), else clear signing (ERC-7730,
 * the words the wedgie shows) where the registry has it, else describe.ts. */
export function WhatItDoes({ chainId, safe, calls, tx }: { chainId: number; safe: Address; calls: Call[]; tx?: SafeTxLike }) {
  const [res, setRes] = useState<Got | null>(null);
  // a delegatecall that isn't our own MultiSend batch of plain calls lets that contract run any code as the Safe
  const danger = !!tx && tx.operation === 1 && (!eq(tx.to, MULTISEND_CALL_ONLY) || !calls.length);
  const key = `${chainId}|${tx?.operation ?? 0}|${tx?.to ?? ""}|${calls.map(c => c.to + c.data + c.value).join()}`;
  useEffect(() => {
    let live = true;
    setRes(null);
    if (calls.length || tx) ask(chainId, safe, calls, tx).then(t => live && setRes(t));
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const sim = res?.sim;
  const fees = calls.flatMap(c => relayFee(chainId, c) ?? []);
  // the relay's fee isn't a step worth reading (the coins line shows it when the run works)
  // nor a swap whose in and out are already shown above it
  const shown = calls.map((c, i) => ({ c, i })).filter(({ c, i }) => !ours(chainId, c)?.startsWith("Network fee") && !res?.calls?.[i]?.swap);
  const swaps = (res?.calls ?? []).flatMap(t => (t?.swap ? [t.swap] : []));
  const many = shown.length > 1;
  // coins in and out say it all; the steps show when no coins move (a signer, a limit), the run failed, or a step warns
  const steps = danger || !sim || !!sim.fails || (!sim.pay.length && !sim.get.length) || calls.some(c => describe(chainId, safe, c).startsWith(WARN));
  return (
    <>
      {danger && (
        <Said text={`${WARN}Lets ${short(tx!.to)} run any code as your wallet. It could take everything. Only sign if you know exactly why.`} />
      )}
      {!res ? (
        <span className="fine">Checking what it does…</span>
      ) : sim?.fails ? (
        <div className="stack" style={{ gap: 4 }}>
          {/* what the swap would do, read from its calldata, when the run can't say */}
          {swaps.map((s, i) => (
            <div key={i} className="stack" style={{ gap: 4 }}>
              <Money amount={s.pay.amount} symbol={s.pay.symbol} />
              <Money amount={s.get.amount} symbol={s.get.symbol} least={s.get.least} get />
            </div>
          ))}
          <span title={sim.fails}>
            <Said text={`${WARN}Would fail now`} />
          </span>
        </div>
      ) : sim ? (
        <div className="stack" style={{ gap: 4 }}>
          {sim.pay.map((m, i) => <Money key={`p${i}`} amount={m.amount} symbol={m.symbol} usd={m.usd} />)}
          {sim.get.map((m, i) => <Money key={`g${i}`} amount={m.amount} symbol={m.symbol} usd={m.usd} get />)}
          {fees.map((f, i) => (
            <span key={`f${i}`} className="fine">
              Network fee: {amount(formatUnits(f.amount, f.decimals))} {f.symbol}
            </span>
          ))}
        </div>
      ) : null}
      {steps && shown.map(({ c, i }, n) => {
        const mine = ours(chainId, c);
        const t = mine ? null : res?.calls?.[i];
        return (
          <div key={i} className="stack" style={{ gap: 2 }}>
            {mine ? (
              <Said n={many ? n + 1 : 0} text={mine} />
            ) : t ? (
              <span style={{ fontSize: 15, fontWeight: 600 }}>{`${many ? `${n + 1}. ` : ""}${t.what}`}</span>
            ) : (
              <Said n={many ? n + 1 : 0} text={describe(chainId, safe, c)} />
            )}
            {t?.fields.map((f, j) => (
              <span key={j} className="fine">
                {f.label}: {f.address ? <span className="mono">{short(f.address)}</span> : f.value}
              </span>
            ))}
          </div>
        );
      })}
    </>
  );
}

function Said({ text, n = 0 }: { text: string; n?: number }) {
  const warn = text.startsWith(WARN);
  return (
    <span style={{ fontSize: 15, color: warn ? "#c62828" : undefined, fontWeight: warn ? 600 : undefined }}>
      {n ? `${n}. ` : ""}
      {text}
    </span>
  );
}
