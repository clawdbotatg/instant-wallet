"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex, formatUnits } from "viem";
import { amount, short, usd } from "@/lib/format";
import { Money, WhatFor, Who } from "../bits";
import { WARN, describe, ours, relayFee } from "@/lib/safe/describe";
import type { Call } from "@/lib/safe/core";
import { type Sim, asSafeTx, moves, simulate } from "@/lib/safe/sim";
import { RECOVERY_DAYS } from "@/lib/safe/config";
import { rolesAddress } from "@/lib/safe/core";
import { dangers } from "clear-signing-safe-kit";

type SafeTxLike = { to: Address; value: bigint; data: Hex; operation: 0 | 1 };

type Field = { label: string; value: string; address?: string };
type Told = { what: string; fields: Field[]; who?: string; swap?: { pay: Move & { most?: boolean }; get: Move & { least?: boolean } } } | null;
type Move = { symbol: string; amount: string; usd?: number; unknown?: boolean };
type Got = { calls: Told[] | null; sim: Sim | null; feeUsd: Record<string, number> };

// one ask per set of calls, kept for the page's life
const got = new Map<string, Promise<Got>>();
const said = new Map<string, Promise<Told[] | null>>();

/** Each call in words from our server (/api/explain: clear signing, else a Uniswap swap), one ask per set of calls. */
export function explainCalls(chainId: number, safe: Address, calls: Call[]): Promise<Told[] | null> {
  if (!calls.length) return Promise.resolve(null);
  const body = JSON.stringify({ chain: chainId, safe, calls: calls.map(c => ({ to: c.to, value: String(c.value), data: c.data })) });
  if (!said.has(body))
    said.set(
      body,
      fetch("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body })
        .then(r => (r.ok ? r.json() : null))
        .then(j => (Array.isArray(j?.calls) ? (j.calls as Told[]) : null))
        .catch(() => null),
    );
  return said.get(body)!;
}

/**
 * What a tx is for, one line per step: clear signing's intent and who it's with ("Deposit · Steakhouse Financial"),
 * else ours / describe.ts. Never the relay's fee, never a bare "Call 0x…". brief (Activity): an approval only feeds
 * the step after it, so it's left out when there's another.
 */
export function intents(chainId: number, safe: Address, calls: Call[], told: Told[] | null, brief = false): string[] {
  const lines = calls.flatMap((c, i) => {
    const mine = ours(chainId, c);
    if (mine?.startsWith("Network fee")) return [];
    const t = mine ? null : told?.[i];
    const text = mine ?? (t ? (t.who && !t.what.includes(t.who) ? `${t.what} · ${t.who}` : t.what) : describe(chainId, safe, c));
    if (text.startsWith("Call ")) return [];
    const approve = /^(Let|Stop) /.test(text) || t?.what === "Approve";
    return [{ text, approve }];
  });
  const keep = brief && lines.some(l => !l.approve) ? lines.filter(l => !l.approve) : lines;
  return keep.map(l => l.text);
}

function ask(chainId: number, safe: Address, calls: Call[], tx?: SafeTxLike) {
  const body = JSON.stringify({ chain: chainId, safe, calls: calls.map(c => ({ to: c.to, value: String(c.value), data: c.data })), op: tx?.operation, to: tx?.to });
  if (!got.has(body)) {
    // the words from our server; the coins from clear-sim, asked from here (lib/safe/sim.ts: the user's own simulator if set)
    const words = explainCalls(chainId, safe, calls);
    const fees: Record<string, bigint> = {};
    for (const c of calls) {
      const f = relayFee(chainId, c);
      if (f) fees[f.token] = (fees[f.token] ?? 0n) + f.amount;
    }
    // the Safe tx itself when we have it (a delegatecall must run as one), else these calls as the batch we'd send
    // the fee in dollars: its share of what the simulator priced that token at
    const feeUsd: Record<string, number> = {};
    const coins = simulate(chainId, safe, tx ?? asSafeTx(calls))
      .then(a => {
        if (!a) return null;
        if (a.ok === "ok")
          for (const c of a.changes) {
            const f = fees[c.token];
            const all = Number(c.amount);
            if (f && c.usd !== "" && all) feeUsd[c.token] = Math.abs(Number(c.usd) * (Number(f) / all));
          }
        return moves(a, fees);
      })
      .catch(() => null);
    got.set(
      body,
      Promise.all([words, coins]).then(([w, s]) => ({ calls: w, sim: s, feeUsd })),
    );
  }
  return got.get(body)!;
}

/** What a Safe tx does: first what it does to your coins (clear-sim runs it on the latest block: you pay, you get),
 * the fee (read from its own call to the relay), then each step in words: ours (describe.ts `ours`: fee, approvals, swaps), else clear signing (ERC-7730,
 * the words the wedgie shows) where the registry has it, else describe.ts. */
export function WhatItDoes({ chainId, safe, calls, tx }: { chainId: number; safe: Address; calls: Call[]; tx?: SafeTxLike }) {
  const [res, setRes] = useState<Got | null>(null);
  // what could take everything (clear-signing-safe-kit, the same rules wedgie.dev uses): a delegatecall that isn't a
  // plain batch, a module that isn't ours, a guard, a fallback handler
  const known = [...Object.keys(RECOVERY_DAYS), rolesAddress(safe)].map(a => a.toLowerCase());
  const warns = calls.length || tx ? dangers(safe, tx ?? asSafeTx(calls), known) : [];
  const danger = warns.length > 0;
  // only the relay's fee: a Reject, which takes another transaction's number so that one can never run
  const reject = calls.length > 0 && calls.every(c => relayFee(chainId, c));
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
    <div data-what style={{ display: "contents" }}>
      {warns.map((w, i) => (
        <Said key={`d${i}`} text={WARN + w} />
      ))}
      {reject && <Said text="Reject: the other transaction at this number can never run." />}
      {!res ? (
        <span className="fine">Checking what it does…</span>
      ) : sim?.fails ? (
        <div className="stack" style={{ gap: 4 }}>
          {/* what the swap would do, read from its calldata, when the run can't say */}
          {swaps.map((s, i) => (
            <div key={i} className="stack" style={{ gap: 4 }}>
              {/* never a router flag (1 << 255) as an amount: no readable number = say so */}
              {s.pay.unknown || !(Number(s.pay.amount) < 1e15) ? (
                <span style={{ fontSize: 20, fontWeight: 700, color: "var(--coral)" }}>
                  − {s.pay.symbol} <span className="fine" style={{ fontWeight: 400 }}>(amount not known)</span>
                </span>
              ) : (
                <Money amount={s.pay.amount} symbol={s.pay.symbol} usd={s.pay.usd} />
              )}
              <Money amount={s.get.amount} symbol={s.get.symbol} least={s.get.least} usd={s.get.usd} get />
            </div>
          ))}
          <span title={sim.fails}>
            <Said text={`${WARN}Would fail now`} />
          </span>
        </div>
      ) : sim ? (
        <div className="stack" style={{ gap: 4 }}>
          {/* what it's for first, in clear signing's words, as Activity: then the coins */}
          {!steps && (() => {
            const w = intents(chainId, safe, calls, res?.calls ?? null, true).join(" · ");
            return w ? <WhatFor>{w}</WhatFor> : null;
          })()}
          {sim.pay.map((m, i) => <Money key={`p${i}`} amount={m.amount} symbol={m.symbol} usd={m.usd} />)}
          {sim.get.map((m, i) => <Money key={`g${i}`} amount={m.amount} symbol={m.symbol} usd={m.usd} get />)}
          {fees.map((f, i) => (
            <span key={`f${i}`} className="fine">
              Network fee: {amount(formatUnits(f.amount, f.decimals))} {f.symbol}
              {res?.feeUsd[f.token] !== undefined && ` (${usd(res.feeUsd[f.token])})`}
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
              <span style={{ fontSize: 15, fontWeight: 600 }}>{`${many ? `${n + 1}. ` : ""}${t.what}${t.who && !t.what.includes(t.who) ? ` · ${t.who}` : ""}`}</span>
            ) : (
              <Said n={many ? n + 1 : 0} text={describe(chainId, safe, c)} />
            )}
            {t?.fields.map((f, j) => (
              <span key={j} className="fine">
                {f.label}: {f.address ? <Who address={f.address} chain={chainId} size={16} inline /> : f.value}
              </span>
            ))}
          </div>
        );
      })}
    </div>
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
