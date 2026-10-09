"use client";

import { openWalletConnect } from "@/lib/walletconnect";
import { type ReactNode, useEffect, useState } from "react";
import { type Address, encodeFunctionData, formatUnits, parseUnits, zeroAddress } from "viem";
import { CHAINS, chainById, explorerAddress, nativeSymbol } from "@/lib/chains";
import { short } from "@/lib/format";
import { DAO, FEE_ALLOWANCE, VERIFIERS, VERIFIERS_SLOT2 } from "@/lib/safe/config";
import { type Call, DEFAULT_BUDGET, abi, budgetCalls, deploySignerCall, feeAllowanceCalls, selfCall, setBudgetCalls, setGuardianCalls } from "@/lib/safe/core";
import { connectHot, hotAvailable } from "@/lib/safe/hot";
import { type FeeToken, type Prepared, type Signer, finishOwners, getQuote, ownerSigners, prepareOwners } from "@/lib/safe/send";
import { type ChainState, type SafeAccount, hotOf, readChain, wedgieSigners } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { AddressInput, Blockie } from "../bits";
import { ChainSelect } from "./Pick";
import { friendly } from "../Welcome";

/**
 * Keys & safety, per chain (each chain's Safe is its own). The burner (Face ID) starts alone, the DAO can recover it
 * (7 days, you can cancel). Then, in any order:
 *   Hot wallet  an owner; big moves need it + the burner (2 of 2), or with the wedgie, the wedgie + one more (3 of 4).
 *   Wedgie      counts twice; big moves need the wedgie + one more (Instant + wedgie = 3 of 3).
 *   Paper       your own 24-word seed replaces the DAO as the recovery address (not a signer).
 * The first second key also gives the burner its daily budget (Zodiac Roles). LVL = how many signing keys (1–3).
 */
export function Keys({
  account,
  states,
  assets,
  toast,
  onAccount,
  onRefresh,
  onSignOut,
  onFund,
  hiddenAssets,
  onUnhide,
}: {
  account: SafeAccount;
  states: ChainState[];
  assets: Asset[];
  toast: (m: string) => void;
  onAccount: (a: SafeAccount) => void;
  onRefresh: () => Promise<void> | void;
  onSignOut: () => void;
  onFund: (chainId: number) => void;
  hiddenAssets: Asset[];
  onUnhide: (a: Asset) => void;
}) {
  const [chainId, setChainId] = useState(CHAINS[0].id);
  const [busy, setBusy] = useState<string | null>(null);
  // an error shows in the step whose button caused it, next to where you tapped
  const [error, setErrorRaw] = useState<{ what: string; msg: string } | null>(null);
  const [guardianIn, setGuardianIn] = useState<Address | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const st = states.find(s => s.chainId === chainId);
  const usdc = chainById(chainId)?.usdc?.toLowerCase();
  const haveUsdc = assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdc && BigInt(a.balance) >= (chainId === 1 ? 10_000_000n : 1_000_000n));
  const haveEth = assets.some(a => a.chainId === chainId && a.asset === zeroAddress && BigInt(a.balance) > 0n);
  const feeToken: FeeToken = haveUsdc ? "usdc" : "eth";
  const canPay = haveUsdc || haveEth || assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdc && BigInt(a.balance) > 0n);
  const hot = st ? hotOf(account, st) : account.hot;

  // the budget comes with the first second key, whichever it is (the burner is still the only owner then)
  // (with the fee's own allowance, so the relay's USDC fee doesn't come off the limit)
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  // (no USDC on this chain: fees are in its native coin, there's no USDC fee to keep apart)
  const feeApart = async () => {
    const u = chainById(chainId)?.usdc;
    return u ? feeAllowanceCalls(account.address, u, (await getQuote(chainId, "setup")).relayer, FEE_ALLOWANCE[chainId] ?? 1_000_000n, now()) : [];
  };
  const budgetFirst = async (s: ChainState): Promise<Call[]> =>
    s.threshold <= 1
      ? [
          ...budgetCalls(account.address, chainById(chainId)?.usdc, account.burnerSigner, { usdc: DEFAULT_BUDGET.usdc, eth: chainById(chainId)?.nativeBudget ?? DEFAULT_BUDGET.eth }, now(), {
            rolesDeployed: s.rolesDeployed,
            rolesEnabled: !!s.roles,
          }),
          ...(await feeApart()),
        ]
      : [];
  // a change the wedgie has to sign: connect it now, while this is still the tap (a port prompt needs one)
  const wedgieFor = async (signers: Signer[]) => (signers.includes("wedgie") && wedgieSupported() ? await Wedgie.connect() : null);

  // two taps: the first gets everything ready (MetaMask / the wedgie connect, the fee, the nonce); the second signs.
  // Face ID has to start straight from a tap: after a MetaMask popup or a network call, Safari and Chrome refuse it.
  // The confirm replaces the step's own button, in place.
  type Ready = { label: ReactNode; p: Prepared; after?: () => void; close?: () => Promise<void>; settled?: (s: ChainState) => boolean };
  const [pending, setPending] = useState<({ what: string } & Ready) | null>(null);
  // once it's sent: a progress bar in the step until the chain read shows the change (block time + RPC lag, ~5-30 s)
  const [wait, setWait] = useState<{ what: string; chainId: number; since: number; ms: number; settled: (s: ChainState) => boolean } | null>(null);
  const waitSt = wait && states.find(s => s.chainId === wait.chainId);
  const waitDone = !!wait && !!waitSt && wait.settled(waitSt);
  useEffect(() => {
    if (!wait || busy) return;
    if (waitDone) {
      setWait(null);
      toast("Done");
      return;
    }
    const t = setInterval(() => {
      if (Date.now() - wait.since > wait.ms + 45_000) setWait(null);
      else onRefresh();
    }, 2_000);
    return () => clearInterval(t);
  }, [wait, waitDone, busy, onRefresh, toast]);

  // read the chain again before building a change: the page can be a block or a poll behind (a key that just
  // landed), and a tx built for the old threshold fails on chain (GS021)
  const fresh = async () => {
    if (!st) throw new Error("Still loading");
    const s = await readChain(chainId, account);
    onRefresh();
    return s;
  };

  async function prep(what: string, fn: () => Promise<Ready>) {
    setBusy(what);
    setErrorRaw(null);
    try {
      setPending({ what, ...(await fn()) });
    } catch (e: any) {
      setErrorRaw({ what, msg: friendly(e) });
    } finally {
      setBusy(null);
    }
  }

  async function sign() {
    if (!pending) return;
    setBusy(pending.what);
    setErrorRaw(null);
    const bt = chainById(chainId)?.chain.blockTime ?? 2_000;
    const w = { what: pending.what, chainId, since: 0, ms: 2 * bt + 5_000, settled: pending.settled ?? (() => true) };
    pending.p.opts.onStage = s => s === "sending" && setWait({ ...w, since: Date.now() });
    try {
      await finishOwners(pending.p);
      pending.after?.();
      setPending(null);
      onRefresh();
    } catch (e: any) {
      setWait(null);
      setErrorRaw({ what: pending.what, msg: friendly(e) });
    } finally {
      await pending.close?.();
      setBusy(null);
    }
  }

  const signLabel = (p: Prepared) =>
    p.opts.signers.map(x => (x === "burner" ? "your Instant wallet" : x === "hot" ? "your hot wallet" : "the wedgie")).join(" + ");

  const addHot = () =>
    prep("hot", async () => {
      const st = await fresh();
      if (st.hasHot) throw new Error("A hot wallet is already on this wallet here.");
      const h = await connectHot();
      if (h.toLowerCase() === account.address.toLowerCase()) throw new Error("That's this wallet itself.");
      // Instant alone: 2 of 2. With the wedgie (3 of 3): 3 of 4, so the wedgie + any one.
      const calls = [...(await budgetFirst(st)), selfCall(account.address, encodeFunctionData({ abi: abi.safe, functionName: "addOwnerWithThreshold", args: [h, st.hasWedgie ? 3n : 2n] }))];
      const signers = ownerSigners(st, account);
      const w = await wedgieFor(signers);
      try {
        const p = await prepareOwners({ account, state: st, calls, signers, feeToken, setup: true, wedgie: w });
        return { label: <>Add <Addr a={h} chainId={chainId} inline /> as your hot wallet</>, p, after: () => onAccount({ ...account, hot: h }), settled: s => s.hasHot, close: async () => w?.close() };
      } catch (e) {
        await w?.close();
        throw e;
      }
    });

  const setPaper = () =>
    prep("paper", async () => {
      const st = await fresh();
      if (!guardianIn) throw new Error("Enter an address (0x…) or an ENS name.");
      const paper = guardianIn;
      if (st.owners.some(o => o.toLowerCase() === paper.toLowerCase())) throw new Error("That address is already one of your keys. The guardian must be separate.");
      if (!st.guardians) throw new Error("Couldn't read the current recovery address. Try again in a moment.");
      const signers = ownerSigners(st, account);
      const w = await wedgieFor(signers);
      try {
        const p = await prepareOwners({ account, state: st, calls: setGuardianCalls(st.guardians, paper), signers, feeToken, wedgie: w });
        return {
          label: <>Make <Addr a={paper} chainId={chainId} inline /> your guardian</>,
          p,
          after: () => {
            onAccount({ ...account, paper });
          },
          close: async () => w?.close(),
          settled: s => s.guardians?.[0]?.toLowerCase() === paper.toLowerCase(),
        };
      } catch (e) {
        await w?.close();
        throw e;
      }
    });

  const [limitUsdc, setLimitUsdc] = useState("");
  const [limitEth, setLimitEth] = useState("");
  const [editLimit, setEditLimit] = useState<number | null>(null); // the chain whose limit is open for editing
  const setLimit = () =>
    prep("limit", async () => {
      const st = await fresh();
      if (!st.budget) throw new Error("Still loading");
      const usdcV = parseUnits(limitUsdc, 6);
      const ethV = parseUnits(limitEth, 18);
      const signers = ownerSigners(st, account);
      const w = await wedgieFor(signers);
      try {
        const calls = [...setBudgetCalls(account.address, { usdc: usdcV, eth: ethV }, now()), ...(await feeApart())];
        const p = await prepareOwners({ account, state: st, calls, signers, feeToken, setup: true, wedgie: w, label: "Change the daily limit" });
        return {
          label: `Daily limit: ${formatUnits(usdcV, 6)} USDC · ${formatUnits(ethV, 18)} ${nativeSymbol(chainId)}`,
          p,
          after: () => setEditLimit(null),
          settled: s => s.budget?.usdcMax === usdcV && s.budget.ethMax === ethV,
          close: async () => w?.close(),
        };
      } catch (e) {
        await w?.close();
        throw e;
      }
    });

  const addWedgie = () =>
    prep("wedgie", async () => {
      if (!st) throw new Error("Still loading");
      const w = await Wedgie.connect(); // first, while it's still the tap (the port prompt needs one)
      try {
        const st = await fresh();
        if (st.hasWedgie) throw new Error("The wedgie is already on this wallet here.");
        const key = await w.key();
        const [w1, w2] = wedgieSigners(key);
        // Instant alone (1 of 1) → 3 of 3; Instant + hot (2 of 2) → 3 of 4. Either way the wedgie + one more.
        const calls = [
          ...(await budgetFirst(st)),
          deploySignerCall(key.x, key.y, VERIFIERS),
          deploySignerCall(key.x, key.y, VERIFIERS_SLOT2),
          selfCall(account.address, encodeFunctionData({ abi: abi.safe, functionName: "addOwnerWithThreshold", args: [w1, 2n] })),
          selfCall(account.address, encodeFunctionData({ abi: abi.safe, functionName: "addOwnerWithThreshold", args: [w2, 3n] })),
        ];
        const p = await prepareOwners({ account, state: st, calls, signers: ownerSigners(st, account), feeToken, setup: true, wedgie: w });
        return { label: "Add your wedgie (it counts twice)", p, after: () => onAccount({ ...account, wedgie: key }), settled: s => s.hasWedgie, close: () => w.close() };
      } catch (e) {
        await w.close();
        throw e;
      }
    });

  // what === the step's own action: its button, or the confirm that replaces it, plus that step's error
  const action = (what: string, button: ReactNode) => (
    <>
      {wait?.what === what && wait.chainId === chainId ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="fine">{busy ? "Sending…" : `Waiting for ${chainById(chainId)?.name}…`}</p>
          <Progress ms={wait.ms} />
        </div>
      ) : pending?.what === what ? (
        <div className="stack" style={{ gap: 8 }}>
          <b>{pending.label}</b>
          <p className="fine">
            Fee {pending.p.opts.feeToken === "usdc" ? `${(Number(pending.p.fee.feeUsdc) / 1e6).toFixed(4)} USDC` : `${(Number(pending.p.fee.feeEth) / 1e18).toFixed(6)} ${nativeSymbol(chainId)}`}. Signed by{" "}
            {signLabel(pending.p)}.
          </p>
          <button className="btn btn-green wide" onClick={sign} disabled={!!busy}>
            {busy ? "Signing and sending…" : "Yes"}
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
      ) : (
        button
      )}
      {error?.what === what && <p className="err">{error.msg}</p>}
    </>
  );

  const current = st?.guardians?.[0];
  const changed = !!guardianIn && guardianIn.toLowerCase() !== current?.toLowerCase();
  const ownRecovery = !!st?.guardians && st.guardians.length > 0 && !st.guardians.some(g => g.toLowerCase() === DAO.toLowerCase());


  return (
    <div className="stack">
      <h2>Keys &amp; safety</h2>
      <ChainSelect value={chainId} onChange={setChainId} />

      {!st && <p className="fine">Loading…</p>}
      {!canPay ? (
        <div className="card stack" style={{ gap: 8 }}>
          <p className="fine">Changes on {chainById(chainId)?.name} need a little gas there, and this wallet has none on it yet.</p>
          {assets.some(a => a.chainId !== chainId && (a.usd ?? 0) >= 0.5) ? (
            <button className="btn btn-green wide" onClick={() => onFund(chainId)}>
              Add gas on {chainById(chainId)?.name}
            </button>
          ) : (
            <p className="fine">Add a little USDC or {nativeSymbol(chainId)} on {chainById(chainId)?.name} first.</p>
          )}
        </div>
      ) : (
        st && !st.deployed && <p className="fine">The first change on {chainById(chainId)?.name} also sets up the wallet there.</p>
      )}

      <h3>Your keys</h3>
      <KeyRow kind="Instant wallet" a={account.burnerSigner} chainId={chainId} />
      {st?.hasWedgie ? (
        <KeyRow kind="Wedgie" a={st.wedgie} chainId={chainId} />
      ) : (
        <Step title="Wedgie (cold)">
          <p className="fine">
            Plug it into a computer (Chrome), open its Safe signer app, then add it. Don&apos;t have one?{" "}
            <a href="https://wedgie.dev" target="_blank" rel="noreferrer">
              Get one at wedgie.dev
            </a>
          </p>
          {action(
            "wedgie",
            <button className="btn btn-green wide" onClick={addWedgie} disabled={!!busy || !!pending || !!wait || !canPay || !wedgieSupported()}>
              {busy === "wedgie" ? "Check the wedgie…" : !wedgieSupported() ? "Needs Chrome on a computer" : "Connect and add the wedgie"}
            </button>,
          )}
        </Step>
      )}

      {st?.hasHot ? (
        <KeyRow kind="Hot wallet" a={hot} chainId={chainId} />
      ) : (
        <Step title="Hot wallet">
          <p className="fine">Any wallet extension on a computer, or a wallet app on your phone. Open this page in it, then add it.</p>
          {action(
            "hot",
            <button className="btn btn-green wide" onClick={addHot} disabled={!!busy || !!pending || !!wait || !canPay || !hotAvailable()}>
              {busy === "hot" ? "Connecting…" : hotAvailable() ? "Connect and add" : "No browser wallet here"}
            </button>,
          )}
        </Step>
      )}
      {st?.budget && st.threshold > 1 && (
        <Step title={`Daily limit (1 of ${st.level} keys)`} key={`limit${chainId}`}>
          {editLimit !== chainId ? (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>
                {cut(st.budget.usdc, 6, 2)}/{formatUnits(st.budget.usdcMax, 6)} USDC · {cut(st.budget.eth, 18, 4)}/{formatUnits(st.budget.ethMax, 18)} {nativeSymbol(chainId)}
              </b>
              <button
                className="pill"
                disabled={!!busy || !!pending || !!wait}
                onClick={() => {
                  setLimitUsdc(formatUnits(st.budget!.usdcMax, 6));
                  setLimitEth(formatUnits(st.budget!.ethMax, 18));
                  setEditLimit(chainId);
                }}
              >
                Edit
              </button>
            </div>
          ) : (
            <>
              <div className="input">
                <input inputMode="decimal" value={limitUsdc} onChange={e => setLimitUsdc(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} />
                <span className="unit">USDC</span>
              </div>
              <div className="input">
                <input inputMode="decimal" value={limitEth} onChange={e => setLimitEth(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} />
                <span className="unit">{nativeSymbol(chainId)}</span>
              </div>
              {action(
                "limit",
                <div className="row">
                  <button className="btn grow" onClick={() => setEditLimit(null)} disabled={!!busy}>
                    Cancel
                  </button>
                  <button className="btn btn-green grow" onClick={setLimit} disabled={!!busy || !!pending || !!wait || !canPay || !limitUsdc || !limitEth}>
                    {busy === "limit" ? "Working…" : "Save"}
                  </button>
                </div>,
              )}
            </>
          )}
        </Step>
      )}

      <Step title="Guardian" done={ownRecovery}>
        <p className="fine">
          Replaces lost keys in 7 days. Best: <a href="/paper" target="_blank">a paper seed</a>.
        </p>
        <div className="guardian">
          <AddressInput key={chainId} initial={current} onChange={setGuardianIn} />
        </div>
        {action(
          "paper",
          <button className="btn btn-green wide" onClick={setPaper} disabled={!!busy || !!pending || !!wait || !canPay || !changed}>
            {busy === "paper" ? "Working…" : "Save"}
          </button>,
        )}
      </Step>


      {hiddenAssets.length > 0 && (
        <div className="card stack" style={{ gap: 8 }}>
          <button className="row unhide" style={{ justifyContent: "space-between" }} onClick={() => setShowHidden(!showHidden)}>
            <b>
              {hiddenAssets.length} token{hiddenAssets.length === 1 ? "" : "s"} hidden
            </b>
            <span className="fine">{showHidden ? "Close" : "See"}</span>
          </button>
          {showHidden &&
            hiddenAssets.map(a => (
              <div key={`${a.chainId}:${a.asset}`} className="row" style={{ justifyContent: "space-between" }}>
                <span>
                  {a.symbol} <span className="fine">· {chainById(a.chainId)?.name}</span>
                </span>
                <button className="pill" onClick={() => onUnhide(a)}>
                  Show
                </button>
              </div>
            ))}
        </div>
      )}

      <button className="btn wide" onClick={() => openWalletConnect()}>
        Connected sites (WalletConnect)
      </button>
      <button className="btn wide" onClick={onSignOut}>
        Sign out of this device
      </button>
    </div>
  );
}

// a balance, cut (not rounded) to a few decimals: 99.77
const cut = (v: bigint, d: number, dp: number) => String(Math.floor((Number(v) / 10 ** d) * 10 ** dp) / 10 ** dp);

/** A key you have: what kind on the left, its address on the right. */
function KeyRow({ kind, a, chainId }: { kind: string; a?: Address; chainId: number }) {
  return (
    <div className="card keyrow">
      <b>{kind}</b>
      {a ? <Addr a={a} chainId={chainId} /> : <span className="fine">…</span>}
    </div>
  );
}

/** Fills toward the end over about `ms`, then creeps; the step replaces it when the change shows up. */
function Progress({ ms }: { ms: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setGo(true));
    return () => cancelAnimationFrame(t);
  }, []);
  return (
    <div className="progress">
      <div style={{ width: go ? "95%" : "2%", transitionDuration: `${ms}ms` }} />
    </div>
  );
}

function Step({ title, done, children }: { title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <div className={`card step ${done ? "done" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>{title}</b>
        <span className={`led ${done ? "on" : ""}`} />
      </div>
      {children}
    </div>
  );
}

/** An address: blockie + short link to the explorer (no chain chip: the chain is already picked above). inline: in a sentence */
function Addr({ a, chainId, inline }: { a: Address; chainId: number; inline?: boolean }) {
  const url = explorerAddress(chainId, a);
  return (
    <span className="row" style={inline ? { display: "inline-flex", gap: 6, verticalAlign: "middle" } : { gap: 8 }}>
      <Blockie address={a} size={inline ? 18 : 22} />
      {url ? (
        <a className="mono" href={url} target="_blank" rel="noreferrer" style={inline ? undefined : { fontSize: 13 }}>
          {short(a)}
        </a>
      ) : (
        <span className="mono">{short(a)}</span>
      )}
    </span>
  );
}
