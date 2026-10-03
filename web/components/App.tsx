"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState } from "react";
import { FACTORY } from "@/lib/chains";
import { IMPLEMENTATION } from "@/lib/address";
import { amount, short, usd } from "@/lib/format";
import { type Parsed, parse } from "@/lib/parse";
import { loadAccount, saveAccount } from "@/lib/store";
import type { Account, Asset, Portfolio } from "@/lib/types";
import { Blockie, ChainChip, ScanIcon, Sheet, copy, useToast } from "./bits";
import { Receive } from "./Receive";
import { Send } from "./Send";
import { Settings } from "./Settings";
import { Welcome } from "./Welcome";

type View = { kind: "home" } | { kind: "send"; prefill?: Extract<Parsed, { kind: "pay" }> } | { kind: "receive" } | { kind: "settings" };

/** The whole wallet: one column, a big balance, Send / Receive, and a scan button that is always there. */
export function App({ link }: { link?: string }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [showUsd, setShowUsd] = useState(true);
  const [toast, setToast] = useToast();

  useEffect(() => setAccount(loadAccount()), []);

  // a link (instantwallet.io/base:0x…;0.01, /ethereum:…, ?uri=wc:…) opens Send prefilled, then leaves the URL
  useEffect(() => {
    if (!link) return;
    const p = parse(link.startsWith("http") ? link : `https://x/${link}`);
    if (p.kind === "pay") setView({ kind: "send", prefill: p });
    if (p.kind === "wc") setToast("WalletConnect is coming next");
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

  if (!FACTORY || !IMPLEMENTATION)
    return (
      <div className="app">
        <p className="err">Not configured: set NEXT_PUBLIC_FACTORY_ADDRESS and NEXT_PUBLIC_IMPLEMENTATION_ADDRESS.</p>
      </div>
    );
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
                <div className="logo">{a.logo ? <img src={a.logo} alt="" /> : a.symbol.slice(0, 3)}</div>
                <div className="grow">
                  <div className="sym">{a.symbol}</div>
                  <ChainChip chainId={a.chainId} />
                </div>
                <div className="right">
                  <div className="sym">{showUsd ? usd(a.usd) : amount(a.formatted)}</div>
                  <div className="fine">{showUsd ? `${amount(a.formatted)} ${a.symbol}` : usd(a.usd)}</div>
                </div>
              </button>
            ))}
        </div>
        <button className="pill" style={{ justifySelf: "center" }} onClick={async () => (await copy(account.address)) && setToast("Address copied")}>
          Copy my address
        </button>
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
              onWalletConnect={() => setToast("WalletConnect is coming next")}
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
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
