"use client";

import { useEffect, useMemo, useState } from "react";
import { type Hash, formatUnits, getAddress, parseUnits, zeroAddress } from "viem";
import { CHAINS, chainById, explorerAddress, explorerTx, publicClient } from "@/lib/chains";
import { amount as fmtAmount, short, usd } from "@/lib/format";
import { abi } from "@/lib/safe/core";
import type { Quote } from "@/lib/safe/fee";
import { type FeeToken, type Signer, type Stage, getQuote, ownerSigners, ownersSend, sendKind, signerOptions } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { POPULAR, type SwapRoute, type Token, swapCalls } from "@/lib/safe/swap";
import { uniswapRoute } from "@/lib/safe/uniswap";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { ChainChip, TokenIcon } from "../bits";
import { type Opt, Select, SignerChoice, assetOpt } from "./Pick";
import { friendly } from "../Welcome";

const SLIPPAGE_BPS = 50;
const tokenOf = (a: Asset): Token => ({ chainId: a.chainId, address: a.asset, symbol: a.symbol, decimals: a.decimals, logo: a.logo, priceUsd: a.price ?? undefined });
/** A search hit: a token plus its name and how deep its pools are (what tells the real coin from its copies). */
type Found = Token & { name: string; liquidityUsd?: number };
const compactUsd = (v: number) => "$" + v.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
const tokenOpt = (t: Token | Found): Opt => ({
  key: t.address,
  icon: <TokenIcon symbol={t.symbol} asset={t.address} chainId={t.chainId} logo={t.logo} size={28} />,
  label: t.symbol,
  right:
    "name" in t ? (
      <span className="fine">
        {t.liquidityUsd ? `${compactUsd(t.liquidityUsd)} pool · ` : ""}
        {short(t.address)}
      </span>
    ) : undefined,
  search: `${t.symbol} ${"name" in t ? t.name : ""} ${t.address}`,
});
const chainOpt = (id: number): Opt => ({ key: String(id), label: <ChainChip chainId={id} />, search: chainById(id)?.name });
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
  const [amountIn, setAmountIn] = useState("");
  const from = useMemo(() => assets.find(a => key(a) === fromKey) ?? null, [assets, fromKey]);
  const chainId = from?.chainId ?? CHAINS[0].id;
  const [toChain, setToChain] = useState(chainId);
  const [to, setTo] = useState<Token | null>(null);
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
    if (to && to.chainId === toChain && !list.some(t => same(t, to))) list.push(to); // a pasted custom token
    return list.filter(t => !from || !same(t, tokenOf(from)));
  }, [toChain, assets, from, to]);
  // typed in the "To" box: search every token on that chain (well-known ones + anything with a pool)
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    setFound([]);
    if (query.length < 2) return setSearching(false);
    setSearching(true);
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      const j = await fetch(`/api/swap/tokens?chain=${toChain}&q=${encodeURIComponent(query)}`, { signal: ctl.signal })
        .then(r => r.json())
        .catch(() => null);
      if (ctl.signal.aborted) return;
      setFound(j?.tokens ?? []);
      setSearching(false);
    }, 300);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query, toChain]);
  const toOptions = useMemo(
    () => [...choices, ...found.filter(t => !choices.some(c => same(c, t)) && (!from || !same(t, tokenOf(from))))],
    [choices, found, from],
  );
  // not a well-known token or one you hold: say so, with its address, since anyone can make a token with any name
  const unknownTo = !!to && !(POPULAR[to.chainId] ?? []).some(t => same({ ...t, chainId: to.chainId }, to)) && !assets.some(a => same(tokenOf(a), to));

  // a sensible default: USDC → ETH, anything else → USDC, same chain
  useEffect(() => {
    if (to && to.chainId === toChain && (!from || !same(to, tokenOf(from)))) return;
    const usdc = chainById(toChain)?.usdc;
    const pick = from && usdc && same(tokenOf(from), { chainId: toChain, address: usdc }) ? zeroAddress : usdc;
    setTo(choices.find(t => t.address.toLowerCase() === pick?.toLowerCase()) ?? choices[0] ?? null);
  }, [toChain, from, choices, to]);

  // a custom token: its contract address on the "To" chain
  async function customTo(v: string): Promise<string | null> {
    const address = getAddress(v);
    const pc = publicClient(toChain);
    const [symbol, decimals] = await Promise.all([
      pc.readContract({ address, abi: abi.erc20, functionName: "symbol" }),
      pc.readContract({ address, abi: abi.erc20, functionName: "decimals" }),
    ]).catch(() => [null, null] as const);
    if (symbol === null || decimals === null) return `That isn't a token on ${chainById(toChain)?.name}.`;
    setTo({ chainId: toChain, address, symbol: String(symbol), decimals: Number(decimals) });
    return null;
  }

  let base: bigint | null = null;
  try {
    base = from && amountIn ? parseUnits(amountIn, from.decimals) : null;
  } catch {
    base = null;
  }
  const tooMuch = !!from && base !== null && base > BigInt(from.balance);
  const st = states.find(s => s.chainId === chainId);
  // which keys sign: the first way this device can, unless the user picks another
  const options = st && st.threshold > 1 ? signerOptions(st, account) : [];
  const [chosen, setChosen] = useState<Signer[] | null>(null);
  const signers: Signer[] =
    chosen && options.some(o => o.ready && o.signers.join() === chosen.join()) ? chosen : st ? ownerSigners(st, account) : ["burner"];
  const needsComputer = options.length > 0 && !options.some(o => o.ready);

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
  }, [route?.tx.data, signers.join()]);
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
      if (signers.includes("wedgie") && wedgieSupported()) wedgie = await Wedgie.connect(); // a phone: it parks for the computer
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
          <Select
            value={assetOpt(from)}
            options={assets.map(assetOpt)}
            onPick={k => {
              setFromKey(k);
              setAmountIn("");
            }}
            disabled={busy}
          />
        ) : (
          <p className="fine">Nothing to swap yet. Receive something first.</p>
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
        <div className="pair">
          <Select
            value={chainOpt(toChain)}
            options={CHAINS.map(c => chainOpt(c.id))}
            onPick={k => setToChain(Number(k))}
            filter={false}
            disabled={busy}
          />
          <Select
            value={to ? { ...tokenOpt(to), right: undefined } : null}
            options={toOptions.map(tokenOpt)}
            onPick={k => setTo(toOptions.find(t => t.address === k) ?? null)}
            placeholder="Token"
            search={{ onQuery: setQuery, busy: searching, placeholder: "Search any token, or paste its address" }}
            custom={{ label: "Custom: paste a contract address", placeholder: `Token contract on ${toName}`, onCustom: customTo }}
            disabled={busy}
          />
        </div>
        {unknownTo && to && (
          <span className="fine">
            Anyone can make a token called {to.symbol}. This one is{" "}
            <a href={explorerAddress(to.chainId, to.address)} target="_blank" rel="noreferrer">
              {short(to.address)}
            </a>
            {"liquidityUsd" in to && (to as Found).liquidityUsd ? ` · ${compactUsd((to as Found).liquidityUsd!)} in its pools` : ""}.
          </span>
        )}
      </div>

      {from && (
        // always the same rows, so nothing below jumps while a price loads: blanks until there's a route
        <div className={`card confirm${route ? "" : " pending"}`}>
          <div className="line">
            <span>You get</span>
            <b className="get">
              {route ? (
                <>
                  ≈ {outFmt(route, route.toAmount)} {toUsd ? <span className="fine">{usd(toUsd)}</span> : null}
                </>
              ) : (
                "—"
              )}
            </b>
          </div>
          <div className="line">
            <span>At least</span>
            <span>{route ? outFmt(route, route.toAmountMin) : "—"}</span>
          </div>
          {!!to && tokenOf(from).chainId !== to.chainId && (
            <div className="line">
              <span>Arrives</span>
              <span>
                {route ? `on ${toName} in ~${route.seconds < 90 ? `${route.seconds} s` : `${Math.round(route.seconds / 60)} min`}` : "—"}
              </span>
            </div>
          )}
          <div className="line">
            <span>Via</span>
            <span className="via">
              {route ? (
                <>
                  {route.via === "uniswap" ? "Uniswap" : `LI.FI · ${route.tool}`}
                  {other && <span className="fine"> (beat {other.via === "uniswap" ? "Uniswap" : "LI.FI"})</span>}
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
          <div className="line">
            <span>Price + fees</span>
            {route && lost !== null ? (
              <span className={lost > 0.02 ? "err" : ""}>{lost <= 0 ? "none" : `${(lost * 100).toFixed(2)}%`}</span>
            ) : (
              <span>—</span>
            )}
          </div>
          <div className="line">
            <span>Network fee</span>
            <span>{route ? feeLabel : "—"}</span>
          </div>
          <div className="line">
            <span>Signed by</span>
            <SignerChoice options={options} value={signers} onChange={setChosen} disabled={busy} />
          </div>
          {!st?.deployed && (
            <div className="line">
              <span>First tx here</span>
              <span className="fine">deploys your wallet on {chainById(chainId)?.name}</span>
            </div>
          )}
          {!route && (
            <p className="fine center status">
              {tooMuch || !to || base === null || base <= 0n
                ? ""
                : quoting
                  ? "Finding the best price…"
                  : routes
                    ? `No route for this swap.${routes.lifiErr ? ` (${routes.lifiErr})` : ""}`
                    : "Finding the best price…"}
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
