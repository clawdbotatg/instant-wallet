import { type Address, type Hex, getAddress, isAddress, slice, zeroAddress } from "viem";
import { publicClient } from "../chains";
import { type SafeTx, type Sig, abi, encodeSignatures, safeTxHash } from "./core";

/**
 * A Safe transaction other signers can see and sign (docs/MULTI-SIGNER.md), kept the way wedgie.dev/safe keeps it:
 * in four places, merged by safeTxHash, so a slow or down service doesn't stop it.
 *   1. Safe's Transaction Service (through /api/safe/svc, our key). Safe{Wallet} sees it too.
 *   2. Instant Wallet's queue, /api/safe/queue (checks each signature on chain).
 *   3. This browser.
 *   4. The link: the tx and its signatures after the #, no server needed.
 * A signature anywhere counts only once the Safe says it's an owner's (checkNSignatures, one at a time).
 */

/** Safe's Transaction Service and Safe{Wallet} names for our networks (none: our queue and the link only). */
export const SAFE_SVC: Record<number, { key: string; app?: string }> = {
  8453: { key: "base" },
  1: { key: "eth" },
  10: { key: "oeth" },
  42161: { key: "arb1" },
  137: { key: "pol", app: "matic" },
  43114: { key: "avax" },
  56: { key: "bnb" },
  100: { key: "gno" },
  42220: { key: "celo" },
  146: { key: "sonic" },
};

/** This transaction in Safe{Wallet} (it has it once it's in Safe's Transaction Service). */
export function safeAppTxLink(chainId: number, safe: Address, hash: Hex): string | null {
  const c = SAFE_SVC[chainId];
  return c ? `https://app.safe.global/transactions/tx?safe=${c.app ?? c.key}:${safe}&id=multisig_${safe}_${hash}` : null;
}

/** One owner's signature as Safe's API and our queue take it: 65 bytes, or a contract one (v = 0) with its data after. */
export const sigHex = (s: Sig): Hex => encodeSignatures([s]);

/** Back from that form (to put several together for the Safe). */
export function sigOf(owner: Address, hex: Hex): Sig {
  const v = Number(BigInt(slice(hex, 64, 65)));
  if (v === 0) {
    const at = Number(BigInt(slice(hex, 32, 64)));
    const len = Number(BigInt(slice(hex, at, at + 32)));
    return { signer: owner, data: slice(hex, at + 32, at + 32 + len), kind: "contract" };
  }
  if (v === 1) return { signer: owner, data: "0x", kind: "approved" };
  return { signer: owner, data: slice(hex, 0, 65), kind: "ecdsa" };
}

export type Waiting = { chainId: number; safe: Address; tx: SafeTx; hash: Hex; sigs: { owner: Address; signature: Hex }[]; inSafe?: boolean; label?: string };

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const within = <T,>(p: Promise<T>, ms = 8000) => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
const svc = (chainId: number, path: string) => `/api/safe/svc?u=${encodeURIComponent(`${SAFE_SVC[chainId].key}/api/v1/${path}`)}`;
const wire = (t: SafeTx) => ({
  to: t.to,
  value: t.value.toString(),
  data: t.data,
  operation: t.operation,
  safeTxGas: "0",
  baseGas: "0",
  gasPrice: "0",
  gasToken: zeroAddress,
  refundReceiver: zeroAddress,
  nonce: t.nonce.toString(),
});
const txOf = (t: any): SafeTx => ({ to: getAddress(t.to), value: BigInt(t.value ?? 0), data: (t.data || "0x") as Hex, operation: Number(t.operation) as 0 | 1, nonce: BigInt(t.nonce) });
// a tx with gas refunds or a gas token isn't one we can sign or send: left out
const plain = (t: any) => !Number(t.safeTxGas || 0) && !Number(t.baseGas || 0) && !Number(t.gasPrice || 0) && (!t.gasToken || eq(t.gasToken, zeroAddress)) && (!t.refundReceiver || eq(t.refundReceiver, zeroAddress));

const LKEY = (c: number, s: string) => `iws.waiting.${c}:${s.toLowerCase()}`;
type Local = Record<string, { tx: ReturnType<typeof wire>; sigs: Waiting["sigs"]; label?: string }>;
function loadLocal(c: number, s: string): Local {
  try {
    return JSON.parse(localStorage.getItem(LKEY(c, s)) || "{}");
  } catch {
    return {};
  }
}
function saveLocal(c: number, s: string, l: Local) {
  try {
    localStorage.setItem(LKEY(c, s), JSON.stringify(l));
  } catch {}
}

/** Put a transaction and its signatures everywhere it's kept. Fine as long as one place took it (this browser always). */
export async function shareTx(w: Waiting): Promise<{ safe: boolean; queue: boolean }> {
  const { chainId: c, safe: a, tx: t, hash: h } = w;
  const l = loadLocal(c, a);
  const m = l[h.toLowerCase()] ?? { tx: wire(t), sigs: [], label: w.label };
  for (const s of w.sigs) if (!m.sigs.some(x => eq(x.owner, s.owner))) m.sigs.push(s);
  l[h.toLowerCase()] = m;
  saveLocal(c, a, l);
  const toSafe = async () => {
    if (!SAFE_SVC[c]) throw new Error("not on Safe's service");
    const had = await fetch(svc(c, `multisig-transactions/${h}/`)).then(r => (r.ok ? r.json() : null)).catch(() => null);
    let rest = m.sigs.filter(s => !(had?.confirmations || []).some((x: any) => eq(x.owner, s.owner)));
    if (!had && rest.length) {
      const [first, ...more] = rest;
      const r = await fetch(svc(c, `safes/${a}/multisig-transactions/`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wire(t), contractTransactionHash: h, sender: first.owner, signature: first.signature, origin: "Instant Wallet" }),
      });
      if (!r.ok) throw new Error(`Safe's service: ${r.status}`);
      rest = more;
    }
    for (const s of rest)
      await fetch(svc(c, `multisig-transactions/${h}/confirmations/`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: s.signature }) });
  };
  const toQueue = async () => {
    const r = await fetch("/api/safe/queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: c, safe: a, tx: wire(t), sigs: m.sigs, origin: "Instant Wallet" }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `queue: ${r.status}`);
  };
  const [s, q] = await Promise.allSettled([within(toSafe(), 15_000), within(toQueue(), 15_000)]);
  return { safe: s.status === "fulfilled", queue: q.status === "fulfilled" };
}

/** Everything waiting on this Safe from nonce on: Safe's service + our queue + this browser, merged. `svc: false`:
 * not Safe's service (home's look, on every wallet with more than one signer: Safe's quota is shared with wedgie.dev). */
export async function readWaiting(c: number, a: Address, nonce: bigint, o: { svc?: boolean } = {}): Promise<Waiting[]> {
  const all = new Map<string, Waiting>();
  const dropped = new Set<string>();
  const add = (t: any, h: string, sigs: { owner: string; signature: string | null }[], o: { inSafe?: boolean; label?: string } = {}) => {
    if (BigInt(t.nonce) < nonce || !plain(t)) return;
    const k = h.toLowerCase();
    const w = all.get(k) ?? { chainId: c, safe: a, tx: txOf(t), hash: h as Hex, sigs: [] };
    if (o.inSafe) w.inSafe = true;
    if (o.label) w.label ??= o.label;
    for (const s of sigs) if (s.signature && isAddress(s.owner) && !w.sigs.some(x => eq(x.owner, s.owner))) w.sigs.push({ owner: getAddress(s.owner), signature: s.signature as Hex });
    all.set(k, w);
  };
  await Promise.allSettled([
    SAFE_SVC[c] && o.svc !== false
      ? within(fetch(svc(c, `safes/${a}/multisig-transactions/?executed=false&nonce__gte=${nonce}&ordering=nonce&limit=20`)).then(r => r.json())).then(j =>
          (j.results || []).forEach((t: any) => add(t, t.safeTxHash, t.confirmations || [], { inSafe: true })),
        )
      : null,
    within(fetch(`/api/safe/queue?chainId=${c}&safe=${a}`).then(r => r.json())).then(j => {
      (j.txs || []).forEach((t: any) => add(t.tx, t.hash, t.sigs));
      (j.dropped || []).forEach((h: string) => dropped.add(h.toLowerCase()));
    }),
  ]);
  const l = loadLocal(c, a);
  for (const [h, e] of Object.entries(l)) {
    if (BigInt(e.tx.nonce) < nonce) delete l[h];
    else add(e.tx, h, e.sigs, { label: e.label });
  }
  saveLocal(c, a, l);
  for (const h of dropped) all.delete(h);
  return [...all.values()].sort((x, y) => Number(x.tx.nonce - y.tx.nonce));
}

/** Which of these signatures the Safe takes as its owners' (one eth_call each). */
export async function checkSigs(w: Waiting): Promise<Waiting["sigs"]> {
  const pc = publicClient(w.chainId);
  const data = await pc.readContract({
    address: w.safe,
    abi: abi.safeTxData,
    functionName: "encodeTransactionData",
    args: [w.tx.to, w.tx.value, w.tx.data, w.tx.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, w.tx.nonce],
  });
  const ok = await Promise.all(
    w.sigs.map(s =>
      pc
        .readContract({ address: w.safe, abi: abi.safeTxData, functionName: "checkNSignatures", args: [w.hash, data, s.signature, 1n] })
        .then(() => true)
        .catch(() => false),
    ),
  );
  return w.sigs.filter((_, i) => ok[i]);
}

/** The link: /tx/<chain>/<safe>#<tx and signatures>. Opened anywhere, it brings the tx with it. */
export function txLink(w: Waiting): string {
  const code = btoa(JSON.stringify({ t: wire(w.tx), s: w.sigs.map(s => [s.owner, s.signature]), l: w.label }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${location.origin}/tx/${w.chainId}/${w.safe}#${code}`;
}

export function fromLink(chainId: number, safe: Address, code: string): Waiting | null {
  try {
    const j = JSON.parse(atob(code.replace(/-/g, "+").replace(/_/g, "/")));
    if (!isAddress(j?.t?.to) || !plain(j.t)) return null;
    const tx = txOf(j.t);
    const sigs = (j.s || [])
      .filter((x: any) => Array.isArray(x) && isAddress(x[0]) && /^0x[0-9a-fA-F]+$/.test(x[1]))
      .map((x: any) => ({ owner: getAddress(x[0]), signature: x[1] as Hex }));
    return { chainId, safe, tx, hash: safeTxHash(chainId, safe, tx), sigs, label: typeof j.l === "string" ? j.l.slice(0, 200) : undefined };
  } catch {
    return null;
  }
}

/** All the signatures, in Safe's order, ready for execTransaction. */
export const allSignatures = (w: Waiting): Hex => encodeSignatures(w.sigs.map(s => sigOf(s.owner, s.signature)));
