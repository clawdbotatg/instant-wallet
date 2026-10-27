"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex, formatUnits, parseUnits, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainById, publicClient } from "@/lib/chains";
import { claimUrl } from "@/lib/claim";
import { cardsPdfBlob } from "@/lib/claimBatch";
import { amount as fmtAmount, usd } from "@/lib/format";
import { transfer } from "@/lib/safe/core";
import { Parked } from "@/lib/safe/pending";
import { type FeeToken, type Stage, budgetSend, getQuote, ownersSend, plan, sendKind } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { Qr } from "../bits";
import { Select, assetOpt } from "./Pick";
import { WedgieIcon, ErrorLine } from "./WedgieButton";
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

/**
 * Gas for a card holding a token that isn't USDC or the native coin: the claim page (Claim.tsx) has the card send
 * the token itself, then sweeps what's left. Two transfers' worth at twice today's price, plus an L2's L1 data fee.
 */
async function gasFor(chainId: number): Promise<bigint> {
  const fees = await publicClient(chainId).estimateFeesPerGas();
  return fees.maxFeePerGas! * 2n * 120_000n + (chainId === 1 ? 0n : 20_000_000_000_000n);
}

type Card = { key: Hex; asset: Asset; amount: bigint; label: string };
type Step = "form" | "check" | "how" | "write" | "unwritten" | "ready" | Stage | "unfunded" | "parked" | "done";

/**
 * Share crypto (docs/NFC-SHARE.md), on the network picked in settings: any token, an amount, then QR (save or
 * print) or an NFC card (the iOS app only), then Fund it. Order (Austin, 10-24): check the money, keep the key,
 * make the QR / write the card, then fund it — a cancelled tap moves no money. A token other than USDC or the
 * native coin also gets a little of the coin, so the card can pay to move it. Big amounts take the wedgie, as a send does.
 */
export function Share({ account, states, assets, chainId, onDone }: { account: SafeAccount; states: ChainState[]; assets: Asset[]; chainId: number; onDone: () => void }) {
  const [amountIn, setAmountIn] = useState("5"); // dollars when the token has a price, else the token
  const [step, setStep] = useState<Step>("form");
  const [how, setHow] = useState<"qr" | "nfc">("qr");
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nfc, setNfc] = useState(false);
  useEffect(() => setNfc(!!wedgieNfc()), []);

  const net = chainById(chainId);
  const st = states.find(s => s.chainId === chainId);
  const usdc = net?.usdc?.toLowerCase();
  const isUsdc = (a: Asset) => a.asset.toLowerCase() === usdc;
  const options = assets.filter(a => a.chainId === chainId && BigInt(a.balance) > 0n);
  const keyOf = (a: Asset) => assetOpt(a).key;
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    if (!options.some(a => keyOf(a) === pick)) setPick(options.length ? keyOf(options.find(isUsdc) ?? options[0]) : null);
  }, [options.map(keyOf).join(), pick]);
  const asset = options.find(a => keyOf(a) === pick) ?? null;

  const price = asset ? (isUsdc(asset) ? 1 : asset.price) : null;
  let base: bigint | null = null;
  try {
    const tokens = price ? (Number(amountIn) / price).toFixed(Math.min(asset!.decimals, 8)) : amountIn;
    base = asset && amountIn ? parseUnits(tokens, asset.decimals) : null;
  } catch {}
  const label = (a: Asset, amt: bigint) => {
    const t = `${fmtAmount(formatUnits(amt, a.decimals))} ${a.symbol}`;
    return isUsdc(a) ? `$${fmtAmount(formatUnits(amt, 6), 2)}` : price ? `${t} (${usd(Number(amountIn))})` : t;
  };

  /** The send: its calls, path, fee — or why it can't go. */
  async function prep(c: { key: Hex; asset: Asset; amount: bigint }) {
    if (!st) throw new Error("Still loading");
    const a = c.asset;
    const to = privateKeyToAccount(c.key).address;
    const coin = a.asset === zeroAddress;
    const gas = coin || isUsdc(a) ? 0n : await gasFor(chainId);
    const calls = [transfer(a.asset as Address, to, c.amount), ...(gas ? [transfer(zeroAddress, to, gas)] : [])];
    const usdcHeld = BigInt(assets.find(x => x.chainId === chainId && isUsdc(x))?.balance ?? "0");
    const coinHeld = BigInt(assets.find(x => x.chainId === chainId && x.asset === zeroAddress)?.balance ?? "0");
    const guess = plan(st, account, a.asset as Address, c.amount, 0n, coin || isUsdc(a));
    let q = await getQuote(chainId, await sendKind(account, st, guess.path, guess.signers));
    const feeToken: FeeToken = coin ? "eth" : isUsdc(a) ? "usdc" : usdcHeld >= BigInt(q.feeUsdc) ? "usdc" : "eth";
    const fee = BigInt(feeToken === "usdc" ? q.feeUsdc : q.feeEth);
    const p = plan(st, account, a.asset as Address, c.amount, fee, coin || isUsdc(a));
    const k = await sendKind(account, st, p.path, p.signers);
    if (k !== q.kind) q = await getQuote(chainId, k);
    const fee2 = BigInt(feeToken === "usdc" ? q.feeUsdc : q.feeEth);
    const needCoin = (coin ? c.amount : 0n) + gas + (feeToken === "eth" ? fee2 : 0n);
    const needUsdc = (isUsdc(a) ? c.amount : 0n) + (feeToken === "usdc" ? fee2 : 0n);
    if (!coin && !isUsdc(a) && BigInt(a.balance) < c.amount) throw new Error(`Not enough ${a.symbol}.`);
    if (coinHeld < needCoin) throw new Error(`Not enough ${net?.native.symbol ?? "ETH"} on ${net?.name}${gas ? " (the card needs a little for gas)" : ""}.`);
    if (usdcHeld < needUsdc) throw new Error(`Not enough USDC on ${net?.name} for this plus the fee.`);
    return { calls, p, q, feeToken };
  }

  async function next() {
    if (!asset || !base || base <= 0n) return;
    setError(null);
    setStep("check");
    try {
      await prep({ key: generatePrivateKey(), asset, amount: base });
    } catch (e: any) {
      setError(friendly(e));
      return setStep("form");
    }
    setCard(null);
    setStep("how");
  }

  /** QR or NFC picked: the key is made and kept now, before anything can hold money. */
  async function make(h: "qr" | "nfc") {
    if (!asset || !base) return;
    const k = generatePrivateKey();
    keep(k);
    const c = { key: k, asset, amount: base, label: label(asset, base) };
    setCard(c);
    setHow(h);
    if (h === "nfc") await write(c);
    else setStep("ready");
  }

  async function write(c: Card) {
    setStep("write");
    setError(null);
    try {
      await wedgieNfc()!.write(claimUrl(window.location.origin, c.key));
      setStep("ready");
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setStep("unwritten");
    }
  }

  async function saveQr(c: Card) {
    setError(null);
    try {
      const blob = await cardsPdfBlob([{ url: claimUrl(window.location.origin, c.key), amount: c.label }]);
      const file = new File([blob], "claim-card.pdf", { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) return void (await navigator.share({ files: [file] }).catch(() => {}));
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = "claim-card.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 10_000);
    } catch (e: any) {
      setError(friendly(e));
    }
  }

  async function fund(c: Card) {
    setError(null);
    let wedgie: Wedgie | null = null;
    try {
      setStep("quote");
      const { calls, p, q, feeToken } = await prep(c);
      const onStage = (s: Stage) => setStep(s);
      if (p.signers.includes("wedgie") && wedgieSupported()) wedgie = await Wedgie.connect(); // a phone: it parks for the computer
      if (p.path === "budget") await budgetSend({ account, state: st!, calls, feeToken, quote: q, onStage });
      else await ownersSend({ account, state: st!, calls, signers: p.signers, feeToken, wedgie, quote: q, onStage, label: `Share ${c.label}` });
      setStep("done");
    } catch (e: any) {
      if (e instanceof Parked) return setStep("parked");
      setError(friendly(e));
      setStep("unfunded");
    } finally {
      await wedgie?.close();
    }
  }

  if (step === "done" && card)
    return (
      <div className="stack center">
        <div style={{ fontSize: 64 }}>✓</div>
        <h2>Done. {card.label} on the {how === "nfc" ? "card" : "QR"}.</h2>
        <button className="btn btn-green wide" onClick={onDone}>
          OK
        </button>
      </div>
    );

  if (step === "parked" && card)
    return (
      <div className="stack center">
        <WedgieIcon size={120} />
        <h2>Now the wedgie</h2>
        <p>You signed {card.label}. Open Instant Wallet on your computer with the wedgie plugged in and press A to send it.</p>
        <button className="btn btn-green wide" onClick={onDone}>
          OK
        </button>
      </div>
    );

  if (step === "unwritten" && card)
    return (
      <div className="stack center">
        <h2>The card wasn&apos;t written</h2>
        <p>No money moved.</p>
        {error && <ErrorLine text={error} />}
        <button className="btn btn-green wide" onClick={() => write(card)}>
          Try again
        </button>
        <button className="btn wide" onClick={() => setStep("how")}>
          Back
        </button>
      </div>
    );

  if (step === "write")
    return (
      <div className="stack center">
        <h2>Hold the card to the top of your phone</h2>
      </div>
    );

  // the QR is out or the card is written: now the money. Also where a failed send comes back to.
  const funding = ["quote", "signing", "signing-hot", "signing-wedgie", "sending", "confirming"].includes(step);
  if ((step === "ready" || step === "unfunded" || funding) && card) {
    const busyLabel: Record<string, string> = { quote: "Getting the fee…", signing: "Signing…", "signing-wedgie": "Press green on the wedgie…", sending: "Sending…", confirming: "Confirming…" };
    return (
      <div className="stack center">
        <h2>{card.label}</h2>
        {how === "qr" ? (
          <>
            <Qr value={claimUrl(window.location.origin, card.key)} />
            <button className="btn wide" onClick={() => saveQr(card)} disabled={funding}>
              Save or print
            </button>
            <p className="fine">Whoever has this QR can take the money. Printing is safer than a photo.</p>
          </>
        ) : (
          <p>Card written ✓</p>
        )}
        {step === "unfunded" && <p className="err">The money didn&apos;t send. {error}</p>}
        <button className="btn btn-green wide" onClick={() => fund(card)} disabled={funding}>
          {funding ? (busyLabel[step] ?? "…") : step === "unfunded" ? "Try again" : "Fund it"}
        </button>
        {!funding && <p className="fine">The {how === "qr" ? "QR" : "card"} is empty until you fund it.</p>}
      </div>
    );
  }

  if (step === "how" && asset && base)
    return (
      <div className="stack">
        <h2>Share {label(asset, base)}</h2>
        <button className="btn btn-green wide" onClick={() => make("qr")}>
          QR code
        </button>
        {nfc && (
          <button className="btn btn-green wide" onClick={() => make("nfc")}>
            NFC card
          </button>
        )}
        <button className="btn wide" onClick={() => setStep("form")}>
          Back
        </button>
      </div>
    );

  const busy = step !== "form";
  return (
    <div className="stack">
      <h2>Share crypto</h2>
      <p className="fine">On {net?.name}. Whoever scans or taps it gets it.</p>
      <a className="fine" href="/claim/new">
        My shares: see which are claimed, take back the rest
      </a>
      <div className="field">
        <label>What</label>
        {options.length ? (
          <Select value={asset ? assetOpt(asset) : null} options={options.map(assetOpt)} onPick={setPick} />
        ) : (
          <p className="fine">Nothing on {net?.name}. Pick another network in settings.</p>
        )}
      </div>
      {price ? (
        <div className="row" style={{ gap: 8 }}>
          {CHIPS.map(c => (
            <button key={c} className={`pill ${amountIn === c ? "on" : ""}`} onClick={() => setAmountIn(c)} disabled={busy}>
              ${c}
            </button>
          ))}
        </div>
      ) : null}
      <div className="field">
        <label>Amount</label>
        <div className="input">
          {price ? <span className="amount-cur">$</span> : null}
          <input className="amount" inputMode="decimal" value={amountIn} disabled={busy} onChange={e => setAmountIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} placeholder="0" />
          {!price && asset && <span className="unit">{asset.symbol}</span>}
        </div>
        {asset && (
          <span className="fine">
            {price && base && !isUsdc(asset) ? `= ${fmtAmount(formatUnits(base, asset.decimals))} ${asset.symbol} · ` : ""}
            You have {fmtAmount(asset.formatted)} {asset.symbol}
          </span>
        )}
      </div>
      {error && <ErrorLine text={error} />}
      <button className="btn btn-green wide" onClick={next} disabled={busy || !st || !asset || !base || base <= 0n}>
        {busy ? "Checking…" : "Next"}
      </button>
    </div>
  );
}
