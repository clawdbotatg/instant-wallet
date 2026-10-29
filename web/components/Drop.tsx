"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { chainById } from "@/lib/chains";
import { type DropInfo, clearStash, dropAmount, dropSig, normCode, stashCode, stashedCode } from "@/lib/dropClient";
import { usd } from "@/lib/format";
import { type SafeAccount, loadAccount, saveAccount } from "@/lib/safe/state";
import { TimedBar } from "./bits";
import { SafeWelcome } from "./safe/SafeWelcome";
import { friendly } from "./Welcome";
import { bio } from "@/lib/passkey";

let ethPrice = 0;
async function ethUsd(): Promise<number> {
  if (ethPrice) return ethPrice;
  const j = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot").then(r => r.json()).catch(() => null);
  return (ethPrice = Number(j?.data?.amount) || 0);
}

/** /d#CODE: a drop (lib/dropClient.ts). Make a wallet if this phone has none, then Face ID once and it's paid. */
export function Drop() {
  const [code, setCode] = useState<string | null | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [info, setInfo] = useState<DropInfo | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [account, setAccount] = useState<SafeAccount | null | undefined>(undefined);
  const [price, setPrice] = useState(0);
  const [busy, setBusy] = useState<"sign" | "send" | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let c = normCode(decodeURIComponent(window.location.hash.slice(1)));
    if (c.length >= 4) stashCode(c);
    else c = stashedCode() ?? "";
    // a card's code is its money: out of the address bar, a screenshot or a synced tab
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    setCode(c || null);
    setAccount(loadAccount());
    ethUsd().then(setPrice);
  }, []);

  useEffect(() => {
    if (!code) return;
    setInfo(null);
    setMissing(null);
    fetch(`/api/drop?code=${code}${account ? `&wallet=${account.address}` : ""}`)
      .then(async r => {
        const j = await r.json();
        if (!r.ok) {
          clearStash();
          setMissing(j.error || "That code didn't work.");
        } else {
          setInfo(j);
          if (j.closed) clearStash();
        }
      })
      .catch(() => setMissing("Couldn't reach Instant Wallet. Check your connection."));
  }, [code, account]);

  if (code === undefined || account === undefined) return null;

  const enter = (
    <form
      className="stack"
      onSubmit={e => {
        e.preventDefault();
        const c = normCode(typed);
        if (c.length < 4) return;
        stashCode(c);
        setCode(c);
      }}
    >
      <input className="mono center" placeholder="Your code" value={typed} onChange={e => setTyped(e.target.value)} autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
      <button className="btn btn-green wide" disabled={normCode(typed).length < 4}>Go</button>
    </form>
  );

  if (!code || missing)
    return (
      <div className="app">
        <div className="welcome">
          <h1>Have a code?</h1>
          {missing && <p className="err">{missing}</p>}
          {enter}
          <a className="btn wide" href="/">Open Instant Wallet</a>
        </div>
      </div>
    );

  const tokens = info ? Number(formatUnits(BigInt(info.amount), info.decimals)) : 0;
  const value = info ? (info.token === "usdc" || info.usd ? usd(tokens) : price ? usd(tokens * price) : dropAmount(info)) : "…";
  const net = info && chainById(info.chainId)?.name;

  async function claim() {
    if (!account || !code) return;
    setBusy("sign");
    setError(null);
    try {
      const sig = await dropSig(account, `claim ${code}`);
      setBusy("send");
      const r = await fetch("/api/drop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, wallet: account.address, sig }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 409 || r.status === 410) clearStash();
        throw new Error(j.error || `error ${r.status}`);
      }
      clearStash();
      setDone(true);
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  const header = (
    <div className="stack center">
      {account && <img className="mark" src="/mark.png" alt="" style={{ width: 96, margin: "0 auto" }} />}
      <div className="fine">{done ? "It's in your wallet" : info?.closed ? info.name : "You get"}</div>
      <div className="big" style={{ fontSize: 56, fontWeight: 700 }}>{value}</div>
      {info && !info.closed && <div className="fine">{`${dropAmount(info)} on ${net}`}</div>}
    </div>
  );

  if (done)
    return (
      <div className="app">
        <div className="welcome">
          {header}
          <a className="btn btn-green wide" href="/">Open my wallet</a>
        </div>
      </div>
    );

  if (info?.closed)
    return (
      <div className="app">
        <div className="welcome">
          {header}
          <p>{info.closed}</p>
          <a className="btn wide" href="/">Open Instant Wallet</a>
        </div>
      </div>
    );

  // no wallet on this phone yet: make one first (its address exists before it's on chain)
  if (!account)
    return (
      <>
        <div className="app" style={{ paddingBottom: 0 }}>{header}</div>
        <SafeWelcome
          onReady={a => {
            saveAccount(a);
            setAccount(a);
          }}
        />
      </>
    );

  return (
    <div className="app">
      <div className="welcome">
        {header}
        <button className="btn btn-green wide" onClick={claim} disabled={!!busy || !info}>
          {busy ? "Claiming…" : `Claim ${value}`}
        </button>
        {busy === "send" && (
          <>
            <TimedBar ms={info?.chainId === 1 ? 25_000 : 6_000} />
            <p className="fine center">Sending it to your wallet{info?.chainId === 1 ? " (Ethereum takes up to half a minute)" : ""}.</p>
          </>
        )}
        {error && <p className="err">{error}</p>}
        {!busy && <p className="fine center">{bio()} once more: it proves the wallet is yours.</p>}
      </div>
    </div>
  );
}
