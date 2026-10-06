"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address, type Hash, formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { DEFAULT_CHAIN, ETH, SENDABLE, chainById, explorerTx } from "@/lib/chains";
import { amount as fmtAmount, short, usd } from "@/lib/format";
import { type Parsed, parse } from "@/lib/parse";
import type { Account, Asset } from "@/lib/types";
import { feeEstimateUsd, isDeployed, sendCalls, transferCall } from "@/lib/wallet";
import { Blockie, ChainChip, ScanIcon, TokenIcon } from "./bits";
import { Scanner } from "./Scanner";
import { friendly } from "./Welcome";

type Prefill = Extract<Parsed, { kind: "pay" }>;

/**
 * Send: who (scan / paste / type 0x or ENS) → what (an asset on a chain, or everything on Base) → how much →
 * Face ID → a bundler submits; the network fee comes out of the wallet's USDC. Burner-wallet simple.
 */
export function Send({
  account,
  assets,
  prefill,
  onDone,
  onWalletConnect,
}: {
  account: Account;
  assets: Asset[];
  prefill?: Prefill;
  onDone: () => void;
  onWalletConnect: (uri: string) => void;
}) {
  const [toInput, setToInput] = useState(prefill?.to ?? "");
  const [scanning, setScanning] = useState(!prefill);
  const [resolved, setResolved] = useState<Address | null>(null);
  const [resolving, setResolving] = useState(false);
  const [pick, setPick] = useState<string | null>(null); // `${chainId}:${asset}`
  const [amountIn, setAmountIn] = useState(prefill?.amount ?? "");
  const [inUsd, setInUsd] = useState(false);
  const [stage, setStage] = useState<"form" | "confirm" | "signing" | "sending" | "confirming" | "done">("form");
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<string | null>(null);
  const [fee, setFee] = useState<number | null>(null);

  // the asset list: what we hold; a link may name something we don't hold yet
  const held = assets.filter(a => BigInt(a.balance) > 0n);
  const key = (a: { chainId: number; asset: string }) => `${a.chainId}:${a.asset.toLowerCase()}`;
  const ALL = "all";
  const all = pick === ALL;
  const allChain = DEFAULT_CHAIN.id;
  const allAssets = held.filter(a => a.chainId === allChain);
  const asset = useMemo(() => (all ? allAssets.find(isUsdc) ?? allAssets[0] ?? null : held.find(a => key(a) === pick) ?? null), [held, pick]);
  const chainId = asset?.chainId ?? allChain;
  const usdc = held.find(a => a.chainId === chainId && isUsdc(a));
  const usdcBal = usdc ? BigInt(usdc.balance) : 0n;
  const ethUsd = assets.find(a => a.asset === ETH && a.price)?.price ?? undefined;

  // default pick: the link's asset/chain, else the biggest holding
  useEffect(() => {
    if (pick || !held.length) return;
    const fromLink = held.find(
      a => (!prefill?.chainId || a.chainId === prefill.chainId) && (!prefill?.asset || a.asset.toLowerCase() === prefill.asset.toLowerCase()),
    );
    setPick(key(prefill?.asset || prefill?.chainId ? fromLink ?? held[0] : held[0]));
  }, [held, pick, prefill]);

  // a link's amount in base units (EIP-681) → human units once we know the decimals
  useEffect(() => {
    if (asset && prefill?.amountBase !== undefined && !amountIn) setAmountIn(formatUnits(prefill.amountBase, asset.decimals));
  }, [asset, prefill, amountIn]);

  // resolve the recipient
  useEffect(() => {
    const v = toInput.trim();
    setResolved(null);
    if (isAddress(v)) return setResolved(getAddress(v));
    if (!/\.[a-z]{2,}$/i.test(v)) return;
    setResolving(true);
    const t = setTimeout(async () => {
      const j = await fetch(`/api/ens?name=${encodeURIComponent(v.toLowerCase())}`).then(r => r.json()).catch(() => null);
      setResolving(false);
      if (j?.address) setResolved(getAddress(j.address));
    }, 350);
    return () => clearTimeout(t);
  }, [toInput]);

  // what the network fee will roughly be (paid in USDC)
  useEffect(() => {
    if (!SENDABLE.has(chainId) || !ethUsd) return;
    let live = true;
    isDeployed(chainId, account.address)
      .then(d => feeEstimateUsd(chainId, d, ethUsd))
      .then(f => live && setFee(f))
      .catch(() => live && setFee(null));
    return () => {
      live = false;
    };
  }, [chainId, account.address, ethUsd]);

  const tokenAmount: string = useMemo(() => {
    if (!asset || !amountIn) return "";
    if (!inUsd) return amountIn;
    if (!asset.price) return "";
    return (Number(amountIn) / asset.price).toFixed(Math.min(asset.decimals, 8));
  }, [amountIn, inUsd, asset]);

  let base: bigint | null = null;
  try {
    base = asset && tokenAmount ? parseUnits(tokenAmount, asset.decimals) : null;
  } catch {
    base = null;
  }
  const tooMuch = !!asset && base !== null && base > BigInt(asset.balance);
  const usdValue = all ? allAssets.reduce((t, a) => t + (a.usd ?? 0), 0) : asset?.price && tokenAmount ? Number(tokenAmount) * asset.price : null;
  const sendable = SENDABLE.has(chainId);
  // the fee needs a few cents of USDC left over (more is reserved up front and refunded)
  const usdcAfter = usdcBal - (asset && usdc && !all && key(asset) === key(usdc) && base !== null ? base : 0n);
  const feeShort = sendable && usdcAfter < FEE_FLOOR;
  const ready = !!resolved && sendable && !feeShort && (all ? allAssets.length > 0 : !!asset && base !== null && base > 0n && !tooMuch);

  function onScan(text: string) {
    setScanning(false);
    const p = parse(text);
    if (p.kind === "wc") return onWalletConnect(p.uri);
    if (p.kind !== "pay") return setError("That QR isn't an address.");
    setToInput(p.to);
    if (p.chainId || p.asset) {
      const m = held.find(a => (!p.chainId || a.chainId === p.chainId) && (!p.asset || a.asset.toLowerCase() === p.asset.toLowerCase()));
      if (m) setPick(key(m));
    }
    if (p.amount) setAmountIn(p.amount);
    else if (p.amountBase !== undefined) {
      const m = held.find(a => key(a) === pick);
      if (m) setAmountIn(formatUnits(p.amountBase, m.decimals));
    }
  }

  async function send() {
    if (!resolved || (!all && (!asset || base === null))) return;
    setError(null);
    try {
      const calls = all
        ? allAssets.filter(a => !isUsdc(a)).map(a => transferCall(a.asset, resolved, BigInt(a.balance)))
        : [transferCall(asset!.asset, resolved, base!)];
      const h = await sendCalls(chainId, account, calls, {
        ethUsd,
        sweepUsdcTo: all ? resolved : undefined,
        onStage: (s, hh) => {
          setStage(s);
          if (hh) setHash(hh);
        },
      });
      setHash(h);
      setStage("done");
    } catch (e: any) {
      setError(friendly(e));
      setStage("confirm");
    }
  }

  const what = all ? `everything on ${chainById(chainId)?.name}` : asset ? `${fmtAmount(tokenAmount)} ${asset.symbol}` : "";

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

  if (stage !== "form" && resolved && (all || (asset && base !== null))) {
    const busy = stage === "signing" || stage === "sending" || stage === "confirming";
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
          {all ? (
            allAssets.map(a => (
              <div className="line" key={key(a)}>
                <span>{a.symbol}</span>
                <b>{isUsdc(a) ? `${fmtAmount(a.formatted)} minus the fee` : fmtAmount(a.formatted)}</b>
              </div>
            ))
          ) : (
            <div className="line">
              <span>Amount</span>
              <b>
                {fmtAmount(tokenAmount)} {asset!.symbol} {usdValue !== null && <span className="fine">≈ {usd(usdValue)}</span>}
              </b>
            </div>
          )}
          <div className="line">
            <span>Network</span>
            <ChainChip chainId={chainId} />
          </div>
          <div className="line">
            <span>Fee</span>
            <span>{fee !== null ? `≈ ${usd(Math.max(fee, 0.01))}` : "a cent or two"}, in USDC</span>
          </div>
        </div>
        {error && <p className="err">{error}</p>}
        <button className="btn btn-green wide" onClick={send} disabled={busy}>
          {stage === "signing" ? "Signing…" : stage === "sending" ? "Sending…" : stage === "confirming" ? "Confirming…" : "Send"}
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
              <input
                value={toInput}
                onChange={e => setToInput(e.target.value)}
                placeholder="0x… or name.eth"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <button className="pill" onClick={() => setScanning(true)} aria-label="Scan">
                <ScanIcon size={20} />
              </button>
            </div>
            {resolving && <span className="fine">Looking up {toInput}…</span>}
            {resolved && toInput.includes(".") && <span className="fine mono">{resolved}</span>}
            {!resolving && toInput.includes(".") && !resolved && toInput.length > 4 && <span className="err">No address for that name</span>}
          </div>

          <div className="field">
            <label>What</label>
            {held.length ? (
              <div className="picker">
                {allAssets.length > 1 && (
                  <button className={`pill ${all ? "on" : ""}`} style={{ justifyContent: "space-between", height: 46 }} onClick={() => setPick(ALL)}>
                    <span className="row">
                      <b>Everything</b> <ChainChip chainId={allChain} />
                    </span>
                    <span>{usd(allAssets.reduce((t, a) => t + (a.usd ?? 0), 0))}</span>
                  </button>
                )}
                {held.map(a => (
                  <button
                    key={key(a)}
                    className={`pill ${key(a) === pick ? "on" : ""}`}
                    style={{ justifyContent: "space-between", height: 46 }}
                    onClick={() => setPick(key(a))}
                  >
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

          {asset && !all && (
            <div className="field">
              <label>Amount</label>
              <div className="input">
                {inUsd && <span className="unit" style={{ fontSize: 30 }}>$</span>}
                <input
                  className="amount"
                  inputMode="decimal"
                  value={amountIn}
                  onChange={e => setAmountIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                  placeholder="0"
                />
                {!inUsd && <span className="unit">{asset.symbol}</span>}
                {asset.price !== null && (
                  <button
                    className="pill"
                    onClick={() => {
                      setInUsd(!inUsd);
                      setAmountIn("");
                    }}
                  >
                    {inUsd ? asset.symbol : "USD"}
                  </button>
                )}
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="fine">
                  {inUsd ? tokenAmount && `${fmtAmount(tokenAmount)} ${asset.symbol}` : usdValue !== null && `≈ ${usd(usdValue)}`}
                </span>
                <button
                  className="pill"
                  onClick={() => {
                    setInUsd(false);
                    setAmountIn(maxOf(asset));
                  }}
                >
                  Max {fmtAmount(maxOf(asset))}
                </button>
              </div>
              {tooMuch && <span className="err">More than you have</span>}
            </div>
          )}

          {asset && !sendable && <p className="err">Sending on {chainById(chainId)?.name} isn&apos;t live yet. Base only for now.</p>}
          {feeShort && (
            <p className="err">
              The network fee is paid in USDC: keep at least {usd(Number(FEE_FLOOR) / 1e6)} of USDC on {chainById(chainId)?.name} after this send.
            </p>
          )}
          {error && <p className="err">{error}</p>}
          <button className="btn btn-green wide" disabled={!ready} onClick={() => setStage("confirm")}>
            Review
          </button>
        </>
      )}
    </div>
  );
}

const FEE_FLOOR = 50_000n; // 5¢ of USDC: the paymaster's up-front reserve, mostly refunded

const isUsdc = (a: Asset) => a.asset.toLowerCase() === chainById(a.chainId)?.usdc?.toLowerCase();

/** Max for a USDC send leaves the fee reserve behind; any other asset can go in full. */
function maxOf(a: Asset): string {
  if (!isUsdc(a)) return a.formatted;
  const left = BigInt(a.balance) - FEE_FLOOR;
  return left > 0n ? formatUnits(left, a.decimals) : "0";
}
