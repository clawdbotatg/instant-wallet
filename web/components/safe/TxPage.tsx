"use client";

import { useCallback, useEffect, useState } from "react";
import { type Address, type Hash, type Hex, getAddress, isAddress, size, zeroAddress } from "viem";
import { chainById, explorerTx, publicClient } from "@/lib/chains";
import { short } from "@/lib/format";
import { recoverKeys, bio } from "@/lib/passkey";
import { MULTISEND_CALL_ONLY } from "@/lib/safe/config";
import { type Call, type Sig, abi, execData, signerAddress } from "@/lib/safe/core";
import { unpackMultiSend } from "@/lib/safe/fee";
import { connectHot, hotAvailable, hotSend, hotSign } from "@/lib/safe/hot";
import { waitFor } from "@/lib/safe/send";
import { type Waiting, allSignatures, checkSigs, fromLink, readWaiting, safeAppTxLink, shareTx, sigHex, txLink } from "@/lib/safe/share";
import { passkeySign } from "@/lib/safe/sign";
import { keyFromCode, loadAccount, loadSigners, wedgieHome, wedgieSigners } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import { Blockie, Eject, GreenButton, copy, useToast } from "../bits";
import { friendly } from "../Welcome";
import { ErrorLine } from "./WedgieButton";
import { WhatItDoes } from "./WhatItDoes";

type Onchain = { owners: Address[]; threshold: number; nonce: bigint; passkeys: Address[]; homes: Record<string, Address> };
const PASSKEY_SIGNER_SIZE = 236; // a passkey signer proxy (lib/safe/state.ts): a phone's Face ID or a wedgie
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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
  const [toast, setToast] = useToast();

  // the Safe from the chain, the tx from the link (or the queue), its signatures from everywhere, each checked
  const load = useCallback(async () => {
    const pc = publicClient(chainId);
    const [owners, threshold, nonce] = (await Promise.all([
      pc.readContract({ address: safe, abi: abi.safe, functionName: "getOwners" }),
      pc.readContract({ address: safe, abi: abi.safe, functionName: "getThreshold" }),
      pc.readContract({ address: safe, abi: abi.safe, functionName: "nonce" }),
    ])) as [Address[], bigint, bigint];
    const os = owners.map(o => getAddress(o));
    const codes = await Promise.all(os.map(o => pc.getCode({ address: o }).catch(() => undefined)));
    // each passkey signer's home address (what a wedgie shows on its screen), read from its contract's key
    const homes: Record<string, Address> = {};
    os.forEach((o, i) => {
      const k = keyFromCode(codes[i]);
      if (k) homes[o.toLowerCase()] = wedgieHome(k);
    });
    setChain({ owners: os, threshold: Number(threshold), nonce, passkeys: os.filter((_, i) => !!codes[i] && codes[i] !== "0x" && size(codes[i]!) === PASSKEY_SIGNER_SIZE), homes });
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

  // enough signatures: the relay sends it (a fee is in an Instant Wallet batch), or your own wallet (you pay the gas)
  const sendRelay = run("send", async () => {
    if (!w) return;
    const ok = { ...w, sigs: valid };
    const r = await fetch("/api/safe/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId, kind: "exec", safe, tx: w.tx, signatures: allSignatures(ok) }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `relay: ${r.status}`);
    sentOut(w.hash, j.hash);
    await waitFor(chainId, j.hash);
    setSent(j.hash);
    load();
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
  const enough = valid.length >= chain.threshold;
  const me = loadAccount();
  const calls: Call[] = eq(w.tx.to, MULTISEND_CALL_ONLY) && w.tx.operation === 1 ? safeUnpack(w.tx.data) : [{ to: w.tx.to, value: w.tx.value, data: w.tx.data }];
  const app = safeAppTxLink(chainId, safe, w.hash);
  const share = async () => {
    const link = txLink(w);
    if (navigator.share) return navigator.share({ url: link, title: w.label ?? "Sign this" }).catch(() => {});
    setToast((await copy(link)) ? "Link copied" : "Couldn't copy");
  };
  const friends = loadSigners(safe);
  const mySlots = me?.wedgie ? wedgieSigners(me.wedgie).map(x => x.toLowerCase()) : [];
  // this phone's key, someone's Face ID (invited, or any passkey when this browser has no wallet), a wedgie, a browser wallet
  const kind = (o: Address): Kind => {
    if (me && eq(o, me.burnerSigner)) return "face";
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
          {inWallet && <Eject href={txLink(w)} title="Open its own page" />}
        </span>
      </div>
      <p className="fine row" style={{ gap: 8 }}>
        <Blockie address={safe} size={20} /> <span className="mono">{short(safe)}</span> on {name}
      </p>

      <div className="card stack" style={{ gap: 6 }}>
        <WhatItDoes chainId={chainId} safe={safe} calls={calls} />
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
          const act = signed || done || enough ? null : k === "face" ? signFace : k === "wedgie" && firstWedgie === o ? signWedgie : k === "wallet" ? signWallet : null;
          return (
            <div key={o} className="keyrow" style={{ padding: 0, minHeight: 42 }}>
              <span className="row" style={{ gap: 8 }}>
                <Blockie address={shown} size={22} />
                <span className="stack" style={{ gap: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{NAMES[k]}</span>
                  <span className="mono fine" style={{ fontSize: 12 }}>
                    {short(shown)}
                  </span>
                </span>
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
          ✓ Sent {explorerTx(chainId, sent) && <Eject href={explorerTx(chainId, sent)!} title="See it on the explorer">Explorer</Eject>}
        </p>
      ) : done ? (
        <p className="fine">This wallet already used number #{w.tx.nonce.toString()}: this one was sent or replaced.</p>
      ) : enough ? (
        <button className="btn btn-green wide" onClick={sendRelay} disabled={!!busy}>
          {busy === "send" ? "Sending…" : "Send it"}
        </button>
      ) : (
        <button className="btn wide" onClick={share}>
          Share with another signer
        </button>
      )}
      {error && <ErrorLine text={error} />}

      <p className="fine row" style={{ gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
        {(enough || done || sent) && (
          <a href="#" onClick={e => (e.preventDefault(), share())}>
            Share
          </a>
        )}
        {enough && !done && !sent && hotAvailable() && (
          <a href="#" onClick={e => (e.preventDefault(), sendSelf())}>
            {busy === "self" ? "Sending…" : "Send from my wallet (I pay gas)"}
          </a>
        )}
      </p>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

type Kind = "face" | "wedgie" | "wedgieFar" | "wallet" | "other" | "person";
const NAMES: Record<Kind, string> = {
  face: "Face ID",
  wedgie: "Wedgie",
  wedgieFar: "Wedgie (sign on a computer)",
  wallet: "Browser wallet",
  other: "Browser wallet",
  person: "Someone's Face ID",
};

function safeUnpack(data: Hex): Call[] {
  try {
    return unpackMultiSend(data);
  } catch {
    return [];
  }
}

export const isSafeRoute = (chain: string, safe: string) => /^\d+$/.test(chain) && isAddress(safe) && safe !== zeroAddress;
