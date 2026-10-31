import { type Address, type Hash, type Hex, zeroAddress } from "viem";
import { chainById, publicClient } from "../chains";
import {
  type Call,
  type SafeTx,
  type Sig,
  abi,
  batch,
  encodeSignatures,
  execData,
  moduleTxHash,
  rolesAddress,
  rolesSpendCall,
  safeTxHash,
  transfer,
} from "./core";
import { type Quote, type SendKind } from "./fee";
import { connectHot, hotAvailable, hotSend, hotSign } from "./hot";
import { passkeySign, passkeySignRaw } from "./sign";
import { short } from "../format";
import { type ChainState, type SafeAccount, loadSigners, salt, wedgieSigners } from "./state";
import { Wedgie, wedgieSupported } from "./wedgie";
import { type Waiting, openTx, readWaiting, shareTx, sigHex } from "./share";
import { bio } from "@/lib/passkey";

/** Thrown by a send this device signed but that needs more signers: it's shared (lib/safe/share.ts) and its page opens. */
export class Shared extends Error {
  w: Waiting;
  constructor(w: Waiting) {
    super("Signed. Opening the transaction…");
    this.name = "Shared";
    this.w = w;
  }
}

export type FeeToken = "usdc" | "eth";
/** A signer is an owner's address. How it signs is worked out per address (`howSigns`): there are no kinds of owner. */
export type Signer = Address;
export type How = "faceid" | "wedgie" | "wallet" | "friend";
const eq = (x: Address, y: Address) => x.toLowerCase() === y.toLowerCase();

/** How this device gets `s`'s signature: this phone's passkey, the wedgie (a passkey signer that isn't this phone's),
 * a browser wallet (any other address: MetaMask, a Ledger, a paper seed loaded into a wallet), or not here at all:
 * someone else's passkey (a friend: they sign from the transaction's link). */
export function howSigns(a: SafeAccount, st: ChainState, s: Signer): How {
  if (eq(s, a.burnerSigner)) return "faceid";
  if (st.friends.some(f => eq(f, s))) return "friend";
  if (st.wedgieSlots.some(w => eq(w, s))) return "wedgie";
  return "wallet";
}
export const usesWedgie = (a: SafeAccount, st: ChainState, signers: Signer[]) => signers.some(s => howSigns(a, st, s) === "wedgie");

/** Who signs, in words: "Face ID + Wedgie", "Face ID + 0x12ab…cdef". */
export function signerLabel(a: SafeAccount, st: ChainState, signers: Signer[]): string {
  const out: string[] = [];
  for (const s of signers) {
    const h = howSigns(a, st, s);
    const name = h === "faceid" ? bio() : h === "wedgie" ? "Wedgie" : (loadSigners(a.address)[s.toLowerCase()]?.name ?? short(s));
    if (!out.includes(name)) out.push(name);
  }
  return out.join(" + ");
}
export type Stage = "quote" | "signing" | "signing-hot" | "signing-wedgie" | "sending" | "confirming";

export async function getQuote(chainId: number, kind: SendKind, extraGas?: bigint): Promise<Quote> {
  const r = await fetch(`/api/safe/relay?chainId=${chainId}&kind=${kind}${extraGas ? `&extra=${extraGas}` : ""}`, { cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "no quote");
  return j;
}

export function feeCall(q: Quote, token: FeeToken): Call {
  const usdc = chainById(q.chainId)?.usdc;
  if (token === "usdc" && usdc) return transfer(usdc, q.relayer, BigInt(q.feeUsdc));
  return transfer(zeroAddress, q.relayer, BigInt(q.feeEth));
}

async function post(body: unknown): Promise<Hash> {
  const r = await fetch("/api/safe/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error === "fee too low" ? "Gas went up while you signed. Try again." : j.error || `relay: ${r.status}`);
  return j.hash;
}

export async function waitFor(chainId: number, hash: Hash) {
  const rc = await publicClient(chainId).waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 1500 });
  if (rc.status !== "success") throw new Error(`It failed on chain (${hash.slice(0, 10)}…)`);
  return rc;
}

/**
 * An owner transaction: `calls` + the relay's fee as one batch, signed by `signers` (enough for the threshold),
 * relayed. Deploys the Safe first on a chain where it isn't yet (the burner's key is in the account).
 */
type OwnersOpts = {
  account: SafeAccount;
  state: ChainState;
  calls: Call[];
  signers: Signer[];
  feeToken: FeeToken;
  wedgie?: Wedgie | null;
  setup?: boolean; // a level change: bigger gas budget
  swapGas?: bigint; // a swap: its route's own gas, on top of the Safe tx
  dappGas?: bigint; // a site's calls (WalletConnect): their own gas, on top of the Safe tx
  quote?: Quote; // the one the user saw, if still fresh and for the same kind of send
  label?: string; // what it does, in words: shown on the computer that finishes it with the wedgie
  self?: boolean; // your own browser wallet sends it and pays the gas: no relay, no fee
  nonce?: bigint; // this number, not the next free one (Reject: takes a waiting tx's number so it can never run)
  onStage?: (s: Stage, hash?: Hash) => void;
};
export type Prepared = { opts: OwnersOpts; t: SafeTx; h: Hex; fee: Quote };

/**
 * Everything before the first signature (quote, nonce, hash). Kept apart so the signing can start straight from a
 * tap: Safari only allows Face ID inside a user gesture, and network calls first can use that gesture up.
 */
export async function prepareOwners(opts: OwnersOpts): Promise<Prepared> {
  const { account: a, state: st, signers } = opts;
  const chainId = st.chainId;
  const signerCode = signers.some(s => eq(s, a.burnerSigner)) ? await publicClient(chainId).getCode({ address: a.burnerSigner }).catch(() => undefined) : "0x01";
  const fresh = !st.deployed || !signerCode || signerCode === "0x"; // the relay deploys the Safe and/or the burner's signer too
  const kind = ownersKind(fresh, usesWedgie(a, st, signers), opts);
  if (opts.self) {
    // anyone can send a signed Safe transaction; the relay only adds deploying the wallet on a new network
    if (fresh) throw new Error("Send one through the relay first on this network (it sets the wallet up there).");
    if (!hotAvailable()) throw new Error("No browser wallet here to execute it.");
    const t: SafeTx = batch(opts.calls, opts.nonce ?? (await freshNonce(chainId, a.address, st)));
    return { opts, t, h: safeTxHash(chainId, a.address, t), fee: selfQuote(chainId, kind) };
  }
  const q = opts.quote && opts.quote.kind === kind && opts.quote.until > Date.now() + 30_000 ? opts.quote : await getQuote(chainId, kind, opts.swapGas ?? opts.dappGas);
  const t: SafeTx = batch([...opts.calls, feeCall(q, opts.feeToken)], opts.nonce ?? (await freshNonce(chainId, a.address, st)));
  return { opts, t, h: safeTxHash(chainId, a.address, t), fee: q };
}

/** Sign (the burner first, straight from the tap) and relay. */
export async function finishOwners(p: Prepared): Promise<Hash> {
  const { account: a, state: st, signers } = p.opts;
  const { t, h } = p;
  const chainId = st.chainId;
  const stage = p.opts.onStage ?? (() => {});
  const face = signers.some(s => howSigns(a, st, s) === "faceid");
  const wallets = signers.filter(s => howSigns(a, st, s) === "wallet");
  const slots = signers.filter(s => howSigns(a, st, s) === "wedgie");
  // everything that can fail without a signature fails first: never ask the wedgie to sign for a key that isn't here
  if (wallets.length && !hotAvailable()) throw new Error("No browser wallet here to sign. Pick another way to sign.");
  // without Face ID first (whose prompt must start straight from the tap), check the browser wallet is the right one
  // before the wedgie is asked to press anything
  if (wallets.length && !face) {
    const who = await connectHot();
    if (!eq(who, wallets[0])) throw new Error(`Switch your wallet to ${wallets[0]} (it's on ${who}).`);
  }
  // the wedgie can't plug in here (a phone): sign the rest; it goes in the queue and the wedgie signs on its page
  const later = slots.length > 0 && !p.opts.wedgie && !wedgieSupported();
  const sigs: Sig[] = [];
  let ownWedgie: Wedgie | null = null;
  try {
    if (face) {
      stage("signing");
      sigs.push(await passkeySign(a.credentialId, a.burnerSigner, h));
    }
    for (const w of wallets) {
      stage("signing-hot");
      sigs.push(await hotSign(chainId, a.address, t, w));
    }
    if (slots.length && !later) {
      const w = p.opts.wedgie ?? (ownWedgie = await Wedgie.connect());
      stage("signing-wedgie");
      sigs.push(...(await w.sign(chainId, a.address, t, h, slots)));
    }
  } finally {
    await ownWedgie?.close();
  }
  // not enough signatures for the Safe yet: the others sign from a link (the tx page)
  if (sigs.length < st.threshold) {
    if (!st.deployed) throw new Error("Set the wallet up on this network first (one send it signs alone), then ask the others.");
    stage("sending");
    const w: Waiting = { chainId, safe: a.address, tx: t, hash: h, sigs: sigs.map(s => ({ owner: s.signer, signature: sigHex(s) })), label: p.opts.label };
    const got = await shareTx(w);
    if (!got.safe && !got.queue) w.label = (w.label ? `${w.label} ` : "") + "(saved in this browser only)";
    used.set(`${chainId}:${a.address}`, t.nonce);
    // one thing here: your signature. The rest (the wedgie, or a link for the others) happens on its page. Callers
    // treat Shared as done (no error, nothing left ready to sign): the sheet is already the transaction's.
    openTx(w);
    throw new Shared(w);
  }
  stage("sending");
  const signatures = encodeSignatures(sigs);
  const hash = p.opts.self
    ? await hotSend(chainId, a.address, execData(t, signatures))
    : await post({ chainId, kind: "exec", safe: a.address, tx: t, signatures, burner: { x: a.qx, y: a.qy }, wedgie: slots.length > 0 });
  stage("confirming", hash);
  await waitFor(chainId, hash);
  used.set(`${chainId}:${a.address}`, t.nonce);
  return hash;
}

/** No relay, no fee: a quote of zero, so the UI can keep reading `fee`. */
const selfQuote = (chainId: number, kind: SendKind): Quote =>
  ({ chainId, relayer: zeroAddress, kind, gasPrice: "0", ethUsd: 0, feeEth: "0", feeUsdc: "0", until: Date.now() + 5 * 60_000 });

/**
 * An owner transaction: `calls` + the relay's fee as one batch, signed by `signers` (enough for the threshold),
 * relayed. Deploys the Safe first on a chain where it isn't yet (the burner's key is in the account).
 */
export async function ownersSend(opts: OwnersOpts): Promise<Hash> {
  (opts.onStage ?? (() => {}))("quote");
  return finishOwners(await prepareOwners(opts));
}

function ownersKind(fresh: boolean, wedgie: boolean, o: { setup?: boolean; swapGas?: bigint; dappGas?: bigint }): SendKind {
  if (o.setup) return fresh ? "first-setup" : "setup";
  if (o.dappGas !== undefined) return fresh ? "first-dapp" : wedgie ? "dapp-wedgie" : "dapp";
  if (o.swapGas !== undefined) return fresh ? "first-swap" : wedgie ? "swap-wedgie" : "swap";
  return fresh ? "first" : wedgie ? "exec-wedgie" : "exec";
}

/** The kind of relayed send (and so the fee quote) a send will be. */
export async function sendKind(
  a: SafeAccount,
  st: ChainState,
  path: "owners" | "budget",
  signers: Signer[],
  o: { swapGas?: bigint; dappGas?: bigint } = {},
): Promise<SendKind> {
  if (path === "budget") return "roles";
  const code = signers.some(s => eq(s, a.burnerSigner)) ? await publicClient(st.chainId).getCode({ address: a.burnerSigner }).catch(() => undefined) : "0x01";
  return ownersKind(!st.deployed || !code || code === "0x", usesWedgie(a, st, signers), o);
}

/** RPC nodes lag a block now and then: never reuse a nonce this page just used. A wallet that needs 2+ signatures
 * goes after what's waiting (as Safe{Wallet} does): two waiting with one number, sending one kills the other. */
const used = new Map<string, bigint>();
async function freshNonce(chainId: number, safe: Address, st: ChainState): Promise<bigint> {
  let n = st.nonce;
  if (st.deployed) n = await publicClient(chainId).readContract({ address: safe, abi: abi.safe, functionName: "nonce" }).catch(() => st.nonce);
  if (st.deployed && st.threshold > 1) for (const w of await readWaiting(chainId, safe, n).catch(() => [])) if (w.tx.nonce >= n) n = w.tx.nonce + 1n;
  const last = used.get(`${chainId}:${safe}`);
  return last !== undefined && last >= n ? last + 1n : n;
}

/** The burner alone, within its daily budget (levels 2+): a signed Roles call, relayed. One Face ID. */
export async function budgetSend(opts: {
  account: SafeAccount;
  state: ChainState;
  calls: Call[]; // all ETH, or all USDC transfers
  feeToken: FeeToken;
  quote?: Quote;
  onStage?: (s: Stage, hash?: Hash) => void;
}): Promise<Hash> {
  const { account: a, state: st } = opts;
  const stage = opts.onStage ?? (() => {});
  stage("quote");
  const q = opts.quote && opts.quote.kind === "roles" && opts.quote.until > Date.now() + 30_000 ? opts.quote : await getQuote(st.chainId, "roles");
  const call = rolesSpendCall([...opts.calls, feeCall(q, opts.feeToken)]);
  const s: Hex = salt();
  const h = moduleTxHash(st.chainId, rolesAddress(a.address), call, s);
  stage("signing");
  const signature = await passkeySignRaw(a.credentialId, h);
  stage("sending");
  const hash = await post({ chainId: st.chainId, kind: "roles", safe: a.address, call, signer: a.burnerSigner, signature, salt: s });
  stage("confirming", hash);
  await waitFor(st.chainId, hash);
  return hash;
}

/**
 * One way to reach the threshold: which owners sign, and whether this device can get their signatures.
 * `of` = how many owners the wallet has.
 */
export type SignerOption = { signers: Signer[]; label: string; threshold: number; of: number; ready: boolean; why?: string; later?: string; share?: boolean };

/**
 * Every set of owners that can sign an owners transaction on this chain, read from the owners and threshold on chain.
 * Owners are grouped by what signs for them (one wedgie press signs all its slots; each browser-wallet address is its
 * own). Minimal sets only (no group that isn't needed), the ones this device can sign first.
 */
export function signerOptions(st: ChainState, a: SafeAccount): SignerOption[] {
  const t = st.threshold;
  const groups: Signer[][] = [];
  if (st.owners.some(o => eq(o, a.burnerSigner)) || !st.deployed) groups.push([a.burnerSigner]);
  if (st.wedgieSlots.length) groups.push(st.wedgieSlots);
  for (const w of st.wallets) groups.push([w]);
  const out: SignerOption[] = [];
  for (let m = 1; m < 1 << groups.length && groups.length <= 12; m++) {
    const gs = groups.filter((_, i) => m & (1 << i));
    const n = gs.reduce((k, g) => k + g.length, 0);
    if (n < t || gs.some(g => n - g.length >= t)) continue;
    const signers = gs.flat();
    const wallets = signers.filter(s => howSigns(a, st, s) === "wallet");
    const why = wallets.length > 1 ? "two browser wallets can't sign together here yet" : wallets.length && !hotAvailable() ? "needs a browser wallet here" : undefined;
    // the wedgie on a phone: sign here, finish on the computer (a send parks for it)
    const later = usesWedgie(a, st, signers) && !wedgieSupported() ? "the wedgie signs after, on its page" : undefined;
    out.push({ signers, label: signerLabel(a, st, signers), threshold: t, of: st.owners.length, ready: !why, why, later });
  }
  // always one more way: sign here, and the other signers sign from a link (wallets with other people on them)
  if (t > 1 && st.deployed && st.owners.some(o => eq(o, a.burnerSigner)))
    out.push({ signers: [a.burnerSigner], label: `${bio()}, then share`, threshold: t, of: st.owners.length, ready: true, later: "the others sign from a link", share: true });
  const face = (o: SignerOption) => Number(o.signers.some(s => eq(s, a.burnerSigner)));
  return out.sort(
    (x, y) =>
      Number(y.ready) - Number(x.ready) || Number(!!x.share) - Number(!!y.share) || Number(!!x.later) - Number(!!y.later) || x.signers.length - y.signers.length || face(y) - face(x),
  );
}

/** A wallet that needs 2+ signatures: this phone signs with Face ID, then the transaction's page (wedgie, or share). */
export const signThenQueue = (st: ChainState, a: SafeAccount) => st.threshold > 1 && st.deployed && st.owners.some(o => eq(o, a.burnerSigner));

/** The keys to ask for by default: Face ID then the queue; or, `inline` (a site waiting for the answer), the first
 * option this device can sign. */
export function ownerSigners(st: ChainState, a: SafeAccount, inline = false): Signer[] {
  if (!inline && signThenQueue(st, a)) return [a.burnerSigner];
  if (st.threshold <= 1 && (!st.deployed || st.owners.some(o => eq(o, a.burnerSigner)))) return [a.burnerSigner];
  return signerOptions(st, a)[0]?.signers ?? [a.burnerSigner];
}

/** Which keys a send needs, given the wallet's shape on that chain and what's within the burner's budget. */
export function plan(st: ChainState, a: SafeAccount, token: Address, amount: bigint, fee: bigint, feeIsSameToken: boolean) {
  if (st.threshold === 1) return { path: "owners" as const, signers: ownerSigners(st, a) };
  const usdc = chainById(st.chainId)?.usdc?.toLowerCase();
  const isEth = token === zeroAddress;
  const isUsdc = token.toLowerCase() === usdc;
  if (st.budget && (isEth || isUsdc)) {
    const left = isEth ? st.budget.eth : st.budget.usdc;
    // a USDC fee on its own allowance doesn't come off the limit: the full limit can be sent
    const feeApart = isUsdc && feeIsSameToken && st.budget.feeUsdc !== null && fee <= st.budget.feeUsdc;
    if (amount + (feeIsSameToken && !feeApart ? fee : 0n) <= left) return { path: "budget" as const, signers: [a.burnerSigner] };
  }
  // a big move: enough owners for the threshold
  return { path: "owners" as const, signers: ownerSigners(st, a) };
}
