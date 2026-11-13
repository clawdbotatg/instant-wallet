"use client";

import { useEffect, useState, useRef } from "react";
import { type Address, type Hex, formatUnits, getAddress } from "viem";
import { amount, feeWords, short, usd } from "@/lib/format";
import { Money, Raw, WhatFor, Who, Words } from "../bits";
import { txRows } from "@/lib/safe/raw";
import { WARN, describe, ours, relayFee } from "@/lib/safe/describe";
import { type Line, type Src, type Told, intents, srcOf } from "@/lib/safe/intents";
export { type Line, type Src, intents };
import type { Call } from "@/lib/safe/core";
import { type Sim, asSafeTx, lightOn, moves, simulate } from "@/lib/safe/sim";
import { RECOVERY_DAYS } from "@/lib/safe/config";
import { rolesAddress } from "@/lib/safe/core";
import { MARKS, dangers } from "clear-signing-safe-kit";
import { chainById } from "@/lib/chains";
import { nativeUsd } from "@/lib/price";

/** A plain send's dollars (the chain's coin or USDC), for the steps' words. undefined: no price for it. */
function sendUsd(chainId: number, c: Call, eth: number): number | undefined {
  if (c.data === "0x" && c.value > 0n) return eth ? (eth * Number(c.value)) / 1e18 : undefined;
  const usdc = chainById(chainId)?.usdc;
  if (usdc && c.to.toLowerCase() === usdc.toLowerCase() && c.data.slice(0, 10).toLowerCase() === "0xa9059cbb" && c.data.length >= 138)
    return Number(BigInt("0x" + c.data.slice(74, 138))) / 1e6;
}

type SafeTxLike = { to: Address; value: bigint; data: Hex; operation: 0 | 1; nonce?: bigint };

type Got = { calls: Told[] | null; sim: Sim | null; feeUsd: Record<string, number>; light?: "ok" | "failed"; why?: string };

// one ask per set of calls. The words never change, so they're kept for the page's life. The coins come from a run on
// the latest block, so they're kept for SIM_LIFE only (a tx that "would fail now" works once the wallet is funded).
// A failed ask is never kept: the next look asks again.
const SIM_LIFE = 30_000;
const got = new Map<string, { p: Promise<Got>; at: number }>();
const said = new Map<string, Promise<Told[] | null>>();

/** Each call in words from our server (/api/explain: clear signing, else a Uniswap swap), one ask per set of calls. */
export function explainCalls(chainId: number, safe: Address, calls: Call[]): Promise<Told[] | null> {
  if (!calls.length) return Promise.resolve(null);
  const body = JSON.stringify({ chain: chainId, safe, calls: calls.map(c => ({ to: c.to, value: String(c.value), data: c.data })) });
  if (!said.has(body)) {
    const p: Promise<Told[] | null> = fetch("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body })
      .then(r => (r.ok ? r.json() : null))
      .then(j => (Array.isArray(j?.calls) ? (j.calls as Told[]) : null))
      .catch(() => null);
    said.set(body, p);
    p.then(v => v === null && said.get(body) === p && said.delete(body));
  }
  return said.get(body)!;
}

/** The step's mark, in place of its number: just the emoji (its meaning on hover). */
export function SrcTag({ src }: { src: Src }) {
  const [icon, title] = MARKS[src];
  return <span title={title} style={{ marginRight: 6 }}>{icon}</span>;
}
/** Steps' words, each with where they came from, one step per line (Austin, 10-31). */
export function Lines({ lines, chain }: { lines: Line[]; chain?: number }) {
  return (
    <>
      {lines.map((l, i) => (
        <span key={i} style={{ display: "block" }}>
          <SrcTag src={l.src} />
          <Words text={l.src === "raw" && l.text.startsWith(WARN) ? l.text.slice(WARN.length) : l.text} chain={chain} />
        </span>
      ))}
    </>
  );
}
function ask(chainId: number, safe: Address, calls: Call[], tx?: SafeTxLike) {
  const body = JSON.stringify({ chain: chainId, safe, calls: calls.map(c => ({ to: c.to, value: String(c.value), data: c.data })), op: tx?.operation, to: tx?.to });
  const had = got.get(body);
  if (!had || Date.now() - had.at > SIM_LIFE) {
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
    // the light client (Settings): checked in this browser, or it says it couldn't. Never the unchecked answer.
    let light: Got["light"] = lightOn(chainId) ? "ok" : undefined;
    let why = ""; // the light client's own error, shown under the red line: never hidden
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
      .catch(e => (light && ((light = "failed"), (why = String(e?.message || e).slice(0, 200))), null));
    const p = Promise.all([words, coins]).then(([w, s]) => ({ calls: w, sim: s, feeUsd, light, why }));
    got.set(body, { p, at: Date.now() });
    p.then(g => (!g.sim || (calls.length > 0 && !g.calls)) && got.get(body)?.p === p && got.delete(body));
  }
  return got.get(body)!.p;
}

/** What a Safe tx does: first what it does to your coins (clear-sim runs it on the latest block: you pay, you get),
 * the fee (read from its own call to the relay), then each step in words: ours (describe.ts `ours`: fee, approvals, swaps), else clear signing (ERC-7730,
 * the words the wedgie shows) where the registry has it, else describe.ts. */
export function WhatItDoes({ chainId, safe, calls, tx, signs, same, quiet, else: orElse }: { chainId: number; safe: Address; calls: Call[]; tx?: SafeTxLike; signs?: SafeTxLike | null; same?: string; quiet?: boolean; else?: React.ReactNode }) {
  const [res, setRes] = useState<Got | null>(null);
  // `same`: a swap gets a new route every 20 s. While this stays the same, the old answer stays up until the new one lands.
  const was = useRef<string | undefined>(undefined);
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
    if (same === undefined || same !== was.current) setRes(null);
    was.current = same;
    if (!(calls.length || tx)) return;
    const look = () => ask(chainId, safe, calls, tx).then(t => live && setRes(t));
    look();
    // while it's on screen, run it again as the coins go stale (the old answer stays up until the new one lands)
    const t = setInterval(() => !document.hidden && look(), SIM_LIFE + 1_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [eth, setEth] = useState(0);
  useEffect(() => void nativeUsd(chainId).then(setEth), [chainId]);
  const sim = res?.sim;
  // the exact bytes and hashes, on a tap (ERC-8213): `signs` is the Safe tx the keys will sign, when it's made already
  const raw = <Raw rows={txRows(chainId, safe, calls, signs ?? tx ?? null)} />;
  const fees = calls.flatMap(c => relayFee(chainId, c) ?? []);
  // the relay's fee isn't a step worth reading (the coins line shows it when the run works)
  // nor a swap whose in and out are already shown above it
  const shown = calls.map((c, i) => ({ c, i })).filter(({ c, i }) => !ours(chainId, c)?.startsWith("Network fee") && !res?.calls?.[i]?.swap);
  const swaps = (res?.calls ?? []).flatMap(t => (t?.swap ? [t.swap] : []));
  const many = shown.length > 1;
  // what a swap would do, read from its calldata: when the run fails or there's no run at all (no simulator)
  const swapLines = swaps.map((s, i) => (
    <div key={i} className="stack" style={{ gap: 4 }}>
      {/* never a router flag (1 << 255) as an amount: no readable number = say so */}
      <Money amount={s.pay.amount} symbol={s.pay.symbol} usd={s.pay.usd} unknown={s.pay.unknown || !(Number(s.pay.amount) < 1e15)} />
      <Money amount={s.get.amount} symbol={s.get.symbol} least={s.get.least} usd={s.get.usd} get />
    </div>
  ));
  // coins in and out say it all; the steps show when no coins move (a signer, a limit), the run failed, or a step warns
  // …or an approval outlives the batch, or a call can't be named: those are never left to a headline (audit 11-13)
  const head = intents(chainId, safe, calls, res?.calls ?? null, true);
  const steps = danger || !sim || !!sim.fails || (!sim.pay.length && !sim.get.length) || calls.some(c => describe(chainId, safe, c).startsWith(WARN)) || head.some(l => l.approve || l.warn);
  // the headline over the coins, and the coins the size they are in Activity (14 under a headline, 17 alone)
  const said = !steps ? head : [];
  // quiet (the Send, Swap and Send-everything sheets, which already say what and the fee): the coins and any trouble.
  // A danger or a step that warns is never quiet: then it's the full card.
  if (quiet && !danger && !calls.some(c => describe(chainId, safe, c).startsWith(WARN))) {
    // no answer from the simulator and nothing else to say: no empty gap
    // `else`: the sheet's own numbers (a swap's quote), for when the run has none
    const plan = swapLines.length ? swapLines : orElse;
    if (res && !sim && res.light !== "failed" && !plan) return null;
    return (
      <div data-what className="stack" style={{ gap: 4, paddingBottom: 8 }}>
        {warns.map((w, i) => (
          <Said key={`d${i}`} text={WARN + w} />
        ))}
        {res?.light === "failed" && <Said text={`${WARN}Couldn't check the coins in this browser`} />}
        {res?.light === "failed" && res.why && <span className="fine">{res.why.split(": ").pop()}</span>}
        {(sim?.fails || (res && !sim)) && plan}
        {sim?.fails && <Said text={`${WARN}Would fail now`} />}
        {/* the run's own answer: what leaves the wallet, what comes in */}
        {!res && <span className="fine">Checking…</span>}
        {sim && !sim.fails && sim.pay.map((m, i) => <Money key={`p${i}`} amount={m.amount} symbol={m.symbol} usd={m.usd} />)}
        {sim && !sim.fails && sim.get.map((m, i) => <Money key={`g${i}`} amount={m.amount} symbol={m.symbol} usd={m.usd} get />)}
        {raw}
      </div>
    );
  }
  return (
    <div data-what style={{ display: "contents" }}>
      {warns.map((w, i) => (
        <Said key={`d${i}`} text={WARN + w} />
      ))}
      {reject && <Said text="Reject: the other transaction at this number can never run." />}
      {res?.light === "failed" && <Said text={`${WARN}Couldn't check the coins in this browser`} />}
      {res?.light === "failed" && res.why && <span className="fine" style={{ display: "block" }}>{res.why.split(": ").pop()}</span>}
      {!res ? (
        <span className="fine">Checking…</span>
      ) : sim?.fails ? (
        <div className="stack" style={{ gap: 4 }}>
          {swapLines}
          <span title={sim.fails}>
            <Said text={`${WARN}Would fail now`} />
          </span>
        </div>
      ) : sim ? (
        <div className="stack" style={{ gap: 4 }}>
          {/* what it's for first, in clear signing's words, as Activity: then the coins */}
          {said.length > 0 && <WhatFor><Lines lines={said} chain={chainId} /></WhatFor>}
          {sim.pay.map((m, i) => <Money key={`p${i}`} amount={m.amount} symbol={m.symbol} usd={m.usd} size={said.length ? 14 : 17} />)}
          {sim.get.map((m, i) => <Money key={`g${i}`} amount={m.amount} symbol={m.symbol} usd={m.usd} size={said.length ? 14 : 17} get />)}
          {fees.map((f, i) => (
            <span key={`f${i}`} className="fine">
              Fee {feeWords(Number(formatUnits(f.amount, f.decimals)), f.symbol, res?.feeUsd[f.token])}
            </span>
          ))}
        </div>
      ) : swapLines.length ? (
        <div className="stack" style={{ gap: 4 }}>{swapLines}</div>
      ) : null}
      {steps && shown.map(({ c, i }, n) => {
        const mine = ours(chainId, c);
        const t = mine ? null : res?.calls?.[i];
        return (
          <div key={i} className="stack" style={{ gap: 2 }}>
            {mine ? (
              <Said n={many ? n + 1 : 0} text={mine} chain={chainId} src="code" />
            ) : t ? (
              <span style={{ fontSize: 15, fontWeight: 600 }}><SrcTag src={srcOf(t.what, t, null)} /><Words chain={chainId} text={`${t.what}${t.who && !t.what.includes(t.who) ? ` · ${t.who}` : ""}`} /></span>
            ) : (
              <Said n={many ? n + 1 : 0} chain={chainId} src={srcOf(describe(chainId, safe, c), undefined, null)} text={((u) => describe(chainId, safe, c) + (u !== undefined ? ` (${usd(u)})` : ""))(sendUsd(chainId, c, eth))} />
            )}
            {t?.fields.map((f, j) => (
              <span key={j} className="fine">
                {f.label}: {f.address ? <Who address={f.address} chain={chainId} size={16} inline /> : f.value}
              </span>
            ))}
          </div>
        );
      })}
      {raw}
    </div>
  );
}

function Said({ text, n = 0, chain, src }: { text: string; n?: number; chain?: number; src?: Src }) {
  const warn = text.startsWith(WARN);
  return (
    <span style={{ fontSize: 15, color: warn ? "#c62828" : undefined, fontWeight: warn ? 600 : undefined }}>
      {src ? <SrcTag src={src} /> : n ? `${n}. ` : ""}
      {/* the ⚠️ mark already says it: never "⚠️ ⚠️ Fees to…" */}
      <Words text={src === "raw" && warn ? text.slice(WARN.length) : text} chain={chain} />
    </span>
  );
}
