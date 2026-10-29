"use client";

import { useCallback, useEffect, useState } from "react";
import { type Address, type Hash, type Hex, formatUnits, getAddress, isAddress, zeroAddress } from "viem";
import { chainById, explorerTx, nativeSymbol, publicClient } from "@/lib/chains";
import { short } from "@/lib/format";
import { recoverKeys } from "@/lib/passkey";
import { MULTISEND_CALL_ONLY } from "@/lib/safe/config";
import { type Call, type Sig, abi, execData, signerAddress } from "@/lib/safe/core";
import { unpackMultiSend } from "@/lib/safe/fee";
import { connectHot, hotAvailable, hotSend, hotSign } from "@/lib/safe/hot";
import { waitFor } from "@/lib/safe/send";
import { type Waiting, allSignatures, checkSigs, fromLink, readWaiting, safeAppTxLink, shareTx, sigHex, txLink } from "@/lib/safe/share";
import { passkeySign } from "@/lib/safe/sign";
import { loadAccount, wedgieSigners } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import { Blockie, copy, useToast } from "../bits";
import { friendly } from "../Welcome";
import { ErrorLine, WedgieIcon } from "./WedgieButton";

type Onchain = { owners: Address[]; threshold: number; nonce: bigint };
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * /tx/<chain>/<safe>#<code>: one Safe transaction anyone can open (docs/MULTI-SIGNER.md). What it does, who signed,
 * Sign with whatever you have (Face ID, a wedgie, a browser wallet), and Send once there are enough signatures.
 * Without a code (?h=<safeTxHash>) it's found in the shared queue.
 */
export function TxPage({ chainId, safe }: { chainId: number; safe: Address }) {
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
    setChain({ owners: owners.map(o => getAddress(o)), threshold: Number(threshold), nonce });
    const code = location.hash.slice(1);
    const linked = code ? fromLink(chainId, safe, code) : null;
    const h = (linked?.hash ?? new URLSearchParams(location.search).get("h") ?? "").toLowerCase();
    const queue = await readWaiting(chainId, safe, 0n).catch(() => [] as Waiting[]);
    const q = queue.find(x => x.hash.toLowerCase() === h);
    const m = linked ?? q ?? null;
    if (!m) return setMissing(true);
    for (const s of q?.sigs ?? []) if (!m.sigs.some(x => eq(x.owner, s.owner))) m.sigs.push(s);
    m.label ??= q?.label;
    setW({ ...m });
    setValid(await checkSigs(m).catch(() => []));
  }, [chainId, safe]);
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
    history.replaceState(null, "", txLink(next).replace(location.origin, ""));
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
    await waitFor(chainId, j.hash);
    setSent(j.hash);
    load();
  });
  const sendSelf = run("self", async () => {
    if (!w) return;
    const h = await hotSend(chainId, safe, execData(w.tx, allSignatures({ ...w, sigs: valid })));
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
  const mineSigned = !!me && valid.some(s => eq(s.owner, me.burnerSigner)); // this browser's Face ID already signed
  const calls: Call[] = eq(w.tx.to, MULTISEND_CALL_ONLY) && w.tx.operation === 1 ? safeUnpack(w.tx.data) : [{ to: w.tx.to, value: w.tx.value, data: w.tx.data }];
  const app = safeAppTxLink(chainId, safe, w.hash);

  return (
    <div className="stack">
      <h2>{w.label ?? `Transaction #${w.tx.nonce}`}</h2>
      <p className="fine row" style={{ gap: 8 }}>
        <Blockie address={safe} size={20} /> <span className="mono">{short(safe)}</span> on {name}
      </p>

      <div className="card stack" style={{ gap: 6 }}>
        <b>What it does</b>
        {calls.map((c, i) => (
          <span key={i} className="fine">
            {describe(chainId, safe, c)}
          </span>
        ))}
      </div>

      <div className="card stack" style={{ gap: 8 }}>
        <b>
          {valid.length} of {chain.threshold} signatures
        </b>
        {chain.owners.map(o => {
          const signed = valid.some(s => eq(s.owner, o));
          return (
            <div key={o} className="keyrow" style={{ padding: 0 }}>
              <span className="row" style={{ gap: 8 }}>
                <Blockie address={o} size={22} />
                <span className="mono" style={{ fontSize: 13 }}>
                  {short(o)}
                </span>
              </span>
              <span className={signed ? "" : "fine"}>{signed ? "✓ signed" : "waiting"}</span>
            </div>
          );
        })}
      </div>

      {sent ? (
        <p>
          Sent.{" "}
          <a href={explorerTx(chainId, sent)} target="_blank" rel="noreferrer">
            See it
          </a>
        </p>
      ) : done ? (
        <p className="fine">This wallet already used number #{w.tx.nonce.toString()}: this one was sent or replaced.</p>
      ) : enough ? (
        <>
          <button className="btn btn-green wide" onClick={sendRelay} disabled={!!busy}>
            {busy === "send" ? "Sending…" : "Send it"}
          </button>
          {hotAvailable() && (
            <button className="btn wide" onClick={sendSelf} disabled={!!busy}>
              {busy === "self" ? "Sending…" : "Send from my wallet (I pay the gas)"}
            </button>
          )}
        </>
      ) : (
        <>
          {!mineSigned && (
            <button className="btn btn-green wide" onClick={signFace} disabled={!!busy}>
              {busy === "face" ? "Signing…" : "Sign with Face ID"}
            </button>
          )}
          {wedgieSupported() ? (
            <button className="btn btn-dark wide" onClick={signWedgie} disabled={!!busy}>
              <WedgieIcon size={30} /> {busy === "wedgie" ? "Press A on the wedgie…" : "Sign with a wedgie"}
            </button>
          ) : (
            <p className="fine">To sign with a wedgie, open this link on your computer.</p>
          )}
          <button
            className={`btn wide ${mineSigned ? "btn-green" : ""}`}
            onClick={async () => {
              const link = txLink(w);
              if (navigator.share) return navigator.share({ url: link, title: w.label ?? "Sign this" }).catch(() => {});
              setToast((await copy(link)) ? "Link copied" : "Couldn't copy");
            }}
          >
            Share with another signer
          </button>
          {hotAvailable() && (
            <button className="btn wide" onClick={signWallet} disabled={!!busy}>
              {busy === "wallet" ? "Signing…" : "Sign with my wallet"}
            </button>
          )}
        </>
      )}
      {error && <ErrorLine text={error} />}

      <button className="btn btn-sm" onClick={async () => setToast((await copy(txLink(w))) ? "Link copied" : "Couldn't copy")}>
        Copy link for the other signers
      </button>
      {app && (
        <a className="btn btn-sm" href={app} target="_blank" rel="noreferrer">
          Open in Safe&#123;Wallet&#125; ↗
        </a>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function safeUnpack(data: Hex): Call[] {
  try {
    return unpackMultiSend(data);
  } catch {
    return [];
  }
}

/** One call, in words: a coin sent, a signer change, else the contract and function. */
function describe(chainId: number, safe: Address, c: Call): string {
  const d = c.data;
  const sel = d.slice(0, 10).toLowerCase();
  const arg = (i: number) => `0x${d.slice(10 + i * 64, 10 + (i + 1) * 64)}`;
  const addr = (i: number) => getAddress(`0x${arg(i).slice(26)}`);
  if (d === "0x") return `Send ${formatUnits(c.value, 18)} ${nativeSymbol(chainId)} to ${short(c.to)}`;
  if (sel === "0xa9059cbb") {
    const usdc = chainById(chainId)?.usdc;
    const amt = BigInt(arg(1));
    return usdc && eq(c.to, usdc) ? `Send ${formatUnits(amt, 6)} USDC to ${short(addr(0))}` : `Send ${amt} of token ${short(c.to)} to ${short(addr(0))}`;
  }
  if (eq(c.to, safe)) {
    if (sel === "0x0d582f13") return `Add signer ${short(addr(0))}, need ${BigInt(arg(1))}`;
    if (sel === "0xf8dc5dd9") return `Remove signer ${short(addr(1))}, need ${BigInt(arg(2))}`;
    if (sel === "0x694e80c3") return `Need ${BigInt(arg(0))} signatures`;
    if (sel === "0xe318b52b") return `Swap signer ${short(addr(1))} for ${short(addr(2))}`;
    return `Change the wallet (${sel})`;
  }
  return `Call ${short(c.to)} (${sel})${c.value ? ` with ${formatUnits(c.value, 18)} ${nativeSymbol(chainId)}` : ""}`;
}

export const isSafeRoute = (chain: string, safe: string) => /^\d+$/.test(chain) && isAddress(safe) && safe !== zeroAddress;
