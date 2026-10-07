import { type Address, type Hash, type Hex, zeroAddress } from "viem";
import { chainById, publicClient } from "../chains";
import {
  type Call,
  type SafeTx,
  type Sig,
  abi,
  batch,
  encodeSignatures,
  moduleTxHash,
  rolesAddress,
  rolesSpendCall,
  safeTxHash,
  transfer,
} from "./core";
import { type Quote, type SendKind } from "./fee";
import { connectHot, hotAvailable, hotSign } from "./hot";
import { passkeySign, passkeySignRaw } from "./sign";
import { type ChainState, type SafeAccount, hotOf, salt, wedgieSigners } from "./state";
import { Wedgie, wedgieSupported } from "./wedgie";

export type FeeToken = "usdc" | "eth";
export type Signer = "burner" | "hot" | "wedgie";
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
  quote?: Quote; // the one the user saw, if still fresh and for the same kind of send
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
  const signerCode = signers.includes("burner") ? await publicClient(chainId).getCode({ address: a.burnerSigner }).catch(() => undefined) : "0x01";
  const fresh = !st.deployed || !signerCode || signerCode === "0x"; // the relay deploys the Safe and/or the burner's signer too
  const kind = ownersKind(fresh, signers, opts);
  const q = opts.quote && opts.quote.kind === kind && opts.quote.until > Date.now() + 30_000 ? opts.quote : await getQuote(chainId, kind, opts.swapGas);
  const t: SafeTx = batch([...opts.calls, feeCall(q, opts.feeToken)], await freshNonce(chainId, a.address, st));
  return { opts, t, h: safeTxHash(chainId, a.address, t), fee: q };
}

/** Sign (the burner first, straight from the tap) and relay. */
export async function finishOwners(p: Prepared): Promise<Hash> {
  const { account: a, state: st, signers } = p.opts;
  const { t, h } = p;
  const chainId = st.chainId;
  const stage = p.opts.onStage ?? (() => {});
  // everything that can fail without a signature fails first: never ask the wedgie to sign for a key that isn't here
  const hot = signers.includes("hot") ? hotOf(a, st) : undefined;
  if (signers.includes("hot") && (!hot || !hotAvailable())) throw new Error("Your hot wallet isn't here. Pick another way to sign.");
  // without Face ID first (whose prompt must start straight from the tap), check the hot wallet is the right one
  // before the wedgie is asked to press anything
  if (hot && !signers.includes("burner")) {
    const who = await connectHot();
    if (who.toLowerCase() !== hot.toLowerCase()) throw new Error(`Switch your wallet to ${hot} (it's on ${who}).`);
  }
  const order = [...signers].sort((x, y) => (x === "burner" ? -1 : y === "burner" ? 1 : 0));
  const sigs: Sig[] = [];
  let ownWedgie: Wedgie | null = null;
  try {
    for (const s of order) {
      if (s === "burner") {
        stage("signing");
        sigs.push(await passkeySign(a.credentialId, a.burnerSigner, h));
      } else if (s === "hot") {
        const hot = hotOf(a, st);
        if (!hot) throw new Error("No hot wallet on this wallet yet.");
        stage("signing-hot");
        sigs.push(await hotSign(chainId, a.address, t, hot));
      } else {
        const w = p.opts.wedgie ?? (ownWedgie = await Wedgie.connect());
        const key = a.wedgie ?? (await w.key());
        stage("signing-wedgie");
        sigs.push(...(await w.sign(chainId, a.address, t, h, wedgieSigners(key))));
      }
    }
  } finally {
    await ownWedgie?.close();
  }
  stage("sending");
  const hash = await post({
    chainId,
    kind: "exec",
    safe: a.address,
    tx: t,
    signatures: encodeSignatures(sigs),
    burner: { x: a.qx, y: a.qy },
    wedgie: signers.includes("wedgie"),
  });
  stage("confirming", hash);
  await waitFor(chainId, hash);
  used.set(`${chainId}:${a.address}`, t.nonce);
  return hash;
}

/**
 * An owner transaction: `calls` + the relay's fee as one batch, signed by `signers` (enough for the threshold),
 * relayed. Deploys the Safe first on a chain where it isn't yet (the burner's key is in the account).
 */
export async function ownersSend(opts: OwnersOpts): Promise<Hash> {
  (opts.onStage ?? (() => {}))("quote");
  return finishOwners(await prepareOwners(opts));
}

function ownersKind(fresh: boolean, signers: Signer[], o: { setup?: boolean; swapGas?: bigint }): SendKind {
  if (o.setup) return fresh ? "first-setup" : "setup";
  if (o.swapGas !== undefined) return fresh ? "first-swap" : signers.includes("wedgie") ? "swap-wedgie" : "swap";
  return fresh ? "first" : signers.includes("wedgie") ? "exec-wedgie" : "exec";
}

/** The kind of relayed send (and so the fee quote) a send will be. */
export async function sendKind(
  a: SafeAccount,
  st: ChainState,
  path: "owners" | "budget",
  signers: Signer[],
  o: { swapGas?: bigint } = {},
): Promise<SendKind> {
  if (path === "budget") return "roles";
  const code = signers.includes("burner") ? await publicClient(st.chainId).getCode({ address: a.burnerSigner }).catch(() => undefined) : "0x01";
  return ownersKind(!st.deployed || !code || code === "0x", signers, o);
}

/** RPC nodes lag a block now and then: never reuse a nonce this page just used. */
const used = new Map<string, bigint>();
async function freshNonce(chainId: number, safe: Address, st: ChainState): Promise<bigint> {
  let n = st.nonce;
  if (st.deployed) n = await publicClient(chainId).readContract({ address: safe, abi: abi.safe, functionName: "nonce" }).catch(() => st.nonce);
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

/** One way to reach the threshold: which keys sign, how many signatures they make, and whether this device can. */
export type SignerOption = { signers: Signer[]; weight: number; threshold: number; ready: boolean; why?: string };

/**
 * Every set of keys that can sign an owners transaction on this chain, read from the owners and threshold on chain
 * (keys come in any order; the wedgie counts twice). Only keys we can name: an owner we can't identify is never
 * asked for. Minimal sets only (no key that isn't needed), the ones this device can sign first.
 */
export function signerOptions(st: ChainState, a: SafeAccount): SignerOption[] {
  const t = st.threshold;
  const owners = st.owners.map(o => o.toLowerCase());
  const w: Partial<Record<Signer, number>> = {};
  if (owners.includes(a.burnerSigner.toLowerCase()) || !st.deployed) w.burner = 1;
  if (st.hasWedgie) w.wedgie = a.wedgie ? wedgieSigners(a.wedgie).filter(x => owners.includes(x.toLowerCase())).length : 2;
  if (st.hasHot && hotOf(a, st)) w.hot = 1;
  const keys = (["burner", "wedgie", "hot"] as Signer[]).filter(k => w[k]);
  const sum = (ks: Signer[]) => ks.reduce((n, k) => n + (w[k] ?? 0), 0);
  const out: SignerOption[] = [];
  for (let m = 1; m < 1 << keys.length; m++) {
    const ks = keys.filter((_, i) => m & (1 << i));
    if (sum(ks) < t || ks.some(k => sum(ks.filter(x => x !== k)) >= t)) continue;
    const why = ks.includes("hot") && !hotAvailable() ? "needs your hot wallet (a browser with it)" : ks.includes("wedgie") && !wedgieSupported() ? "needs the wedgie (Chrome on a computer)" : undefined;
    out.push({ signers: ks, weight: sum(ks), threshold: t, ready: !why, why });
  }
  return out.sort((x, y) => Number(y.ready) - Number(x.ready) || x.signers.length - y.signers.length || Number(y.signers.includes("burner")) - Number(x.signers.includes("burner")));
}

/** The keys to ask for by default: the first option this device can sign. */
export function ownerSigners(st: ChainState, a: SafeAccount): Signer[] {
  if (st.threshold <= 1) return ["burner"];
  return signerOptions(st, a)[0]?.signers ?? ["burner"];
}

/** Which keys a send needs, given the wallet's shape on that chain and what's within the burner's budget. */
export function plan(st: ChainState, a: SafeAccount, token: Address, amount: bigint, fee: bigint, feeIsSameToken: boolean) {
  if (st.level === 1 || st.threshold === 1) return { path: "owners" as const, signers: ["burner"] as Signer[] };
  const usdc = chainById(st.chainId)?.usdc?.toLowerCase();
  const isEth = token === zeroAddress;
  const isUsdc = token.toLowerCase() === usdc;
  if (st.budget && (isEth || isUsdc)) {
    const left = isEth ? st.budget.eth : st.budget.usdc;
    if (amount + (feeIsSameToken ? fee : 0n) <= left) return { path: "budget" as const, signers: ["burner"] as Signer[] };
  }
  // a big move: the owners. Burner + hot, or the wedgie + one more.
  return { path: "owners" as const, signers: ownerSigners(st, a) };
}
