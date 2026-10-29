"use client";

import { useEffect, useMemo, useState } from "react";
import { type Hash, formatUnits } from "viem";
import { CHAINS, chainById } from "@/lib/chains";
import { amount as fmtAmount, short } from "@/lib/format";
import { siteCalls, siteGas, signForSite } from "@/lib/safe/connect";
import { type FeeToken, type Prepared, type Signer, type Stage, Shared, finishOwners, ownerSigners, prepareOwners, signThenQueue, signerLabel, usesWedgie } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { type Pending, remember, respond } from "@/lib/walletconnect";
import { ChainChip } from "../bits";
import { CallLine, ConnectLayer, DappHead, type Session } from "../WalletConnect";
import { friendly } from "../Welcome";
import { Progress } from "./Progress";
import { ErrorLine } from "./WedgieButton";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";

/** A site's transaction that went to its page for more signatures: answer the site when that page sends it. */
function answerWhenSent(safeTx: Hash, answer: (hash: Hash) => Promise<void>) {
  const on = (e: Event) => {
    const d = (e as CustomEvent<{ safeTx: Hash; hash: Hash }>).detail;
    if (d.safeTx.toLowerCase() !== safeTx.toLowerCase()) return;
    window.removeEventListener("iw:txsent", on);
    answer(d.hash).catch(() => {});
  };
  window.addEventListener("iw:txsent", on);
}

/** WalletConnect for the Safe wallet: the shared connect layer, with a card that signs the Safe way. */
export function SafeConnectLayer({
  account,
  states,
  feeTokenOn,
  onSent,
  onSessions,
}: {
  account: SafeAccount;
  states: ChainState[];
  feeTokenOn: (chainId: number) => FeeToken;
  onSent: () => void;
  onSessions?: (s: Session[]) => void;
}) {
  const chainIds = useMemo(() => CHAINS.map(c => c.id), []);
  return (
    <ConnectLayer
      address={account.address}
      chainIds={chainIds}
      onSessions={onSessions}
      request={(pending, onDone, onNo) => (
        <SafeRequest
          pending={pending}
          account={account}
          state={states.find(s => s.chainId === pending.chainId)}
          feeToken={feeTokenOn(pending.chainId)}
          onDone={() => (onDone(), onSent())}
          onNo={onNo}
        />
      )}
    />
  );
}

function SafeRequest({
  pending,
  account,
  state: st,
  feeToken,
  onDone,
  onNo,
}: {
  pending: Pending;
  account: SafeAccount;
  state?: ChainState;
  feeToken: FeeToken;
  onDone: () => void;
  onNo: () => void;
}) {
  const [stage, setStage] = useState<Stage | null>(null);
  const [hash, setHash] = useState<Hash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [tick, setTick] = useState(0);
  // no choosing who signs (Austin, 10-29): a transaction is Face ID, then its page, where any other signer adds theirs
  // and the site gets its answer when it's sent; a message (the site needs it back here) is the first set that can sign
  const queue = !!st && pending.kind === "calls" && signThenQueue(st, account);
  const signers: Signer[] = st ? ownerSigners(st, account, !queue) : [account.burnerSigner];
  const busy = stage !== null;

  let calls: ReturnType<typeof siteCalls> | null = null;
  let refused: string | null = null;
  if (pending.kind === "calls") {
    try {
      calls = siteCalls(account.address, pending.calls);
    } catch (e: any) {
      refused = e.message;
    }
  }

  // quote, nonce and hash before the tap: Face ID must start straight from it
  useEffect(() => {
    if (!st || !calls || busy) return;
    let live = true;
    setPrepared(null);
    (async () => {
      const dappGas = await siteGas(st.chainId, account.address, calls!);
      const p = await prepareOwners({ account, state: st, calls: calls!, signers, feeToken, dappGas, label: `${pending.dapp.name}: ${calls!.length} step${calls!.length > 1 ? "s" : ""}` });
      if (live) setPrepared(p);
    })().catch(e => live && setError(friendly(e)));
    return () => {
      live = false;
    };
  }, [st?.chainId, st?.nonce, signers.join(), feeToken, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go() {
    if (!st) return;
    setError(null);
    let w: Wedgie | null = null;
    try {
      if (pending.kind === "calls" && !prepared) return;
      if (pending.kind === "calls" && prepared!.fee.until < Date.now() + 30_000) return setTick(t => t + 1); // stale quote: a fresh one, then tap again
      // the wedgie first, while it's still the tap: Chrome's port prompt needs one, and Face ID used it up
      // (10-27: "Must be handling a user gesture" on a Uniswap swap from the extension)
      if (st && usesWedgie(account, st, signers) && wedgieSupported() && (pending.kind === "calls" || pending.raw)) w = await Wedgie.connect();
      if (pending.kind === "calls") {
        if (!prepared) return;
        // answer the site the moment the relay has the hash, as any wallet does: the site watches the chain itself
        // (10-10: answering only after the receipt left Uniswap on "Confirm in wallet" for the whole wait)
        let answered: Promise<void> | null = null;
        const answer = (hash: Hash) => {
          remember(hash, pending.chainId);
          return (answered ??= respond(pending.topic, pending.id, pending.method === "wallet_sendCalls" ? { id: hash } : hash));
        };
        let hash: Hash;
        try {
          hash = await finishOwners({
            ...prepared,
            opts: {
              ...prepared.opts,
              wedgie: w ?? prepared.opts.wedgie,
              onStage: (s, h) => {
                setStage(s);
                if (h) setHash(h);
                if (s === "confirming" && h) answer(h).catch(() => {}); // a dropped socket shows again below
              },
            },
          });
        } catch (e) {
          if (!(e instanceof Shared)) throw e;
          // signed with Face ID; its page is open (finishOwners), the others sign there and it answers the site
          answerWhenSent(e.w.hash, answer);
          return onDone();
        }
        await answer(hash);
      } else {
        const sig = await signForSite(account, st, signers, pending.hash, s => setStage(s), pending.raw, w);
        await respond(pending.topic, pending.id, sig);
      }
      onDone();
    } catch (e) {
      setError(friendly(e));
      setStage(null);
      setHash(null);
    } finally {
      await w?.close();
    }
  }

  const fee = prepared ? BigInt(feeToken === "usdc" ? prepared.fee.feeUsdc : prepared.fee.feeEth) : null;
  const feeLabel = fee === null ? "…" : feeToken === "usdc" ? `${fmtAmount(formatUnits(fee, 6))} USDC` : `${fmtAmount(formatUnits(fee, 18))} ETH`;
  const label: Record<string, string> = {
    quote: "Getting the fee…",
    signing: "Face ID…",
    "signing-hot": "Sign in your hot wallet…",
    "signing-wedgie": "Press green on the wedgie…",
    sending: "Sending…",
    confirming: "Confirming…",
  };
  const ready = !!st && !refused && (pending.kind === "sign" || !!prepared);

  return (
    <div className="stack confirm">
      <DappHead {...pending.dapp} />
      {pending.kind === "calls" ? (
        <>
          <h2>{pending.calls.length > 1 ? `${pending.calls.length} steps, all or nothing` : "Approve?"}</h2>
          <div className="card stack" style={{ gap: 12 }}>
            {pending.calls.map((c, i) => (
              <CallLine key={i} call={c} chainId={pending.chainId} />
            ))}
          </div>
        </>
      ) : (
        <>
          <h2>Sign this?</h2>
          <div className="recess" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", fontSize: 14 }}>
            {pending.preview}
          </div>
          <p className="fine">Signing proves it's your wallet. It doesn't move money by itself, but read it.</p>
        </>
      )}
      <div className="card">
        <div className="line">
          <span>Network</span>
          <ChainChip chainId={pending.chainId} />
        </div>
        {pending.kind === "calls" && (
          <div className="line">
            <span>Fee</span>
            <span>{feeLabel}</span>
          </div>
        )}
        <div className="line">
          <span>Signed by</span>
          <span className="stack" style={{ gap: 2, justifyItems: "end" }}>
            <span>{st ? signerLabel(account, st, signers) : "Face ID"}</span>
            {queue && <span className="fine">then the others, on the next screen</span>}
          </span>
        </div>
      </div>
      {!st && <p className="err">This wallet isn&apos;t on {chainById(pending.chainId)?.name ?? "that network"} here.</p>}
      {refused && <p className="err">{refused}</p>}
      {error && <ErrorLine text={error} />}
      {!refused && (
        <button className="btn btn-green wide" disabled={busy || !ready} onClick={go}>
          {busy ? label[stage!] ?? "…" : pending.kind === "calls" ? (prepared ? "Approve" : "Getting the fee…") : "Sign"}
        </button>
      )}
      <Progress stage={stage} chainId={pending.chainId} hash={hash} />
      {!busy && (
        <button className="btn wide" onClick={onNo}>
          Reject
        </button>
      )}
      <p className="fine center">
        from <span className="mono">{short(account.address)}</span>
      </p>
    </div>
  );
}
