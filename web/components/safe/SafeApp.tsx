"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState } from "react";
import { CHAINS, chainById } from "@/lib/chains";
import { amount, short, usd } from "@/lib/format";
import { type ChainState, LEVEL_NAME, type SafeAccount, loadAccount, readAll, saveAccount } from "@/lib/safe/state";
import type { Asset, Portfolio } from "@/lib/types";
import { dropOtherBudgetsCalls } from "@/lib/safe/core";
import { ownerSigners, ownersSend } from "@/lib/safe/send";
import { friendly } from "../Welcome";
import { Blockie, ChainChip, ScanIcon, Sheet, TokenIcon, copy, useToast } from "../bits";
import { Receive } from "../Receive";
import { Keys } from "./Keys";
import { RecoveryAlert } from "./RecoveryAlert";
import { SafeSend } from "./SafeSend";
import { SafeWelcome } from "./SafeWelcome";

type View = { kind: "home" } | { kind: "send"; asset?: Asset } | { kind: "receive" } | { kind: "keys" };

/** Instant Wallet on a Safe: a big balance, Send / Receive, your keys and level, and a scan button. */
export function SafeApp() {
  const [account, setAccountState] = useState<SafeAccount | null | undefined>(undefined);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [states, setStates] = useState<ChainState[]>([]);
  const [view, setView] = useState<View>({ kind: "home" });
  const [showUsd, setShowUsd] = useState(true);
  const [toast, setToast] = useToast();

  useEffect(() => setAccountState(loadAccount()), []);
  const setAccount = (a: SafeAccount | null) => {
    saveAccount(a);
    setAccountState(a);
  };

  const refresh = useCallback(async () => {
    if (!account) return;
    const [p, s] = await Promise.all([
      fetch(`/api/portfolio?address=${account.address}`, { cache: "no-store" }).then(r => r.json()).catch(() => null),
      readAll(account).catch(() => null),
    ]);
    if (p?.assets) setPortfolio(p);
    if (s) setStates(s);
  }, [account]);

  useEffect(() => {
    if (!account) return;
    refresh();
    const t = setInterval(refresh, 12_000);
    return () => clearInterval(t);
  }, [account, refresh]);

  if (account === undefined) return null;
  if (!account) return <SafeWelcome onReady={setAccount} />;

  const assets: Asset[] = (portfolio?.assets ?? []).filter(a => BigInt(a.balance) > 0n);
  const close = () => {
    setView({ kind: "home" });
    refresh();
  };
  const top = Math.max(1, ...states.map(s => s.level));
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
      if (!s.rolesMembers) throw new Error("Couldn't read the budget's keys. Try again.");
      const calls = dropOtherBudgetsCalls(account!.address, s.rolesMembers, account!.burnerSigner);
      await ownersSend({ account: account!, state: s, calls, signers: ownerSigners(s), feeToken: feeTokenOn(s.chainId) });
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
            Instant
          </div>
          <button className="pill me" onClick={() => setView({ kind: "keys" })}>
            <Blockie address={account.address} size={28} />
            <span className="mono" style={{ fontSize: 13 }}>{short(account.address)}</span>
          </button>
        </div>

        {states.map(s => s.recovery && <RecoveryAlert key={s.chainId} account={account} state={s} feeToken={feeTokenOn(s.chainId)} onDone={refresh} />)}
        {states.map(
          s =>
            s.staleBudget &&
            s.owners.some(o => o.toLowerCase() === account.burnerSigner.toLowerCase()) && (
              <div key={`b${s.chainId}`} className="card alert">
                <b>Turn off the old phone&apos;s budget</b>
                <p className="fine">
                  On {chainById(s.chainId)?.name}, a key that isn&apos;t this phone can still spend the daily Face ID budget (a lost phone, after a recovery).
                </p>
                <button className="btn btn-red wide" onClick={() => dropOldBudget(s)}>
                  Turn it off
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
                (await copy(`${window.location.origin}/safe/recover?wallet=${account.address}&owner=${account.burnerSigner}`)) && setToast("Link copied")
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
            <button className="btn btn-green" onClick={() => setView({ kind: "send" })}>
              Send
            </button>
            <button className="btn" onClick={() => setView({ kind: "receive" })}>
              Receive
            </button>
          </div>
        </div>

        <button className="card level" onClick={() => setView({ kind: "keys" })}>
          <div className="meter" aria-hidden>
            {[1, 2, 3, 4, 5].map(n => (
              <i key={n} className={n <= top ? "on" : ""} />
            ))}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>
              Level {top}: {LEVEL_NAME[top]}
            </b>
            <span className="fine">Keys &amp; safety ›</span>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {CHAINS.map(c => {
              const s = states.find(x => x.chainId === c.id);
              return (
                <span key={c.id} className="fine row" style={{ gap: 4 }}>
                  <ChainChip chainId={c.id} /> {s ? (s.deployed ? `level ${s.level}` : "not deployed yet") : "…"}
                </span>
              );
            })}
          </div>
        </button>

        <div className="card assets">
          {assets.length === 0 && (
            <p className="fine center" style={{ padding: 18 }}>
              Empty. Tap Receive and send USDC or ETH to your address on {CHAINS.map(c => c.name).join(" or ")}.
            </p>
          )}
          {assets.map(a => (
            <button key={`${a.chainId}:${a.asset}`} className="asset" onClick={() => setView({ kind: "send", asset: a })}>
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
            </button>
          ))}
        </div>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="pill" onClick={async () => (await copy(account.address)) && setToast("Address copied")}>
            Copy my address
          </button>
        </div>
      </div>

      <button className="fab" aria-label="Scan to send" onClick={() => setView({ kind: "send" })}>
        <ScanIcon />
      </button>

      {view.kind !== "home" && (
        <Sheet onClose={close}>
          {view.kind === "send" && <SafeSend account={account} assets={assets} states={states} start={view.asset} onDone={close} />}
          {view.kind === "receive" && <Receive account={{ address: account.address } as any} toast={setToast} />}
          {view.kind === "keys" && (
            <Keys
              account={account}
              states={states}
              assets={assets}
              toast={setToast}
              onAccount={a => setAccount(a)}
              onRefresh={refresh}
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
