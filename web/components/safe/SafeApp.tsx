"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from "react";
import { CHAINS, chainById } from "@/lib/chains";
import { amount, short, usd } from "@/lib/format";
import { type ChainState, type SafeAccount, loadAccount, readAll, saveAccount } from "@/lib/safe/state";
import type { Address } from "viem";
import type { Asset, Portfolio } from "@/lib/types";
import { dropOtherBudgetsCalls } from "@/lib/safe/core";
import { type Prepared, finishOwners, ownerSigners, prepareOwners, signerOptions } from "@/lib/safe/send";
import { friendly } from "../Welcome";
import { Blockie, DepositIcon, GearIcon, ScanIcon, SendIcon, Sheet, SwapIcon, TokenIcon, copy, useToast } from "../bits";
import { Receive } from "../Receive";
import { Deposit } from "./Deposit";
import { Keys } from "./Keys";
import { RecoveryAlert } from "./RecoveryAlert";
import { SafeSend } from "./SafeSend";
import { SafeSwap } from "./SafeSwap";
import { SafeWelcome } from "./SafeWelcome";
import { WedgieButton } from "./WedgieButton";
import { PendingCards } from "./PendingCard";

type View = { kind: "home" } | { kind: "send"; asset?: Asset; to?: Address } | { kind: "swap" } | { kind: "receive" } | { kind: "deposit" } | { kind: "keys" };

/** Instant Wallet on a Safe: a big balance, Deposit / Swap, the address pill opens Receive, settings bottom middle (keys needed / keys you have), a send button on each asset, a scan button and the wedgie (bottom left). */
export function SafeApp() {
  const [account, setAccountState] = useState<SafeAccount | null | undefined>(undefined);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [states, setStates] = useState<ChainState[]>([]);
  const [view, setView] = useState<View>({ kind: "home" });
  const [showUsd, setShowUsd] = useState(true);
  const [toast, setToast] = useToast();
  const [dropReady, setDropReady] = useState<Prepared | null>(null);

  useEffect(() => setAccountState(loadAccount()), []);
  const setAccount = (a: SafeAccount | null) => {
    saveAccount(a);
    setAccountState(a);
  };

  // the balance shows as soon as it lands; the keys read (slower, several calls per network) never holds it up
  const busy = useRef(false);
  const loadBalance = useCallback(async () => {
    if (!account || busy.current) return;
    busy.current = true;
    const p = await fetch(`/api/portfolio?address=${account.address}`, { cache: "no-store" }).then(r => r.json()).catch(() => null);
    busy.current = false;
    if (p?.assets) setPortfolio(p);
  }, [account]);
  const loadStates = useCallback(async () => {
    if (!account) return;
    const s = await readAll(account).catch(() => null);
    if (s) setStates(s);
  }, [account]);
  const refresh = useCallback(async () => {
    await Promise.all([loadBalance(), loadStates()]);
  }, [loadBalance, loadStates]);

  useEffect(() => {
    if (!account) return;
    refresh();
    // balance every 3 s, keys every 12 s; nothing while the tab is hidden
    const b = setInterval(() => document.hidden || loadBalance(), 3_000);
    const k = setInterval(() => document.hidden || loadStates(), 12_000);
    return () => {
      clearInterval(b);
      clearInterval(k);
    };
  }, [account, refresh, loadBalance, loadStates]);

  if (account === undefined) return null;
  if (!account) return <SafeWelcome onReady={setAccount} />;

  const assets: Asset[] = (portfolio?.assets ?? []).filter(a => BigInt(a.balance) > 0n);
  const close = () => {
    setView({ kind: "home" });
    refresh();
  };
  const top = Math.max(1, ...states.map(s => s.level));
  // the settings button's "2/3": keys it takes to move everything / keys you have (on the chain at the top level)
  const topState = states.find(s => s.level === top);
  const opts = topState && topState.threshold > 1 ? signerOptions(topState, account!) : [];
  const keysHave = new Set(opts.flatMap(o => o.signers)).size || 1;
  const keysNeed = opts.length ? Math.min(...opts.map(o => o.signers.length)) : 1;
  const feeTokenOn = (chainId: number): "usdc" | "eth" => {
    const usdcAddr = chainById(chainId)?.usdc?.toLowerCase();
    // USDC only when there's plenty for a fee there (Ethereum fees are dollars); else ETH
    const need = chainId === 1 ? 10_000_000n : 1_000_000n;
    const usdcOk = assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdcAddr && BigInt(a.balance) >= need);
    const ethOk = assets.some(a => a.chainId === chainId && a.asset === "0x0000000000000000000000000000000000000000" && BigInt(a.balance) > 0n);
    return usdcOk || !ethOk ? "usdc" : "eth";
  };
  // after a recovery, the lost phone still has the burner budget: take it out of Roles (the owners sign)
  async function dropOldBudget(s: ChainState) {
    try {
      if (!dropReady) {
        if (!s.rolesMembers) throw new Error("Couldn't read the budget's keys. Try again.");
        const calls = dropOtherBudgetsCalls(account!.address, s.rolesMembers, account!.burnerSigner);
        setDropReady(await prepareOwners({ account: account!, state: s, calls, signers: ownerSigners(s, account!), feeToken: feeTokenOn(s.chainId) }));
        return; // the next tap signs (Face ID must start straight from a tap)
      }
      await finishOwners(dropReady);
      setDropReady(null);
      setToast("The old phone's budget is off");
      refresh();
    } catch (e: any) {
      setToast(friendly(e));
    }
  }

  return (
    <>
      <div className="app">
        <div className="top">
          <div className="brand">
            <img src="/mark-160.png" alt="" height={30} />
            <span>Instant Wallet</span>
          </div>
          <button className="pill me big" onClick={() => setView({ kind: "receive" })}>
            <Blockie address={account.address} size={38} />
            <span className="mono">{short(account.address)}</span>
          </button>
        </div>

        <PendingCards account={account} states={states} onDone={refresh} toast={setToast} />
        {states.map(s => s.recovery && <RecoveryAlert key={s.chainId} account={account} state={s} feeToken={feeTokenOn(s.chainId)} onDone={refresh} />)}
        {states.map(
          s =>
            s.staleBudget &&
            s.owners.some(o => o.toLowerCase() === account.burnerSigner.toLowerCase()) && (
              <div key={`b${s.chainId}`} className="card alert">
                <b>Turn off the old phone&apos;s budget</b>
                <p className="fine">
                  On {chainById(s.chainId)?.name}, a key that isn&apos;t this phone can still spend the Instant wallet's daily budget (a lost phone, after a recovery).
                </p>
                <button className="btn btn-red wide" onClick={() => dropOldBudget(s)}>
                  {dropReady ? "Sign to turn it off" : "Turn it off"}
                </button>
              </div>
            ),
        )}
        {account.recovered && !states.some(s => s.owners.some(o => o.toLowerCase() === account.burnerSigner.toLowerCase())) && (
          <div className="card stack">
            <b>Waiting for recovery</b>
            <p className="fine">
              This phone&apos;s new key isn&apos;t an owner of this wallet yet. Send your recovery address (the DAO, or whoever holds your paper seed) this link. After they start it, it takes 7 days.
            </p>
            <span className="mono" style={{ fontSize: 12 }}>new key {account.burnerSigner}</span>
            <button
              className="pill"
              onClick={async () =>
                (await copy(`${window.location.origin}/recover?wallet=${account.address}&owner=${account.burnerSigner}`)) && setToast("Link copied")
              }
            >
              Copy the recovery link
            </button>
          </div>
        )}

        <div className="card balance">
          <div className="big" onClick={() => setShowUsd(!showUsd)}>
            {portfolio ? (showUsd ? usd(portfolio.totalUsd ?? 0) : `${assets.length} assets`) : "…"}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setView({ kind: "deposit" })}>
              <DepositIcon /> Deposit
            </button>
            <button className="btn" onClick={() => setView({ kind: "swap" })}>
              <SwapIcon /> Swap
            </button>
          </div>
        </div>

        <div className="card assets">
          {assets.length === 0 && (
            <p className="fine center" style={{ padding: 18 }}>
              Empty. Tap Deposit, or tap your address and send USDC or ETH to your address on {CHAINS.map(c => c.name).join(" or ")}.
            </p>
          )}
          {assets.map(a => (
            <div key={`${a.chainId}:${a.asset}`} className="asset">
              <TokenIcon symbol={a.symbol} asset={a.asset} chainId={a.chainId} logo={a.logo} />
              <div className="grow">
                <div className="sym">{a.symbol}</div>
                <div className="fine">
                  {a.name === a.symbol ? "" : `${a.name} · `}
                  {chainById(a.chainId)?.name}
                </div>
              </div>
              <div className="right">
                <div className="sym">{showUsd ? usd(a.usd) : amount(a.formatted)}</div>
                <div className="fine">{showUsd ? `${amount(a.formatted)} ${a.symbol}` : usd(a.usd)}</div>
              </div>
              <button className="btn btn-green send-one" aria-label={`Send ${a.symbol}`} onClick={() => setView({ kind: "send", asset: a })}>
                <SendIcon />
              </button>
            </div>
          ))}
        </div>
      </div>

      <WedgieButton account={account} states={states} onKeys={() => setView({ kind: "keys" })} />
      <button className="fab fab-settings" aria-label="Settings" onClick={() => setView({ kind: "keys" })}>
        <GearIcon />
        <span className="lvl">{keysNeed}/{keysHave}</span>
      </button>
      <button className="fab" aria-label="Scan to send" onClick={() => setView({ kind: "send" })}>
        <ScanIcon />
      </button>

      {view.kind !== "home" && (
        <Sheet onClose={close}>
          {view.kind === "send" && <SafeSend account={account} assets={assets} states={states} start={view.asset} to={view.to} onDone={close} />}
          {view.kind === "swap" && <SafeSwap account={account} assets={assets} states={states} onDone={close} />}
          {view.kind === "deposit" && <Deposit address={account.address} />}
          {view.kind === "receive" && <Receive account={{ address: account.address } as any} toast={setToast} />}
          {view.kind === "keys" && (
            <Keys
              account={account}
              states={states}
              assets={assets}
              toast={setToast}
              onAccount={a => setAccount(a)}
              onRefresh={refresh}
              // Withdraw: Send, to the saved cash-out address, USDC on Base picked if there is any
              onWithdraw={to => setView({ kind: "send", to, asset: assets.find(a => a.chainId === 8453 && a.asset.toLowerCase() === chainById(8453)?.usdc?.toLowerCase()) })}
              onSignOut={() => {
                setAccount(null);
                setPortfolio(null);
                setStates([]);
                setView({ kind: "home" });
              }}
            />
          )}
        </Sheet>
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
