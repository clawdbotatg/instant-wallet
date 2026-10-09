"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { CHAINS, chainById } from "@/lib/chains";
import { amount as fmtAmount, short } from "@/lib/format";
import { siteCalls, siteGas, signForSite } from "@/lib/safe/connect";
import { type FeeToken, type Prepared, type Signer, type Stage, finishOwners, ownerSigners, prepareOwners, signerOptions } from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { type Pending, remember, respond } from "@/lib/walletconnect";
import { ChainChip } from "../bits";
import { CallLine, ConnectLayer, DappHead } from "../WalletConnect";
import { friendly } from "../Welcome";
import { SignerChoice } from "./Pick";

/** WalletConnect for the Safe wallet: the shared connect layer, with a card that signs the Safe way. */
export function SafeConnectLayer({
  account,
  states,
  feeTokenOn,
  onSent,
}: {
  account: SafeAccount;
  states: ChainState[];
  feeTokenOn: (chainId: number) => FeeToken;
  onSent: () => void;
}) {
  const chainIds = useMemo(() => CHAINS.map(c => c.id), []);
  return (
    <ConnectLayer
      address={account.address}
      chainIds={chainIds}
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
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [tick, setTick] = useState(0);
  const options = st && st.threshold > 1 ? signerOptions(st, account) : [];
  const [chosen, setChosen] = useState<Signer[] | null>(null);
  const signers: Signer[] =
    chosen && options.some(o => o.ready && o.signers.join() === chosen.join()) ? chosen : st ? ownerSigners(st, account) : ["burner"];
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
    try {
      if (pending.kind === "calls") {
        if (!prepared) return;
        if (prepared.fee.until < Date.now() + 30_000) return setTick(t => t + 1); // stale quote: a fresh one, then tap again
        const hash = await finishOwners({ ...prepared, opts: { ...prepared.opts, onStage: s => setStage(s) } });
        remember(hash, pending.chainId);
        await respond(pending.topic, pending.id, pending.method === "wallet_sendCalls" ? { id: hash } : hash);
      } else {
        const sig = await signForSite(account, st, signers, pending.hash, s => setStage(s));
        await respond(pending.topic, pending.id, sig);
      }
      onDone();
    } catch (e) {
      setError(friendly(e));
      setStage(null);
    }
  }

  const fee = prepared ? BigInt(feeToken === "usdc" ? prepared.fee.feeUsdc : prepared.fee.feeEth) : null;
  const feeLabel = fee === null ? "…" : feeToken === "usdc" ? `${fmtAmount(formatUnits(fee, 6))} USDC` : `${fmtAmount(formatUnits(fee, 18))} ETH`;
  const label: Record<string, string> = {
    quote: "Getting the fee…",
    signing: "Face ID…",
    "signing-hot": "Sign in your hot wallet…",
    "signing-wedgie": "Check the wedgie, press A…",
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
          <SignerChoice options={options} value={signers} onChange={setChosen} disabled={busy} />
        </div>
      </div>
      {!st && <p className="err">This wallet isn&apos;t on {chainById(pending.chainId)?.name ?? "that network"} here.</p>}
      {refused && <p className="err">{refused}</p>}
      {error && <p className="err">{error}</p>}
      {!refused && (
        <button className="btn btn-green wide" disabled={busy || !ready} onClick={go}>
          {busy ? label[stage!] ?? "…" : pending.kind === "calls" ? (prepared ? "Approve" : "Getting the fee…") : "Sign"}
        </button>
      )}
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
