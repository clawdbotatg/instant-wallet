"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from "react";
import { CHAINS, chainById } from "@/lib/chains";
import { amount, short, usd } from "@/lib/format";
import { type ChainState, type SafeAccount, defaultWalletName, loadAccount, loadWalletName, readAll, saveAccount, saveWalletName } from "@/lib/safe/state";
import type { Asset, Portfolio } from "@/lib/types";
import { loadHidden, loadPortfolio, loadShown, saveHidden, savePortfolio, saveShown } from "@/lib/store";
import { dropOtherBudgetsCalls } from "@/lib/safe/core";
import { type Prepared, finishOwners, ownerSigners, prepareOwners, signerOptions } from "@/lib/safe/send";
import { friendly } from "../Welcome";
import { Blockie, ConnectIcon, DepositIcon, GearIcon, ScanIcon, SendIcon, Sheet, SwapIcon, sheetOpen, TokenIcon, TrashIcon, copy, useToast } from "../bits";
import { Receive } from "../Receive";
import { Deposit } from "./Deposit";
import { Keys } from "./Keys";
import { Share } from "./Share";
import { RecoveryAlert } from "./RecoveryAlert";
import { SafeSend } from "./SafeSend";
import { SendAll } from "./SendAll";
import { SafeSwap } from "./SafeSwap";
import { SafeWelcome } from "./SafeWelcome";
import { WedgieButton, WedgieProgress } from "./WedgieButton";
import { PendingCards } from "./PendingCard";
import { SafeConnectLayer } from "./SafeConnect";
import { NftGrid } from "./Nfts";
import { PositionList } from "./Positions";
import { stashedCode } from "@/lib/dropClient";
import { renamePasskey } from "@/lib/passkey";
import { disconnect, openWalletConnect } from "@/lib/walletconnect";
import type { Session } from "../WalletConnect";

type View = { kind: "home" } | { kind: "send"; asset?: Asset; scanned?: string } | { kind: "swap"; fund?: number } | { kind: "receive" } | { kind: "deposit" } | { kind: "keys" } | { kind: "share"; chainId: number } | { kind: "sendAll" };

/** Instant Wallet on a Safe: a big balance, Connect / Deposit / Swap, the connected sites above the coins, the address pill opens Receive, settings bottom middle (keys needed / keys you have), a send button on each asset, a scan button (addresses, claim cards, WalletConnect QRs) and the wedgie (bottom left). */
export function SafeApp({ link }: { link?: string } = {}) {
  const [account, setAccountState] = useState<SafeAccount | null | undefined>(undefined);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [fresh, setFresh] = useState(false); // false while portfolio is last open's, saved
  const [states, setStates] = useState<ChainState[]>([]);
  const [view, setView] = useState<View>({ kind: "home" });
  const [showUsd, setShowUsd] = useState(true);
  const [toast, setToast] = useToast();
  const [dropReady, setDropReady] = useState<Prepared | null>(null);
  const [hidden, setHiddenState] = useState<string[]>([]);
  const [shown, setShownState] = useState<string[]>([]);
  const [sites, setSites] = useState<Session[]>([]); // WalletConnect sites connected to this wallet
  const [posUsd, setPosUsd] = useState<number | null>(null); // DeFi positions, added to the big total (null: loading)
  const [dropCode, setDropCode] = useState<string | null>(null); // a drop code scanned before this wallet existed
  useEffect(() => setDropCode(stashedCode()), []);

  useEffect(() => {
    setAccountState(loadAccount());
    setHiddenState(loadHidden());
    setShownState(loadShown());
  }, []);
  const setHidden = (h: string[]) => {
    saveHidden(h);
    setHiddenState(h);
  };
  const setShown = (h: string[]) => {
    saveShown(h);
    setShownState(h);
  };
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
    if (p?.assets) {
      setPortfolio(p);
      setFresh(true);
      savePortfolio(account.address, p);
    }
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
    // last open's balance at once, the fresh one replaces it when it lands
    setPortfolio(loadPortfolio(account.address));
    setFresh(false);
    refresh();
    // balance every 3 s, keys every 12 s; nothing while the tab is hidden
    const b = setInterval(() => document.hidden || loadBalance(), 3_000);
    const k = setInterval(() => document.hidden || loadStates(), 12_000);
    return () => {
      clearInterval(b);
      clearInterval(k);
    };
  }, [account, refresh, loadBalance, loadStates]);

  // the wallet's name: the user's own once they set one (we never rename it then), else Spending / Savings account
  // by balance (under $200 is spending money)
  const [customName, setCustomName] = useState<string | null>(null);
  useEffect(() => setCustomName(account ? loadWalletName(account.address) : null), [account]);
  const setName = (n: string | null) => {
    if (!account) return;
    saveWalletName(account.address, n);
    setCustomName(n);
  };
  const walletName = customName ?? (portfolio ? defaultWalletName((portfolio.totalUsd ?? 0) + (posUsd ?? 0)) : null);
  // the passkey's name in the password manager tracks the wallet: "Savings account · atg.eth · ~$50". Every
  // rename can pop a system notification, so the balance is rough (1-2-5 steps) and only
  // moves when the real one halves or doubles; the last name sent is saved, so a reload doesn't rename again.
  const [ens, setEns] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!account) return;
    setEns(undefined);
    fetch(`/api/ens?address=${account.address}`)
      .then(r => r.json())
      .then(j => setEns(j?.name ?? null))
      .catch(() => setEns(null));
  }, [account]);
  useEffect(() => {
    if (!account || !fresh || !portfolio || posUsd === null || !walletName || ens === undefined) return;
    const key = `iws.passkeyName.${account.credentialId}`;
    let last: { name: string; rough: number } | null = null;
    try {
      last = JSON.parse(localStorage.getItem(key) || "null");
    } catch {}
    const total = (portfolio.totalUsd ?? 0) + posUsd;
    const rough = last && total >= last.rough / 2 && total <= last.rough * 2 && (last.rough > 0 || total < 1) ? last.rough : roughUsd(total);
    const name = `${walletName} · ${ens ?? short(account.address)} · ~${compactUsd(rough)}`;
    if (name === last?.name) return;
    renamePasskey(account.credentialId, name).then(ok => {
      if (!ok) return;
      try {
        localStorage.setItem(key, JSON.stringify({ name, rough }));
      } catch {}
    });
  }, [account, fresh, portfolio, posUsd, walletName, ens]);

  // the iOS app's pull-down: a newer deploy reloads the whole page; otherwise reload the balance now, with the
  // spinner beside it for at least a beat
  const [pulling, setPulling] = useState(false);
  const pullBusy = useRef(false);
  useEffect(() => {
    const pull = async () => {
      if (pullBusy.current || sheetOpen()) return; // a pull while one is loading, or under a sheet, does nothing
      pullBusy.current = true;
      setPulling(true);
      const live = await fetch("/api/version", { cache: "no-store" })
        .then(r => r.json())
        .catch(() => null);
      if (live?.build && live.build !== process.env.NEXT_PUBLIC_BUILD) return window.location.reload();
      await Promise.all([refresh(), new Promise(r => setTimeout(r, 800))]);
      pullBusy.current = false;
      setPulling(false);
    };
    window.addEventListener("instantwallet:refresh", pull);
    return () => window.removeEventListener("instantwallet:refresh", pull);
  }, [refresh]);

  // a payment request link (/[...link]): Send opens on it once the balance is known, so it can pick the token
  const [pendingLink, setPendingLink] = useState(link);
  useEffect(() => {
    if (!pendingLink || !account || !portfolio) return;
    setView({ kind: "send", scanned: pendingLink });
    setPendingLink(undefined);
  }, [pendingLink, account, portfolio]);

  // the iOS app holds its logo until the balance is on screen (or there's no wallet yet); in a browser this does nothing
  useEffect(() => {
    if (account === null || portfolio) (window as any).webkit?.messageHandlers?.ready?.postMessage(true);
  }, [account, portfolio]);

  if (account === undefined) return null;
  if (!account) return <SafeWelcome onReady={setAccount} />;

  const keyOf = (a: Asset) => `${a.chainId}:${a.asset}`.toLowerCase();
  const held = (portfolio?.assets ?? []).filter(a => BigInt(a.balance) > 0n);
  const isCore = (a: Asset) => a.asset === "0x0000000000000000000000000000000000000000" || a.asset.toLowerCase() === chainById(a.chainId)?.usdc?.toLowerCase();
  // under 2¢ (or no price) and not the coin or USDC: almost always airdropped spam, so the send button becomes a trash can that hides it
  const isDust = (a: Asset) => (a.usd ?? 0) < 0.02 && !isCore(a);
  // priced and under a penny: spam dust, hidden on its own unless the user tapped Show for it in settings. No price (no liquidity, e.g. your own new token) stays visible
  const isHidden = (a: Asset) => hidden.includes(keyOf(a)) || (a.usd != null && a.usd < 0.01 && !isCore(a) && !shown.includes(keyOf(a)));
  const assets: Asset[] = held.filter(a => !isHidden(a));
  const hiddenAssets = held.filter(isHidden);
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
            <span className="me-text">
              {customName && <span className="me-name own">{customName}</span>}
              <span className="mono">{short(account.address)}</span>
              {!customName && walletName && <span className="me-name">{walletName}</span>}
            </span>
          </button>
        </div>

        <PendingCards account={account} states={states} onDone={refresh} toast={setToast} />
        {dropCode && (
          <div className="card stack">
            <b>You have money to claim</b>
            <p className="fine">The code {dropCode} is waiting for this wallet.</p>
            <a className="btn btn-green wide" href="/d">Claim it</a>
          </div>
        )}
        {states.flatMap(s => s.recoveries.filter(r => r.request).map(r => <RecoveryAlert key={`${s.chainId}:${r.module}`} account={account} state={s} rec={r} feeToken={feeTokenOn(s.chainId)} onDone={refresh} />))}
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
              This phone&apos;s new key isn&apos;t an owner of this wallet yet. Send your recovery address (the DAO, or your own recovery wallet) this link. After they start it, it takes 7 days (with a wedgie: 14 from your own recovery address, 60 from the DAO).
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
          <div className="total">
            <div className={fresh ? "big" : "big stale"} onClick={() => setShowUsd(!showUsd)}>
              {portfolio ? (showUsd ? usd((portfolio.totalUsd ?? 0) + (posUsd ?? 0)) : `${assets.length} assets`) : <span className="loading-bar" aria-label="Loading" />}
            </div>
            {portfolio && (!fresh || pulling) && <span className="spinner" aria-label="Updating" />}
            {fresh && !pulling && assets.length > 0 && (
              <button className="send-all" aria-label="Send everything" onClick={() => setView({ kind: "sendAll" })}>
                <SendIcon size={26} />
              </button>
            )}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => openWalletConnect()}>
              <ConnectIcon /> Connect
            </button>
            <button className="btn" onClick={() => setView({ kind: "deposit" })}>
              <DepositIcon /> Deposit
            </button>
            <button className="btn" onClick={() => setView({ kind: "swap" })}>
              <SwapIcon /> Swap
            </button>
          </div>
        </div>

        {sites.length > 0 && (
          <div className="card assets sites">
            <b className="sites-head">Connected</b>
            {sites.map(x => (
              <div key={x.topic} className="asset">
                <div className="logo">{x.icon ? <img src={x.icon} alt="" /> : (x.name || "?").slice(0, 1)}</div>
                <a className="grow" href={x.url} target="_blank" rel="noopener noreferrer">
                  <div className="sym">{x.name || "A site"}</div>
                  <div className="fine">{x.url.replace(/^https?:\/\//, "")}</div>
                </a>
                <button className="pill" onClick={() => disconnect(x.topic).catch(() => {})}>
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={portfolio && !fresh ? "card assets stale" : "card assets"}>
          {!portfolio && <div className="loading-bar row" />}
          {portfolio && assets.length === 0 && (
            <p className="fine center" style={{ padding: 18 }}>
              Empty. Tap Deposit, or tap your address and send crypto to your address on {CHAINS.length > 2 ? `Base, Ethereum, or ${CHAINS.length - 2} other networks` : CHAINS.map(c => c.name).join(" or ")}.
            </p>
          )}
          {portfolio && assets.length === 0 && !dropCode && (
            <a className="fine center" href="/d" style={{ display: "block", paddingBottom: 14 }}>
              Have a code?
            </a>
          )}
          {assets.map(a => {
            const Row = isDust(a) ? "div" : "button";
            return (
            <Row key={`${a.chainId}:${a.asset}`} className="asset" {...(isDust(a) ? {} : { "aria-label": `Send ${a.symbol}`, onClick: () => setView({ kind: "send", asset: a }) })}>
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
              {isDust(a) && (
                <button className="btn btn-red send-one" aria-label={`Hide ${a.symbol}`} onClick={() => {
                    setHidden([...hidden, keyOf(a)]);
                    setShown(shown.filter(k => k !== keyOf(a)));
                  }}>
                  <TrashIcon />
                </button>
              )}
            </Row>
            );
          })}
        </div>
        <PositionList address={account.address} onTotal={setPosUsd} />
        <NftGrid address={account.address} />
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
          {view.kind === "send" && <SafeSend account={account} assets={assets} states={states} start={view.asset} scanned={view.scanned} onDone={close} />}
          {view.kind === "sendAll" && <SendAll account={account} assets={assets} states={states} onDone={close} />}
          {view.kind === "swap" && <SafeSwap account={account} assets={assets} states={states} fund={view.fund} onDone={close} />}
          {view.kind === "deposit" && <Deposit account={account} onReceive={() => setView({ kind: "receive" })} />}
          {view.kind === "receive" && <Receive account={{ address: account.address } as any} toast={setToast} name={walletName} onName={setName} />}
          {view.kind === "share" && <Share account={account} states={states} assets={assets} chainId={view.chainId} onDone={close} />}
          {view.kind === "keys" && (
            <Keys
              account={account}
              states={states}
              assets={assets}
              toast={setToast}
              onAccount={a => setAccount(a)}
              onRefresh={refresh}
              hiddenAssets={hiddenAssets}
              onUnhide={a => {
                setHidden(hidden.filter(k => k !== keyOf(a)));
                setShown([...shown, keyOf(a)]);
              }}
              onFund={chainId => setView({ kind: "swap", fund: chainId })}
              onShare={chainId => setView({ kind: "share", chainId })}
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
      <SafeConnectLayer account={account} states={states} feeTokenOn={feeTokenOn} onSent={refresh} onSessions={setSites} />
      {toast && <div className="toast">{toast}</div>}
      <WedgieProgress />
    </>
  );
}

/** The nearest 1-2-5 step: 0, 1, 2, 5, 10, 20, 50, 100… */
function roughUsd(v: number): number {
  if (v < 0.5) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map(m => m * p).reduce((a, b) => (Math.abs(Math.log(b / v)) < Math.abs(Math.log(a / v)) ? b : a));
}
const compactUsd = (v: number) => (v >= 1e6 ? `$${v / 1e6}M` : v >= 1e3 ? `$${v / 1e3}k` : `$${v}`);
