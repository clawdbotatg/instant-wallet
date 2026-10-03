"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address, type Hash, formatEther, formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { chainById, explorerTx, publicClient } from "@/lib/chains";
import { gasAccount } from "@/lib/gasKey";
import { amount as fmtAmount, short, usd } from "@/lib/format";
import { type Parsed, parse } from "@/lib/parse";
import type { Account, Asset } from "@/lib/types";
import { gasCost, isDeployed, sendTransfer } from "@/lib/wallet";
import { Blockie, ChainChip, Qr, ScanIcon, copy } from "./bits";
import { Scanner } from "./Scanner";
import { friendly } from "./Welcome";

type Prefill = Extract<Parsed, { kind: "pay" }>;

/**
 * Send: who (scan / paste / type 0x or ENS) → what (an asset on a chain) → how much (USD or token) →
 * Face ID → the gas key submits. Burner-wallet simple: nothing else in the way.
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
  const [gas, setGas] = useState<{ have: bigint; need: bigint } | null>(null);

  // the asset list: what we hold; a link may name something we don't hold yet
  const held = assets.filter(a => BigInt(a.balance) > 0n);
  const key = (a: { chainId: number; asset: string }) => `${a.chainId}:${a.asset.toLowerCase()}`;
  const asset = useMemo(() => held.find(a => key(a) === pick) ?? null, [held, pick]);

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

  // gas key balance vs what this send will cost on the asset's chain
  useEffect(() => {
    if (!asset) return;
    let live = true;
    (async () => {
      try {
        const deployed = await isDeployed(asset.chainId, account.address);
        const [have, need] = await Promise.all([
          publicClient(asset.chainId).getBalance({ address: gasAccount(account.address).address }),
          gasCost(asset.chainId, deployed),
        ]);
        if (live) setGas({ have, need });
      } catch {
        if (live) setGas(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [asset, account.address]);

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
  const usdValue = asset?.price && tokenAmount ? Number(tokenAmount) * asset.price : null;
  const gasShort = !!gas && gas.have < gas.need;
  const ready = !!asset && !!resolved && base !== null && base > 0n && !tooMuch && !gasShort;

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
    if (!asset || !resolved || base === null) return;
    setError(null);
    try {
      const h = await sendTransfer(asset.chainId, account, { asset: asset.asset, to: resolved, amount: base }, (s, hh) => {
        setStage(s);
        if (hh) setHash(hh);
      });
      setHash(h);
      setStage("done");
    } catch (e: any) {
      setError(friendly(e));
      setStage("confirm");
    }
  }

  if (stage === "done" && asset && resolved) {
    const url = hash && explorerTx(asset.chainId, hash);
    return (
      <div className="stack center">
        <div style={{ fontSize: 64 }}>✓</div>
        <h2>Sent</h2>
        <p>
          {fmtAmount(tokenAmount)} {asset.symbol} to {toInput.includes(".") ? toInput : short(resolved)}
        </p>
        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            View on {chainById(asset.chainId)?.name} explorer
          </a>
        )}
        <button className="btn btn-green wide" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }

  if (stage !== "form" && asset && resolved && base !== null) {
    const busy = stage === "signing" || stage === "sending" || stage === "confirming";
    return (
      <div className="stack confirm">
        <h2>Send {fmtAmount(tokenAmount)} {asset.symbol}?</h2>
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
              {fmtAmount(tokenAmount)} {asset.symbol} {usdValue !== null && <span className="fine">≈ {usd(usdValue)}</span>}
            </b>
          </div>
          <div className="line">
            <span>Network</span>
            <ChainChip chainId={asset.chainId} />
          </div>
        </div>
        {error && <p className="err">{error}</p>}
        <button className="btn btn-green wide" onClick={send} disabled={busy}>
          {stage === "signing" ? "Face ID…" : stage === "sending" ? "Sending…" : stage === "confirming" ? "Confirming…" : "Send with Face ID"}
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
                {held.map(a => (
                  <button
                    key={key(a)}
                    className={`pill ${key(a) === pick ? "on" : ""}`}
                    style={{ justifyContent: "space-between", height: 46 }}
                    onClick={() => setPick(key(a))}
                  >
                    <span className="row">
                      <b>{a.symbol}</b> <ChainChip chainId={a.chainId} />
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
                    setAmountIn(asset.formatted);
                  }}
                >
                  Max {fmtAmount(asset.formatted)}
                </button>
              </div>
              {tooMuch && <span className="err">More than you have</span>}
            </div>
          )}

          {asset && gasShort && gas && <GasNeeded account={account} chainId={asset.chainId} have={gas.have} need={gas.need} />}
          {error && <p className="err">{error}</p>}
          <button className="btn btn-green wide" disabled={!ready} onClick={() => setStage("confirm")}>
            Review
          </button>
        </>
      )}
    </div>
  );
}

/** The gas key is empty on this chain: show where to put a little ETH. */
export function GasNeeded({ account, chainId, have, need }: { account: Account; chainId: number; have: bigint; need: bigint }) {
  const gasAddr = gasAccount(account.address).address;
  const [copied, setCopied] = useState(false);
  return (
    <div className="card stack">
      <b>Your gas key needs a little ETH on {chainById(chainId)?.name}</b>
      <p className="fine">
        It pays the network fee for your sends and can't touch your money. Has {fmtAmount(formatEther(have))} ETH, needs about{" "}
        {fmtAmount(formatEther(need))} ETH. Send a little ETH on {chainById(chainId)?.name} to:
      </p>
      <Qr value={gasAddr} center={gasAddr} />
      <button
        className="pill"
        style={{ justifyContent: "center" }}
        onClick={async () => setCopied(await copy(gasAddr))}
      >
        <span className="mono">{copied ? "Copied" : gasAddr}</span>
      </button>
    </div>
  );
}

