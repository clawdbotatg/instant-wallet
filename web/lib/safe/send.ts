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
import { hotAvailable, hotSign } from "./hot";
import { passkeySign, passkeySignRaw } from "./sign";
import { type ChainState, type SafeAccount, hotOf, salt, wedgieSigners } from "./state";
import { Wedgie } from "./wedgie";

export type FeeToken = "usdc" | "eth";
export type Signer = "burner" | "hot" | "wedgie";
export type Stage = "quote" | "signing" | "signing-hot" | "signing-wedgie" | "sending" | "confirming";

export async function getQuote(chainId: number, kind: SendKind): Promise<Quote> {
  const r = await fetch(`/api/safe/relay?chainId=${chainId}&kind=${kind}`, { cache: "no-store" });
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
export async function ownersSend(opts: {
  account: SafeAccount;
  state: ChainState;
  calls: Call[];
  signers: Signer[];
  feeToken: FeeToken;
  wedgie?: Wedgie | null;
  setup?: boolean; // a level change: bigger gas budget
  onStage?: (s: Stage, hash?: Hash) => void;
}): Promise<Hash> {
  const { account: a, state: st, signers } = opts;
  const chainId = st.chainId;
  const stage = opts.onStage ?? (() => {});
  stage("quote");
  const kind: SendKind = !st.deployed ? (opts.setup ? "first-setup" : "first") : opts.setup ? "setup" : signers.includes("wedgie") ? "exec-wedgie" : "exec";
  const q = await getQuote(chainId, kind);
  const t: SafeTx = batch([...opts.calls, feeCall(q, opts.feeToken)], await freshNonce(chainId, a.address, st));
  const h = safeTxHash(chainId, a.address, t);
  const sigs: Sig[] = [];
  let ownWedgie: Wedgie | null = null;
  try {
    for (const s of signers) {
      if (s === "burner") {
        stage("signing");
        sigs.push(await passkeySign(a.credentialId, a.burnerSigner, h));
      } else if (s === "hot") {
        const hot = hotOf(a, st);
        if (!hot) throw new Error("No hot wallet on this wallet yet.");
        stage("signing-hot");
        sigs.push(await hotSign(chainId, a.address, t, hot));
      } else {
        const w = opts.wedgie ?? (ownWedgie = await Wedgie.connect());
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
    deploy: st.deployed ? undefined : { x: a.qx, y: a.qy },
    wedgie: signers.includes("wedgie"),
  });
  stage("confirming", hash);
  await waitFor(chainId, hash);
  used.set(`${chainId}:${a.address}`, t.nonce);
  return hash;
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
  onStage?: (s: Stage, hash?: Hash) => void;
}): Promise<Hash> {
  const { account: a, state: st } = opts;
  const stage = opts.onStage ?? (() => {});
  stage("quote");
  const q = await getQuote(st.chainId, "roles");
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

/** The owners needed for a change on this chain, at its current shape (pre-phase-4 thresholds). */
export function ownerSigners(st: ChainState): Signer[] {
  if (st.threshold <= 1) return ["burner"];
  if (st.owners.length >= 4) return ["wedgie", hotAvailable() ? "hot" : "burner"]; // the wedgie + whichever other key is here
  return ["burner", "hot"];
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
  // a big move: the owners. Level 2–3: burner + hot. Level 4+: the wedgie + one more.
  return { path: "owners" as const, signers: ownerSigners(st) };
}
