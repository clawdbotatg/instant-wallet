"use client";

import { useEffect, useRef, useState } from "react";
import { type Address, encodeFunctionData, getAddress, isAddress, zeroAddress } from "viem";
import { CHAINS, chainById, explorerAddress } from "@/lib/chains";
import { short } from "@/lib/format";
import { DAO, VERIFIERS, VERIFIERS_SLOT2 } from "@/lib/safe/config";
import { DEFAULT_BUDGET, abi, deploySignerCall, levelUpToHotCalls, selfCall, setGuardianCalls } from "@/lib/safe/core";
import { connectHot, hotAvailable } from "@/lib/safe/hot";
import { type FeeToken, type Prepared, finishOwners, ownerSigners, prepareOwners } from "@/lib/safe/send";
import { type ChainState, LEVEL_NAME, type SafeAccount, hotOf, wedgieSigners } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { Blockie, ChainChip, copy } from "../bits";
import { friendly } from "../Welcome";

const NAME = (a: string) => (a.toLowerCase() === DAO.toLowerCase() ? "dao.buidlguidl.eth" : short(a));

/**
 * Keys & safety: the ladder from a burner to full self-custody, per chain (each chain's Safe is its own).
 *   1 Burner      Face ID, the only key. DAO can recover it (7 days, you can cancel).
 *   2 Hot wallet  MetaMask becomes an owner; big moves need both; the burner keeps a daily budget (Zodiac Roles).
 *   3 Paper       your own 24-word seed replaces the DAO as the recovery address.
 *   4 Wedgie      counts twice; big moves need the wedgie + one more.
 *   5 Full        wedgie + your own recovery, no DAO anywhere.
 */
export function Keys({
  account,
  states,
  assets,
  toast,
  onAccount,
  onRefresh,
  onSignOut,
}: {
  account: SafeAccount;
  states: ChainState[];
  assets: Asset[];
  toast: (m: string) => void;
  onAccount: (a: SafeAccount) => void;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const [chainId, setChainId] = useState(CHAINS[0].id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paperIn, setPaperIn] = useState("");
  const st = states.find(s => s.chainId === chainId);
  const usdc = chainById(chainId)?.usdc?.toLowerCase();
  const haveUsdc = assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdc && BigInt(a.balance) >= (chainId === 1 ? 10_000_000n : 1_000_000n));
  const haveEth = assets.some(a => a.chainId === chainId && a.asset === zeroAddress && BigInt(a.balance) > 0n);
  const feeToken: FeeToken = haveUsdc ? "usdc" : "eth";
  const canPay = haveUsdc || haveEth || assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdc && BigInt(a.balance) > 0n);
  const hot = st ? hotOf(account, st) : account.hot;
  const level = st?.level ?? 1;

  // two taps: the first gets everything ready (MetaMask / the wedgie connect, the fee, the nonce); the second signs.
  // Face ID has to start straight from a tap: after a MetaMask popup or a network call, Safari and Chrome refuse it.
  const [pending, setPending] = useState<{ what: string; label: string; p: Prepared; after?: () => void; close?: () => Promise<void> } | null>(null);

  async function prep(what: string, fn: () => Promise<{ label: string; p: Prepared; after?: () => void; close?: () => Promise<void> }>) {
    setBusy(what);
    setError(null);
    try {
      setPending({ what, ...(await fn()) });
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  async function sign() {
    if (!pending) return;
    setBusy(pending.what);
    setError(null);
    try {
      await finishOwners(pending.p);
      pending.after?.();
      toast("Done");
      setPending(null);
      onRefresh();
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      await pending.close?.();
      setBusy(null);
    }
  }

  const pendingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending) pendingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [pending]);

  const signLabel = (p: Prepared) =>
    p.opts.signers.map(x => (x === "burner" ? "your Instant wallet" : x === "hot" ? "your hot wallet" : "the wedgie")).join(" + ");

  const addHot = () =>
    prep("hot", async () => {
      if (!st) throw new Error("Still loading");
      const h = await connectHot();
      if (h.toLowerCase() === account.address.toLowerCase()) throw new Error("That's this wallet itself.");
      const calls = levelUpToHotCalls(account.address, chainById(chainId)!.usdc!, account.burnerSigner, h, DEFAULT_BUDGET, BigInt(Math.floor(Date.now() / 1000)), {
        rolesDeployed: st.rolesDeployed,
        rolesEnabled: !!st.roles,
      });
      const p = await prepareOwners({ account, state: st, calls, signers: ["burner"], feeToken, setup: true });
      return { label: `Add ${short(h)} as your hot wallet`, p, after: () => onAccount({ ...account, hot: h }) };
    });

  const setPaper = () =>
    prep("paper", async () => {
      if (!st) throw new Error("Still loading");
      if (!isAddress(paperIn.trim())) throw new Error("Paste the paper seed's address (0x…), from the wallet you made the seed in.");
      const paper = getAddress(paperIn.trim());
      if (st.owners.some(o => o.toLowerCase() === paper.toLowerCase())) throw new Error("That address is already one of your keys. The paper must be separate.");
      if (!st.guardians) throw new Error("Couldn't read the current recovery address. Try again in a moment.");
      const p = await prepareOwners({ account, state: st, calls: setGuardianCalls(st.guardians, paper), signers: ownerSigners(st), feeToken });
      return {
        label: `Make ${short(paper)} your recovery address`,
        p,
        after: () => {
          onAccount({ ...account, paper });
          setPaperIn("");
        },
      };
    });

  const addWedgie = () =>
    prep("wedgie", async () => {
      if (!st) throw new Error("Still loading");
      const w = await Wedgie.connect();
      try {
        const key = await w.key();
        const [w1, w2] = wedgieSigners(key);
        const calls = [
          deploySignerCall(key.x, key.y, VERIFIERS),
          deploySignerCall(key.x, key.y, VERIFIERS_SLOT2),
          selfCall(account.address, encodeFunctionData({ abi: abi.safe, functionName: "addOwnerWithThreshold", args: [w1, 2n] })),
          selfCall(account.address, encodeFunctionData({ abi: abi.safe, functionName: "addOwnerWithThreshold", args: [w2, 3n] })),
        ];
        const p = await prepareOwners({ account, state: st, calls, signers: ownerSigners(st), feeToken, setup: true, wedgie: w });
        return { label: "Add your wedgie (it counts twice)", p, after: () => onAccount({ ...account, wedgie: key }), close: () => w.close() };
      } catch (e) {
        await w.close();
        throw e;
      }
    });

  const card = `Instant Wallet ${account.address}\nInstant wallet key ${account.burnerSigner}\n(Recovery needs this if the wallet was never deployed on a chain.)`;

  return (
    <div className="stack">
      <h2>Keys &amp; safety</h2>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {CHAINS.map(c => (
          <button key={c.id} className={`pill ${c.id === chainId ? "on" : ""}`} onClick={() => setChainId(c.id)}>
            {c.name} · {states.find(s => s.chainId === c.id)?.level ?? "…"}
          </button>
        ))}
      </div>
      <p className="fine">
        Each chain&apos;s wallet is set up on its own. On {chainById(chainId)?.name}: level {level}, {LEVEL_NAME[level]}.
        {st && !st.deployed && " Not deployed here yet: the first change deploys it."}
      </p>
      {pending && (
        <div className="card alert stack" ref={pendingRef}>
          <b>{pending.label}</b>
          <p className="fine">
            Fee {pending.p.opts.feeToken === "usdc" ? `${(Number(pending.p.fee.feeUsdc) / 1e6).toFixed(4)} USDC` : `${(Number(pending.p.fee.feeEth) / 1e18).toFixed(6)} ETH`}. Signed by{" "}
            {signLabel(pending.p)}.
          </p>
          <button className="btn btn-green wide" onClick={sign} disabled={!!busy}>
            {busy ? "Signing and sending…" : "Sign"}
          </button>
          <button
            className="btn wide"
            disabled={!!busy}
            onClick={async () => {
              await pending.close?.();
              setPending(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p className="err">{error}</p>}
      {!canPay && <p className="err">Changes cost a few cents of gas, paid from this wallet. Add a little USDC or ETH on {chainById(chainId)?.name} first.</p>}

      <Step n={1} title="Instant wallet" done>
        <p className="fine">This phone&apos;s passkey. Level 1 it can do everything; later it keeps a daily budget.</p>
        <Addr a={account.burnerSigner} chainId={chainId} />
      </Step>

      <Step n={2} title="Hot wallet" done={!!hot && (st?.owners.length ?? 0) >= 2} current={level === 1}>
        {hot && (st?.owners.length ?? 0) >= 2 ? (
          <>
            <p className="fine">Big moves need your Instant wallet + this hot wallet. The Instant wallet alone: 100 USDC + 0.04 ETH a day.</p>
            <Addr a={hot} chainId={chainId} />
            {st?.budget && (
              <p className="fine">
                Today&apos;s Instant wallet budget: {(Number(st.budget.usdc) / 1e6).toFixed(2)} USDC · {(Number(st.budget.eth) / 1e18).toFixed(4)} ETH
              </p>
            )}
          </>
        ) : (
          <>
            <p className="fine">
              Add your hot wallet as a second key: any wallet extension on your computer, or a wallet app on your phone. After this, anything over the Instant wallet&apos;s daily budget (100 USDC + 0.04 ETH) needs both.
              For now, open this page in that wallet: on a computer with the extension, or in the wallet app&apos;s own browser.
            </p>
            <button className="btn btn-green wide" onClick={addHot} disabled={!!busy || !!pending || !canPay || !hotAvailable()}>
              {busy === "hot" ? "Connecting…" : hotAvailable() ? "Connect and add" : "No browser wallet here"}
            </button>
          </>
        )}
      </Step>

      <Step n={3} title="Paper backup (your recovery)" done={!!st?.guardians && st.guardians.length > 0 && !st.guardians.some(g => g.toLowerCase() === DAO.toLowerCase())} current={level === 2}>
        <p className="fine">
          Recovery: {st?.guardians ? (st.guardians.length ? st.guardians.map(NAME).join(", ") : "none") : "…"} can replace your keys after a 7-day wait (you get time to cancel).
        </p>
        <p className="fine">
          To make it yours: create a new 24-word seed in a wallet (a fresh one, only for this), write it on the 3 cards (
          <a href="/paper" target="_blank">print them</a>, any 2 rebuild it), seal each in a tamper-evident bag, then paste its address here.
        </p>
        <div className="input">
          <input value={paperIn} onChange={e => setPaperIn(e.target.value)} placeholder="0x… the paper seed's address" autoCapitalize="none" spellCheck={false} />
        </div>
        <button className="btn wide" onClick={setPaper} disabled={!!busy || !!pending || !canPay || level < 2 || !paperIn}>
          {busy === "paper" ? "Working…" : level < 2 ? "Add a hot wallet first" : "Make it my recovery"}
        </button>
      </Step>

      <Step n={4} title="Wedgie (cold)" done={(st?.owners.length ?? 0) >= 4} current={level === 2 || level === 3}>
        {(st?.owners.length ?? 0) >= 4 ? (
          <p className="fine">The wedgie counts twice. Big moves need the wedgie + your Instant wallet or hot wallet. The Instant wallet + hot wallet alone can&apos;t.</p>
        ) : (
          <>
            <p className="fine">
              Plug your wedgie into this computer (Chrome), open its Safe signer app, then add it. One press signs for both of its slots.
            </p>
            <button className="btn btn-green wide" onClick={addWedgie} disabled={!!busy || !!pending || !canPay || level < 2 || !wedgieSupported()}>
              {busy === "wedgie" ? "Check the wedgie…" : !wedgieSupported() ? "Needs Chrome on a computer" : level < 2 ? "Add a hot wallet first" : "Connect and add the wedgie"}
            </button>
          </>
        )}
      </Step>

      <Step n={5} title="Full self-custody" done={level === 5} current={level === 4}>
        <p className="fine">Wedgie + your own recovery, no DAO. You depend on nobody (this app is open source; any Safe tool works too).</p>
      </Step>

      <div className="card stack">
        <b>Wallet card</b>
        <p className="fine">Save this somewhere. If you lose this phone before your first send on a chain, recovery needs it.</p>
        <span className="mono" style={{ fontSize: 13 }}>{account.address}</span>
        <span className="mono fine" style={{ fontSize: 12 }}>Instant wallet key {account.burnerSigner}</span>
        <button className="pill" onClick={async () => (await copy(card)) && toast("Copied")}>
          Copy wallet card
        </button>
      </div>
      <button className="btn wide" onClick={onSignOut}>
        Sign out of this device
      </button>
    </div>
  );
}

function Step({ n, title, done, current, children }: { n: number; title: string; done?: boolean; current?: boolean; children: React.ReactNode }) {
  return (
    <div className={`card step ${done ? "done" : ""} ${current ? "current" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>
          {n}. {title}
        </b>
        <span className={`led ${done ? "on" : ""}`} />
      </div>
      {children}
    </div>
  );
}

function Addr({ a, chainId }: { a: Address; chainId: number }) {
  const url = explorerAddress(chainId, a);
  return (
    <span className="row" style={{ gap: 8 }}>
      <Blockie address={a} size={22} />
      {url ? (
        <a className="mono" href={url} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
          {short(a)}
        </a>
      ) : (
        <span className="mono">{short(a)}</span>
      )}
      <ChainChip chainId={chainId} />
    </span>
  );
}
