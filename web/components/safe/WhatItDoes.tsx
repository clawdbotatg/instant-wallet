"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { amount, short } from "@/lib/format";
import { Money } from "../bits";
import { WARN, describe, ours } from "@/lib/safe/describe";
import type { Call } from "@/lib/safe/core";

type Field = { label: string; value: string; address?: string };
type Told = { what: string; fields: Field[]; swap?: { pay: Move & { most?: boolean }; get: Move & { least?: boolean } } } | null;
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
  // the relay's fee isn't a step worth reading (the coins line shows it when the run works)
  // nor a swap whose in and out are already shown above it
  const shown = calls.map((c, i) => ({ c, i })).filter(({ c, i }) => !ours(chainId, c)?.startsWith("Network fee") && !res?.calls?.[i]?.swap);
  const swaps = (res?.calls ?? []).flatMap(t => (t?.swap ? [t.swap] : []));
  const many = shown.length > 1;
  // coins in and out say it all; the steps show when no coins move (a signer, a limit), the run failed, or a step warns
  const steps = !sim || !!sim.fails || (!sim.pay.length && !sim.get.length) || calls.some(c => describe(chainId, safe, c).startsWith(WARN));
  return (
    <>
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
          {sim.fee.map((m, i) => <Line key={`f${i}`} label="Network fee" m={m} small />)}
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
