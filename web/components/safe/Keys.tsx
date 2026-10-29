"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type Address, type Hex, encodeFunctionData, formatUnits, zeroAddress } from "viem";
import { brainKey, isXdai, oldBurnerKey } from "@/lib/brand";
import { claimKey } from "@/lib/claim";
import { CHAINS, chainById, explorerAddress, nativeSymbol } from "@/lib/chains";
import { amount, short } from "@/lib/format";
import { DAO, FEE_ALLOWANCE, RECOVERY_60D, VERIFIERS } from "@/lib/safe/config";
import { type Call, DEFAULT_BUDGET, abi, signerAddress, budgetCalls, deploySignerCall, feeAllowanceCalls, recoveryLayoutCalls, selfCall } from "@/lib/safe/core";
import type { Waiting } from "@/lib/safe/share";
import { SharedDone } from "./Waiting";
import { type FeeToken, type Prepared, Shared, type Signer, finishOwners, getQuote, howSigns, ownerSigners, prepareOwners, signerLabel, usesWedgie } from "@/lib/safe/send";
import { type ChainState, type SafeAccount, daoDays, loadSigners, loadWalletName, readChain, saveSigner, wedgieSigners } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { AddressInput, Blockie, PencilIcon, TimedBar, copy } from "../bits";
import { Alerts } from "./Alerts";
import { ChainSelect } from "./Pick";
import { ChainLimit } from "./Limits";
import { friendly } from "../Welcome";
import { ErrorLine, WedgieIcon, WedgiePanel } from "./WedgieButton";

/**
 * Settings, per chain (each chain's Safe is its own). A plain Safe multisig (Austin 10-28: no kinds of signer):
 *   Signers     any addresses, M of N, add / remove / change M. How each one signs is worked out per address
 *               (lib/safe/send.ts howSigns): this phone's Face ID, the wedgie (one signer; older wallets have it
 *               twice), or a browser wallet.
 *   Daily limit what Face ID alone can send once M > 1 (Zodiac Roles); set up when M goes past 1.
 *   Recovery    the DAO only, when too many signers are lost: 7 days, or 60. You can cancel it in that time.
 *               (Older wallets may still have their own recovery address on: it's shown.)
 */
export function Keys({
  account,
  states,
  assets,
  toast,
  onAccount,
  onRefresh,
  onFund,
}: {
  account: SafeAccount;
  states: ChainState[];
  assets: Asset[];
  toast: (m: string) => void;
  onAccount: (a: SafeAccount) => void;
  onRefresh: () => Promise<void> | void;
  onFund: (chainId: number) => void;
}) {

  const [chainId, setChainId] = useState(CHAINS[0].id);
  const [busy, setBusy] = useState<string | null>(null);
  // an error shows in the step whose button caused it, next to where you tapped
  const [error, setErrorRaw] = useState<{ what: string; msg: string } | null>(null);
  const [signerIn, setSignerIn] = useState<Address | null>(null);
  const [recEdit, setRecEdit] = useState(false); // recovery: one line until Edit / learn more
  const [keysEdit, setKeysEdit] = useState(false); // signers: the list until Edit
  const [wedgieOpen, setWedgieOpen] = useState(false);
  const [shared, setShared] = useState<Waiting | null>(null); // a change signed here that needs the others (its link) // the wedgie panel (status, find, install), under the signers
  const st = states.find(s => s.chainId === chainId);
  const usdc = chainById(chainId)?.usdc?.toLowerCase();
  const haveUsdc = assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdc && BigInt(a.balance) >= (chainId === 1 ? 10_000_000n : 1_000_000n));
  const haveEth = assets.some(a => a.chainId === chainId && a.asset === zeroAddress && BigInt(a.balance) > 0n);
  const feeToken: FeeToken = haveUsdc ? "usdc" : "eth";
  const canPay = haveUsdc || haveEth || assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdc && BigInt(a.balance) > 0n);

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
  const wedgieFor = async (s: ChainState, signers: Signer[]) => (usesWedgie(account, s, signers) && wedgieSupported() ? await Wedgie.connect() : null);

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
      if (e instanceof Shared) {
        setShared(e.w); // a wallet with other people on it: they sign from the link
        setPending(null);
      } else setErrorRaw({ what: pending.what, msg: friendly(e) });
    } finally {
      await pending.close?.();
      setBusy(null);
    }
  }

  const signLabel = (p: Prepared) => signerLabel(account, p.opts.state, p.opts.signers);

  /** An owners change (`calls` from the fresh chain state), confirmed with Yes like every other step. */
  const ownersChange = (what: string, label: ReactNode, build: (s: ChainState) => Promise<Call[]> | Call[], settled: (s: ChainState) => boolean, after?: () => void) =>
    prep(what, async () => {
      const st = await fresh();
      const calls = await build(st);
      const signers = ownerSigners(st, account);
      const w = await wedgieFor(st, signers);
      try {
        const p = await prepareOwners({ account, state: st, calls, signers, feeToken, setup: true, wedgie: w, label: typeof label === "string" ? label : "Change the signers" });
        return { label, p, settled, after, close: async () => w?.close() };
      } catch (e) {
        await w?.close();
        throw e;
      }
    });
  const safeCall = (functionName: "addOwnerWithThreshold" | "removeOwner" | "changeThreshold", args: readonly unknown[]) =>
    selfCall(account.address, encodeFunctionData({ abi: abi.safe, functionName, args } as any));
  const same = (x: Address, y: Address) => x.toLowerCase() === y.toLowerCase();

  // invites (components/safe/Join.tsx): a link a friend opens to send their passkey's public key; once it's back,
  // Add makes it a signer here (its signer contract is deployed in the same batch). Kept till dismissed, so the
  // same person can be added on each network.
  const IKEY = `iws.invites.${account.address.toLowerCase()}`;
  type Inv = { id: string; at: number; answer?: { x: Hex; y: Hex; name?: string } };
  const [invites, setInvites] = useState<Inv[]>([]);
  const [newInvite, setNewInvite] = useState<string | null>(null);
  const saveInvites = (l: Inv[]) => {
    setInvites(l);
    try {
      localStorage.setItem(IKEY, JSON.stringify(l.map(({ id, at }) => ({ id, at }))));
    } catch {}
  };
  useEffect(() => {
    let l: Inv[] = [];
    try {
      l = JSON.parse(localStorage.getItem(IKEY) || "[]");
    } catch {}
    setInvites(l);
  }, [IKEY]);
  const waiting = invites.filter(i => !i.answer).map(i => i.id).join();
  useEffect(() => {
    if (!waiting) return;
    const look = async () => {
      const got = await Promise.all(
        invites.map(async i => (i.answer ? i : { ...i, answer: (await fetch(`/api/safe/invite?id=${i.id}`).then(r => r.json()).catch(() => null))?.answer })),
      );
      if (got.some((g, k) => g.answer && !invites[k].answer)) setInvites(got);
    };
    look();
    const t = setInterval(look, 5_000);
    return () => clearInterval(t);
  }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  async function invite() {
    setErrorRaw(null);
    try {
      const r = await fetch("/api/safe/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ safe: account.address, from: loadWalletName(account.address) ?? undefined }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `invite: ${r.status}`);
      saveInvites([...invites, { id: j.id, at: Date.now() }]);
      setNewInvite(`${location.origin}/join#${j.id}`);
    } catch (e: any) {
      setErrorRaw({ what: "invite", msg: friendly(e) });
    }
  }
  const dismiss = (id: string) => {
    fetch(`/api/safe/invite?id=${id}`, { method: "DELETE" }).catch(() => {});
    saveInvites(invites.filter(i => i.id !== id));
  };
  const addFriend = (i: Inv) => {
    const { x, y, name } = i.answer!;
    const who = signerAddress(x, y);
    ownersChange(
      `join${i.id}`,
      <>Add {name ?? "them"} (<Addr a={who} chainId={chainId} inline />) as a signer</>,
      st => {
        if (st.owners.some(o => same(o, who))) throw new Error("Already a signer here.");
        return [deploySignerCall(x, y, VERIFIERS), safeCall("addOwnerWithThreshold", [who, BigInt(st.threshold)])];
      },
      s => s.owners.some(o => same(o, who)),
      () => saveSigner(account.address, who, { name, passkey: true }),
    );
  };

  const addSigner = () => {
    const a = signerIn;
    if (!a) return;
    ownersChange(
      "add",
      <>Add <Addr a={a} chainId={chainId} inline /> as a signer</>,
      st => {
        if (st.owners.some(o => same(o, a))) throw new Error("That address is already a signer.");
        if (same(a, account.address)) throw new Error("That's this wallet itself.");
        return [safeCall("addOwnerWithThreshold", [a, BigInt(st.threshold)])];
      },
      s => s.owners.some(o => same(o, a)),
    );
  };

  const removeSigner = (a: Address) =>
    ownersChange(
      `rm${a}`,
      <>Remove <Addr a={a} chainId={chainId} inline />{same(a, account.burnerSigner) ? " (this phone's Face ID: it can't sign after this)" : ""}</>,
      st => {
        const i = st.owners.findIndex(o => same(o, a));
        if (i < 0) throw new Error("That address isn't a signer any more.");
        if (st.owners.length < 2) throw new Error("A wallet needs at least one signer.");
        // getOwners is the Safe's linked list in order: the one before it, or the sentinel for the first
        const prev = i === 0 ? "0x0000000000000000000000000000000000000001" : st.owners[i - 1];
        return [safeCall("removeOwner", [prev, a, BigInt(Math.min(st.threshold, st.owners.length - 1))])];
      },
      s => !s.owners.some(o => same(o, a)),
    );

  const setThreshold = (t: number) =>
    ownersChange(
      "threshold",
      `Need ${t} of ${st?.owners.length} signers`,
      async st => [
        // going past 1 of N: Face ID gets its daily limit in the same batch (it can't send alone any more)
        ...(st.threshold <= 1 && t > 1 && st.owners.some(o => same(o, account.burnerSigner)) ? await budgetFirst(st) : []),
        safeCall("changeThreshold", [BigInt(t)]),
      ],
      s => s.threshold === t,
    );

  // a wallet that paired its wedgie before the 60-day layout: the same move on its own (the wedgie signs it too)
  const upgradeLayout = () =>
    prep("layout", async () => {
      const st = await fresh();
      const calls = await toLayout(st);
      if (!calls.length) throw new Error("Already done.");
      const signers = ownerSigners(st, account);
      const w = await wedgieFor(st, signers);
      try {
        const p = await prepareOwners({ account, state: st, calls, signers, feeToken, setup: true, wedgie: w, label: "Recovery: DAO 60 days" });
        return { label: "The DAO waits 60 days", p, settled: s => s.modules.includes(RECOVERY_60D), close: async () => w?.close() };
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
        const [w1] = wedgieSigners(key);
        // one more signer, and one more needed: Face ID alone (1 of 1) → Face ID + wedgie (2 of 2), with Face ID's
        // daily limit; recovery moves to the DAO's 60 days in the same batch (first: see recoveryLayoutCalls)
        const calls = [
          ...(await toLayout(st)),
          ...(await budgetFirst(st)),
          deploySignerCall(key.x, key.y, VERIFIERS),
          safeCall("addOwnerWithThreshold", [w1, BigInt(st.threshold + 1)]),
        ];
        const p = await prepareOwners({ account, state: st, calls, signers: ownerSigners(st, account), feeToken, setup: true, wedgie: w });
        return { label: "Add your wedgie as a signer", p, after: () => onAccount({ ...account, wedgie: key }), settled: s => s.hasWedgie, close: () => w.close() };
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
          <TimedBar ms={wait.ms} />
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
      {error?.what === what && <ErrorLine text={error.msg} />}
    </>
  );

  const layout = !!st?.modules.includes(RECOVERY_60D);
  const daoWait = st ? daoDays(st) : null;
  const idle = !!busy || !!pending || !!wait || !canPay;


  if (shared && st) return <SharedDone w={shared} need={st.threshold} onDone={() => setShared(null)} />;

  return (
    <div className="stack">
      <h2>Instant Wallet is a Safe multisig</h2>
      <ChainSelect value={chainId} onChange={setChainId} />
      {st && (
        <Summary key={chainId} account={account} st={st} assets={assets} onRefresh={onRefresh} toast={toast}>
          {st.owners.map(o => (
            <div className="keyrow" key={o} style={{ padding: 0 }}>
              <span className="row" style={{ gap: 8 }}>
                {howSigns(account, st, o) === "wedgie" && st.wedgieHomes[o.toLowerCase()] ? (
                  // the wedgie by the address on its own home screen; the owner (its signer contract) when opened
                  <span className="stack" style={{ gap: 2 }}>
                    <Addr a={st.wedgieHomes[o.toLowerCase()]} chainId={chainId} />
                    {wedgieOpen && (
                      <span className="fine">
                        signs through <Addr a={o} chainId={chainId} inline />
                      </span>
                    )}
                  </span>
                ) : (
                  <Addr a={o} chainId={chainId} />
                )}
                {howSigns(account, st, o) === "faceid" && <span className="fine">Face ID</span>}
                {howSigns(account, st, o) !== "faceid" && loadSigners(account.address)[o.toLowerCase()]?.name && <b>{loadSigners(account.address)[o.toLowerCase()].name}</b>}
                {howSigns(account, st, o) === "wedgie" && (
                  <button className="pill row" style={{ gap: 4 }} onClick={() => setWedgieOpen(v => !v)} aria-expanded={wedgieOpen}>
                    <WedgieIcon size={26} /> wedgie
                  </button>
                )}
              </span>
              {keysEdit && st.owners.length > 1 && action(`rm${o}`, <button className="btn btn-sm" onClick={() => removeSigner(o)} disabled={idle}>Remove</button>)}
            </div>
          ))}
          {wedgieOpen && st.hasWedgie && <WedgiePanel account={account} states={states} />}
          {!keysEdit ? (
            <button className="btn btn-sm" onClick={() => setKeysEdit(true)}>
              Edit signers
            </button>
          ) : (
            <>
              {st.owners.length > 1 && (
                <div className="stack" style={{ gap: 6 }}>
                  <b>Signatures needed</b>
                  {action(
                    "threshold",
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      {st.owners.map((_, i) => (
                        <button key={i} className={`pill ${st.threshold === i + 1 ? "on" : ""}`} disabled={idle || st.threshold === i + 1} onClick={() => setThreshold(i + 1)}>
                          {i + 1} of {st.owners.length}
                        </button>
                      ))}
                    </div>,
                  )}
                </div>
              )}
              <div className="stack" style={{ gap: 6 }}>
                <b>Add a signer</b>
                <p className="fine">
                  Any address: MetaMask, a Ledger, another phone&apos;s wallet. No wallet for it? <a href="/paper">Make a 24-word seed on 3 paper cards</a>.
                </p>
                <AddressInput key={chainId} onChange={setSignerIn} />
                {action(
                  "add",
                  <button className="btn btn-green wide" onClick={addSigner} disabled={idle || !signerIn}>
                    {busy === "add" ? "Working…" : "Add signer"}
                  </button>,
                )}
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <b>Invite someone</b>
                <p className="fine">They open a link and use their own Face ID. Then they sign from the links you send them.</p>
                <button className="btn wide" onClick={invite} disabled={!!busy}>
                  Invite signer
                </button>
                {error?.what === "invite" && <ErrorLine text={error.msg} />}
                {newInvite && (
                  <div className="row" style={{ gap: 6 }}>
                    <span className="mono fine grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {newInvite}
                    </span>
                    <button
                      className="btn btn-sm btn-green"
                      onClick={async () => {
                        if (navigator.share) return navigator.share({ url: newInvite, title: "Be a signer" }).catch(() => {});
                        toast((await copy(newInvite)) ? "Link copied" : "Couldn't copy");
                      }}
                    >
                      Share
                    </button>
                  </div>
                )}
                {invites.map(i => {
                  const who = i.answer && signerAddress(i.answer.x, i.answer.y);
                  const here = !!who && st.owners.some(o => same(o, who));
                  return (
                    <div key={i.id} className="stack" style={{ gap: 6 }}>
                      <div className="keyrow" style={{ padding: 0 }}>
                        {who ? (
                          <span className="row" style={{ gap: 8 }}>
                            <Addr a={who} chainId={chainId} />
                            <b>{i.answer!.name ?? "Someone"}</b>
                          </span>
                        ) : (
                          <span className="fine">Invite sent, waiting for them…</span>
                        )}
                        <button className="pill" onClick={() => dismiss(i.id)} aria-label="Remove this invite">
                          ×
                        </button>
                      </div>
                      {who &&
                        (here ? (
                          <span className="fine">A signer on {chainById(chainId)?.name}.</span>
                        ) : (
                          action(
                            `join${i.id}`,
                            <button className="btn btn-green wide" onClick={() => addFriend(i)} disabled={idle}>
                              Add {i.answer!.name ?? "them"} on {chainById(chainId)?.name}
                            </button>,
                          )
                        ))}
                    </div>
                  );
                })}
              </div>
              {!st.hasWedgie && (
                <>
                  <button className="btn btn-dark wide" onClick={() => setWedgieOpen(v => !v)} aria-expanded={wedgieOpen}>
                    <WedgieIcon size={34} /> Add a wedgie
                  </button>
                  {wedgieOpen && (
                    <WedgiePanel
                      account={account}
                      states={states}
                      add={action(
                        "wedgie",
                        <button className="btn btn-green wide" onClick={addWedgie} disabled={idle}>
                          {busy === "wedgie" ? "Check the wedgie…" : "Add it as a signer"}
                        </button>,
                      )}
                    />
                  )}
                </>
              )}
              <button className="btn btn-sm" onClick={() => setKeysEdit(false)} disabled={!!busy}>
                Done
              </button>
            </>
          )}
        </Summary>
      )}

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



      <div className="card stack" style={{ gap: 10 }}>
        {st?.recoveries
          .filter(r => r.guardians?.length)
          .map(r => (
            <div className="keyrow" key={r.module} style={{ padding: 0 }}>
              <b>{r.days}-day recovery</b>
              <span className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {r.guardians!.map(g => (
                  <Addr key={g} a={g} chainId={chainId} name={g.toLowerCase() === DAO.toLowerCase() ? "dao.buidlguidl.eth" : undefined} />
                ))}
              </span>
            </div>
          ))}
        {!recEdit ? (
          <button className="btn btn-sm" onClick={() => setRecEdit(true)}>
            Edit / learn more
          </button>
        ) : (
          <>
            <p className="fine">
              If you lose too many signers to sign, the DAO (dao.buidlguidl.eth) can replace them after {daoWait ?? 7} days. You can cancel a recovery you didn&apos;t start
              any time before then.
              {!layout && " Make it wait 60 days to get more time to cancel."}
            </p>
            {st &&
              st.has60 &&
              !layout &&
              action(
                "layout",
                <button className="btn wide" onClick={upgradeLayout} disabled={idle}>
                  {busy === "layout" ? "Working…" : "Make the DAO wait 60 days"}
                </button>,
              )}
            <button className="btn btn-sm" onClick={() => setRecEdit(false)} disabled={!!busy}>
              Done
            </button>
          </>
        )}
      </div>

      <Step title="Recovery alerts" key="alerts">
        <Alerts account={account} toast={toast} />
      </Step>


      <OldBurner toast={toast} />
    </div>
  );
}

/**
 * xdai.io: the old Burner Wallet. Copy out a key this browser has (lib/brand.ts), or load one from somewhere else, as
 * a private key or as the old "seed phrase" box's text (any text: lib/brand.ts brainKey). Loading opens the move screen.
 */
function OldBurner({ toast }: { toast: (m: string) => void }) {
  const [key, setKey] = useState<Hex | null>(null);
  const [xdai, setXdai] = useState(false);
  const [pk, setPk] = useState("");
  const [phrase, setPhrase] = useState("");
  useEffect(() => {
    // only on xdai.io, only after an old Burner was moved into this wallet
    setKey(isXdai() ? oldBurnerKey() : null);
    setXdai(isXdai());
  }, []);
  const load = (k: Hex | null) => {
    if (!k) return toast("That's not a private key");
    window.location.href = `/pk#${k}`; // the claim screen: what's on it, then move it into this wallet
  };
  const field = { autoComplete: "off", autoCorrect: "off", autoCapitalize: "none", spellCheck: false } as const;
  return (
    <>
      {key && (
        <button className="btn wide" onClick={async () => toast((await copy(key)) ? "Old Burner private key copied" : "Couldn't copy")}>
          Copy old Burner private key
        </button>
      )}
      {xdai && (
        <div className="card stack" style={{ gap: 10 }}>
          <b>Load old Burner Wallet</b>
          <div className="row">
            <div className="input grow">
              <input {...field} placeholder="private key" value={pk} onChange={e => setPk(e.target.value)} />
            </div>
            <button className="btn btn-green btn-sm" disabled={!pk.trim()} onClick={() => load(claimKey(pk.trim(), true))}>
              Load
            </button>
          </div>
          <div className="row">
            <div className="input grow">
              <input {...field} type="password" placeholder="seed phrase" value={phrase} onChange={e => setPhrase(e.target.value)} />
            </div>
            <button className="btn btn-green btn-sm" disabled={!phrase} onClick={() => load(brainKey(phrase))}>
              Load
            </button>
          </div>
          <p className="fine">Type the seed phrase exactly as you did in the old Burner Wallet, spaces and capitals too.</p>
        </div>
      )}
    </>
  );
}


/** This chain's Safe: the daily limit (Face ID alone), M of N for anything else, then the signers (`children`). */
function Summary({ account, st, assets, onRefresh, toast, children }: { account: SafeAccount; st: ChainState; assets: Asset[]; onRefresh: () => void; toast: (m: string) => void; children: ReactNode }) {
  const [edit, setEdit] = useState(false);
  const close = useCallback(() => setEdit(false), []); // stable: the editor's wait effect depends on it
  const coin = nativeSymbol(st.chainId);
  const b = st.threshold > 1 ? st.budget : null;
  return (
    <div className="card stack" style={{ gap: 10 }}>
      {b && (
        <p className="row" style={{ gap: 8 }}>
          <span>
            Daily limit: <b>{amount(formatUnits(b.usdcMax, 6))} USDC + {amount(formatUnits(b.ethMax, 18))} {coin}</b>
          </span>
          {!edit && (
            <button aria-label="Change the daily limit" onClick={() => setEdit(true)} style={{ border: 0, padding: 4, background: "none", color: "var(--muted)", cursor: "pointer", display: "flex" }}>
              <PencilIcon size={16} />
            </button>
          )}
        </p>
      )}
      {b && edit && <ChainLimit account={account} st={st} assets={assets} onRefresh={onRefresh} toast={toast} onClose={close} />}
      <p>
        {b ? "Anything else" : "Signers"}:{" "}
        <b>
          {st.threshold} of {st.owners.length}
        </b>
      </p>
      {children}
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

/** An address: blockie + short link (or its name) to the explorer (no chain chip: the chain is already picked above). inline: in a sentence */
function Addr({ a, chainId, inline, name }: { a: Address; chainId: number; inline?: boolean; name?: string }) {
  const url = explorerAddress(chainId, a);
  return (
    <span className="row" style={inline ? { display: "inline-flex", gap: 6, verticalAlign: "middle" } : { gap: 8 }}>
      <Blockie address={a} size={inline ? 18 : 22} />
      {url ? (
        <a className="mono" href={url} target="_blank" rel="noreferrer" style={inline ? undefined : { fontSize: 13 }}>
          {name ?? short(a)}
        </a>
      ) : (
        <span className="mono">{name ?? short(a)}</span>
      )}
    </span>
  );
}
