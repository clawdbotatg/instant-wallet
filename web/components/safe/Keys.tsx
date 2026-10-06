"use client";

import { useState } from "react";
import { type Address, encodeFunctionData, getAddress, isAddress, zeroAddress } from "viem";
import { CHAINS, chainById, explorerAddress } from "@/lib/chains";
import { short } from "@/lib/format";
import { DAO, VERIFIERS, VERIFIERS_SLOT2 } from "@/lib/safe/config";
import { DEFAULT_BUDGET, abi, deploySignerCall, levelUpToHotCalls, selfCall, setGuardianCalls } from "@/lib/safe/core";
import { connectHot, hotAvailable } from "@/lib/safe/hot";
import { type FeeToken, ownerSigners, ownersSend } from "@/lib/safe/send";
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

  async function run(what: string, fn: () => Promise<void>) {
    setBusy(what);
    setError(null);
    try {
      await fn();
      toast("Done");
      onRefresh();
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  const addHot = () =>
    run("hot", async () => {
      if (!st) throw new Error("Still loading");
      const h = await connectHot();
      if (h.toLowerCase() === account.address.toLowerCase()) throw new Error("That's this wallet itself.");
      const calls = levelUpToHotCalls(account.address, chainById(chainId)!.usdc!, account.burnerSigner, h, DEFAULT_BUDGET, BigInt(Math.floor(Date.now() / 1000)), {
        rolesDeployed: st.rolesDeployed,
        rolesEnabled: !!st.roles,
      });
      await ownersSend({ account, state: st, calls, signers: ["burner"], feeToken, setup: true });
      onAccount({ ...account, hot: h });
    });

  const setPaper = () =>
    run("paper", async () => {
      if (!st) throw new Error("Still loading");
      if (!isAddress(paperIn.trim())) throw new Error("Paste the paper seed's address (0x…), from MetaMask after you import the seed.");
      const paper = getAddress(paperIn.trim());
      if (st.owners.some(o => o.toLowerCase() === paper.toLowerCase())) throw new Error("That address is already one of your keys. The paper must be separate.");
      if (!st.guardians) throw new Error("Couldn't read the current recovery address. Try again in a moment.");
      await ownersSend({ account, state: st, calls: setGuardianCalls(st.guardians, paper), signers: ownerSigners(st), feeToken });
      onAccount({ ...account, paper });
      setPaperIn("");
    });

  const addWedgie = () =>
    run("wedgie", async () => {
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
        await ownersSend({ account, state: st, calls, signers: ownerSigners(st), feeToken, setup: true, wedgie: w });
        onAccount({ ...account, wedgie: key });
      } finally {
        await w.close();
      }
    });

  const card = `Instant Wallet ${account.address}\nBurner signer ${account.burnerSigner}\n(Recovery needs this if the wallet was never deployed on a chain.)`;

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
      {!canPay && <p className="err">Changes cost a few cents of gas, paid from this wallet. Add a little USDC or ETH on {chainById(chainId)?.name} first.</p>}

      <Step n={1} title="Burner (Face ID)" done>
        <p className="fine">This phone&apos;s passkey. Level 1 it can do everything; later it keeps a daily budget.</p>
        <Addr a={account.burnerSigner} chainId={chainId} />
      </Step>

      <Step n={2} title="Hot wallet (MetaMask)" done={!!hot && (st?.owners.length ?? 0) >= 2} current={level === 1}>
        {hot && (st?.owners.length ?? 0) >= 2 ? (
          <>
            <p className="fine">Big moves need Face ID + this wallet. Face ID alone: 100 USDC + 0.04 ETH a day.</p>
            <Addr a={hot} chainId={chainId} />
            {st?.budget && (
              <p className="fine">
                Today&apos;s Face ID budget: {(Number(st.budget.usdc) / 1e6).toFixed(2)} USDC · {(Number(st.budget.eth) / 1e18).toFixed(4)} ETH
              </p>
            )}
          </>
        ) : (
          <>
            <p className="fine">
              Add MetaMask (or any browser wallet) as a second key. After this, anything over Face ID&apos;s daily budget (100 USDC + 0.04 ETH) needs both.
              Do this on a computer with MetaMask, or in the MetaMask app&apos;s browser.
            </p>
            <button className="btn btn-green wide" onClick={addHot} disabled={!!busy || !canPay || !hotAvailable()}>
              {busy === "hot" ? "Working…" : hotAvailable() ? "Connect and add" : "No browser wallet here"}
            </button>
          </>
        )}
      </Step>

      <Step n={3} title="Paper backup (your recovery)" done={!!st?.guardians && st.guardians.length > 0 && !st.guardians.some(g => g.toLowerCase() === DAO.toLowerCase())} current={level === 2}>
        <p className="fine">
          Recovery: {st?.guardians ? (st.guardians.length ? st.guardians.map(NAME).join(", ") : "none") : "…"} can replace your keys after a 7-day wait (you get time to cancel).
        </p>
        <p className="fine">
          To make it yours: create a new 24-word seed in MetaMask (a fresh wallet), write it on the 3 cards (
          <a href="/safe/paper" target="_blank">print them</a>, any 2 rebuild it), seal each in a tamper-evident bag, then paste its address here.
        </p>
        <div className="input">
          <input value={paperIn} onChange={e => setPaperIn(e.target.value)} placeholder="0x… the paper seed's address" autoCapitalize="none" spellCheck={false} />
        </div>
        <button className="btn wide" onClick={setPaper} disabled={!!busy || !canPay || level < 2 || !paperIn}>
          {busy === "paper" ? "Working…" : level < 2 ? "Add a hot wallet first" : "Make it my recovery"}
        </button>
      </Step>

      <Step n={4} title="Wedgie (cold)" done={(st?.owners.length ?? 0) >= 4} current={level === 2 || level === 3}>
        {(st?.owners.length ?? 0) >= 4 ? (
          <p className="fine">The wedgie counts twice. Big moves need the wedgie + Face ID or MetaMask. Face ID + MetaMask alone can&apos;t.</p>
        ) : (
          <>
            <p className="fine">
              Plug your wedgie into this computer (Chrome), open its Safe signer app, then add it. One press signs for both of its slots.
            </p>
            <button className="btn btn-green wide" onClick={addWedgie} disabled={!!busy || !canPay || level < 2 || !wedgieSupported()}>
              {busy === "wedgie" ? "Check the wedgie…" : !wedgieSupported() ? "Needs Chrome on a computer" : level < 2 ? "Add a hot wallet first" : "Connect and add the wedgie"}
            </button>
          </>
        )}
      </Step>

      <Step n={5} title="Full self-custody" done={level === 5} current={level === 4}>
        <p className="fine">Wedgie + your own recovery, no DAO. You depend on nobody (this app is open source; any Safe tool works too).</p>
      </Step>

      {error && <p className="err">{error}</p>}

      <div className="card stack">
        <b>Wallet card</b>
        <p className="fine">Save this somewhere. If you lose this phone before your first send on a chain, recovery needs it.</p>
        <span className="mono" style={{ fontSize: 13 }}>{account.address}</span>
        <span className="mono fine" style={{ fontSize: 12 }}>burner signer {account.burnerSigner}</span>
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
