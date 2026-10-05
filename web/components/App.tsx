"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState } from "react";
import { amount, short, usd } from "@/lib/format";
import { type Parsed, parse } from "@/lib/parse";
import { loadAccount, saveAccount } from "@/lib/store";
import type { Account, Asset, Portfolio } from "@/lib/types";
import { Blockie, ScanIcon, Sheet, TokenIcon, copy, useToast } from "./bits";
import { chainById } from "@/lib/chains";
import { Receive } from "./Receive";
import { Send } from "./Send";
import { Settings } from "./Settings";
import { WalletConnectLayer } from "./WalletConnect";
import { Welcome } from "./Welcome";
import { openWalletConnect } from "@/lib/walletconnect";

type View = { kind: "home" } | { kind: "send"; prefill?: Extract<Parsed, { kind: "pay" }> } | { kind: "receive" } | { kind: "settings" };

/** The whole wallet: one column, a big balance, Send / Receive, and a scan button that is always there. */
export function App({ link }: { link?: string }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [showUsd, setShowUsd] = useState(true);
  const [toast, setToast] = useToast();
  const [wcUri, setWcUri] = useState<string>();

  useEffect(() => setAccount(loadAccount()), []);

  // a link (instantwallet.io/base:0x…;0.01, /ethereum:…, ?uri=wc:…) opens Send prefilled, then leaves the URL
  useEffect(() => {
    if (!link) return;
    const p = parse(link.startsWith("http") ? link : `https://x/${link}`);
    if (p.kind === "pay") setView({ kind: "send", prefill: p });
    if (p.kind === "wc") setWcUri(p.uri);
    window.history.replaceState(null, "", "/");
  }, [link, setToast]);

  const refresh = useCallback(async () => {
    if (!account) return;
    const p = await fetch(`/api/portfolio?address=${account.address}`, { cache: "no-store" }).then(r => r.json()).catch(() => null);
    if (p?.assets) setPortfolio(p);
  }, [account]);

  useEffect(() => {
    if (!account) return;
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [account, refresh]);

  if (account === undefined) return null;
  if (!account)
    return (
      <Welcome
        onReady={a => {
          saveAccount(a);
          setAccount(a);
        }}
      />
    );

  const assets: Asset[] = portfolio?.assets ?? [];
  const close = () => {
    setView({ kind: "home" });
    refresh();
  };

  return (
    <>
      <div className="app">
        <div className="top">
          <div className="brand">
            <img src="/mark-160.png" alt="" height={30} />
            Instant
          </div>
          <button className="pill me" onClick={() => setView({ kind: "settings" })}>
            <Blockie address={account.address} size={28} />
            <span className="mono" style={{ fontSize: 13 }}>{short(account.address)}</span>
          </button>
        </div>

        <div className="card balance">
          <div className="big" onClick={() => setShowUsd(!showUsd)}>
            {portfolio ? (showUsd ? usd(portfolio.totalUsd ?? 0) : `${assets.filter(a => BigInt(a.balance) > 0n).length} assets`) : "…"}
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

        <div className="card assets">
          {assets.filter(a => BigInt(a.balance) > 0n).length === 0 && (
            <p className="fine center" style={{ padding: 18 }}>
              Empty. Tap Receive and send anything to your address on Base or Ethereum.
            </p>
          )}
          {assets
            .filter(a => BigInt(a.balance) > 0n)
            .map(a => (
              <button key={`${a.chainId}:${a.asset}`} className="asset" onClick={() => setView({ kind: "send", prefill: { kind: "pay", to: "", chainId: a.chainId, asset: a.asset } })}>
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
          <button className="pill" onClick={() => openWalletConnect()}>
            Connect to a site
          </button>
        </div>
      </div>

      <button className="fab" aria-label="Scan to send" onClick={() => setView({ kind: "send" })}>
        <ScanIcon />
      </button>

      {view.kind !== "home" && (
        <Sheet onClose={close}>
          {view.kind === "send" && (
            <Send
              account={account}
              assets={assets}
              prefill={view.prefill?.to || view.prefill?.amount ? view.prefill : view.prefill ? { ...view.prefill } : undefined}
              onDone={close}
              onWalletConnect={uri => {
                setView({ kind: "home" });
                openWalletConnect(uri);
              }}
            />
          )}
          {view.kind === "receive" && <Receive account={account} toast={setToast} />}
          {view.kind === "settings" && (
            <Settings
              account={account}
              toast={setToast}
              onSignOut={() => {
                saveAccount(null);
                setAccount(null);
                setPortfolio(null);
                setView({ kind: "home" });
              }}
            />
          )}
        </Sheet>
      )}
      <WalletConnectLayer account={account} pairUri={wcUri} />
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
