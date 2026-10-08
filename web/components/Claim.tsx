"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { type Address, type Hex, createWalletClient, formatUnits, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, publicClient, rpcPath } from "@/lib/chains";
import { AUTH_TYPES, type ClaimAuth, claimKey, usdc3009 } from "@/lib/claim";
import { usd } from "@/lib/format";
import { abi } from "@/lib/safe/core";
import { getQuote, waitFor } from "@/lib/safe/send";
import { type SafeAccount, loadAccount, saveAccount } from "@/lib/safe/state";
import { SafeWelcome } from "./safe/SafeWelcome";
import { friendly } from "./Welcome";

type OnChain = { chainId: number; usdc: bigint; eth: bigint };
const ETH_DUST = 50_000_000_000_000n; // 0.00005 ETH: less than it costs to send, left on the card (shown as empty)
const STORE = "iw.claim"; // the key survives a reload while the passkey is made, never the address bar

/** What's on a card: USDC and ETH on each network. */
async function read(addr: Address): Promise<OnChain[]> {
  return Promise.all(
    CHAINS.map(async c => {
      const pc = publicClient(c.id);
      const [usdc, eth] = await Promise.all([
        c.usdc ? (pc.readContract({ address: c.usdc, abi: abi.erc20, functionName: "balanceOf", args: [addr] }) as Promise<bigint>).catch(() => 0n) : 0n,
        pc.getBalance({ address: addr }).catch(() => 0n),
      ]);
      return { chainId: c.id, usdc, eth: eth < ETH_DUST ? 0n : eth };
    }),
  );
}

let ethPrice: number | null = null;
async function ethUsd(): Promise<number> {
  if (ethPrice) return ethPrice;
  const j = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot").then(r => r.json()).catch(() => null);
  ethPrice = Number(j?.data?.amount) || 0;
  return ethPrice;
}

/** USDC: two signed transfers (all but the fee to `to`, the fee to the relay), the relay submits them. */
async function claimUsdc(key: Hex, chainId: number, balance: bigint, to: Address): Promise<bigint> {
  const c = CHAINS.find(x => x.id === chainId)!;
  const card = privateKeyToAccount(key);
  const q = await getQuote(chainId, "claim");
  const fee = BigInt(q.feeUsdc);
  if (balance <= fee) throw new Error(`Only ${formatUnits(balance, 6)} USDC on ${c.name}: less than the network fee.`);
  const pc = publicClient(chainId);
  const [name, version] = await Promise.all([
    pc.readContract({ address: c.usdc!, abi: usdc3009, functionName: "name" }),
    pc.readContract({ address: c.usdc!, abi: usdc3009, functionName: "version" }),
  ]);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const sign = async (dest: Address, value: bigint): Promise<ClaimAuth> => {
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const msg = { from: card.address, to: dest, value, validAfter: 0n, validBefore, nonce };
    const sig = await card.signTypedData({
      domain: { name, version, chainId, verifyingContract: c.usdc! },
      types: AUTH_TYPES,
      primaryType: "TransferWithAuthorization",
      message: msg,
    });
    return {
      from: card.address,
      to: dest,
      value: value.toString(),
      validAfter: "0",
      validBefore: validBefore.toString(),
      nonce,
      r: `0x${sig.slice(2, 66)}` as Hex,
      s: `0x${sig.slice(66, 130)}` as Hex,
      v: parseInt(sig.slice(130, 132), 16),
    };
  };
  const auths = [await sign(to, balance - fee), await sign(q.relayer, fee)];
  const r = await fetch("/api/safe/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId, kind: "claim", auths }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error === "fee too low" ? "Gas went up. Try again." : j.error || `relay: ${r.status}`);
  await waitFor(chainId, j.hash);
  return balance - fee;
}

/** ETH: the card pays its own gas and sends the rest. Dust that can't pay for a transfer stays. */
async function claimEth(key: Hex, chainId: number, to: Address): Promise<bigint> {
  const c = CHAINS.find(x => x.id === chainId)!;
  const card = privateKeyToAccount(key);
  const pc = publicClient(chainId);
  const wc = createWalletClient({ account: card, chain: c.chain, transport: http(rpcPath(chainId)) });
  const [bal, fees] = await Promise.all([pc.getBalance({ address: card.address }), pc.estimateFeesPerGas()]);
  const gas = await pc.estimateGas({ account: card.address, to, value: 1n }).catch(() => 50_000n);
  const maxFee = fees.maxFeePerGas;
  const cost = gas * maxFee + (chainId === 1 ? 0n : 1_000_000_000_000n); // an L2's L1 data fee: 0.000001 ETH
  if (bal <= cost) return 0n;
  const hash = await wc.sendTransaction({ to, value: bal - cost, gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, chain: c.chain });
  await waitFor(chainId, hash);
  return bal - cost;
}

/** /pk#0x<key> (or /claim#<key>): see what's on the card, make a wallet if this phone has none, move it all in. */
export function Claim() {
  const [key, setKey] = useState<Hex | null | undefined>(undefined);
  const [account, setAccount] = useState<SafeAccount | null | undefined>(undefined);
  const [onChain, setOnChain] = useState<OnChain[] | null>(null);
  const [price, setPrice] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null); // the $ claimed
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let k = claimKey(window.location.hash);
    try {
      if (k) sessionStorage.setItem(STORE, k);
      else k = claimKey(sessionStorage.getItem(STORE) || "");
    } catch {}
    // out of the address bar and the history: a shared screenshot or a synced tab shouldn't carry the money
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    setKey(k);
    setAccount(loadAccount());
    ethUsd().then(setPrice);
  }, []);

  useEffect(() => {
    if (!key) return;
    const addr = privateKeyToAccount(key).address;
    const load = () => read(addr).then(setOnChain).catch(() => {});
    load();
    const t = setInterval(() => document.hidden || load(), 5_000);
    return () => clearInterval(t);
  }, [key]);

  if (key === undefined || account === undefined) return null;
  if (!key)
    return (
      <div className="app">
        <div className="welcome">
          <h1>Claim</h1>
          <p className="err">This claim link is broken or incomplete. Scan the card again.</p>
          <a className="btn wide" href="/">Open Instant Wallet</a>
        </div>
      </div>
    );

  const usdcTotal = (onChain ?? []).reduce((t, c) => t + c.usdc, 0n);
  const ethTotal = (onChain ?? []).reduce((t, c) => t + c.eth, 0n);
  const value = Number(formatUnits(usdcTotal, 6)) + Number(formatUnits(ethTotal, 18)) * price;
  const empty = onChain !== null && usdcTotal === 0n && ethTotal === 0n;

  async function claim() {
    if (!account || !key || !onChain) return;
    setBusy(true);
    setError(null);
    try {
      let got = 0; // what arrived, after fees
      for (const c of onChain) {
        if (c.usdc > 0n) got += Number(formatUnits(await claimUsdc(key, c.chainId, c.usdc, account.address), 6));
        if (c.eth > 0n) got += Number(formatUnits(await claimEth(key, c.chainId, account.address), 18)) * price;
      }
      try {
        sessionStorage.removeItem(STORE);
      } catch {}
      setDone(got);
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div className="stack center">
      {account && <img className="mark" src="/mark.png" alt="" style={{ width: 96, margin: "0 auto" }} />}
      <div className="fine">{done !== null ? "It's in your wallet" : empty ? "This card" : "Someone sent you"}</div>
      <div className="big" style={{ fontSize: 56, fontWeight: 900 }}>{done !== null ? usd(done) : onChain === null || (ethTotal > 0n && !price) ? "…" : usd(value)}</div>
      {done === null && !empty && onChain && (
        <div className="fine">
          {[usdcTotal > 0n && `${formatUnits(usdcTotal, 6)} USDC`, ethTotal > 0n && `${Number(formatUnits(ethTotal, 18)).toFixed(6)} ETH`].filter(Boolean).join(" + ")}
        </div>
      )}
    </div>
  );

  if (done !== null)
    return (
      <div className="app">
        <div className="welcome">
          {header}
          <a className="btn btn-green wide" href="/">Open my wallet</a>
        </div>
      </div>
    );

  if (empty)
    return (
      <div className="app">
        <div className="welcome">
          {header}
          <p>Nothing on it: it was claimed already, or it hasn&apos;t been filled yet.</p>
          <a className="btn wide" href="/">Open Instant Wallet</a>
        </div>
      </div>
    );

  // no wallet on this phone yet: make one first (the claim goes to its address, which exists before it's deployed)
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
        <button className="btn btn-green wide" onClick={claim} disabled={busy || !onChain}>
          {busy ? "Claiming…" : "Claim it"}
        </button>
        {error && <p className="err">{error}</p>}
        <p className="fine center">Goes to your Instant Wallet. A few cents of it pays the network fee.</p>
      </div>
    </div>
  );
}
