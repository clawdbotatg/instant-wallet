"use client";

import { useCallback, useEffect, useState } from "react";
import { type Address, type Hash, type Hex, getAddress, isAddress, parseAbi, size, zeroAddress } from "viem";
import { chainById, explorerTx, publicClient } from "@/lib/chains";
import { short } from "@/lib/format";
import { recoverKeys, bio } from "@/lib/passkey";
import { MULTISEND_CALL_ONLY } from "@/lib/safe/config";
import { type Call, type Sig, abi, batch, execData, safeTxHash, signerAddress } from "@/lib/safe/core";
import { callsOf, relayFee } from "@/lib/safe/describe";
import { unpackMultiSend } from "@/lib/safe/fee";
import { connectHot, hotAvailable, hotSend, hotSign } from "@/lib/safe/hot";
import { feeCall, getQuote, ownerSigners, usesWedgie, waitFor } from "@/lib/safe/send";
import { signForSite } from "@/lib/safe/connect";
import { type Waiting, allSignatures, checkSigs, deleteHash, dropTx, fromLink, openTx, readWaiting, safeAppTxLink, shareTx, sigHex, txLink } from "@/lib/safe/share";
import { passkeySign } from "@/lib/safe/sign";
import { type ChainState, keyFromCode, loadAccount, loadSigners, readChain, wedgieHome, wedgieSigners } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import { BioSigner, Blockie, CopyLink, Eject, GreenButton, RemoveX, Who, useToast } from "../bits";
import { friendly } from "../Welcome";
import { ErrorLine } from "./WedgieButton";
import { WhatItDoes } from "./WhatItDoes";

type Onchain = { owners: Address[]; threshold: number; nonce: bigint; passkeys: Address[]; contracts: Address[]; version: string; homes: Record<string, Address> };
const PASSKEY_SIGNER_SIZE = 236; // a passkey signer proxy (lib/safe/state.ts): a phone's Face ID or a wedgie
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const SAFE_VERSION = parseAbi(["function VERSION() view returns (string)"]);
const ERC6492 = "6492".repeat(16); // the ERC-6492 suffix: a signature that deploys first (useless to a Safe)

/**
 * /tx/<chain>/<safe>#<code>: one Safe transaction anyone can open (docs/MULTI-SIGNER.md). What it does, who signed,
 * Sign with whatever you have (Face ID, a wedgie, a browser wallet), and Send once there are enough signatures.
 * Without a code (?h=<safeTxHash>) it's found in the shared queue. Inside the wallet (a sheet) it gets `code` and
 * leaves the address bar alone.
 */
/** Tell whoever waits on this Safe tx (a site that asked for it, SafeConnect) the chain hash, the moment there is one. */
const sentOut = (safeTx: Hex, hash: Hash) => window.dispatchEvent(new CustomEvent("iw:txsent", { detail: { safeTx, hash } }));

export function TxPage({ chainId, safe, code: inWallet }: { chainId: number; safe: Address; code?: string }) {
  const [w, setW] = useState<Waiting | null>(null);
  const [valid, setValid] = useState<Waiting["sigs"]>([]);
  const [chain, setChain] = useState<Onchain | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Hash | null>(null);
  const [missing, setMissing] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [mine, setMine] = useState<ChainState | null>(null);
  const [toast, setToast] = useToast();

  // the Safe from the chain, the tx from the link (or the queue), its signatures from everywhere, each checked
  const load = useCallback(async () => {
    const pc = publicClient(chainId);
    const [owners, threshold, nonce, version] = (await Promise.all([
      pc.readContract({ address: safe, abi: abi.safe, functionName: "getOwners" }),
      pc.readContract({ address: safe, abi: abi.safe, functionName: "getThreshold" }),
      pc.readContract({ address: safe, abi: abi.safe, functionName: "nonce" }),
      pc.readContract({ address: safe, abi: SAFE_VERSION, functionName: "VERSION" }).catch(() => ""),
    ])) as [Address[], bigint, bigint, string];
    const os = owners.map(o => getAddress(o));
    const codes = await Promise.all(os.map(o => pc.getCode({ address: o }).catch(() => undefined)));
    // each passkey signer's home address (what a wedgie shows on its screen), read from its contract's key
    const homes: Record<string, Address> = {};
    os.forEach((o, i) => {
      const k = keyFromCode(codes[i]);
      if (k) homes[o.toLowerCase()] = wedgieHome(k);
    });
    const isCode = (i: number) => !!codes[i] && codes[i] !== "0x";
    setChain({
      owners: os,
      threshold: Number(threshold),
      nonce,
      passkeys: os.filter((_, i) => isCode(i) && size(codes[i]!) === PASSKEY_SIGNER_SIZE),
      contracts: os.filter((_, i) => isCode(i) && size(codes[i]!) !== PASSKEY_SIGNER_SIZE),
      version,
      homes,
    });
    const code = inWallet ?? location.hash.slice(1);
    const linked = code ? fromLink(chainId, safe, code) : null;
    const h = (linked?.hash ?? (inWallet ? "" : new URLSearchParams(location.search).get("h")) ?? "").toLowerCase();
    const queue = await readWaiting(chainId, safe, 0n).catch(() => [] as Waiting[]);
    const q = queue.find(x => x.hash.toLowerCase() === h);
    const m = linked ?? q ?? null;
    if (!m) return setMissing(true);
    for (const s of q?.sigs ?? []) if (!m.sigs.some(x => eq(x.owner, s.owner))) m.sigs.push(s);
    m.label ??= q?.label;
    setW({ ...m });
    setValid(await checkSigs(m).catch(() => []));
    // this browser's own wallet is a signer here: read what it signs now, so Face ID starts straight from the tap
    const me = loadAccount();
    if (me && os.some(o => eq(o, me.address))) setMine(await readChain(chainId, me).catch(() => null));
  }, [chainId, safe, inWallet]);
  useEffect(() => {
    load().catch(e => setError(friendly(e)));
  }, [load]);

  // all of one press at once: a wedgie signs as two owners, and adding them one by one from the same `w` kept only the last
  async function add(...ss: Sig[]) {
    if (!w || !chain) return;
    for (const s of ss) if (!chain.owners.some(o => eq(o, s.signer))) throw new Error(`${short(s.signer)} isn't a signer on this wallet.`);
    const next: Waiting = {
      ...w,
      sigs: [...w.sigs.filter(x => !ss.some(s => eq(x.owner, s.signer))), ...ss.map(s => ({ owner: s.signer, signature: sigHex(s) }))],
    };
    setW(next);
    await shareTx(next);
    setValid(await checkSigs(next).catch(() => valid));
    if (!inWallet) history.replaceState(null, "", txLink(next).replace(location.origin, ""));
    setToast("Signed");
  }

  const run = (what: string, fn: () => Promise<void>) => async () => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  };

  // Face ID: this browser's wallet key if it's a signer here, else any passkey (worked out from a sign-in)
  const signFace = run("face", async () => {
    if (!w || !chain) return;
    const mine = loadAccount();
    if (mine && chain.owners.some(o => eq(o, mine.burnerSigner))) return add(await passkeySign(mine.credentialId, mine.burnerSigner, w.hash));
    const { credentialId, candidates } = await recoverKeys();
    const c = candidates.find(k => chain.owners.some(o => eq(o, signerAddress(k.qx, k.qy))));
    if (!c) throw new Error("That passkey isn't a signer on this wallet.");
    await add(await passkeySign(credentialId, signerAddress(c.qx, c.qy), w.hash));
  });

  const signWallet = run("wallet", async () => {
    if (!w) return;
    const who = await connectHot();
    await add(await hotSign(chainId, safe, w.tx, who));
  });

  const signWedgie = run("wedgie", async () => {
    if (!w || !chain) return;
    const wd = await Wedgie.connect();
    try {
      const slots = wedgieSigners(await wd.key()).filter(x => chain.owners.some(o => eq(o, x)));
      if (!slots.length) throw new Error("This wedgie isn't a signer on this wallet.");
      const sigs = await wd.sign(chainId, safe, w.tx, w.hash, slots);
      await add(...sigs);
    } finally {
      await wd.close();
    }
  });

  // this browser's Instant Wallet is the signer: its own keys sign for it (ERC-1271, as for a site), nothing is sent
  const signMine = run("mine", async () => {
    const me = loadAccount();
    if (!w || !me || !mine || !chain) return;
    // a 1.5 Safe asks its owner Safe about the tx's hash; a 1.4.1 one (wedgie.dev's) about its bytes, which a 1.5
    // Safe like this wallet can't answer (tested on a Base fork, 10-30): that needs an on-chain approveHash
    if (!chain.version.startsWith("1.5")) throw new Error(`This is an older Safe (${chain.version || "unknown version"}). Your wallet can't sign for it yet.`);
    const st = mine;
    if (!st.deployed) throw new Error(`Your wallet isn't on ${chainById(chainId)?.name ?? "this chain"} yet. Send anything from it there first.`);
    const signers = ownerSigners(st, me, true);
    if (usesWedgie(me, st, signers)) throw new Error("Your wallet needs its wedgie too, and a wedgie can't sign for another wallet yet.");
    const sig = await signForSite(me, st, signers, w.hash);
    if (sig.endsWith(ERC6492)) throw new Error(`Your ${bio()} key isn't on ${chainById(chainId)?.name ?? "this chain"} yet. Send anything from your wallet there first.`);
    await add({ signer: me.address, data: sig, kind: "contract" });
  });

  // enough signatures: the relay sends it (a fee is in an Instant Wallet batch), or your own wallet (you pay the gas)
  const sendRelay = run("send", async () => {
    if (!w) return;
    const ok = { ...w, sigs: valid };
    const r = await fetch("/api/safe/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId, kind: "exec", safe, tx: w.tx, signatures: allSignatures(ok), wedgie: (chain?.passkeys.length ?? 0) > 1 }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `relay: ${r.status}`);
    sentOut(w.hash, j.hash);
    await waitFor(chainId, j.hash);
    setSent(j.hash);
    load();
  });
  // Remove (as on Home's waiting card): this phone's Face ID signs Safe's delete message
  const remove = run("remove", async () => {
    const me = loadAccount();
    if (!w || !me) return;
    await dropTx(w, await passkeySign(me.credentialId, me.burnerSigner, deleteHash(w)));
    setRemoved(true);
  });
  const sendSelf = run("self", async () => {
    if (!w) return;
    const h = await hotSend(chainId, safe, execData(w.tx, allSignatures({ ...w, sigs: valid })));
    sentOut(w.hash, h);
    await waitFor(chainId, h);
    setSent(h);
    load();
  });

  const name = chainById(chainId)?.name ?? `chain ${chainId}`;
  if (removed)
    return (
      <div className="stack">
        <h2>Removed</h2>
        <p className="fine">It's off the list. Only Reject stops it for sure: its signatures can still run it until another transaction takes #{w?.tx.nonce.toString()}.</p>
      </div>
    );
  if (missing)
    return (
      <div className="stack">
        <h2>Transaction not found</h2>
        <p className="fine">Ask for the link again. It may have been sent or replaced already.</p>
      </div>
    );
  if (!w || !chain)
    return (
      <div className="stack">
        <h2>Loading…</h2>
        {error && <ErrorLine text={error} />}
      </div>
    );

  const done = w.tx.nonce < chain.nonce;
  const behind = w.tx.nonce > chain.nonce; // the wallet runs them in order: the one before it goes first (or is rejected)
  const enough = valid.length >= chain.threshold;
  // a Reject is just the relay's fee at another one's number: nothing to reject in it
  const fees = callsOf(w.tx).map(c => relayFee(chainId, c));
  const isReject = fees.length > 0 && fees.every(Boolean);
  // Reject (as on wedgie.dev): the fee alone at this number, so this one can never run. Its own page opens to sign.
  async function reject() {
    if (!w || !chain) return;
    setBusy("reject");
    setError(null);
    try {
      const q = await getQuote(chainId, chain.passkeys.length > 1 ? "exec-wedgie" : "exec");
      const t = batch([feeCall(q, fees.find(Boolean)?.token === "eth" ? "eth" : "usdc")], w.tx.nonce);
      const r: Waiting = { chainId, safe, tx: t, hash: safeTxHash(chainId, safe, t), sigs: [], label: `Reject: ${w.label ?? "transaction"}` };
      await shareTx(r);
      openTx(r);
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }
  const me = loadAccount();
  const calls: Call[] = eq(w.tx.to, MULTISEND_CALL_ONLY) && w.tx.operation === 1 ? safeUnpack(w.tx.data) : [{ to: w.tx.to, value: w.tx.value, data: w.tx.data }];
  const app = safeAppTxLink(chainId, safe, w.hash);
  const friends = loadSigners(safe);
  const mySlots = me?.wedgie ? wedgieSigners(me.wedgie).map(x => x.toLowerCase()) : [];
  // this phone's key, someone's Face ID (invited, or any passkey when this browser has no wallet), a wedgie, a browser wallet
  const kind = (o: Address): Kind => {
    if (me && eq(o, me.burnerSigner)) return "face";
    if (me && eq(o, me.address)) return "mine";
    if (chain.contracts.some(c => eq(c, o))) return "safe";
    if (!chain.passkeys.some(p => eq(p, o))) return hotAvailable() ? "wallet" : "other";
    if (mySlots.includes(o.toLowerCase())) return wedgieSupported() ? "wedgie" : "wedgieFar";
    if (friends[o.toLowerCase()]?.passkey) return me ? "person" : "face";
    // an unknown passkey signer: a wedgie this browser never paired, or (on a phone with no wallet here) your Face ID
    return wedgieSupported() ? "wedgie" : me ? "wedgieFar" : "face";
  };

  return (
    <div className="stack">
      {!inWallet && me && (
        <a className="fine" href="/">
          ← My wallet
        </a>
      )}
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <h2>{w.label ?? `Transaction #${w.tx.nonce}`}</h2>
        <span className="row" style={{ gap: 6 }}>
          {app && (
            <Eject href={app} title="Open in Safe{Wallet}">
              Safe
            </Eject>
          )}
          <CopyLink link={txLink(w)} />
        </span>
      </div>
      <p className="fine row" style={{ gap: 8 }}>
        <Who address={safe} chain={chainId} size={20} inline /> on {name}
      </p>

      <div className="card stack" style={{ gap: 6 }}>
        <WhatItDoes chainId={chainId} safe={safe} calls={calls} tx={w.tx} />
      </div>

      <div className="card stack" style={{ gap: 8 }}>
        <b>
          {valid.length} of {chain.threshold} signatures
        </b>
        {chain.owners.map(o => {
          const signed = valid.some(s => eq(s.owner, o));
          const k = kind(o);
          // a wedgie by the address on its own screen (same blockie as the device), never its signer contract
          const shown = (k === "wedgie" || k === "wedgieFar") && chain.homes[o.toLowerCase()] ? chain.homes[o.toLowerCase()] : o;
          // one wedgie press signs all its slots: the button sits on the first one waiting
          const firstWedgie = chain.owners.find(x => kind(x) === "wedgie" && !valid.some(s => eq(s.owner, x)));
          const act = signed || done || enough ? null : k === "face" ? signFace : k === "mine" && mine ? signMine : k === "wedgie" && firstWedgie === o ? signWedgie : k === "wallet" ? signWallet : null;
          return (
            <div key={o} className="keyrow" style={{ padding: 0, minHeight: 42 }}>
              <span className="row" style={{ gap: 8 }}>
                {k === "face" ? (
                  <BioSigner />
                ) : (
                  <Who address={shown} chain={chainId} label={NAMES[k]} plain={k === "wedgie" || k === "wedgieFar"} />
                )}
              </span>
              {signed ? (
                <span>✓ signed</span>
              ) : act ? (
                <button className="btn btn-sm btn-green" onClick={act} disabled={!!busy}>
                  {busy === k ? (k === "wedgie" ? <>Press <GreenButton /></> : "Signing…") : k === "face" ? bio() : "Sign"}
                </button>
              ) : (
                <span className="fine">waiting</span>
              )}
            </div>
          );
        })}
      </div>

      {sent ? (
        <p className="row" style={{ gap: 8 }}>
          ✓ Executed {explorerTx(chainId, sent) && <Eject href={explorerTx(chainId, sent)!} title="See it on the explorer">Explorer</Eject>}
        </p>
      ) : done ? (
        <p className="fine">This wallet already used number #{w.tx.nonce.toString()}: this one was executed or replaced.</p>
      ) : enough && behind ? (
        <p className="fine">Signed. It runs after #{chain.nonce.toString()}{w.tx.nonce - chain.nonce > 1n ? ` (and the others before it)` : ""}: execute or reject that one first.</p>
      ) : null}
      {/* ✕, Reject, Execute: one row, as on Home's waiting card */}
      {!sent && !done && (
        <div style={{ display: "flex", gap: 8 }}>
          {me && chain.owners.some(o => eq(o, me.burnerSigner)) && <RemoveX disabled={!!busy} busy={busy === "remove"} onClick={remove} />}
          {!isReject && (
            <button className="btn btn-sm" style={{ flex: "none" }} onClick={reject} disabled={!!busy}>
              {busy === "reject" ? "Getting ready…" : "Reject"}
            </button>
          )}
          {enough && !behind && (
            <button className="btn btn-sm btn-green" style={{ flex: 1, minWidth: 0 }} onClick={sendRelay} disabled={!!busy}>
              {busy === "send" ? "Executing…" : "Execute"}
            </button>
          )}
        </div>
      )}
      {error && <ErrorLine text={error} />}

      <p className="fine row" style={{ gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
        {enough && !done && !behind && !sent && hotAvailable() && (
          <a href="#" onClick={e => (e.preventDefault(), sendSelf())}>
            {busy === "self" ? "Executing…" : "Execute from my wallet (I pay gas)"}
          </a>
        )}
      </p>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

type Kind = "face" | "mine" | "safe" | "wedgie" | "wedgieFar" | "wallet" | "other" | "person";
// face: <BioSigner> (this device's name for it, Touch ID on a Mac)
const NAMES: Record<Kind, string> = {
  face: "",
  wedgie: "Wedgie",
  wedgieFar: "Wedgie (sign on a computer)",
  wallet: "Browser wallet",
  other: "Browser wallet",
  person: "Someone's passkey",
  mine: "My wallet",
  safe: "Another wallet", // a Safe: it signs from its own app (open this link there)
};

function safeUnpack(data: Hex): Call[] {
  try {
    return unpackMultiSend(data);
  } catch {
    return [];
  }
}

export const isSafeRoute = (chain: string, safe: string) => /^\d+$/.test(chain) && isAddress(safe) && safe !== zeroAddress;
