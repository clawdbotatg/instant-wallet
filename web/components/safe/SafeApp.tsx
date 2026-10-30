"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { CHAINS, chainById } from "@/lib/chains";
import { amount, short, usd } from "@/lib/format";
import { type ChainState, type SafeAccount, defaultWalletName, forgetKnown, loadAccount, loadWalletName, readAll, saveAccount, saveWalletName } from "@/lib/safe/state";
import { type Asset, type Portfolio, keepLate } from "@/lib/types";
import { loadHidden, loadPortfolio, loadShown, saveHidden, savePortfolio, saveShown } from "@/lib/store";
import { dropOtherBudgetsCalls } from "@/lib/safe/core";
import { type Prepared, finishOwners, ownerSigners, prepareOwners } from "@/lib/safe/send";
import { friendly } from "../Welcome";
import { AppsIcon, Blockie, DepositIcon, GearIcon, ScanIcon, SendIcon, Sheet, sheetOpen, TokenIcon, TrashIcon, copy, useToast } from "../bits";
import { Receive } from "../Receive";
import { Deposit } from "./Deposit";
import { Keys } from "./Keys";
import { Share } from "./Share";
import { RecoveryAlert } from "./RecoveryAlert";
import { SafeSend } from "./SafeSend";
import { SendAll } from "./SendAll";
import { SafeSwap } from "./SafeSwap";
import { AppFrame, AppList } from "./Apps";
import type { AppEntry } from "@/lib/apps";
import { type Confirm, SafeWelcome, signIn } from "./SafeWelcome";
import { WedgieProgress } from "./WedgieButton";
import { PendingCards } from "./PendingCard";
import { TxPage } from "./TxPage";
import { WaitingCards } from "./Waiting";
import { Activity } from "./Activity";
import { SafeConnectLayer } from "./SafeConnect";
import { NftGrid } from "./Nfts";
import { PositionList } from "./Positions";
import { stashedCode } from "@/lib/dropClient";
import { renamePasskey } from "@/lib/passkey";
import { disconnect } from "@/lib/walletconnect";
import type { Session } from "../WalletConnect";

const WATCH = "watch"; // credentialId of a ?watch= view

type View = { kind: "home" } | { kind: "send"; asset?: Asset; scanned?: string } | { kind: "swap"; fund?: number } | { kind: "apps" } | { kind: "receive" } | { kind: "deposit" } | { kind: "keys" } | { kind: "share"; chainId: number } | { kind: "sendAll" } | { kind: "tx"; chainId: number; safe: Address; code: string };

/** Instant Wallet on a Safe: a big balance, Deposit / Apps, the connected sites above the coins, the address pill opens Receive, settings bottom left (signatures needed / signers; the wedgie lives in there), a send button on each asset, a scan button (addresses, claim cards, WalletConnect QRs). */
export function SafeApp({ link }: { link?: string } = {}) {
  const [account, setAccountState] = useState<SafeAccount | null | undefined>(undefined);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [fresh, setFresh] = useState(false); // false while portfolio is last open's, saved
  const [states, setStates] = useState<ChainState[]>([]);
  const [view, setView] = useState<View>({ kind: "home" });
  const [app, setApp] = useState<AppEntry | null>(null); // a Safe App open full screen (components/safe/Apps.tsx)
  const [showUsd, setShowUsd] = useState(true);
  const [toast, setToast] = useToast();
  const [dropReady, setDropReady] = useState<Prepared | null>(null);
  const [hidden, setHiddenState] = useState<string[]>([]);
  const [shown, setShownState] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false); // the hidden tokens, under the coin list
  const [sites, setSites] = useState<Session[]>([]); // WalletConnect sites connected to this wallet
  const [posUsd, setPosUsd] = useState<number | null>(null); // DeFi positions, added to the big total (null: loading)
  const [receipts, setReceipts] = useState<string[]>([]); // "chainId:address" of tokens a position stands for (aBasUSDC): not shown or counted as coins
  const [dropCode, setDropCode] = useState<string | null>(null); // a drop code scanned before this wallet existed
  useEffect(() => setDropCode(stashedCode()), []);

  useEffect(() => {
    // ?watch=0x…: view any wallet, read only (not advertised; for debugging). Never saved, never signs.
    // ?watch=atg.eth works too (resolved on Ethereum).
    const w = new URLSearchParams(window.location.search).get("watch");
    const watch = (a: string) => setAccountState({ credentialId: WATCH, qx: "0x", qy: "0x", burnerSigner: zeroAddress, address: getAddress(a) });
    if (w && isAddress(w)) watch(w);
    else if (w?.includes("."))
      fetch(`/api/ens?name=${encodeURIComponent(w)}`)
        .then(r => r.json())
        .then(j => (j?.address && isAddress(j.address) ? watch(j.address) : setAccountState(loadAccount())))
        .catch(() => setAccountState(loadAccount()));
    else setAccountState(loadAccount());
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
    if (a) setSwitchConfirm(null);
  };
  // the address page's Switch account goes straight to the passkey prompt
  // (a recovered one asks first, on the sign-in screen). Picking one reloads the page, so nothing of the old
  // wallet (a balance read still in flight, its sites, its name) can land on the new one.
  const [switchConfirm, setSwitchConfirm] = useState<Confirm | null>(null);
  const [switching, setSwitching] = useState(false); // covers the old wallet from the passkey prompt to the reload
  const openAccount = (a: SafeAccount) => {
    saveAccount(a);
    window.location.reload();
  };
  const anotherPasskey = async () => {
    setSwitching(true);
    try {
      const r = await signIn();
      if (!("confirm" in r)) return openAccount(r.account);
      setSwitching(false);
      setPortfolio(null);
      setStates([]);
      setPosUsd(null);
      setView({ kind: "home" });
      setSwitchConfirm(r.confirm);
      setAccount(null);
    } catch (e: any) {
      setSwitching(false);
      setToast(friendly(e));
    }
  };

  // the balance shows as soon as it lands; the keys read (slower, several calls per network) never holds it up
  const busy = useRef(false);
  const loadBalance = useCallback(async () => {
    if (!account || busy.current) return;
    busy.current = true;
    const p = await fetch(`/api/portfolio?address=${account.address}`, { cache: "no-store" }).then(r => r.json()).catch(() => null);
    busy.current = false;
    if (p?.assets) {
      setPortfolio(prev => {
        const m = keepLate(p, prev);
        savePortfolio(account.address, m);
        return m;
      });
      setFresh(true);
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
  // by the rough balance below (under ~$200 is spending money)
  const [customName, setCustomName] = useState<string | null>(null);
  useEffect(() => setCustomName(account ? loadWalletName(account.address) : null), [account]);
  const setName = (n: string | null) => {
    if (!account) return;
    saveWalletName(account.address, n);
    setCustomName(n);
  };
  // the passkey's name in the password manager tracks the wallet: "Savings account · atg.eth · ~$50". Every
  // rename can pop a system notification, so the balance is rough (1-2-5 steps) and sticky: it only moves when the
  // real one halves or doubles (so does the default name, which follows it). The last name sent is saved, so a
  // reload doesn't rename again.
  const namedKey = account ? `iws.passkeyName.${account.credentialId}` : "";
  const roughRef = useRef<number | null>(null);
  useEffect(() => {
    roughRef.current = null;
    try {
      roughRef.current = JSON.parse(localStorage.getItem(namedKey) || "null")?.rough ?? null;
    } catch {}
  }, [namedKey]);
  const isReceipt = (a: Asset) => receipts.includes(`${a.chainId}:${a.asset}`.toLowerCase());
  const receiptUsd = (portfolio?.assets ?? []).filter(isReceipt).reduce((t, a) => t + (a.usd ?? 0), 0);
  const total = portfolio ? (portfolio.totalUsd ?? 0) - receiptUsd + (posUsd ?? 0) : null;
  const rough = total === null ? null : stickyRough(total, roughRef.current);
  roughRef.current = rough ?? roughRef.current;
  const walletName = customName ?? (rough === null ? null : defaultWalletName(rough));
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
    if (!account || account.credentialId === WATCH || !fresh || posUsd === null || rough === null || !walletName || ens === undefined) return;
    let last: { name: string } | null = null;
    try {
      last = JSON.parse(localStorage.getItem(namedKey) || "null");
    } catch {}
    const name = `${walletName} · ${ens ?? short(account.address)} · ~${compactUsd(rough)}`;
    if (name === last?.name) return;
    renamePasskey(account.credentialId, name).then(ok => {
      if (!ok) return;
      try {
        localStorage.setItem(namedKey, JSON.stringify({ name, rough }));
      } catch {}
    });
  }, [account, namedKey, fresh, posUsd, rough, walletName, ens]);

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

  // a transaction that needs more signatures opens here, over the wallet (lib/safe/share.ts openTx), not as a new page
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setView({ kind: "tx", ...(e as CustomEvent).detail });
    };
    window.addEventListener("iw:tx", on);
    return () => window.removeEventListener("iw:tx", on);
  }, []);
  if (account === undefined) return null;
  if (!account) return <SafeWelcome onReady={setAccount} initialConfirm={switchConfirm} />;

  const keyOf = (a: Asset) => `${a.chainId}:${a.asset}`.toLowerCase();
  const held = (portfolio?.assets ?? []).filter(a => BigInt(a.balance) > 0n && !isReceipt(a));
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
  // the settings button's "2/3": the Safe's threshold / its owners (on the chain at the top level)
  const topState = states.find(s => s.level === top);
  const keysHave = topState?.owners.length || 1;
  const keysNeed = topState?.threshold || 1;
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
        {account.credentialId === WATCH && <div className="fine" style={{ textAlign: "center" }}>View only</div>}
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
              {portfolio ? (showUsd ? usd(total ?? 0) : `${assets.length} assets`) : <span className="loading-bar" aria-label="Loading" />}
            </div>
            {portfolio && (!fresh || pulling) && <span className="spinner" aria-label="Updating" />}
            {fresh && !pulling && assets.length > 0 && (
              <button className="send-all" aria-label="Send everything" onClick={() => setView({ kind: "sendAll" })}>
                <SendIcon size={26} />
              </button>
            )}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setView({ kind: "deposit" })}>
              <DepositIcon /> Deposit
            </button>
            <button className="btn" onClick={() => setView({ kind: "apps" })}>
              <AppsIcon /> Apps
            </button>
          </div>
        </div>

        <WaitingCards account={account} states={states} feeTokenOn={feeTokenOn} />

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
          {hiddenAssets.length > 0 && (
            <button className="hidden-link fine" onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? "Close" : `${hiddenAssets.length} token${hiddenAssets.length === 1 ? "" : "s"} hidden`}
            </button>
          )}
          {showHidden &&
            hiddenAssets.map(a => (
              <div key={`${a.chainId}:${a.asset}`} className="asset">
                <TokenIcon symbol={a.symbol} asset={a.asset} chainId={a.chainId} logo={a.logo} />
                <div className="grow">
                  <div className="sym">{a.symbol}</div>
                  <div className="fine">{chainById(a.chainId)?.name}</div>
                </div>
                <button
                  className="pill"
                  onClick={() => {
                    setHidden(hidden.filter(k => k !== keyOf(a)));
                    setShown([...shown, keyOf(a)]);
                  }}
                >
                  Show
                </button>
              </div>
            ))}
        </div>
        <PositionList address={account.address} assets={fresh ? portfolio?.assets : undefined} onTotal={setPosUsd} onReceipts={setReceipts} />
        <NftGrid address={account.address} />
        <Activity safe={account.address} chains={states.filter(s => s.deployed).map(s => s.chainId)} assets={portfolio?.assets ?? []} />
      </div>

      <button className="fab fab-settings" aria-label="Settings" onClick={() => setView({ kind: "keys" })}>
        <GearIcon />
        <span className="lvl">{keysNeed}/{keysHave}</span>
      </button>
      <button className="fab" aria-label="Scan an address or WalletConnect" onClick={() => setView({ kind: "send" })}>
        <ScanIcon />
      </button>

      {view.kind !== "home" && (
        <Sheet onClose={close}>
          {view.kind === "send" && <SafeSend account={account} assets={assets} states={states} start={view.asset} scanned={view.scanned} onDone={close} />}
          {view.kind === "tx" && <TxPage key={view.code} chainId={view.chainId} safe={view.safe} code={view.code} />}
          {view.kind === "sendAll" && <SendAll account={account} assets={assets} states={states} onDone={close} />}
          {view.kind === "apps" && <AppList onOpen={a => (a.url ? (setApp(a), close()) : setView({ kind: "swap" }))} />}
          {view.kind === "swap" && <SafeSwap account={account} assets={assets} states={states} fund={view.fund} onDone={close} />}
          {view.kind === "deposit" && <Deposit account={account} onReceive={() => setView({ kind: "receive" })} />}
          {view.kind === "receive" && (
            <Receive
              account={{ address: account.address } as any}
              toast={setToast}
              name={walletName}
              onName={setName}
              onSwitch={anotherPasskey}
              onShare={() => {
                // start on the network with the most money on it
                const top = [...assets].sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0))[0];
                setView({ kind: "share", chainId: top?.chainId ?? CHAINS[0].id });
              }}
              onSignOut={() => {
                setAccount(null);
                forgetKnown(account);
                setPortfolio(null);
                setStates([]);
                setView({ kind: "home" });
              }}
            />
          )}
          {view.kind === "share" && <Share account={account} states={states} assets={assets} chainId={view.chainId} onDone={close} />}
          {view.kind === "keys" && (
            <Keys
              account={account}
              states={states}
              assets={assets}
              toast={setToast}
              onAccount={a => setAccount(a)}
              onRefresh={refresh}
              onFund={chainId => setView({ kind: "swap", fund: chainId })}
            />
          )}
        </Sheet>
      )}
      {app && <AppFrame app={app} account={account} states={states} onClose={() => (setApp(null), refresh())} />}
      <SafeConnectLayer account={account} states={states} feeTokenOn={feeTokenOn} onSent={refresh} onSessions={setSites} />
      {toast && <div className="toast">{toast}</div>}
      {switching && (
        <div className="switching">
          <span className="spinner" aria-label="Switching" />
          <p>Switching account…</p>
        </div>
      )}
      <WedgieProgress />
    </>
  );
}

/** The last rough balance while the real one is within half to double of it (and under $1 for 0), else a new one. */
function stickyRough(total: number, last: number | null): number {
  if (last !== null && (last > 0 ? total >= last / 2 && total <= last * 2 : total < 1)) return last;
  return roughUsd(total);
}

/** The nearest 1-2-5 step: 0, 1, 2, 5, 10, 20, 50, 100… */
function roughUsd(v: number): number {
  if (v < 0.5) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map(m => m * p).reduce((a, b) => (Math.abs(Math.log(b / v)) < Math.abs(Math.log(a / v)) ? b : a));
}
const compactUsd = (v: number) => (v >= 1e6 ? `$${v / 1e6}M` : v >= 1e3 ? `$${v / 1e3}k` : `$${v}`);

