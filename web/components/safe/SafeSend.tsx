"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type Address, type Hash, formatUnits, parseUnits, zeroAddress } from "viem";
import { chainById, explorerTx, nativeSymbol } from "@/lib/chains";
import { amount as fmtAmount, usd, feeText, addressIn } from "@/lib/format";
import { isClaimLink } from "@/lib/claim";
import { isXdai } from "@/lib/brand";
import { dropCode } from "@/lib/dropClient";
import { rememberPaid } from "@/lib/names";
import { parse } from "@/lib/parse";
import { openWalletConnect } from "@/lib/walletconnect";
import { transfer } from "@/lib/safe/core";
import type { Quote } from "@/lib/safe/fee";
import { type FeeToken, type Signer, type Stage, Shared, budgetSend, feeCall, getQuote, ownersSend, plan, sendKind, signThenQueue, signerOptions, usesWedgie } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { Net, AddressInput, AmountBox, ChainChip, DoneBar, Money, NameMoved, TokenIcon, Who, stageLabel, useSheetBack } from "../bits";
import { Scanner } from "../Scanner";
import { Select, assetOpt } from "./Pick";
import { friendly } from "@/lib/friendly";
import { SignerChoice } from "./Pick";
import { Progress } from "./Progress";
import { ErrorLine } from "./WedgieButton";
import { WhatItDoes } from "./WhatItDoes";


/**
 * Send: who → what → how much → review (which keys, the fee) → sign → the relay sends. The burner alone covers
 * level 1, and its daily budget after that; bigger moves ask for the other keys (the wedgie).
 */
export function SafeSend({
  account,
  assets,
  states,
  start,
  scanned,
  onDone,
}: {
  account: SafeAccount;
  assets: Asset[];
  states: ChainState[];
  start?: Asset;
  scanned?: string; // a payment request link that opened the app: filled in as if scanned
  onDone: () => void;
}) {
  const [toInput, setToInput] = useState("");
  const [scanning, setScanning] = useState(!start && !scanned);
  // the scanner opened from the form: swiping it away goes back to the form
  const [scanFromForm, setScanFromForm] = useState(false);
  const leaveScan = useCallback(() => {
    setScanning(false);
    setScanFromForm(false);
  }, []);
  useSheetBack(scanning && scanFromForm ? leaveScan : null);
  const [resolved, setResolved] = useState<Address | null>(null);
  const [toName, setToName] = useState<string | null>(null); // the name that was looked up: as typed, or lil.inst.eth for a bare "lil"
  const key = (a: { chainId: number; asset: string }) => `${a.chainId}:${a.asset.toLowerCase()}`;
  const [pick, setPick] = useState<string | null>(start ? key(start) : null);
  const [amountIn, setAmountIn] = useState(""); // always the token amount (<AmountBox> takes dollars and works it out)
  const [asCoin, setAsCoin] = useState(false); // the box opens on the coin: a payment request names a coin amount
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

  let base: bigint | null = null;
  try {
    base = asset && amountIn ? parseUnits(amountIn, asset.decimals) : null;
  } catch {
    base = null;
  }
  const price = asset?.price || null;
  const tooMuch = !!asset && base !== null && base > BigInt(asset.balance);

  // the fee: in the token being sent when it's USDC or ETH, else USDC if there's enough, else ETH
  const sendingUsdc = !!asset && asset.asset.toLowerCase() === usdcAddr?.toLowerCase();
  const sendingEth = asset?.asset === zeroAddress;
  const feeToken: FeeToken = sendingEth ? "eth" : sendingUsdc ? "usdc" : usdcHeld ? "usdc" : "eth";
  const fee = quote ? BigInt(feeToken === "usdc" ? quote.feeUsdc : quote.feeEth) : 0n;
  const feeLabel = quote ? feeText(quote, feeToken, nativeSymbol(chainId)) : "…";
  const p = st && asset && base !== null ? plan(st, account, asset.asset as Address, base, fee, sendingUsdc || sendingEth) : null;
  // which keys sign a big move: the first way this device can, unless the user picks another
  const options = st && p?.path === "owners" && st.threshold > 1 && !signThenQueue(st, account) ? signerOptions(st, account) : [];
  const [chosen, setChosen] = useState<Signer[] | null>(null);
  const signers: Signer[] = p?.path === "owners" && chosen && options.some(o => o.ready && o.signers.join() === chosen.join()) ? chosen : (p?.signers ?? []);
  useEffect(() => {
    // another set of keys can be another kind of send (the wedgie verifies in Solidity): quote that one
    if (stage !== "review" || !st || p?.path !== "owners" || !quote) return;
    let live = true;
    sendKind(account, st, "owners", signers)
      .then(k => (k === quote.kind ? null : getQuote(chainId, k)))
      .then(q => live && q && setQuote(q))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [signers.join(), stage]);
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
      setQuote(await quoteFor(base));
    } catch (e: any) {
      setError(friendly(e));
    }
  }

  async function quoteFor(amount: bigint) {
    if (!st || !asset) throw new Error("Still loading");
    // a first guess at the path (the budget check needs a fee), then the quote for that exact kind of send
    const same = sendingUsdc || sendingEth;
    const guess = plan(st, account, asset.asset as Address, amount, 0n, same);
    const k1 = await sendKind(account, st, guess.path, guess.signers);
    let q = await getQuote(chainId, k1);
    // with the real fee, the path can change (near the budget's edge): then quote that kind instead
    const real = plan(st, account, asset.asset as Address, amount, BigInt(feeToken === "usdc" ? q.feeUsdc : q.feeEth), same);
    const k2 = await sendKind(account, st, real.path, real.signers);
    if (k2 !== k1) q = await getQuote(chainId, k2);
    return q;
  }

  // Max: the whole balance, less the fee when the fee is paid in this same token
  const [maxing, setMaxing] = useState(false);
  async function max() {
    if (!asset) return;
    setError(null);
    let amt = BigInt(asset.balance);
    if (sendingUsdc || sendingEth) {
      setMaxing(true);
      try {
        const q = await quoteFor(amt);
        amt -= BigInt(sendingUsdc ? q.feeUsdc : q.feeEth);
      } catch (e: any) {
        setMaxing(false);
        return setError(friendly(e));
      }
      setMaxing(false);
    }
    if (amt < 0n) amt = 0n;
    const t = formatUnits(amt, asset.decimals);
    setAmountIn(t);
  }

  function onScan(text: string) {
    setScanning(false);
    const drop = dropCode(text);
    if (drop) return void (window.location.href = `/d#${drop}`); // a drop's QR (any host): claim it into this wallet
    if (isClaimLink(text)) return void (window.location.href = `/claim${new URL(text.trim()).hash}`); // a claim card (any host): claim it into this wallet
    const r = parse(text);
    if (r.kind === "wc") return void (onDone(), openWalletConnect(r.uri)); // a site's WalletConnect QR: connect to it
    if (r.kind !== "pay") return setError("That QR isn't an address.");
    setToInput(r.to);
    const find = (chainId?: number) => assets.find(a => (!chainId || a.chainId === chainId) && (!r.asset || a.asset.toLowerCase() === r.asset.toLowerCase()));
    // no network named: on xdai.io an old Burner link (/0x…;5) meant xDAI on Gnosis, so Gnosis first if it's held there
    const home = !r.chainId && isXdai() ? find(100) : undefined;
    const m = home ?? (r.chainId || r.asset ? find(r.chainId) : undefined);
    if (r.chainId || r.asset || home) {
      if (!m) {
        setPick(null);
        setAmountIn("");
        return setError("That request is for a token or network you don't hold here.");
      }
      setPick(key(m));
    }
    const amt = r.amount ?? (r.amountBase !== undefined && m ? formatUnits(r.amountBase, m.decimals) : undefined);
    if (amt) {
      setAmountIn(amt);
      setAsCoin(true); // a payment request names the token amount
    }
  }

  const clip = () => navigator.clipboard?.readText().then(t => t.trim()).catch(() => "") ?? Promise.resolve("");
  // one Paste: it works out what the clipboard holds. A WalletConnect code connects, a payment link or claim card
  // works like a scan, anything else (an address, a name) goes in To
  async function paste() {
    const t = await clip();
    if (!t) return;
    if (dropCode(t) || isClaimLink(t) || parse(t).kind !== "unknown") return onScan(t);
    setToInput(addressIn(t));
  }

  useEffect(() => {
    if (scanned) onScan(scanned);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (st && usesWedgie(account, st, signers) && wedgieSupported()) wedgie = await Wedgie.connect(); // a computer: it signs here too
      const h =
        p.path === "budget"
          ? await budgetSend({ account, state: st, calls, feeToken, quote: quote ?? undefined, onStage })
          : await ownersSend({ account, state: st, calls, signers, feeToken, wedgie, quote: quote ?? undefined, onStage, label: `Send ${what} to ${toName ?? resolved}` });
      setHash(h);
      setStage("done");
      if (toName) rememberPaid(toName, resolved);
    } catch (e: any) {
      if (e instanceof Shared) return; // its page has the sheet now
      setError(friendly(e));
      setStage("review");
    } finally {
      await wedgie?.close();
    }
  }

  const what = asset && amountIn ? `${fmtAmount(amountIn)} ${asset.symbol}` : "";
  const usd2 = (v: number) => "$" + v.toFixed(2);


  if (stage === "done" && resolved) {
    const url = hash && explorerTx(chainId, hash);
    return (
      <div className="stack center">
        <div style={{ fontSize: 64 }}>✓</div>
        <h2>Executed</h2>
        {asset && <Money amount={amountIn} symbol={asset.symbol} usd={asset.price ? Number(amountIn) * asset.price : null} />}
        <div>
          <Who inline address={resolved} chain={chainId} label={toName ?? undefined} />
        </div>
        <DoneBar onDone={onDone} href={url} />
      </div>
    );
  }

  if (stage !== "form" && resolved && asset && base !== null) {
    const busy = stage !== "review";
    const ran = !!quote && !!st?.deployed; // a wallet not yet on this network can't be run
    return (
      <div className="stack confirm">
        {/* said once (Austin 11-10): dollars, the coin, who. The run still happens: it speaks only when something is wrong */}
        <h2>
          Send {asset.price ? `${usd2(Number(amountIn) * asset.price)} of ${asset.symbol}` : what} to <Who flat address={resolved} chain={chainId} label={toName ?? undefined} />?
        </h2>
        <div className="card">
          {/* only while you decide: once it's signed the run has nothing left to say */}
          {ran && quote && !busy && <WhatItDoes quiet chainId={chainId} safe={account.address} calls={[transfer(asset.asset as Address, resolved, base), feeCall(quote, feeToken)]} />}
          <div className="line">
            <span>To</span>
            <Who address={resolved} chain={chainId} label={toName ?? undefined} />
          </div>
          {toName && <NameMoved name={toName} address={resolved} />}
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
            {p ? <SignerChoice options={options} value={signers} onChange={setChosen} disabled={busy} note={p.path === "budget" ? "daily budget" : st && signThenQueue(st, account) ? "then the wedgie or the others" : undefined} /> : <span>…</span>}
          </div>
          {!st?.deployed && (
            <div className="line">
              <span>First send here</span>
              <span className="fine">deploys your wallet on <Net chainId={chainId} /></span>
            </div>
          )}
        </div>
        {feeShort && <p className="err">Not enough {feeToken === "usdc" ? "USDC" : nativeSymbol(chainId)} on <Net chainId={chainId} /> for this plus the fee.</p>}
        {error && <ErrorLine text={error} />}
        <button className="btn btn-green wide" onClick={send} disabled={busy || !quote || feeShort}>
          {busy ? stageLabel(stage) : "Send"}
        </button>
        <Progress stage={stage} chainId={chainId} hash={hash} />
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
      <h2>{scanning ? "Send or scan" : "Send"}</h2>
      {scanning && <Scanner short onResult={onScan} />}
      {/* the one To box, on the scan screen and on the form (the scan pill only on the form: the scan screen is the scanner) */}
      <div className="field">
        <label>To</label>
        <AddressInput
          value={toInput}
          onText={setToInput}
          onChange={(a, name) => (setResolved(a), setToName(name ?? null))}
          chain={chainId}
          scan={!scanning}
          onScan={() => (setScanFromForm(true), setScanning(true))}
          onEnter={scanning ? leaveScan : undefined}
        />
      </div>
      {scanning ? (
        <>
          {/* typed or pasted instead of scanned: green once it is an address or a name that points somewhere */}
          <button className="btn btn-green wide" disabled={!resolved} onClick={leaveScan}>
            {resolved ? <>Send to <Who flat address={resolved} chain={chainId} label={toName ?? undefined} /></> : "Send"}
          </button>
          <button className="btn wide" onClick={paste}>
            Paste
          </button>
        </>
      ) : (
        <>
          <div className="field">
            <label>What</label>
            {assets.length ? (
              <Select
                value={asset ? assetOpt(asset) : null}
                options={assets.map(assetOpt)}
                onPick={k => {
                  setPick(k);
                  setAmountIn("");
                  setAsCoin(false);
                }}
              />
            ) : (
              <p className="fine">Nothing to send yet. Receive something first.</p>
            )}
          </div>

          {asset && (
            <div className="field">
              <label>Amount</label>
              {/* the shared box: dollars first, the pill switches to the coin (the same in Swap, Share, Request, Limits) */}
              <AmountBox
                key={`${key(asset)}:${asCoin}`}
                value={amountIn}
                onChange={setAmountIn}
                symbol={asset.symbol}
                decimals={asset.decimals}
                price={price}
                onMax={max}
                maxing={maxing}
                startCoin={asCoin}
                right={
                  st?.budget && (sendingUsdc || sendingEth)
                    ? `${sendingUsdc ? `${fmtAmount(formatUnits(st.budget.usdc, 6))} USDC` : price ? usd(Number(formatUnits(st.budget.eth, 18)) * price) : `${fmtAmount(formatUnits(st.budget.eth, 18))} ${nativeSymbol(chainId)}`} left today`
                    : `You have ${asset.usd ? usd(asset.usd) : `${fmtAmount(asset.formatted)} ${asset.symbol}`}`
                }
              />
              {tooMuch && <span className="err">More than you have</span>}
            </div>
          )}
          {error && <ErrorLine text={error} />}
          <button className="btn btn-green wide" disabled={!ready} onClick={review}>
            Review
          </button>
        </>
      )}
    </div>
  );
}
