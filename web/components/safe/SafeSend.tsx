"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address, type Hash, formatUnits, getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import { chainById, explorerTx } from "@/lib/chains";
import { amount as fmtAmount, short, usd } from "@/lib/format";
import { parse } from "@/lib/parse";
import { transfer } from "@/lib/safe/core";
import type { Quote } from "@/lib/safe/fee";
import { type FeeToken, type Signer, type Stage, budgetSend, getQuote, ownersSend, plan, sendKind } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { Wedgie } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { Blockie, ChainChip, ScanIcon, TokenIcon } from "../bits";
import { Scanner } from "../Scanner";
import { friendly } from "../Welcome";

const SIGNER_NAME: Record<Signer, string> = { burner: "your Instant wallet", hot: "your hot wallet", wedgie: "your wedgie (press A)" };

/**
 * Send: who → what → how much → review (which keys, the fee) → sign → the relay sends. The burner alone covers
 * level 1, and its daily budget after that; bigger moves ask for the other keys (hot wallet, wedgie).
 */
export function SafeSend({
  account,
  assets,
  states,
  start,
  onDone,
}: {
  account: SafeAccount;
  assets: Asset[];
  states: ChainState[];
  start?: Asset;
  onDone: () => void;
}) {
  const [toInput, setToInput] = useState("");
  const [scanning, setScanning] = useState(!start);
  const [resolved, setResolved] = useState<Address | null>(null);
  const [resolving, setResolving] = useState(false);
  const key = (a: { chainId: number; asset: string }) => `${a.chainId}:${a.asset.toLowerCase()}`;
  const [pick, setPick] = useState<string | null>(start ? key(start) : null);
  const [amountIn, setAmountIn] = useState("");
  const [stage, setStage] = useState<"form" | "review" | Stage | "done">("form");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<string | null>(null);

  const asset = useMemo(() => assets.find(a => key(a) === pick) ?? null, [assets, pick]);
  useEffect(() => {
    if (!pick && assets.length) setPick(key(assets[0]));
  }, [assets, pick]);
  const chainId = asset?.chainId ?? 8453;
  const st = states.find(s => s.chainId === chainId);
  const usdcAddr = chainById(chainId)?.usdc;
  const usdcHeld = assets.find(a => a.chainId === chainId && a.asset.toLowerCase() === usdcAddr?.toLowerCase());
  const ethHeld = assets.find(a => a.chainId === chainId && a.asset === zeroAddress);

  // resolve the recipient
  useEffect(() => {
    const v = toInput.trim();
    setResolved(null);
    if (isAddress(v)) return setResolved(getAddress(v));
    if (!/\.[a-z]{2,}$/i.test(v)) return;
    setResolving(true);
    let live = true; // a late answer for an older name must never land on a newer input
    const t = setTimeout(async () => {
      const j = await fetch(`/api/ens?name=${encodeURIComponent(v.toLowerCase())}`).then(r => r.json()).catch(() => null);
      if (!live) return;
      setResolving(false);
      if (j?.address) setResolved(getAddress(j.address));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [toInput]);

  let base: bigint | null = null;
  try {
    base = asset && amountIn ? parseUnits(amountIn, asset.decimals) : null;
  } catch {
    base = null;
  }
  const tooMuch = !!asset && base !== null && base > BigInt(asset.balance);

  // the fee: in the token being sent when it's USDC or ETH, else USDC if there's enough, else ETH
  const sendingUsdc = !!asset && asset.asset.toLowerCase() === usdcAddr?.toLowerCase();
  const sendingEth = asset?.asset === zeroAddress;
  const feeToken: FeeToken = sendingEth ? "eth" : sendingUsdc ? "usdc" : usdcHeld ? "usdc" : "eth";
  const fee = quote ? BigInt(feeToken === "usdc" ? quote.feeUsdc : quote.feeEth) : 0n;
  const feeLabel = quote ? (feeToken === "usdc" ? `${fmtAmount(formatUnits(fee, 6))} USDC` : `${fmtAmount(formatUnits(fee, 18))} ETH`) : "…";
  const p = st && asset && base !== null ? plan(st, account, asset.asset as Address, base, fee, sendingUsdc || sendingEth) : null;
  const feeBalance = feeToken === "usdc" ? BigInt(usdcHeld?.balance ?? "0") : BigInt(ethHeld?.balance ?? "0");
  const spentInFeeToken = (feeToken === "usdc" && sendingUsdc) || (feeToken === "eth" && sendingEth) ? (base ?? 0n) : 0n;
  const feeShort = !!quote && feeBalance < spentInFeeToken + fee;
  const ready = !!resolved && !!asset && base !== null && base > 0n && !tooMuch;

  async function review() {
    setError(null);
    setStage("review");
    setQuote(null);
    try {
      if (!st || !asset || base === null) throw new Error("Still loading");
      // a first guess at the path (the budget check needs a fee), then the quote for that exact kind of send
      const same = sendingUsdc || sendingEth;
      const guess = plan(st, account, asset.asset as Address, base, 0n, same);
      const k1 = await sendKind(account, st, guess.path, guess.signers);
      let q = await getQuote(chainId, k1);
      // with the real fee, the path can change (near the budget's edge): then quote that kind instead
      const real = plan(st, account, asset.asset as Address, base, BigInt(feeToken === "usdc" ? q.feeUsdc : q.feeEth), same);
      const k2 = await sendKind(account, st, real.path, real.signers);
      if (k2 !== k1) q = await getQuote(chainId, k2);
      setQuote(q);
    } catch (e: any) {
      setError(friendly(e));
    }
  }

  function onScan(text: string) {
    setScanning(false);
    const r = parse(text);
    if (r.kind !== "pay") return setError("That QR isn't an address.");
    setToInput(r.to);
    if (r.chainId || r.asset) {
      const m = assets.find(a => (!r.chainId || a.chainId === r.chainId) && (!r.asset || a.asset.toLowerCase() === r.asset.toLowerCase()));
      if (!m) {
        setPick(null);
        setAmountIn("");
        return setError("That request is for a token or network you don't hold here.");
      }
      setPick(key(m));
    }
    if (r.amount) setAmountIn(r.amount);
  }

  async function send() {
    if (!resolved || !asset || base === null || !st || !p) return;
    setError(null);
    let wedgie: Wedgie | null = null;
    try {
      const calls = [transfer(asset.asset as Address, resolved, base)];
      const onStage = (s: Stage, h?: Hash) => {
        setStage(s);
        if (h) setHash(h);
      };
      if (p.signers.includes("wedgie")) wedgie = await Wedgie.connect();
      const h =
        p.path === "budget"
          ? await budgetSend({ account, state: st, calls, feeToken, quote: quote ?? undefined, onStage })
          : await ownersSend({ account, state: st, calls, signers: p.signers, feeToken, wedgie, quote: quote ?? undefined, onStage });
      setHash(h);
      setStage("done");
    } catch (e: any) {
      setError(friendly(e));
      setStage("review");
    } finally {
      await wedgie?.close();
    }
  }

  const what = asset && amountIn ? `${fmtAmount(amountIn)} ${asset.symbol}` : "";

  if (stage === "done" && resolved) {
    const url = hash && explorerTx(chainId, hash);
    return (
      <div className="stack center">
        <div style={{ fontSize: 64 }}>✓</div>
        <h2>Sent</h2>
        <p>
          {what} to {toInput.includes(".") ? toInput : short(resolved)}
        </p>
        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            View on {chainById(chainId)?.name} explorer
          </a>
        )}
        <button className="btn btn-green wide" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }

  if (stage !== "form" && resolved && asset && base !== null) {
    const busy = stage !== "review";
    const label: Record<string, string> = {
      quote: "Getting the fee…",
      signing: "Signing…",
      "signing-hot": "Sign in your hot wallet…",
      "signing-wedgie": "Check the wedgie, press A…",
      sending: "Sending…",
      confirming: "Confirming…",
    };
    return (
      <div className="stack confirm">
        <h2>Send {what}?</h2>
        <div className="card">
          <div className="line">
            <span>To</span>
            <span className="row">
              <Blockie address={resolved} size={22} />
              <b>{toInput.includes(".") ? toInput : short(resolved)}</b>
            </span>
          </div>
          {toInput.includes(".") && (
            <div className="line">
              <span>Address</span>
              <span className="mono" style={{ fontSize: 13 }}>{resolved}</span>
            </div>
          )}
          <div className="line">
            <span>Amount</span>
            <b>
              {what} {asset.price && <span className="fine">≈ {usd(Number(amountIn) * asset.price)}</span>}
            </b>
          </div>
          <div className="line">
            <span>Network</span>
            <ChainChip chainId={chainId} />
          </div>
          <div className="line">
            <span>Fee</span>
            <span>{feeLabel}</span>
          </div>
          <div className="line">
            <span>Signed by</span>
            <span>{p ? p.signers.map(s => SIGNER_NAME[s]).join(" + ") : "…"}</span>
          </div>
          {!st?.deployed && (
            <div className="line">
              <span>First send here</span>
              <span className="fine">deploys your wallet on {chainById(chainId)?.name}</span>
            </div>
          )}
          {p?.path === "budget" && (
            <div className="line">
              <span>Daily budget</span>
              <span className="fine">within your Instant wallet's daily budget</span>
            </div>
          )}
        </div>
        {feeShort && <p className="err">Not enough {feeToken === "usdc" ? "USDC" : "ETH"} on {chainById(chainId)?.name} for this plus the fee.</p>}
        {error && <p className="err">{error}</p>}
        <button className="btn btn-green wide" onClick={send} disabled={busy || !quote || feeShort}>
          {busy ? label[stage] ?? "…" : "Sign and send"}
        </button>
        {!busy && (
          <button className="btn wide" onClick={() => setStage("form")}>
            Back
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      <h2>Send</h2>
      {scanning ? (
        <>
          <Scanner onResult={onScan} />
          <button className="btn wide" onClick={() => setScanning(false)}>
            Type it instead
          </button>
        </>
      ) : (
        <>
          <div className="field">
            <label>To</label>
            <div className="input">
              {resolved && <Blockie address={resolved} size={30} />}
              <input value={toInput} onChange={e => setToInput(e.target.value)} placeholder="0x… or name.eth" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <button className="pill" onClick={() => setScanning(true)} aria-label="Scan">
                <ScanIcon size={20} />
              </button>
            </div>
            {resolving && <span className="fine">Looking up {toInput}…</span>}
            {resolved && toInput.includes(".") && <span className="fine mono">{resolved}</span>}
          </div>

          <div className="field">
            <label>What</label>
            {assets.length ? (
              <div className="picker">
                {assets.map(a => (
                  <button key={key(a)} className={`pill ${key(a) === pick ? "on" : ""}`} style={{ justifyContent: "space-between", height: 46 }} onClick={() => setPick(key(a))}>
                    <span className="row">
                      <TokenIcon symbol={a.symbol} asset={a.asset} chainId={a.chainId} logo={a.logo} size={28} /> <b>{a.symbol}</b>
                    </span>
                    <span>
                      {fmtAmount(a.formatted)} {a.usd !== null && <span style={{ opacity: 0.75 }}>· {usd(a.usd)}</span>}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="fine">Nothing to send yet. Receive something first.</p>
            )}
          </div>

          {asset && (
            <div className="field">
              <label>Amount</label>
              <div className="input">
                <input
                  className="amount"
                  inputMode="decimal"
                  value={amountIn}
                  onChange={e => setAmountIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                  placeholder="0"
                />
                <span className="unit">{asset.symbol}</span>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="fine">{asset.price && amountIn ? `≈ ${usd(Number(amountIn) * asset.price)}` : ""}</span>
                <span className="fine">
                  {st?.budget && (sendingUsdc || sendingEth)
                    ? `Daily budget left: ${sendingUsdc ? `${fmtAmount(formatUnits(st.budget.usdc, 6))} USDC` : `${fmtAmount(formatUnits(st.budget.eth, 18))} ETH`}`
                    : `You have ${fmtAmount(asset.formatted)}`}
                </span>
              </div>
              {tooMuch && <span className="err">More than you have</span>}
            </div>
          )}
          {error && <p className="err">{error}</p>}
          <button className="btn btn-green wide" disabled={!ready} onClick={review}>
            Review
          </button>
        </>
      )}
    </div>
  );
}
