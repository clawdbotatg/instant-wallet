"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address, type Hash, formatUnits, getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import { CHAINS, chainById, explorerTx, publicClient } from "@/lib/chains";
import { amount as fmtAmount, usd } from "@/lib/format";
import { abi } from "@/lib/safe/core";
import type { Quote } from "@/lib/safe/fee";
import { hotAvailable } from "@/lib/safe/hot";
import { type FeeToken, type Signer, type Stage, getQuote, ownerSigners, ownersSend, sendKind } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { POPULAR, type SwapRoute, type Token, swapCalls } from "@/lib/safe/swap";
import { uniswapRoute } from "@/lib/safe/uniswap";
import { Wedgie } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { ChainChip, TokenIcon } from "../bits";
import { friendly } from "../Welcome";

const SIGNER_NAME: Record<Signer, string> = { burner: "your Instant wallet", hot: "your hot wallet", wedgie: "your wedgie (press A)" };
const SLIPPAGE_BPS = 50;
const tokenOf = (a: Asset): Token => ({ chainId: a.chainId, address: a.asset, symbol: a.symbol, decimals: a.decimals, logo: a.logo, priceUsd: a.price ?? undefined });
const same = (x: { chainId: number; address: string }, y: { chainId: number; address: string }) =>
  x.chainId === y.chainId && x.address.toLowerCase() === y.address.toLowerCase();

/** A test hook: localStorage "iws.swapVia" = "uniswap" | "lifi" forces one source. */
function forcedVia(): string | null {
  try {
    return localStorage.getItem("iws.swapVia");
  } catch {
    return null;
  }
}

/**
 * Swap any asset you hold for any token, here or on another chain (docs/SWAP.md). Uniswap (on chain) and LI.FI
 * are both asked; the one that lands more wins. Signed like a big send: by the owners (Face ID alone at level 1).
 */
export function SafeSwap({
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
  const key = (a: { chainId: number; asset: string }) => `${a.chainId}:${a.asset.toLowerCase()}`;
  const [fromKey, setFromKey] = useState<string | null>(start ? key(start) : assets[0] ? key(assets[0]) : null);
  const [choosingFrom, setChoosingFrom] = useState(false);
  const [amountIn, setAmountIn] = useState("");
  const from = useMemo(() => assets.find(a => key(a) === fromKey) ?? null, [assets, fromKey]);
  const chainId = from?.chainId ?? CHAINS[0].id;
  const [toChain, setToChain] = useState(chainId);
  const [to, setTo] = useState<Token | null>(null);
  const [paste, setPaste] = useState("");
  const [routes, setRoutes] = useState<{ uni: SwapRoute | null; lifi: SwapRoute | null; lifiErr?: string } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [tick, setTick] = useState(0);
  const [fee, setFee] = useState<Quote | null>(null);
  const [stage, setStage] = useState<"form" | Stage | "done">("form");
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<string | null>(null);
  const [arrival, setArrival] = useState<{ status: string; substatus?: string } | null>(null);

  useEffect(() => {
    if (!fromKey && assets.length) setFromKey(key(assets[0]));
  }, [assets, fromKey]);
  // a new "From" chain: swap on that chain unless the user picks another
  useEffect(() => setToChain(chainId), [chainId]);

  // the "To" choices on the chosen chain: well-known tokens + what you hold there, never the "From" token itself
  const choices = useMemo(() => {
    const list: Token[] = (POPULAR[toChain] ?? []).map(t => ({ ...t, chainId: toChain }));
    for (const a of assets) if (a.chainId === toChain && !list.some(t => same(t, tokenOf(a)))) list.push(tokenOf(a));
    return list.filter(t => !from || !same(t, tokenOf(from)));
  }, [toChain, assets, from]);
  // a sensible default: USDC → ETH, anything else → USDC, same chain
  useEffect(() => {
    if (to && to.chainId === toChain && (!from || !same(to, tokenOf(from)))) return;
    const usdc = chainById(toChain)?.usdc;
    const pick = from && usdc && same(tokenOf(from), { chainId: toChain, address: usdc }) ? zeroAddress : usdc;
    setTo(choices.find(t => t.address.toLowerCase() === pick?.toLowerCase()) ?? choices[0] ?? null);
  }, [toChain, from, choices, to]);

  // a pasted token address on the "To" chain
  useEffect(() => {
    const v = paste.trim();
    if (!isAddress(v)) return;
    let live = true;
    (async () => {
      const address = getAddress(v);
      const pc = publicClient(toChain);
      const [symbol, decimals] = await Promise.all([
        pc.readContract({ address, abi: abi.erc20, functionName: "symbol" }),
        pc.readContract({ address, abi: abi.erc20, functionName: "decimals" }),
      ]).catch(() => [null, null] as const);
      if (!live) return;
      if (symbol === null || decimals === null) return setError(`That isn't a token on ${chainById(toChain)?.name}.`);
      setError(null);
      setTo({ chainId: toChain, address, symbol: String(symbol), decimals: Number(decimals) });
    })();
    return () => {
      live = false;
    };
  }, [paste, toChain]);

  let base: bigint | null = null;
  try {
    base = from && amountIn ? parseUnits(amountIn, from.decimals) : null;
  } catch {
    base = null;
  }
  const tooMuch = !!from && base !== null && base > BigInt(from.balance);
  const st = states.find(s => s.chainId === chainId);
  const signers: Signer[] = st ? ownerSigners(st) : ["burner"];
  const needsComputer = signers.includes("hot") && !hotAvailable();

  // quotes: both sources at once, again every 20 s while the form is up
  useEffect(() => {
    if (stage !== "form") return;
    const t = setInterval(() => setTick(n => n + 1), 20_000);
    return () => clearInterval(t);
  }, [stage]);
  useEffect(() => {
    if (stage !== "form") return; // signing or done: keep the route the user is signing
    setRoutes(null);
    setFee(null);
    if (!from || !to || base === null || base <= 0n || tooMuch) return;
    let live = true;
    setQuoting(true);
    const timer = setTimeout(async () => {
      const f = tokenOf(from);
      const sameChain = f.chainId === to.chainId;
      const force = forcedVia();
      const uniP =
        sameChain && force !== "lifi"
          ? uniswapRoute({ safe: account.address, from: f, to, amount: base!, slippageBps: SLIPPAGE_BPS, usdc: chainById(f.chainId)?.usdc }).catch(() => null)
          : Promise.resolve(null);
      const qs = new URLSearchParams({
        fromChain: String(f.chainId),
        toChain: String(to.chainId),
        fromToken: f.address,
        toToken: to.address,
        amount: base!.toString(),
        safe: account.address,
        slippageBps: String(SLIPPAGE_BPS),
      });
      // LI.FI gets a few seconds when Uniswap can answer too (it's the decentralized fallback); longer across chains
      const lifiP: Promise<SwapRoute | string> =
        force === "uniswap"
          ? Promise.resolve("off")
          : fetch(`/api/swap/quote?${qs}`, { signal: AbortSignal.timeout(sameChain ? 6_000 : 15_000) })
              .then(async r => {
                const j = await r.json();
                return r.ok ? (j as SwapRoute) : String(j.error || r.status);
              })
              .catch(e => (e?.name === "TimeoutError" ? "LI.FI didn't answer in time" : friendly(e)));
      const [uni, lifi] = await Promise.all([uniP, lifiP]);
      if (!live) return;
      setQuoting(false);
      setRoutes({ uni, lifi: typeof lifi === "string" ? null : lifi, lifiErr: typeof lifi === "string" ? lifi : undefined });
    }, 450);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // base as a string: a new bigint each render
  }, [fromKey, base?.toString(), to?.chainId, to?.address, tick, stage, tooMuch]);

  // the winner: whichever lands more of the same token (both pay the relay the same kind of fee)
  const route: SwapRoute | null = useMemo(() => {
    if (!routes) return null;
    const { uni, lifi } = routes;
    if (uni && lifi) return BigInt(uni.toAmount) >= BigInt(lifi.toAmount) ? uni : lifi;
    return uni ?? lifi;
  }, [routes]);
  const other = route && routes ? (route === routes.uni ? routes.lifi : routes.uni) : null;

  // the fee: in the token being swapped when it's USDC or ETH, else USDC if there's enough, else ETH
  const usdcAddr = chainById(chainId)?.usdc;
  const usdcHeld = assets.find(a => a.chainId === chainId && a.asset.toLowerCase() === usdcAddr?.toLowerCase());
  const ethHeld = assets.find(a => a.chainId === chainId && a.asset === zeroAddress);
  const fromUsdc = !!from && from.asset.toLowerCase() === usdcAddr?.toLowerCase();
  const fromEth = from?.asset === zeroAddress;
  const feeToken: FeeToken = fromEth ? "eth" : fromUsdc ? "usdc" : usdcHeld ? "usdc" : "eth";
  useEffect(() => {
    if (!route || !st) return;
    let live = true;
    (async () => {
      const k = await sendKind(account, st, "owners", signers, { swapGas: BigInt(route.gas) });
      const q = await getQuote(chainId, k, BigInt(route.gas));
      if (live) setFee(q);
    })().catch(e => live && setError(friendly(e)));
    return () => {
      live = false;
    };
  }, [route?.tx.data]);
  const feeAmt = fee ? BigInt(feeToken === "usdc" ? fee.feeUsdc : fee.feeEth) : 0n;
  const feeLabel = fee ? (feeToken === "usdc" ? `${fmtAmount(formatUnits(feeAmt, 6))} USDC` : `${fmtAmount(formatUnits(feeAmt, 18))} ETH`) : "…";
  const feeBalance = BigInt((feeToken === "usdc" ? usdcHeld?.balance : ethHeld?.balance) ?? "0");
  const spentInFeeToken = (feeToken === "usdc" && fromUsdc) || (feeToken === "eth" && fromEth) ? (base ?? 0n) : 0n;
  const feeShort = !!fee && feeBalance < spentInFeeToken + feeAmt;

  async function max() {
    if (!from || !st) return;
    let bal = BigInt(from.balance);
    if (fromUsdc || fromEth) {
      // leave room for the fee (a generous guess: the route isn't known yet)
      const q = await getQuote(chainId, await sendKind(account, st, "owners", signers, { swapGas: 600_000n }), 600_000n).catch(() => null);
      if (q) bal -= (BigInt(fromUsdc ? q.feeUsdc : q.feeEth) * 3n) / 2n;
    }
    setAmountIn(bal > 0n ? formatUnits(bal, from.decimals) : "0");
  }

  async function swap() {
    if (!route || !st || !fee) return;
    if (route.until < Date.now()) return setTick(n => n + 1); // a stale price: get a fresh one first
    setError(null);
    let wedgie: Wedgie | null = null;
    try {
      const onStage = (s: Stage, h?: Hash) => {
        setStage(s);
        if (h) setHash(h);
      };
      if (signers.includes("wedgie")) wedgie = await Wedgie.connect();
      const h = await ownersSend({
        account,
        state: st,
        calls: swapCalls(route),
        signers,
        feeToken,
        wedgie,
        quote: fee,
        swapGas: BigInt(route.gas),
        onStage,
      });
      setHash(h);
      setStage("done");
    } catch (e: any) {
      setError(friendly(e));
      setStage("form");
    } finally {
      await wedgie?.close();
    }
  }

  // across chains: follow it until it lands
  const crossChain = !!route && route.from.chainId !== route.to.chainId;
  useEffect(() => {
    if (stage !== "done" || !crossChain || !hash || !route) return;
    let live = true;
    const poll = async () => {
      const j = await fetch(`/api/swap/status?hash=${hash}&fromChain=${route.from.chainId}&toChain=${route.to.chainId}`)
        .then(r => r.json())
        .catch(() => null);
      if (!live) return;
      if (j) setArrival(j);
      if (!j || (j.status !== "DONE" && j.status !== "FAILED")) setTimeout(poll, 5000);
    };
    poll();
    return () => {
      live = false;
    };
  }, [stage, crossChain, hash]);

  const outFmt = (r: SwapRoute, v: string) => `${fmtAmount(formatUnits(BigInt(v), r.to.decimals))} ${r.to.symbol}`;
  const toName = chainById(toChain)?.name;

  if (stage === "done" && route) {
    const url = hash && explorerTx(chainId, hash);
    const landed = !crossChain || arrival?.status === "DONE";
    const failed = arrival?.status === "FAILED";
    return (
      <div className="stack center">
        <div style={{ fontSize: 64 }}>{failed ? "!" : landed ? "✓" : "⇄"}</div>
        <h2>{failed ? "The bridge failed" : landed ? "Swapped" : `On its way to ${toName}`}</h2>
        <p>
          {fmtAmount(amountIn)} {route.from.symbol} → ≈ {outFmt(route, route.toAmount)}
          {crossChain && ` on ${toName}`}
        </p>
        {crossChain && !landed && !failed && <p className="fine">Usually about {Math.max(1, Math.round(route.seconds / 60))} min. You can close this.</p>}
        {failed && <p className="fine">{arrival?.substatus === "REFUNDED" ? `Refunded to your wallet on ${chainById(chainId)?.name}.` : "Check the explorer; LI.FI usually refunds."}</p>}
        {arrival?.substatus === "PARTIAL" && <p className="fine">It arrived as a different token than planned (the bridge's fallback).</p>}
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

  const busy = stage !== "form";
  const label: Record<string, string> = {
    quote: "Getting the fee…",
    signing: "Signing…",
    "signing-hot": "Sign in your hot wallet…",
    "signing-wedgie": "Check the wedgie, press A…",
    sending: "Swapping…",
    confirming: "Confirming…",
  };
  const fromUsd = from?.price && amountIn ? Number(amountIn) * from.price : route?.fromUsd;
  const toPrice = route?.to.priceUsd ?? other?.to.priceUsd ?? to?.priceUsd;
  const toUsd = route ? (route.toUsd ?? (toPrice ? Number(formatUnits(BigInt(route.toAmount), route.to.decimals)) * toPrice : undefined)) : undefined;
  const lost = fromUsd && toUsd ? 1 - toUsd / fromUsd : null;
  const ready = !!route && !!fee && !feeShort && !needsComputer && !quoting;

  return (
    <div className="stack swap">
      <h2>Swap</h2>

      <div className="field">
        <label>From</label>
        {from ? (
          <button className="pill" style={{ justifyContent: "space-between", height: 50 }} onClick={() => setChoosingFrom(!choosingFrom)} disabled={busy}>
            <span className="row">
              <TokenIcon symbol={from.symbol} asset={from.asset} chainId={from.chainId} logo={from.logo} size={30} /> <b>{from.symbol}</b>
            </span>
            <span className="fine">
              {fmtAmount(from.formatted)} {choosingFrom ? "▴" : "▾"}
            </span>
          </button>
        ) : (
          <p className="fine">Nothing to swap yet. Receive something first.</p>
        )}
        {choosingFrom && (
          <div className="picker">
            {assets.map(a => (
              <button
                key={key(a)}
                className={`pill ${key(a) === fromKey ? "on" : ""}`}
                style={{ justifyContent: "space-between", height: 46 }}
                onClick={() => {
                  setFromKey(key(a));
                  setAmountIn("");
                  setChoosingFrom(false);
                }}
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
        )}
        {from && (
          <>
            <div className="input">
              <input
                className="amount"
                inputMode="decimal"
                value={amountIn}
                disabled={busy}
                onChange={e => setAmountIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
                placeholder="0"
              />
              <button className="pill" onClick={max} disabled={busy}>
                Max
              </button>
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="fine">{fromUsd ? `≈ ${usd(fromUsd)}` : ""}</span>
              <span className="fine">You have {fmtAmount(from.formatted)}</span>
            </div>
            {tooMuch && <span className="err">More than you have</span>}
          </>
        )}
      </div>

      <div className="field">
        <label>To</label>
        {CHAINS.length > 1 && (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {CHAINS.map(c => (
              <button key={c.id} className={`pill ${c.id === toChain ? "on" : ""}`} onClick={() => setToChain(c.id)} disabled={busy}>
                <ChainChip chainId={c.id} />
              </button>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {choices.map(t => (
            <button
              key={t.address}
              className={`pill tok ${to && same(t, to) ? "on" : ""}`}
              onClick={() => {
                setPaste("");
                setTo(t);
              }}
              disabled={busy}
            >
              <TokenIcon symbol={t.symbol} asset={t.address} chainId={t.chainId} logo={t.logo} size={22} /> {t.symbol}
            </button>
          ))}
        </div>
        <div className="input" style={{ minHeight: 46 }}>
          <input
            value={paste}
            onChange={e => setPaste(e.target.value.trim())}
            placeholder="or paste a token address"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ fontSize: 15, padding: "10px 0" }}
          />
        </div>
        {to && paste && isAddress(paste) && same(to, { chainId: toChain, address: paste }) && (
          <span className="fine">
            {to.symbol} on {toName} — check this is the token you mean
          </span>
        )}
      </div>

      {from && to && base !== null && base > 0n && !tooMuch && (
        <div className="card confirm">
          {route ? (
            <>
              <div className="line">
                <span>You get</span>
                <b className="get">
                  ≈ {outFmt(route, route.toAmount)} {toUsd ? <span className="fine">{usd(toUsd)}</span> : null}
                </b>
              </div>
              <div className="line">
                <span>At least</span>
                <span>{outFmt(route, route.toAmountMin)}</span>
              </div>
              {route.to.chainId !== route.from.chainId && (
                <div className="line">
                  <span>Arrives</span>
                  <span>
                    on {toName} in ~{route.seconds < 90 ? `${route.seconds} s` : `${Math.round(route.seconds / 60)} min`}
                  </span>
                </div>
              )}
              <div className="line">
                <span>Via</span>
                <span className="via">
                  {route.via === "uniswap" ? "Uniswap" : `LI.FI · ${route.tool}`}
                  {other && <span className="fine"> (beat {other.via === "uniswap" ? "Uniswap" : "LI.FI"})</span>}
                </span>
              </div>
              {lost !== null && (
                <div className="line">
                  <span>Price + fees</span>
                  <span className={lost > 0.02 ? "err" : ""}>{lost <= 0 ? "none" : `${(lost * 100).toFixed(2)}%`}</span>
                </div>
              )}
              <div className="line">
                <span>Network fee</span>
                <span>{feeLabel}</span>
              </div>
              <div className="line">
                <span>Signed by</span>
                <span>{signers.map(s => SIGNER_NAME[s]).join(" + ")}</span>
              </div>
              {!st?.deployed && (
                <div className="line">
                  <span>First tx here</span>
                  <span className="fine">deploys your wallet on {chainById(chainId)?.name}</span>
                </div>
              )}
            </>
          ) : (
            <p className="fine center" style={{ padding: 8 }}>
              {quoting ? "Finding the best price…" : routes ? `No route for this swap.${routes.lifiErr ? ` (${routes.lifiErr})` : ""}` : "…"}
            </p>
          )}
        </div>
      )}

      {needsComputer && <p className="err">Swaps at your level need your hot wallet too: open Instant Wallet on your computer.</p>}
      {feeShort && <p className="err">Not enough {feeToken === "usdc" ? "USDC" : "ETH"} on {chainById(chainId)?.name} for this plus the fee.</p>}
      {error && <p className="err">{error}</p>}
      <button className="btn btn-green wide go-swap" onClick={swap} disabled={busy || !ready}>
        {busy ? label[stage] ?? "…" : "Swap"}
      </button>
    </div>
  );
}
