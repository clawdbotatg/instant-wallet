"use client";

import { type ReactNode, useState } from "react";
import { type Address, encodeFunctionData, getAddress, isAddress, zeroAddress } from "viem";
import { CHAINS, chainById, explorerAddress } from "@/lib/chains";
import { short } from "@/lib/format";
import { DAO, VERIFIERS, VERIFIERS_SLOT2 } from "@/lib/safe/config";
import { type Call, DEFAULT_BUDGET, abi, budgetCalls, deploySignerCall, selfCall, setGuardianCalls } from "@/lib/safe/core";
import { connectHot, hotAvailable } from "@/lib/safe/hot";
import { type FeeToken, type Prepared, type Signer, finishOwners, ownerSigners, prepareOwners } from "@/lib/safe/send";
import { type ChainState, type SafeAccount, hotOf, wedgieSigners } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { Blockie, ChainChip, copy } from "../bits";
import { friendly } from "../Welcome";

const NAME = (a: string) => (a.toLowerCase() === DAO.toLowerCase() ? "dao.buidlguidl.eth" : short(a));

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
  // an error shows in the step whose button caused it, next to where you tapped
  const [error, setErrorRaw] = useState<{ what: string; msg: string } | null>(null);
  const [paperIn, setPaperIn] = useState("");
  const st = states.find(s => s.chainId === chainId);
  const usdc = chainById(chainId)?.usdc?.toLowerCase();
  const haveUsdc = assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdc && BigInt(a.balance) >= (chainId === 1 ? 10_000_000n : 1_000_000n));
  const haveEth = assets.some(a => a.chainId === chainId && a.asset === zeroAddress && BigInt(a.balance) > 0n);
  const feeToken: FeeToken = haveUsdc ? "usdc" : "eth";
  const canPay = haveUsdc || haveEth || assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdc && BigInt(a.balance) > 0n);
  const hot = st ? hotOf(account, st) : account.hot;
  const level = st?.level ?? 1;
  const keysWord = (n: number) => `${n} key${n === 1 ? "" : "s"}`;

  // the budget comes with the first second key, whichever it is (the burner is still the only owner then)
  const budgetFirst = (s: ChainState): Call[] =>
    s.threshold <= 1
      ? budgetCalls(account.address, chainById(chainId)!.usdc!, account.burnerSigner, DEFAULT_BUDGET, BigInt(Math.floor(Date.now() / 1000)), {
          rolesDeployed: s.rolesDeployed,
          rolesEnabled: !!s.roles,
        })
      : [];
  // a change the wedgie has to sign: connect it now, while this is still the tap (a port prompt needs one)
  const wedgieFor = async (signers: Signer[]) => (signers.includes("wedgie") ? await Wedgie.connect() : null);

  // two taps: the first gets everything ready (MetaMask / the wedgie connect, the fee, the nonce); the second signs.
  // Face ID has to start straight from a tap: after a MetaMask popup or a network call, Safari and Chrome refuse it.
  // The confirm replaces the step's own button, in place.
  const [pending, setPending] = useState<{ what: string; label: ReactNode; p: Prepared; after?: () => void; close?: () => Promise<void> } | null>(null);

  async function prep(what: string, fn: () => Promise<{ label: ReactNode; p: Prepared; after?: () => void; close?: () => Promise<void> }>) {
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
    try {
      await finishOwners(pending.p);
      pending.after?.();
      toast("Done");
      setPending(null);
      onRefresh();
    } catch (e: any) {
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
      if (!st) throw new Error("Still loading");
      const h = await connectHot();
      if (h.toLowerCase() === account.address.toLowerCase()) throw new Error("That's this wallet itself.");
      // Instant alone: 2 of 2. With the wedgie (3 of 3): 3 of 4, so the wedgie + any one.
      const calls = [...budgetFirst(st), selfCall(account.address, encodeFunctionData({ abi: abi.safe, functionName: "addOwnerWithThreshold", args: [h, st.hasWedgie ? 3n : 2n] }))];
      const signers = ownerSigners(st);
      const w = await wedgieFor(signers);
      try {
        const p = await prepareOwners({ account, state: st, calls, signers, feeToken, setup: true, wedgie: w });
        return { label: <>Add <Addr a={h} chainId={chainId} inline /> as your hot wallet</>, p, after: () => onAccount({ ...account, hot: h }), close: async () => w?.close() };
      } catch (e) {
        await w?.close();
        throw e;
      }
    });

  const setPaper = () =>
    prep("paper", async () => {
      if (!st) throw new Error("Still loading");
      if (!isAddress(paperIn.trim())) throw new Error("Paste the paper seed's address (0x…), from the wallet you made the seed in.");
      const paper = getAddress(paperIn.trim());
      if (st.owners.some(o => o.toLowerCase() === paper.toLowerCase())) throw new Error("That address is already one of your keys. The paper must be separate.");
      if (!st.guardians) throw new Error("Couldn't read the current recovery address. Try again in a moment.");
      const signers = ownerSigners(st);
      const w = await wedgieFor(signers);
      try {
        const p = await prepareOwners({ account, state: st, calls: setGuardianCalls(st.guardians, paper), signers, feeToken, wedgie: w });
        return {
          label: <>Make <Addr a={paper} chainId={chainId} inline /> your recovery address</>,
          p,
          after: () => {
            onAccount({ ...account, paper });
            setPaperIn("");
          },
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
      const w = await Wedgie.connect();
      try {
        const key = await w.key();
        const [w1, w2] = wedgieSigners(key);
        // Instant alone (1 of 1) → 3 of 3; Instant + hot (2 of 2) → 3 of 4. Either way the wedgie + one more.
        const calls = [
          ...budgetFirst(st),
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

  // what === the step's own action: its button, or the confirm that replaces it, plus that step's error
  const action = (what: string, button: ReactNode) => (
    <>
      {pending?.what === what ? (
        <div className="stack" style={{ gap: 8 }}>
          <b>{pending.label}</b>
          <p className="fine">
            Fee {pending.p.opts.feeToken === "usdc" ? `${(Number(pending.p.fee.feeUsdc) / 1e6).toFixed(4)} USDC` : `${(Number(pending.p.fee.feeEth) / 1e18).toFixed(6)} ETH`}. Signed by{" "}
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

  const ownRecovery = !!st?.guardians && st.guardians.length > 0 && !st.guardians.some(g => g.toLowerCase() === DAO.toLowerCase());

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
        Each chain&apos;s wallet is set up on its own. On {chainById(chainId)?.name}: {keysWord(level)}. Add the others in any order.
        {st && !st.deployed && " Not deployed here yet: the first change deploys it."}
      </p>
      {!canPay && <p className="err">Changes cost a few cents of gas, paid from this wallet. Add a little USDC or ETH on {chainById(chainId)?.name} first.</p>}

      <Step title="Instant wallet" done>
        <p className="fine">This phone&apos;s passkey. Alone it can do everything; once you add another key, it keeps a daily budget.</p>
        <Addr a={account.burnerSigner} chainId={chainId} />
      </Step>

      <Step title="Hot wallet" done={!!st?.hasHot}>
        {st?.hasHot ? (
          <>
            <p className="fine">
              {st.hasWedgie ? "Big moves need the wedgie + this hot wallet or your Instant wallet." : "Big moves need your Instant wallet + this hot wallet."} The
              Instant wallet alone: 100 USDC + 0.04 ETH a day.
            </p>
            {hot && <Addr a={hot} chainId={chainId} />}
            {st?.budget && (
              <p className="fine">
                Today&apos;s Instant wallet budget: {(Number(st.budget.usdc) / 1e6).toFixed(2)} USDC · {(Number(st.budget.eth) / 1e18).toFixed(4)} ETH
              </p>
            )}
          </>
        ) : (
          <>
            <p className="fine">
              Add your hot wallet as a second key: any wallet extension on your computer, or a wallet app on your phone. After this, anything over the Instant wallet&apos;s daily budget (100 USDC + 0.04 ETH) needs a second key.
              For now, open this page in that wallet: on a computer with the extension, or in the wallet app&apos;s own browser.
            </p>
            {action(
              "hot",
              <button className="btn btn-green wide" onClick={addHot} disabled={!!busy || !!pending || !canPay || !hotAvailable()}>
                {busy === "hot" ? "Connecting…" : hotAvailable() ? "Connect and add" : "No browser wallet here"}
              </button>,
            )}
          </>
        )}
      </Step>

      <Step title="Paper backup (your recovery)" done={ownRecovery}>
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
        {action(
          "paper",
          <button className="btn wide" onClick={setPaper} disabled={!!busy || !!pending || !canPay || !paperIn}>
            {busy === "paper" ? "Working…" : "Make it my recovery"}
          </button>,
        )}
      </Step>

      <Step title="Wedgie (cold)" done={!!st?.hasWedgie}>
        {st?.hasWedgie ? (
          <p className="fine">
            {st.hasHot
              ? "The wedgie counts twice. Big moves need the wedgie + your Instant wallet or hot wallet. The Instant wallet + hot wallet alone can't."
              : "The wedgie counts twice. Big moves need the wedgie + your Instant wallet; neither alone can."}
          </p>
        ) : (
          <>
            <p className="fine">
              Plug your wedgie into this computer (Chrome), open its Safe signer app, then add it. One press signs for both of its slots.
            </p>
            {action(
              "wedgie",
              <button className="btn btn-green wide" onClick={addWedgie} disabled={!!busy || !!pending || !canPay || !wedgieSupported()}>
                {busy === "wedgie" ? "Check the wedgie…" : !wedgieSupported() ? "Needs Chrome on a computer" : "Connect and add the wedgie"}
              </button>,
            )}
          </>
        )}
      </Step>

      <Step title="Full self-custody" done={!!st?.hasWedgie && ownRecovery}>
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

/** inline: sits in a sentence (no chain chip; the chain is already picked above) */
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
      {!inline && <ChainChip chainId={chainId} />}
    </span>
  );
}
