"use client";

import { useState } from "react";
import { type Address, type Hex, formatUnits, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainById } from "@/lib/chains";
import { claimUrl } from "@/lib/claim";
import { amount as fmtAmount } from "@/lib/format";
import { transfer } from "@/lib/safe/core";
import {
  type Stage,
  budgetSend,
  getQuote,
  ownersSend,
  plan,
  sendKind,
} from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import type { Asset } from "@/lib/types";
import { friendly } from "../Welcome";

/** The iOS app's NFC writer (instant-wallet-app InstantWallet/Nfc.swift). Only there. */
type WedgieNfc = {
  available: () => Promise<boolean>;
  write: (url: string) => Promise<string>;
};
export const wedgieNfc = (): WedgieNfc | null =>
  (typeof window !== "undefined" && (window as any).wedgieNfc) || null;

const BASE = 8453;
const CHIPS = ["5", "10", "20"];

/** iw.cards, the same list /claim/new keeps (ClaimMaker.tsx): Take back there gets an unclaimed card's money. */
function keep(key: Hex) {
  try {
    const cards = JSON.parse(localStorage.getItem("iw.cards") || "[]");
    cards.push({ key, made: Date.now() }); // it marks itself funded once /claim/new sees money on it
    localStorage.setItem("iw.cards", JSON.stringify(cards));
  } catch {}
}

/**
 * Share to an NFC card (docs/NFC-SHARE.md): a new key, its claim link written to the card, then USDC on Base from
 * this wallet to it. Within the daily budget only (one Face ID). Order (Austin, 10-24): check the money and the
 * budget, keep the key, write the card, then fund it — a cancelled tap moves no money. A failed send leaves an
 * empty card; Try again sends to the same key.
 */
export function Share({
  account,
  states,
  assets,
  onDone,
}: {
  account: SafeAccount;
  states: ChainState[];
  assets: Asset[];
  onDone: () => void;
}) {
  const [usdIn, setUsdIn] = useState("5");
  const [stage, setStage] = useState<
    "form" | "check" | Stage | "write" | "unwritten" | "unfunded" | "done"
  >("form");
  const [card, setCard] = useState<{
    key: Hex;
    amount: bigint;
    label: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const st = states.find((s) => s.chainId === BASE);
  const usdc = chainById(BASE)?.usdc as Address | undefined;
  const held = assets.find(
    (a) => a.chainId === BASE && a.asset.toLowerCase() === usdc?.toLowerCase(),
  );
  let base: bigint | null = null;
  try {
    base = usdIn ? parseUnits(usdIn, 6) : null;
  } catch {}
  const left = st?.budget?.usdc;

  /** The send's path and fee, or why it can't go (over the budget, not enough USDC). */
  async function prep(amount: bigint) {
    if (!st || !usdc) throw new Error("Still loading");
    const guess = plan(st, account, usdc, amount, 0n, true);
    let q = await getQuote(
      BASE,
      await sendKind(account, st, guess.path, guess.signers),
    );
    const fee = BigInt(q.feeUsdc);
    const p = plan(st, account, usdc, amount, fee, true);
    if (p.signers.some((s) => s !== "burner"))
      throw new Error("More than your daily budget. Pick a smaller amount.");
    if (BigInt(held?.balance ?? "0") < amount + fee)
      throw new Error("Not enough USDC on Base for this plus the fee.");
    const k = await sendKind(account, st, p.path, p.signers);
    if (k !== q.kind) q = await getQuote(BASE, k);
    return { p, q };
  }

  async function go() {
    if (!base || base <= 0n) return;
    setError(null);
    setStage("check");
    try {
      await prep(base);
    } catch (e: any) {
      setError(friendly(e));
      return setStage("form");
    }
    const key = generatePrivateKey();
    keep(key); // first: if the send lands and the screen is lost, /claim/new can still take it back
    const c = { key, amount: base, label: usdIn };
    setCard(c);
    await write(c);
  }

  async function write(c: { key: Hex; amount: bigint }) {
    setStage("write");
    setError(null);
    try {
      await wedgieNfc()!.write(claimUrl(window.location.origin, c.key));
    } catch (e: any) {
      setError(String(e?.message ?? e));
      return setStage("unwritten");
    }
    await fund(c);
  }

  async function fund(c: { key: Hex; amount: bigint }) {
    setError(null);
    try {
      setStage("quote");
      const { p, q } = await prep(c.amount);
      const calls = [
        transfer(usdc!, privateKeyToAccount(c.key).address, c.amount),
      ];
      const onStage = (s: Stage) => setStage(s);
      if (p.path === "budget")
        await budgetSend({
          account,
          state: st!,
          calls,
          feeToken: "usdc",
          quote: q,
          onStage,
        });
      else
        await ownersSend({
          account,
          state: st!,
          calls,
          signers: p.signers,
          feeToken: "usdc",
          quote: q,
          onStage,
          label: "Share to a card",
        });
      setStage("done");
    } catch (e: any) {
      setError(friendly(e));
      setStage("unfunded");
    }
  }

  if (stage === "done" && card)
    return (
      <div className="stack center">
        <div style={{ fontSize: 64 }}>✓</div>
        <h2>Done. ${fmtAmount(card.label)} on the card.</h2>
        <button className="btn btn-green wide" onClick={onDone}>
          OK
        </button>
      </div>
    );

  if (stage === "unwritten" && card)
    return (
      <div className="stack center">
        <h2>The card wasn't written</h2>
        <p>No money moved.</p>
        {error && <p className="err">{error}</p>}
        <button className="btn btn-green wide" onClick={() => write(card)}>
          Try again
        </button>
        <button className="btn wide" onClick={() => setStage("form")}>
          Back
        </button>
      </div>
    );

  if (stage === "unfunded" && card)
    return (
      <div className="stack center">
        <h2>The card is written, but empty</h2>
        <p>The money didn't send.</p>
        {error && <p className="err">{error}</p>}
        <button className="btn btn-green wide" onClick={() => fund(card)}>
          Try again
        </button>
      </div>
    );

  if (stage === "write")
    return (
      <div className="stack center">
        <h2>Hold the card to the top of your phone</h2>
      </div>
    );

  const busy = stage !== "form";
  const label: Record<string, string> = {
    check: "Checking…",
    quote: "Getting the fee…",
    signing: "Signing…",
    sending: "Sending…",
    confirming: "Confirming…",
  };
  return (
    <div className="stack">
      <h2>Share to a card</h2>
      <p className="fine">
        Puts USDC on Base on an NFC card. Whoever taps it gets the money.
      </p>
      <a className="fine" href="/claim/new">
        My cards: see which are claimed, take back the rest
      </a>
      <div className="row" style={{ gap: 8 }}>
        {CHIPS.map((c) => (
          <button
            key={c}
            className={`pill ${usdIn === c ? "on" : ""}`}
            onClick={() => setUsdIn(c)}
            disabled={busy}
          >
            ${c}
          </button>
        ))}
      </div>
      <div className="field">
        <label>Amount</label>
        <div className="input">
          <span className="amount-cur">$</span>
          <input
            className="amount"
            inputMode="decimal"
            value={usdIn}
            disabled={busy}
            onChange={(e) =>
              setUsdIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))
            }
            placeholder="0"
          />
        </div>
        <span className="fine">
          {left !== undefined
            ? `Daily budget left: $${fmtAmount(formatUnits(left, 6))}`
            : held
              ? `You have $${fmtAmount(held.formatted)}`
              : "No USDC on Base yet"}
        </span>
      </div>
      {error && <p className="err">{error}</p>}
      <button
        className="btn btn-green wide"
        onClick={go}
        disabled={busy || !st || !base || base <= 0n}
      >
        {busy ? (label[stage] ?? "…") : "Write card"}
      </button>
    </div>
  );
}
