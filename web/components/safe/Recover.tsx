"use client";

import { useEffect, useState } from "react";
import { type Address, type Hash, isAddress } from "viem";
import { explorerTx } from "@/lib/chains";
import { connectHot, hotAvailable, hotCall } from "@/lib/safe/hot";
import { type Party, type Via, feeCoin, finishCall, partyWallets, startCall, viaFor } from "@/lib/safe/recover";
import { type Prepared, Shared, finishOwners, ownerSigners, prepareOwners, waitFor } from "@/lib/safe/send";
import { type SafeAccount, readChain } from "@/lib/safe/state";
import { when as when_ } from "@/lib/format";
import { friendly } from "@/lib/friendly";
import { AddressInput, ExecutedLine, Net, Who, stageLabel } from "../bits";
import { ErrorLine } from "./WedgieButton";
import { Progress, useSendProgress } from "./Progress";

const keyOf = (p: Party) => `${p.chainId}:${p.module}:${p.address}`;

/**
 * Recover this wallet (Austin 11-23): for someone who holds one of its recovery addresses, from the wallet's own
 * page. The owner's new signer, checked by voice, then Start on each network; after the wait, Finish. The bare tool
 * at /recover stays for the rest (a wallet never set up on a network, a Safe transaction to copy).
 */
export function Recover({ account, parties, newSigner, onRefresh }: { account: SafeAccount; parties: Party[]; newSigner?: string | null; onRefresh: () => void }) {
  const from = newSigner && isAddress(newSigner) ? newSigner : "";
  const [newKey, setNewKey] = useState<Address | null>(null);
  // the new signer is whoever's key this is: a link can come from anyone. Start waits for a check by voice
  const [voiced, setVoiced] = useState<string | null>(null);
  const checked = !!newKey && voiced === newKey;
  const [vias, setVias] = useState<Record<string, Via | null> | null>(null);
  const [tick, setTick] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all(parties.map(async p => [keyOf(p), await viaFor(p)] as const)).then(r => live && setVias(Object.fromEntries(r)));
    return () => {
      live = false;
    };
  }, [parties, tick]);

  const mine = vias ? parties.filter(p => vias[keyOf(p)]) : [];
  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      await connectHot(partyWallets(parties));
      setTick(t => t + 1);
    } catch (e: any) {
      setError(/^Switch your wallet/.test(e?.message ?? "") ? "That browser wallet isn't a recovery address for this wallet. Switch it to one that is." : friendly(e));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="stack">
      <h2>Recover this wallet</h2>
      <Who address={account.address} />
      <div className="field">
        <label>Their new signer</label>
        <AddressInput initial={from} onChange={setNewKey} />
      </div>
      {newKey && (
        <div className="stack" style={{ gap: 6 }}>
          <Who plain address={newKey} />
          <p className={checked ? "fine" : "err"}>
            {from && from.toLowerCase() === newKey.toLowerCase() ? "From a link. " : ""}
            This key gets the wallet. Call the owner: check the picture and {newKey.slice(-4)} by voice.
          </p>
          <button className="btn wide" disabled={checked} onClick={() => setVoiced(newKey)}>
            {checked ? "Checked" : "I checked it by voice"}
          </button>
        </div>
      )}
      {mine.map(p => (
        <Row key={keyOf(p)} wallet={account.address} p={p} via={vias![keyOf(p)]!} newKey={checked ? newKey : null} onRefresh={onRefresh} />
      ))}
      {vias && !mine.length && (
        <>
          {hotAvailable() && (
            <button className="btn btn-green wide" onClick={connect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect"}
            </button>
          )}
          <a className="fine" style={{ textAlign: "center" }} href={`/recover?wallet=${account.address}${newKey ? `&owner=${newKey}` : ""}`}>
            Do it by hand
          </a>
        </>
      )}
      {error && <ErrorLine text={error} />}
    </div>
  );
}

/** One network: Start, or what's running there and Finish once its wait is over. */
function Row({ wallet, p, via, newKey, onRefresh }: { wallet: Address; p: Party; via: Via; newKey: Address | null; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<Prepared | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [hash, setHash] = useState<Hash | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bar = useSendProgress();
  const r = p.request;
  const due = !!r && Date.now() >= r.executeAfter;
  const call = r ? (due ? finishCall(p, wallet) : null) : newKey ? startCall(p, wallet, newKey) : null;
  // a new signer typed after Start was got ready: that one is for the old signer
  useEffect(() => setReady(null), [newKey]);

  async function go() {
    if (!call) return;
    setBusy(true);
    setError(null);
    try {
      if ("wallet" in via) {
        // the recovery address is this browser wallet: it sends it and pays the gas
        setStage("sending");
        const h = await hotCall(p.chainId, via.wallet, call);
        setHash(h);
        setStage("confirming");
        await waitFor(p.chainId, h);
      } else if (!ready) {
        // two taps: get it ready, then sign (Face ID must start straight from a tap)
        const st = await readChain(p.chainId, via.account);
        const feeToken = await feeCoin(p.chainId, via.account.address);
        setReady(await prepareOwners({ account: via.account, state: st, calls: [call], signers: ownerSigners(st, via.account), feeToken, label: `${r ? "Finish recovering" : "Recover"} ${wallet}` }));
        return;
      } else {
        bar.watch(ready);
        const h = await finishOwners(ready);
        setHash(h);
      }
      setDone(true);
      onRefresh();
    } catch (e: any) {
      setReady(null); // its page has the sheet now (Shared), or it failed: the next tap gets a fresh fee and number
      if (e instanceof Shared) return;
      setError(friendly(e));
    } finally {
      bar.end();
      setStage(null);
      setBusy(false);
    }
  }

  const verb = r ? "Finish" : "Start";
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <b>
          <Net chainId={p.chainId} />
        </b>
        <span className="fine">{p.days} days</span>
      </div>
      <span className="fine">
        as <Who plain inline size={18} address={p.address} chain={p.chainId} />
      </span>
      {r && r.newOwners.map(o => <Who key={o} address={o} chain={p.chainId} />)}
      {done ? (
        <ExecutedLine href={hash && explorerTx(p.chainId, hash)} />
      ) : r && !due ? (
        <button className="btn wide" disabled>
          Ready {when_(r.executeAfter)}
        </button>
      ) : (
        <button className="btn btn-green wide" onClick={go} disabled={busy || !call}>
          {busy ? stageLabel(ready ? (bar.stage ?? "signing") : (stage ?? "quote")) : ready ? `Sign to ${verb.toLowerCase()}` : verb}
        </button>
      )}
      <Progress stage={bar.stage ?? stage} chainId={p.chainId} hash={bar.hash ?? hash} />
      {error && <ErrorLine text={error} />}
    </div>
  );
}
