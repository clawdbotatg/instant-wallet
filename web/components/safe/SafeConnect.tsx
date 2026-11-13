"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type Hash, formatUnits } from "viem";
import { CHAINS, chainById, nativeSymbol } from "@/lib/chains";
import { amount as fmtAmount, feeText, when } from "@/lib/format";
import { siteCalls, siteGas, signForSite } from "@/lib/safe/connect";
import { type FeeToken, type Prepared, type Signer, type Stage, Shared, finishOwners, ownerSigners, prepareOwners, requote, signThenQueue, signerLabel, usesWedgie } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { type Pending, type Siwe, remember, respond } from "@/lib/walletconnect";
import { Net, Raw, Who, Words, stageLabel } from "../bits";
import { messageRows } from "@/lib/safe/raw";
import type { TypedCard } from "@/lib/safe/typed";
import { ConnectLayer, DappHead, type Session } from "../WalletConnect";
import { friendly } from "@/lib/friendly";
import { Progress } from "./Progress";
import { ErrorLine } from "./WedgieButton";
import { WhatItDoes } from "./WhatItDoes";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import { bio } from "@/lib/passkey";

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
      request={(pending, onDone, onNo, onBusy) => (
        <SafeRequest
          pending={pending}
          account={account}
          state={states.find(s => s.chainId === pending.chainId)}
          feeToken={feeTokenOn(pending.chainId)}
          onDone={() => (onDone(), onSent())}
          onNo={onNo}
          onBusy={onBusy}
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
  onBusy,
}: {
  pending: Pending;
  account: SafeAccount;
  state?: ChainState;
  feeToken: FeeToken;
  onDone: () => void;
  onNo: () => void;
  onBusy: (b: boolean) => void;
}) {
  const [stage, setStage] = useState<Stage | null>(null);
  const [hash, setHash] = useState<Hash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [tick, setTick] = useState(0);
  const quoteFailed = useRef(false); // the error on screen is a failed fee quote (cleared when the next one lands)
  // no choosing who signs (Austin, 10-29): a transaction is Face ID, then its page, where any other signer adds theirs
  // and the site gets its answer when it's sent; a message (the site needs it back here) is the first set that can sign
  const queue = !!st && pending.kind === "calls" && signThenQueue(st, account);
  const signers: Signer[] = st ? ownerSigners(st, account, !queue) : [account.burnerSigner];
  const busy = stage !== null;
  useEffect(() => onBusy(busy), [busy]); // eslint-disable-line react-hooks/exhaustive-deps

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
    let again: ReturnType<typeof setTimeout> | undefined;
    setPrepared(null);
    (async () => {
      const dappGas = await siteGas(st.chainId, account.address, calls!);
      const p = await prepareOwners({ account, state: st, calls: calls!, signers, feeToken, dappGas, label: pending.dapp.name });
      if (!live) return;
      setPrepared(p);
      if (quoteFailed.current) setError(null);
      quoteFailed.current = false;
    })().catch(e => {
      if (!live) return;
      // say why, and ask again in 5 s: the button must not sit on "Getting the fee…" for good
      setError(friendly(e));
      quoteFailed.current = true;
      again = setTimeout(() => setTick(t => t + 1), 5_000);
    });
    return () => {
      live = false;
      clearTimeout(again);
    };
  }, [st?.chainId, st?.nonce, signers.join(), feeToken, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // the fee follows gas while the sheet is up (EXPECTATIONS #6; Austin 11-12: it was read once, and a jump in gas
  // only showed after the tap). Every 15 s, the same tx and number with the new fee; never once signing has started.
  const now = useRef({ prepared, busy });
  now.current = { prepared, busy };
  useEffect(() => {
    if (!prepared || busy) return;
    const t = setInterval(() => {
      const was = now.current.prepared;
      if (document.hidden || !was) return;
      requote(was)
        .then(p => p !== was && now.current.prepared === was && !now.current.busy && setPrepared(p))
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, [!!prepared, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go() {
    if (!st) return;
    setError(null);
    quoteFailed.current = false;
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
  const feeLabel = prepared ? feeText(prepared.fee, feeToken, nativeSymbol(pending.chainId)) : "…";
  const ready = !!st && !refused && (pending.kind === "sign" || !!prepared);

  return (
    <div className="stack confirm">
      <DappHead {...pending.dapp} />
      {pending.kind === "calls" ? (
        calls && (
          <div className="card stack" style={{ gap: 8 }}>
            <WhatItDoes chainId={pending.chainId} safe={account.address} calls={calls} signs={prepared?.t} />
          </div>
        )
      ) : pending.siwe ? (
        <>
          <SignIn siwe={pending.siwe} site={pending.dapp.url} safe={account.address} />
          <Raw rows={messageRows(pending.chainId, account.address, pending)} />
        </>
      ) : pending.typed ? (
        <Typed typed={pending.typed} chainId={pending.chainId}>
          <Raw rows={messageRows(pending.chainId, account.address, pending)} />
        </Typed>
      ) : (
        <>
          <h2>Sign this?</h2>
          <div className="recess" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", fontSize: 14 }}>
            {pending.preview}
          </div>
          {/* text a person can read moves no money; bytes that aren't text could be anything (an order's hash) */}
          {pending.raw && pending.preview === pending.raw ? (
            <p className="err">This isn&apos;t text, so the wallet can&apos;t read it. Only sign if you trust the site.</p>
          ) : (
            <p className="fine">Moves no money. Read it anyway.</p>
          )}
          <Raw rows={messageRows(pending.chainId, account.address, pending)} />
        </>
      )}
      <div className="card">
        <div className="line">
          <span>Network</span>
          <span><Net chainId={pending.chainId} /></span>
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
            <span>{st ? <Words text={signerLabel(account, st, signers)} /> : bio()}</span>
            {queue && <span className="fine">then the others, on the next screen</span>}
          </span>
        </div>
      </div>
      {!st && <p className="err">This wallet isn&apos;t on <Net chainId={pending.chainId} /> here.</p>}
      {refused && <ErrorLine text={refused} />}
      {error && <ErrorLine text={error} />}
      {!refused && (
        <button className="btn btn-green wide" disabled={busy || !ready} onClick={go}>
          {busy ? stageLabel(stage) : pending.kind === "calls" ? (prepared ? "Sign" : "Getting the fee…") : "Sign"}
        </button>
      )}
      <Progress stage={stage} chainId={pending.chainId} hash={hash} />
      {!busy && (
        <button className="btn wide" onClick={onNo}>
          Reject
        </button>
      )}
      <p className="fine center">
        from <Who address={account.address} size={18} inline />
      </p>
    </div>
  );
}

/**
 * A typed-data request (EIP-712, lib/safe/typed.ts). A signature like this can move money with no transaction (a
 * token's permit, Permit2, an order), so it never says "moves no money": a permit says who may spend what, in red;
 * then the app, its network and the contract that takes the signature; then the message's own fields.
 */
function Typed({ typed, chainId, children }: { typed: TypedCard; chainId: number; children?: React.ReactNode }) {
  return (
    <>
      <h2>Sign this?</h2>
      {typed.warn.map((w, i) => (
        <p key={i} className="err" data-typed-warn style={{ fontWeight: 600 }}>
          <Words text={w} chain={chainId} />
        </p>
      ))}
      {typed.otherChain !== undefined && (
        <p className="err">
          This is for another network: <Net chainId={typed.otherChain} />.
        </p>
      )}
      <div className="card">
        <div className="line">
          <span>App</span>
          <span>{typed.app}{typed.version ? ` (${typed.version})` : ""}</span>
        </div>
        {typed.contract && (
          <div className="line">
            <span>Contract</span>
            <span><Who address={typed.contract} chain={typed.chain ?? chainId} size={18} inline /></span>
          </div>
        )}
      </div>
      <div className="recess stack" style={{ gap: 2, maxHeight: 260, overflow: "auto", fontSize: 14, wordBreak: "break-word" }}>
        {typed.lines.map((l, i) => (
          <span key={i}><Words text={l} chain={chainId} /></span>
        ))}
      </div>
      {children}
    </>
  );
}

/**
 * A Sign-In with Ethereum request (ERC-4361), shown as a sign-in: where to, the site's own line, when it ends.
 * Red when it names another site than the one asking (a phishing page passing on a real site's sign-in), or another
 * account than this wallet.
 */
function SignIn({ siwe, site, safe }: { siwe: Siwe; site: string; safe: string }) {
  let host = "";
  try {
    host = site ? new URL(site).host.toLowerCase() : "";
  } catch {}
  const elsewhere = host && host !== siwe.domain.toLowerCase();
  const other = siwe.address.toLowerCase() !== safe.toLowerCase();
  return (
    <>
      <h2>Sign in to {siwe.domain}?</h2>
      {elsewhere && <ErrorLine text={`This is a sign-in for ${siwe.domain}, but ${host} is asking.`} />}
      {other && <ErrorLine text={`It names another account: ${siwe.address}`} />}
      {siwe.statement && <p style={{ fontSize: 15 }}>“{siwe.statement}”</p>}
      <p className="fine">Moves no money.{siwe.expires ? ` Ends ${when(siwe.expires)}.` : ""}</p>
    </>
  );
}
