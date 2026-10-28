"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { type Address, type Hash, type Hex, createWalletClient, formatUnits, http, parseAbi, toHex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isXdai, retireBurnerKey } from "@/lib/brand";
import { type OldSafe, findOldSafes, sweepOldSafe } from "@/lib/oldSafes";
import { CHAINS, nativeSymbol, publicClient, rpcPath } from "@/lib/chains";
import { AUTH_TYPES, type ClaimAuth, claimKey, usdc3009 } from "@/lib/claim";
import { amount as fmtAmount, usd } from "@/lib/format";
import { abi } from "@/lib/safe/core";
import { getQuote, waitFor } from "@/lib/safe/send";
import { createPasskey } from "@/lib/passkey";
import { type SafeAccount, accountFor, loadAccount, saveAccount } from "@/lib/safe/state";
import type { Asset, Nft } from "@/lib/types";
import { TimedBar, copy } from "./bits";
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

/** Any other token (Share puts a little ETH on the card for this): the card sends it, paying its own gas. */
async function claimToken(key: Hex, t: Asset, to: Address): Promise<void> {
  const c = CHAINS.find(x => x.id === t.chainId)!;
  const card = privateKeyToAccount(key);
  const pc = publicClient(t.chainId);
  const wc = createWalletClient({ account: card, chain: c.chain, transport: http(rpcPath(t.chainId)) });
  const bal = (await pc.readContract({ address: t.asset, abi: abi.erc20, functionName: "balanceOf", args: [card.address] })) as bigint;
  if (bal === 0n) return;
  const hash = await wc.writeContract({ address: t.asset, abi: abi.erc20, functionName: "transfer", args: [to, bal], chain: c.chain }).catch((e: any) => {
    throw new Error(/insufficient funds/i.test(String(e?.message)) ? `No ${c.native.symbol} on the card to move the ${t.symbol}.` : e?.shortMessage || e?.message);
  });
  await waitFor(t.chainId, hash);
}

/** NFTs on an old key (xdai.io): the key sends each one, paying its own gas. All sent first, then all waited for. */
async function claimNfts(key: Hex, nfts: Nft[], to: Address): Promise<number> {
  let moved = 0;
  for (const chainId of [...new Set(nfts.map(n => n.chainId))]) {
    const c = CHAINS.find(x => x.id === chainId)!;
    const card = privateKeyToAccount(key);
    const pc = publicClient(chainId);
    const wc = createWalletClient({ account: card, chain: c.chain, transport: http(rpcPath(chainId)) });
    let nonce = await pc.getTransactionCount({ address: card.address, blockTag: "pending" });
    const sent: Hash[] = [];
    for (const n of nfts.filter(x => x.chainId === chainId)) {
      const call =
        n.type === "ERC1155"
          ? { address: n.contract, abi: nftAbi, functionName: "safeTransferFrom" as const, args: [card.address, to, BigInt(n.tokenId), BigInt(n.balance || "1"), "0x"] as const }
          : { address: n.contract, abi: nftAbi, functionName: "transferFrom" as const, args: [card.address, to, BigInt(n.tokenId)] as const };
      const h = await wc.writeContract({ ...(call as any), chain: c.chain, nonce }).catch(() => null); // one that won't move doesn't stop the rest
      if (h) {
        sent.push(h);
        nonce++;
      }
    }
    for (const h of sent) if ((await pc.waitForTransactionReceipt({ hash: h }).catch(() => null))?.status === "success") moved++;
  }
  return moved;
}

const nftAbi = parseAbi([
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
]);

async function oldNfts(addr: Address): Promise<Nft[]> {
  const j = await fetch(`/api/nfts?address=${addr}&all=1`, { cache: "no-store" }).then(r => r.json()).catch(() => null);
  return (j?.nfts ?? []) as Nft[];
}

/** Every token on the card other than USDC and the native coin (those two are read straight from the chain), and
 *  each network's native coin price (ETH, xDAI, POL…). Null if the portfolio didn't load. */
async function others(addr: Address): Promise<{ tokens: Asset[]; nativeUsd: Record<number, number> } | null> {
  const p = await fetch(`/api/portfolio?address=${addr}`, { cache: "no-store" }).then(r => r.json()).catch(() => null);
  if (!p?.assets) return null;
  const nativeUsd: Record<number, number> = {};
  for (const a of p.assets as Asset[]) if (a.asset === zeroAddress && a.price) nativeUsd[a.chainId] = a.price;
  const tokens = (p.assets as Asset[]).filter(a => {
    const usdc = CHAINS.find(c => c.id === a.chainId)?.usdc?.toLowerCase();
    return a.asset !== zeroAddress && a.asset.toLowerCase() !== usdc && BigInt(a.balance) > 0n;
  });
  return { tokens, nativeUsd };
}

/** An old Burner Wallet's address holds years of spam airdrops: only tokens worth a cent are moved. */
const worthMoving = (t: Asset) => (t.usd ?? 0) >= 0.01;

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

/**
 * /pk#0x<key> (or /claim#<key>): see what's on the card, make a wallet if this phone has none, move it all in.
 * `burner`: the same move for an old Burner Wallet key found in this domain's storage (xdai.io, lib/brand.ts).
 */
export function Claim({ burner }: { burner?: { key: Hex; onDone: () => void } } = {}) {
  const [key, setKey] = useState<Hex | null | undefined>(undefined);
  const [acct, setAccount] = useState<SafeAccount | null | undefined>(undefined);
  const account = acct;
  const [onChain, setOnChain] = useState<OnChain[] | null>(null);
  const [tokens, setTokens] = useState<Asset[]>([]);
  const [nfts, setNfts] = useState<Nft[]>([]);
  const [safes, setSafes] = useState<OldSafe[]>([]); // xdai.io: the old Burner's optional Safes this key owns (lib/oldSafes.ts) // xdai.io: the old key's NFTs (Burner badges and the like)
  const [nativeUsd, setNativeUsd] = useState<Record<number, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [sweeping, setSweeping] = useState(false); // past Face ID, the coins are moving: the progress bar runs
  const [done, setDone] = useState<number | null>(null); // the $ claimed
  const [error, setError] = useState<string | null>(null);
  const [xdai, setXdai] = useState(false); // xdai.io: an old Burner key or card becomes an Instant Wallet

  useEffect(() => {
    setXdai(isXdai());
    if (burner) {
      setKey(burner.key);
      setAccount(loadAccount());
      return;
    }
    let k = claimKey(window.location.hash, true);
    try {
      if (k) sessionStorage.setItem(STORE, k);
      else k = claimKey(sessionStorage.getItem(STORE) || "");
    } catch {}
    // out of the address bar and the history: a shared screenshot or a synced tab shouldn't carry the money
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    setKey(k);
    setAccount(loadAccount());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!key) return;
    const addr = privateKeyToAccount(key).address;
    const load = () => {
      read(addr).then(setOnChain).catch(() => {});
      if (burner || isXdai()) {
        oldNfts(addr).then(setNfts);
        findOldSafes(addr).then(setSafes).catch(() => {});
      }
      others(addr).then(o => {
        if (!o) return;
        setTokens(burner || isXdai() ? o.tokens.filter(worthMoving) : o.tokens);
        setNativeUsd(o.nativeUsd);
      });
    };
    load();
    const t = setInterval(() => document.hidden || load(), 5_000);
    return () => clearInterval(t);
  }, [key]);

  // an old Burner key with nothing on it (once the token list is in too): straight on to the wallet
  const burnerEmpty =
    !!burner && onChain !== null && nativeUsd !== null && tokens.length === 0 && nfts.length === 0 && safes.length === 0 && onChain.every(c => c.usdc === 0n && c.eth === 0n);
  useEffect(() => {
    if (burnerEmpty && done === null && !busy) burner!.onDone();
  }, [burnerEmpty, busy]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const natives = (onChain ?? []).filter(c => c.eth > 0n); // ETH, xDAI, POL… one line each
  const nativeValue = (chainId: number, wei: bigint) => Number(formatUnits(wei, 18)) * (nativeUsd?.[chainId] ?? 0);
  // xdai.io: a token on a network where the old key has no coin for gas can't move yet (rare: Burner keys kept xDAI)
  const stuck = (burner || xdai) && onChain ? tokens.filter(t => !onChain.find(c => c.chainId === t.chainId)?.eth) : [];
  const movable = tokens.filter(t => !stuck.includes(t));
  const nftsStuck = onChain ? nfts.filter(n => !onChain.find(c => c.chainId === n.chainId)?.eth) : [];
  const nftsMovable = nfts.filter(n => !nftsStuck.includes(n));
  const safesStuck = onChain && !onChain.find(c => c.chainId === 100)?.eth ? safes : []; // the old key pays the Safe's gas in xDAI
  const safesMovable = safes.filter(x => !safesStuck.includes(x));
  const value = Number(formatUnits(usdcTotal, 6)) + natives.reduce((t, c) => t + nativeValue(c.chainId, c.eth), 0) + movable.reduce((t, a) => t + (a.usd ?? 0), 0);
  const empty = onChain !== null && usdcTotal === 0n && ethTotal === 0n && tokens.length === 0 && nfts.length === 0 && safes.length === 0;

  /** `make`: xdai.io's one button: no wallet on this phone yet, so the passkey is made first, then the sweep runs. */
  async function claim(make = false) {
    if (!key || !onChain) return;
    setBusy(true);
    setError(null);
    try {
      let account = acct;
      if (!account && make) {
        const pk = await createPasskey("Instant Wallet");
        account = accountFor(pk.credentialId, pk.qx, pk.qy);
        saveAccount(account);
        setAccount(account);
      }
      if (!account) return;
      setSweeping(true);
      let got = 0; // what arrived, after fees
      for (const t of movable) {
        // first: the card's ETH pays for these, the rest is swept after. An old Burner key moves what it can.
        if (burner || xdai) {
          if (await claimToken(key, t, account.address).then(() => true, () => false)) got += t.usd ?? 0;
          continue;
        }
        await claimToken(key, t, account.address);
        got += t.usd ?? 0;
      }
      if (nftsMovable.length) await claimNfts(key, nftsMovable, account.address); // before the coin: it pays their gas
      for (const x of safesMovable) got += nativeValue(100, await sweepOldSafe(key, x.address, account.address));
      const fresh = movable.length || nftsMovable.length || safesMovable.length ? await read(privateKeyToAccount(key).address) : onChain; // what gas left of the ETH
      for (const c of fresh) {
        if (c.usdc > 0n) got += Number(formatUnits(await claimUsdc(key, c.chainId, c.usdc, account.address), 6));
        if (c.eth > 0n) got += nativeValue(c.chainId, await claimEth(key, c.chainId, account.address));
      }
      if (burner && !stuck.length && !nftsStuck.length && !safesStuck.length) retireBurnerKey(key); // still holding stuck tokens: the move screen comes back
      else
        try {
          sessionStorage.removeItem(STORE);
        } catch {}
      setDone(got);
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(false);
      setSweeping(false);
    }
  }

  const upgrade = (burner || xdai) && done === null && (!empty || busy); // mid-sweep the balance drains: stay put
  // what's on it, coin by coin; one dollar coin alone (5.00 xDAI under $5.00) says nothing new, so it's left off
  const parts = [
    usdcTotal > 0n && `${formatUnits(usdcTotal, 6)} USDC`,
    ...movable.map(t => `${fmtAmount(t.formatted)} ${t.symbol}`),
    ...natives.map(c => `${Number(formatUnits(c.eth, 18)).toFixed(c.chainId === 100 ? 2 : 6)} ${nativeSymbol(c.chainId)}`),
  ].filter(Boolean) as string[];
  const chainName = (id: number) => CHAINS.find(c => c.id === id)?.name ?? "";
  const rows = [
    ...(onChain ?? []).flatMap(c => [
      ...(c.eth > 0n ? [{ k: `n${c.chainId}`, amount: `${Number(formatUnits(c.eth, 18)).toFixed(c.chainId === 100 ? 2 : 6)} ${nativeSymbol(c.chainId)}`, chain: chainName(c.chainId) }] : []),
      ...(c.usdc > 0n ? [{ k: `u${c.chainId}`, amount: `${formatUnits(c.usdc, 6)} USDC`, chain: chainName(c.chainId) }] : []),
    ]),
    ...movable.map(t => ({ k: `${t.chainId}:${t.asset}`, amount: `${fmtAmount(t.formatted)} ${t.symbol}`, chain: chainName(t.chainId) })),
    ...safesMovable.map(x => ({ k: `safe${x.address}`, amount: `${Number(formatUnits(x.wei, 18)).toFixed(2)} xDAI`, chain: "old Safe" })),
    ...[...new Set(nftsMovable.map(n => n.chainId))].map(id => {
      const k = nftsMovable.filter(n => n.chainId === id).length;
      return { k: `nft${id}`, amount: `${k} NFT${k === 1 ? "" : "s"}`, chain: chainName(id) };
    }),
  ];
  const onlyDollars = movable.length === 0 && natives.every(c => c.chainId === 100) && (usdcTotal === 0n || natives.length === 0);
  const header = (
    <div className="stack center">
      {upgrade ? (
        <div className="stack center" style={{ gap: 10, marginBottom: 8 }}>
          <img src="/brand/xdai/burner.png" alt="Burner Wallet" style={{ height: 72, margin: "0 auto" }} />
          <h2 style={{ fontSize: 26, lineHeight: 1.25, display: "grid", gap: 18 }}>
            <span>Burner Wallet</span>
            <span style={{ fontWeight: 500, color: "var(--muted)" }}>has become</span>
            <span>Instant Wallet</span>
          </h2>
          <img src="/brand/xdai/logo.png" alt="Instant Wallet" style={{ width: 130, margin: "0 auto" }} />
        </div>
      ) : (
        account && <img className="mark" src="/mark.png" alt="" style={{ width: 96, margin: "0 auto" }} />
      )}
      {/* an old xdai.io card is the person's own old wallet, not a gift: no "Someone sent you" */}
      {upgrade ? (
        // xdai.io: what gets swept, coin by coin, instead of one dollar total
        <div className="recess stack" style={{ gap: 6, textAlign: "left" }}>
          {onChain === null ? (
            <span className="loading-bar" style={{ width: "100%" }} />
          ) : (
            rows.map(r => (
              <div key={r.k} className="row" style={{ justifyContent: "space-between" }}>
                <b>{r.amount}</b>
                <span className="fine">{r.chain}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="fine">{done !== null ? "It's in your wallet" : empty ? "This card" : burner ? "Your old Burner Wallet has" : "Someone sent you"}</div>
          <div className="big" style={{ fontSize: 56, fontWeight: 700 }}>{done !== null ? usd(done) : onChain === null || (ethTotal > 0n && !nativeUsd) ? "…" : usd(value)}</div>
          {done === null && !empty && onChain && (parts.length > 1 || !onlyDollars) && <div className="fine">{parts.join(" + ")}</div>}
        </>
      )}
      {done === null && stuck.length + nftsStuck.length + safesStuck.length > 0 && key && (
        <Stuck stuck={stuck} nfts={nftsStuck} safes={safesStuck} address={privateKeyToAccount(key).address} />
      )}
    </div>
  );

  if (done !== null)
    return (
      <div className="app">
        <div className="welcome">
          {header}
          {burner ? (
            <button className="btn btn-green wide" onClick={burner.onDone}>Open my wallet</button>
          ) : (
            <a className="btn btn-green wide" href="/">Open my wallet</a>
          )}
        </div>
      </div>
    );

  if (empty && burner && !busy) return null; // on its way to the wallet (above), or the token list is still loading
  if (empty && !busy)
    return (
      <div className="app">
        <div className="welcome">
          {header}
          <p>Nothing on it: it was claimed already, or it hasn&apos;t been filled yet.</p>
          <a className="btn wide" href="/">Open Instant Wallet</a>
        </div>
      </div>
    );

  // xdai.io: one button. A wallet already on this phone gets it; none yet, the button makes one (Face ID) and sweeps.
  if (upgrade)
    return (
      <div className="app">
        <div className="welcome" style={{ minHeight: 0, paddingTop: 12 }}>
          {header}
          <button className="btn btn-green wide" onClick={() => claim(true)} disabled={busy || !onChain}>
            {busy ? "Sweeping…" : "Sweep to Instant Wallet"}
          </button>
          {sweeping && <TimedBar ms={15_000 + 2_000 * nftsMovable.length} />}
          {error && <p className="err">{error}</p>}
          {burner && !busy && (
            <button className="nfts-link" onClick={burner.onDone}>
              Not now
            </button>
          )}
          <p className="fine center" style={{ marginTop: 24 }}>long live the burner wallet</p>
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
        {burner && (
          <div className="app" style={{ paddingTop: 0 }}>
            <button className="nfts-link" onClick={burner.onDone}>
              Not now
            </button>
          </div>
        )}
      </>
    );

  return (
    <div className="app">
      <div className="welcome">
        {header}
        <button className="btn btn-green wide" onClick={() => claim()} disabled={busy || !onChain}>
          {busy ? (burner ? "Moving…" : "Claiming…") : burner ? "Move it to my wallet" : "Claim it"}
        </button>
        {error && <p className="err">{error}</p>}
        <p className="fine center">Goes to your Instant Wallet. A few cents of it pays the network fee.</p>
        {burner && !busy && (
          <button className="nfts-link" onClick={burner.onDone}>
            Not now
          </button>
        )}
      </div>
    </div>
  );
}

/** Tokens an old key can't move: no coin on that network to pay gas. Says how much to send in first (about 2× the gas). */
function Stuck({ stuck, nfts, safes, address }: { stuck: Asset[]; nfts: Nft[]; safes: OldSafe[]; address: Address }) {
  const ids = [...new Set([...stuck, ...nfts, ...safes.map(() => ({ chainId: 100 }))].map(t => t.chainId))];
  const [gas, setGas] = useState<Record<number, bigint>>({});
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    for (const id of ids)
      publicClient(id)
        .getGasPrice()
        .then(p => {
          const need = p * 70_000n * 2n * BigInt([...stuck, ...nfts].filter(t => t.chainId === id).length + (id === 100 ? safes.length : 0));
          setGas(g => ({ ...g, [id]: need > 2n * ETH_DUST ? need : 2n * ETH_DUST })); // under the dust line it reads as empty
        })
        .catch(() => {});
  }, [ids.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const what = (id: number) => {
    const k = nfts.filter(n => n.chainId === id).length;
    const inSafes = id === 100 ? safes.reduce((t, x) => t + x.wei, 0n) : 0n;
    return [
      ...stuck.filter(t => t.chainId === id).map(t => `${fmtAmount(t.formatted)} ${t.symbol}`),
      k && `${k} NFT${k === 1 ? "" : "s"}`,
      inSafes > 0n && `${Number(formatUnits(inSafes, 18)).toFixed(2)} xDAI in your old Safe`,
    ]
      .filter(Boolean)
      .join(" + ");
  };
  return (
    <div className="recess stack" style={{ gap: 8, textAlign: "left" }}>
      {ids.map(id => (
        <p key={id} className="fine">
          Also here: {what(id)} on {CHAINS.find(c => c.id === id)?.name}. To move {[...stuck, ...nfts].filter(t => t.chainId === id).length + (id === 100 ? safes.length : 0) > 1 ? "them" : "it"} too, first send{" "}
          {gas[id] ? `about ${parseFloat(Number(formatUnits(gas[id], 18)).toPrecision(2))}` : "a little"} {nativeSymbol(id)} for gas to:
        </p>
      ))}
      <div className="mono" style={{ fontSize: 13 }}>{address}</div>
      <button className="pill" onClick={async () => setCopied(await copy(address))}>
        {copied ? "Copied" : "Copy address"}
      </button>
      <p className="fine">Then reload this page.</p>
    </div>
  );
}
