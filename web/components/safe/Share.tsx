"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex, formatUnits, parseUnits, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainById } from "@/lib/chains";
import { claimUrl } from "@/lib/claim";
import { amount as fmtAmount } from "@/lib/format";
import { transfer } from "@/lib/safe/core";
import { type FeeToken, type Stage, budgetSend, getQuote, ownersSend, plan, sendKind } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import type { Asset } from "@/lib/types";
import { Select, assetOpt } from "./Pick";
import { friendly } from "../Welcome";

/** The iOS app's NFC writer (instant-wallet-app InstantWallet/Nfc.swift). Only there. */
type WedgieNfc = { available: () => Promise<boolean>; write: (url: string) => Promise<string> };
export const wedgieNfc = (): WedgieNfc | null => (typeof window !== "undefined" && (window as any).wedgieNfc) || null;

const CHIPS = ["5", "10", "20"];

/** iw.cards, the same list /claim/new keeps (ClaimMaker.tsx): Take back there gets an unclaimed card's money. */
function keep(key: Hex) {
  try {
    const cards = JSON.parse(localStorage.getItem("iw.cards") || "[]");
    cards.push({ key, made: Date.now() }); // it marks itself funded once /claim/new sees money on it
    localStorage.setItem("iw.cards", JSON.stringify(cards));
  } catch {}
}

type Card = { key: Hex; asset: Asset; amount: bigint; label: string };

/**
 * Share to an NFC card (docs/NFC-SHARE.md): a new key, its claim link written to the card, then money from this
 * wallet to it, on the network picked in settings. USDC or the native coin: the two the claim page (Claim.tsx) can
 * sweep (USDC gasless, the coin pays its own gas). Within the daily budget only (one Face ID). Order (Austin,
 * 10-24): check the money and the budget, keep the key, write the card, then fund it — a cancelled tap moves no
 * money. A failed send leaves an empty card; Try again sends to the same key.
 */
export function Share({ account, states, assets, chainId, onDone }: { account: SafeAccount; states: ChainState[]; assets: Asset[]; chainId: number; onDone: () => void }) {
  const [usdIn, setUsdIn] = useState("5");
  const [stage, setStage] = useState<"form" | "check" | Stage | "write" | "unwritten" | "unfunded" | "done">("form");
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);

  const st = states.find(s => s.chainId === chainId);
  const usdc = chainById(chainId)?.usdc?.toLowerCase();
  const isUsdc = (a: Asset) => a.asset.toLowerCase() === usdc;
  const options = assets.filter(a => a.chainId === chainId && (isUsdc(a) || a.asset === zeroAddress) && BigInt(a.balance) > 0n);
  const keyOf = (a: Asset) => assetOpt(a).key;
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    if (!options.some(a => keyOf(a) === pick)) setPick(options.length ? keyOf(options.find(isUsdc) ?? options[0]) : null);
  }, [options.map(keyOf).join(), pick]);
  const asset = options.find(a => keyOf(a) === pick) ?? null;

  const price = asset ? (isUsdc(asset) ? 1 : asset.price) : null;
  let base: bigint | null = null;
  try {
    base = asset && price && usdIn ? parseUnits((Number(usdIn) / price).toFixed(Math.min(asset.decimals, 8)), asset.decimals) : null;
  } catch {}
  const coin = asset?.asset === zeroAddress;
  const left = st?.budget ? (coin ? st.budget.eth : st.budget.usdc) : undefined;

  /** The send's path and fee, or why it can't go (over the budget, not enough money). */
  async function prep(a: Asset, amount: bigint) {
    if (!st) throw new Error("Still loading");
    const t = a.asset as Address;
    const guess = plan(st, account, t, amount, 0n, true);
    let q = await getQuote(chainId, await sendKind(account, st, guess.path, guess.signers));
    const fee = BigInt(a.asset === zeroAddress ? q.feeEth : q.feeUsdc);
    const p = plan(st, account, t, amount, fee, true);
    if (p.signers.some(s => s !== "burner")) throw new Error("More than your daily budget. Pick a smaller amount.");
    if (BigInt(a.balance) < amount + fee) throw new Error(`Not enough ${a.symbol} for this plus the fee.`);
    const k = await sendKind(account, st, p.path, p.signers);
    if (k !== q.kind) q = await getQuote(chainId, k);
    return { p, q };
  }

  async function go() {
    if (!asset || !base || base <= 0n) return;
    setError(null);
    setStage("check");
    try {
      await prep(asset, base);
    } catch (e: any) {
      setError(friendly(e));
      return setStage("form");
    }
    const k = generatePrivateKey();
    keep(k); // first: if the send lands and the screen is lost, /claim/new can still take it back
    const c = { key: k, asset, amount: base, label: `${fmtAmount(formatUnits(base, asset.decimals))} ${asset.symbol}` };
    setCard(c);
    await write(c);
  }

  async function write(c: Card) {
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

  async function fund(c: Card) {
    setError(null);
    try {
      setStage("quote");
      const { p, q } = await prep(c.asset, c.amount);
      const calls = [transfer(c.asset.asset as Address, privateKeyToAccount(c.key).address, c.amount)];
      const feeToken: FeeToken = c.asset.asset === zeroAddress ? "eth" : "usdc";
      const onStage = (s: Stage) => setStage(s);
      if (p.path === "budget") await budgetSend({ account, state: st!, calls, feeToken, quote: q, onStage });
      else await ownersSend({ account, state: st!, calls, signers: p.signers, feeToken, quote: q, onStage, label: "Share to a card" });
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
        <h2>Done. {card.label} on the card.</h2>
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
  const label: Record<string, string> = { check: "Checking…", quote: "Getting the fee…", signing: "Signing…", sending: "Sending…", confirming: "Confirming…" };
  const net = chainById(chainId);
  return (
    <div className="stack">
      <h2>Share to a card</h2>
      <p className="fine">Puts money on {net?.name} on an NFC card. Whoever taps it gets it.</p>
      <a className="fine" href="/claim/new">
        My cards: see which are claimed, take back the rest
      </a>
      <div className="field">
        <label>What</label>
        {options.length ? (
          <Select value={asset ? assetOpt(asset) : null} options={options.map(assetOpt)} onPick={setPick} />
        ) : (
          <p className="fine">
            No USDC or {net?.native.symbol ?? "ETH"} on {net?.name}. Pick another network in settings.
          </p>
        )}
      </div>
      <div className="row" style={{ gap: 8 }}>
        {CHIPS.map(c => (
          <button key={c} className={`pill ${usdIn === c ? "on" : ""}`} onClick={() => setUsdIn(c)} disabled={busy}>
            ${c}
          </button>
        ))}
      </div>
      <div className="field">
        <label>Amount</label>
        <div className="input">
          <span className="amount-cur">$</span>
          <input className="amount" inputMode="decimal" value={usdIn} disabled={busy} onChange={e => setUsdIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} placeholder="0" />
        </div>
        {asset && (
          <span className="fine">
            {base && !isUsdc(asset) ? `= ${fmtAmount(formatUnits(base, asset.decimals))} ${asset.symbol} · ` : ""}
            {left !== undefined ? `Daily budget left: ${fmtAmount(formatUnits(left, asset.decimals))} ${asset.symbol}` : `You have ${fmtAmount(asset.formatted)} ${asset.symbol}`}
          </span>
        )}
      </div>
      {error && <p className="err">{error}</p>}
      <button className="btn btn-green wide" onClick={go} disabled={busy || !st || !asset || !base || base <= 0n}>
        {busy ? (label[stage] ?? "…") : "Write card"}
      </button>
    </div>
  );
}
