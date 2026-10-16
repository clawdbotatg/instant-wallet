"use client";

import { openWalletConnect } from "@/lib/walletconnect";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Address, encodeFunctionData, formatUnits, parseUnits, zeroAddress } from "viem";
import { CHAINS, chainById, explorerAddress, nativeSymbol } from "@/lib/chains";
import { short } from "@/lib/format";
import { DAO, FEE_ALLOWANCE, RECOVERY_60D, VERIFIERS, VERIFIERS_SLOT2 } from "@/lib/safe/config";
import { type Call, DEFAULT_BUDGET, abi, budgetCalls, deploySignerCall, feeAllowanceCalls, recoveryLayoutCalls, selfCall, setBudgetCalls, setGuardianCalls } from "@/lib/safe/core";
import { type FeeToken, type Prepared, type Signer, finishOwners, getQuote, ownerSigners, prepareOwners } from "@/lib/safe/send";
import { type ChainState, type SafeAccount, hotOf, oldLayout, readChain, wedgieSigners } from "@/lib/safe/state";
import { Wedgie, wedgieDrive, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { AddressInput, Blockie } from "../bits";
import { Alerts } from "./Alerts";
import { ChainSelect } from "./Pick";
import { friendly } from "../Welcome";

/**
 * Keys & safety, per chain (each chain's Safe is its own). Three things (Austin 10-14: no hot wallet any more):
 *   Instant     the passkey (Face ID). Alone at first; once the wedgie is on, it spends a daily limit.
 *   Wedgie      the hardware key, counts twice: big moves and settings need the wedgie + Instant (3 of 3).
 *   Recovery    replaces lost keys only, after a wait you can cancel in. Not a signer. Instant alone: the DAO, or
 *               any address you control (MetaMask, Ledger, ENS, a paper seed), 7 days. With the wedgie (Austin
 *               10-15): your own address waits 14 days, the DAO 60 (it mustn't get your money in two weeks).
 * Pairing the wedgie also gives the burner its daily budget (Zodiac Roles). A wallet that already has a hot wallet
 * (added before 10-14) keeps it: it's still an owner, so it's shown and can still sign.
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

  // the budget comes with the first second key (the wedgie; on older wallets maybe a hot wallet)
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
  // the wedgie's recovery: the DAO on 60 days, your own address on 14 (never while a recovery runs: a guardian
  // change drops it)
  // (a chain without the 60-day module yet, HyperEVM: pairing leaves it as it is, the upgrade shows once it's there)
  const toLayout = async (s: ChainState): Promise<Call[]> => {
    if (s.modules.includes(RECOVERY_60D) || !s.has60) return [];
    if (s.recovery) throw new Error("A recovery is running on this wallet. Cancel it or let it finish first.");
    if (!s.stored) throw new Error("Couldn't read the recovery address. Try again in a moment.");
    return recoveryLayoutCalls(account.address, s.modules, s.stored);
  };
  // a change the wedgie has to sign: connect it now, while this is still the tap (a port prompt needs one)
  const wedgieFor = async (signers: Signer[]) => (signers.includes("wedgie") && wedgieSupported() ? await Wedgie.connect() : null);

  // two taps: the first gets everything ready (MetaMask / the wedgie connect, the fee, the nonce); the second signs.
  // Face ID has to start straight from a tap: after a MetaMask popup or a network call, Safari and Chrome refuse it.
  // The confirm replaces the step's own button, in place.
  type Ready = { label: ReactNode; p: Prepared; after?: () => void; close?: () => Promise<void>; settled?: (s: ChainState) => boolean };
  const [pending, setPending] = useState<({ what: string } & Ready) | null>(null);
  // the confirm can land below the fold (Austin: you couldn't tell there was a Yes to tap): scroll it to the middle
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending) confirmRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [pending?.what]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const setPaper = () =>
    prep("paper", async () => {
      const st = await fresh();
      if (!guardianIn) throw new Error("Enter an address (0x…) or an ENS name.");
      const paper = guardianIn;
      if (st.owners.some(o => o.toLowerCase() === paper.toLowerCase())) throw new Error("That address is already one of your keys. Recovery must be separate.");
      if (st.modules.includes(RECOVERY_60D) && paper.toLowerCase() === DAO.toLowerCase()) throw new Error("That's the DAO. It's already your 60-day recovery.");
      if (!st.guardians) throw new Error("Couldn't read the current recovery address. Try again in a moment.");
      const signers = ownerSigners(st, account);
      const w = await wedgieFor(signers);
      try {
        const p = await prepareOwners({ account, state: st, calls: setGuardianCalls(st.recoveryModule, st.guardians, paper), signers, feeToken, wedgie: w });
        return {
          label: <>Make <Addr a={paper} chainId={chainId} inline /> your recovery address</>,
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
        // the fee rule is set once (with the budget): re-send it only on a wallet from before it existed
        const calls = [...setBudgetCalls(account.address, { usdc: usdcV, eth: ethV }, now()), ...(st.budget.feeUsdc === null ? await feeApart() : [])];
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

  // a wallet that paired its wedgie before the 60-day layout: the same move on its own (the wedgie signs it too)
  const upgradeLayout = () =>
    prep("layout", async () => {
      const st = await fresh();
      const calls = await toLayout(st);
      if (!calls.length) throw new Error("Already done.");
      const signers = ownerSigners(st, account);
      const w = await wedgieFor(signers);
      try {
        const p = await prepareOwners({ account, state: st, calls, signers, feeToken, setup: true, wedgie: w, label: "Recovery: DAO 60 days" });
        return { label: "The DAO waits 60 days, your own address 14", p, settled: s => s.modules.includes(RECOVERY_60D), close: async () => w?.close() };
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
        // Instant alone (1 of 1) → 3 of 3: the wedgie + Instant. (An older wallet's Instant + hot, 2 of 2 → 3 of 4.)
        // recovery moves to 14 + 60 days in the same batch (first: see recoveryLayoutCalls)
        const calls = [
          ...(await toLayout(st)),
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
        <div className="stack" style={{ gap: 8 }} ref={confirmRef}>
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
  const layout = !!st?.modules.includes(RECOVERY_60D); // with the wedgie: DAO 60 days, yours 14


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
        <Step title="Wedgie (hardware key)">
          <p className="fine">Keeping more than about $100 here? Pair a wedgie. Instant then spends a daily limit, and anything bigger needs the wedgie too.</p>
          <p className="fine">
            {wedgieDrive() ? "Plug it into this iPhone" : "Plug it into a computer (Chrome)"}, open its Safe signer app, then add it. Don&apos;t have one?{" "}
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

      {st?.hasHot && <KeyRow kind="Hot wallet" a={hot} chainId={chainId} />}
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

      <Step title="Recovery" done={ownRecovery}>
        <p className="fine">
          {layout
            ? "If you lose a key, the DAO (dao.buidlguidl.eth) can replace it after 60 days."
            : ownRecovery
              ? `Your own address can replace lost keys after ${st?.recoveryDays ?? 7} days.`
              : `If you lose a key, the DAO (dao.buidlguidl.eth) can replace it after ${st?.recoveryDays ?? 7} days.`}{" "}
          {layout && (ownRecovery ? "Your own address can, after 14 days." : "Add your own address and it can, after 14 days.")} You can cancel any recovery.
          {!st?.hasWedgie && " Pairing a wedgie makes the DAO wait 60 days and your own address 14."}
        </p>
        {!ownRecovery && <p className="fine"><b>Make your own recovery: a wallet only you control.</b></p>}
        {st &&
          oldLayout(st) &&
          st.has60 &&
          action(
            "layout",
            <button className="btn wide" onClick={upgradeLayout} disabled={!!busy || !!pending || !!wait || !canPay}>
              {busy === "layout" ? "Working…" : "Make the DAO wait 60 days"}
            </button>,
          )}
        <p className="fine">
          No wallet for it yet? <a href="/paper">Make a 24-word seed on 3 paper cards</a>.
        </p>
        <div className="guardian">
          <AddressInput key={chainId} initial={current} onChange={setGuardianIn} />
        </div>
        {action(
          "paper",
          <button className="btn btn-green wide" onClick={setPaper} disabled={!!busy || !!pending || !!wait || !canPay || !changed || (!!st && oldLayout(st) && st.has60)}>
            {busy === "paper" ? "Working…" : "Save"}
          </button>,
        )}
      </Step>

      <Step title="Recovery alerts" key="alerts">
        <Alerts account={account} toast={toast} />
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
