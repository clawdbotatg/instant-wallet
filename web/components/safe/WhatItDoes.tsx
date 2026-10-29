"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { amount, short, usd } from "@/lib/format";
import { WARN, describe, ours } from "@/lib/safe/describe";
import type { Call } from "@/lib/safe/core";

type Field = { label: string; value: string; address?: string };
type Told = { what: string; fields: Field[] } | null;
type Move = { symbol: string; amount: string; usd?: number };
type Sim = { pay: Move[]; get: Move[]; fee: Move[]; fails?: string } | null;
type Got = { calls: Told[] | null; sim: Sim };

// one ask per set of calls, kept for the page's life
const got = new Map<string, Promise<Got>>();
function ask(chainId: number, safe: Address, calls: Call[]) {
  const body = JSON.stringify({ chain: chainId, safe, calls: calls.map(c => ({ to: c.to, value: String(c.value), data: c.data })) });
  if (!got.has(body))
    got.set(
      body,
      fetch("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body })
        .then(r => (r.ok ? r.json() : null))
        .then(j => ({ calls: Array.isArray(j?.calls) ? (j.calls as Told[]) : null, sim: (j?.sim as Sim) ?? null }))
        .catch(() => ({ calls: null, sim: null })),
    );
  return got.get(body)!;
}

/** What a Safe tx does: first what it does to your coins (the server runs it on the latest block: you pay, you get,
 * the fee), then each step in words: ours (describe.ts `ours`: fee, approvals, swaps), else clear signing (ERC-7730,
 * the words the wedgie shows) where the registry has it, else describe.ts. */
export function WhatItDoes({ chainId, safe, calls }: { chainId: number; safe: Address; calls: Call[] }) {
  const [res, setRes] = useState<Got | null>(null);
  const key = `${chainId}|${calls.map(c => c.to + c.data + c.value).join()}`;
  useEffect(() => {
    let live = true;
    setRes(null);
    if (calls.length) ask(chainId, safe, calls).then(t => live && setRes(t));
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const sim = res?.sim;
  const many = calls.length > 1;
  // coins in and out say it all; the steps show when no coins move (a signer, a limit), the run failed, or a step warns
  const steps = !sim || !!sim.fails || (!sim.pay.length && !sim.get.length) || calls.some(c => describe(chainId, safe, c).startsWith(WARN));
  return (
    <>
      {!res ? (
        <span className="fine">Checking what it does…</span>
      ) : sim?.fails ? (
        <Said text={`${WARN}This would fail right now (${sim.fails})`} />
      ) : sim ? (
        <div className="stack" style={{ gap: 4 }}>
          {sim.pay.map((m, i) => <Coin key={`p${i}`} m={m} />)}
          {sim.get.map((m, i) => <Coin key={`g${i}`} m={m} get />)}
          {sim.fee.map((m, i) => <Line key={`f${i}`} label="Network fee" m={m} small />)}
        </div>
      ) : null}
      {steps && calls.map((c, i) => {
        const mine = ours(chainId, c);
        const t = mine ? null : res?.calls?.[i];
        return (
          <div key={i} className="stack" style={{ gap: 2 }}>
            {mine ? (
              <Said n={many ? i + 1 : 0} text={mine} />
            ) : t ? (
              <span style={{ fontSize: 15, fontWeight: 600 }}>{`${many ? `${i + 1}. ` : ""}${t.what}`}</span>
            ) : (
              <Said n={many ? i + 1 : 0} text={describe(chainId, safe, c)} />
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

function Coin({ m, get }: { m: Move; get?: boolean }) {
  return (
    <span style={{ fontSize: 20, fontWeight: 700, color: get ? "var(--mint-d)" : "var(--coral)" }}>
      {get ? "+" : "−"}
      {amount(m.amount)} {m.symbol}
      {m.usd !== undefined && <span className="fine" style={{ fontWeight: 400 }}> ({usd(m.usd)})</span>}
    </span>
  );
}

function Line({ label, m, small }: { label: string; m: Move; small?: boolean }) {
  return (
    <span style={{ fontSize: small ? 14 : 18, fontWeight: small ? 400 : 700 }} className={small ? "fine" : undefined}>
      {label}: {amount(m.amount)} {m.symbol}
    </span>
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
