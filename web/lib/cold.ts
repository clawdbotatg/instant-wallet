import { type Address, type Hex, bytesToHex as vBytesToHex, decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAddress, hexToBytes, parseAbiItem } from "viem";
import { p256 } from "@noble/curves/nist.js";
import { instantWalletAbi } from "./abi";
import { publicClient } from "./chains";
import type { Call, KeySigner } from "./wallet";
import { bigintToHex32, bytesToHex, toLowS } from "./webauthn";
import { signerIdOf } from "./address";

/**
 * Cold storage on an InstantWallet 3.2 (docs/COLD-STORAGE.md): read the wallet's safety state, and build the
 * calls for setting it up, cancelling / skipping / running queued actions, freezing. Every call here targets the
 * wallet itself and goes through sendCalls like any other batch.
 */

/** InstantWallet 3.2.0 on Base (CREATE2: same address on every chain). Wallets move to it with upgradeToAndCall. */
export const IMPL_32: Address = "0xe4770da4Ac9D0d23aD01957A1C8185c5B0Ae402D";
export const KIND_RAW = 1;
export const ROLE_SPENDER = 0;
export const ROLE_OWNER = 1;

const self = (wallet: Address, data: Hex): Call => ({ target: wallet, value: 0n, data });
const enc = (functionName: string, args: unknown[] = []) =>
  encodeFunctionData({ abi: instantWalletAbi as any, functionName, args } as any) as Hex;

export type Signer = { id: Address; kind: number; role: number; qx: Hex; qy: Hex };
export type QueuedAction = { id: Hex; proposer: Address; executeAfter: number; calls: Call[]; txHash: Hex };
export type Safety = {
  version: string;
  deployed: boolean;
  coldDelay: number;
  frozenUntil: number;
  noTwoKeySkip: boolean;
  recoveryDelay: number;
  guardians: Address[];
  signers: Signer[];
  limits: Record<string, { asset: Address; limit: bigint; spent: bigint; windowStart: number }[]>;
  queue: QueuedAction[];
  recovery: { replaces: Address; newId: Address; executeAfter: number; proposer: Address } | null;
};

const QUEUED = parseAbiItem("event ActionQueued(bytes32 indexed id, address indexed proposer, uint64 executeAfter, bytes calls)");

export async function readSafety(chainId: number, wallet: Address): Promise<Safety> {
  const pc = publicClient(chainId);
  const code = await pc.getCode({ address: wallet });
  const empty: Safety = {
    version: "", deployed: false, coldDelay: 0, frozenUntil: 0, noTwoKeySkip: false, recoveryDelay: 0,
    guardians: [], signers: [], limits: {}, queue: [], recovery: null,
  };
  if (!code || code === "0x") return empty;
  const r = (functionName: string, args: unknown[] = []) =>
    pc.readContract({ address: wallet, abi: instantWalletAbi as any, functionName, args } as any) as Promise<any>;
  const version: string = await r("version");
  const [ids, list] = await r("getSigners");
  const signers: Signer[] = (ids as Address[]).map((id, i) => ({ id, kind: list[i].kind, role: list[i].role, qx: list[i].qx, qy: list[i].qy }));
  const guardians: Address[] = await r("getGuardians");
  const recoveryDelay = Number(await r("recoveryDelay"));
  const rec = await r("pendingRecovery");
  const limits: Safety["limits"] = {};
  for (const s of signers) {
    if (s.role !== ROLE_SPENDER) continue;
    const [assets, al] = await r("getLimits", [s.id]);
    limits[s.id] = (assets as Address[]).map((asset, i) => ({ asset, limit: al[i].limit, spent: al[i].spent, windowStart: Number(al[i].windowStart) }));
  }
  const base: Safety = {
    ...empty,
    version,
    deployed: true,
    recoveryDelay,
    guardians,
    signers,
    limits,
    recovery:
      Number(rec.executeAfter) > 0
        ? { replaces: rec.replaces, newId: signerIdOf(rec.qx, rec.qy), executeAfter: Number(rec.executeAfter), proposer: rec.proposer }
        : null,
  };
  if (!version.startsWith("3.2") && !version.startsWith("3.3")) return base;
  const [coldDelay, frozenUntil, noTwoKeySkip] = await Promise.all([r("coldDelay"), r("frozenUntil"), r("noTwoKeySkip")]);
  // pending = every ActionQueued whose slot is still filled
  const logs = await pc.getLogs({ address: wallet, event: QUEUED, fromBlock: "earliest", toBlock: "latest" }).catch(() => []);
  const queue: QueuedAction[] = [];
  for (const l of logs) {
    const id = l.args.id as Hex;
    const q = await r("queued", [id]);
    if (Number(q[0]) === 0) continue;
    const [calls] = decodeAbiParameters(
      [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }],
      l.args.calls as Hex,
    );
    queue.push({ id, proposer: getAddress(q[1]), executeAfter: Number(q[0]), calls: calls as Call[], txHash: l.transactionHash as Hex });
  }
  return { ...base, coldDelay: Number(coldDelay), frozenUntil: Number(frozenUntil), noTwoKeySkip, queue };
}

// ---------------------------------------------------------------- calls

export type ColdSetup = {
  wedgie: { qx: Hex; qy: Hex };
  passkeyId: Address;
  limits: { asset: Address; limit: bigint }[];
  coldDelay: number; // seconds
  guardians: Address[];
  recoveryDelay: number; // seconds
  vault?: boolean; // no two-key skip
  upgrade: boolean; // move to 3.2 first
};

/** One batch, signed by the passkey while it's still the owner and there's no wait: the whole setup at once. */
export function coldSetupCalls(wallet: Address, s: ColdSetup): Call[] {
  const c: Call[] = [];
  if (s.upgrade) c.push(self(wallet, enc("upgradeToAndCall", [IMPL_32, "0x"])));
  c.push(self(wallet, enc("addSigner", [s.wedgie.qx, s.wedgie.qy, KIND_RAW, ROLE_OWNER, `0x${"0".repeat(64)}`])));
  c.push(self(wallet, enc("updateSigner", [s.passkeyId, ROLE_SPENDER])));
  for (const l of s.limits) c.push(self(wallet, enc("setLimit", [s.passkeyId, l.asset, l.limit])));
  c.push(self(wallet, enc("setGuardians", [s.guardians, BigInt(s.recoveryDelay)])));
  if (s.vault) c.push(self(wallet, enc("setNoTwoKeySkip", [true])));
  c.push(self(wallet, enc("setColdDelay", [BigInt(s.coldDelay)])));
  return c;
}

export const upgradeCalls = (wallet: Address): Call[] => [self(wallet, enc("upgradeToAndCall", [IMPL_32, "0x"]))];
export const cancelCalls = (wallet: Address, id: Hex): Call[] => [self(wallet, enc("cancelQueued", [id]))];
export const freezeCalls = (wallet: Address): Call[] => [self(wallet, enc("freeze"))];
export const unfreezeCalls = (wallet: Address): Call[] => [self(wallet, enc("unfreeze"))];
export const cancelRecoveryCalls = (wallet: Address): Call[] => [self(wallet, enc("cancelRecovery"))];
export const removeSignerCalls = (wallet: Address, id: Address): Call[] => [self(wallet, enc("removeSigner", [id]))];
export const runCalls = (wallet: Address, q: QueuedAction): Call[] => [self(wallet, enc("executeQueued", [q.id, q.calls]))];
/** "Both keys": a second key skips the wait and runs it, in one signature. */
export const skipAndRunCalls = (wallet: Address, q: QueuedAction): Call[] => [
  self(wallet, enc("skipWait", [q.id])),
  self(wallet, enc("executeQueued", [q.id, q.calls])),
];

/** What a queued (or about-to-be-signed) call does, in words. */
export function describeCall(wallet: Address, c: Call): string {
  if (c.target.toLowerCase() === wallet.toLowerCase()) {
    try {
      const d = decodeFunctionData({ abi: instantWalletAbi as any, data: c.data }) as { functionName: string; args?: readonly unknown[] };
      const a = (d.args ?? []).map(x => (typeof x === "string" && x.length === 42 ? `${x.slice(0, 6)}…${x.slice(-4)}` : String(x)));
      return `${d.functionName}(${a.join(", ")})`;
    } catch {
      return `wallet call ${c.data.slice(0, 10)}`;
    }
  }
  if (c.data === "0x") return `send ${Number(c.value) / 1e18} ETH to ${c.target.slice(0, 6)}…${c.target.slice(-4)}`;
  if (c.data.startsWith("0xa9059cbb")) {
    const to = `0x${c.data.slice(34, 74)}`;
    const amt = BigInt(`0x${c.data.slice(74, 138)}`);
    const usdc = c.target.toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" || c.target.toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const what = usdc ? `$${(Number(amt) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC` : `${amt} of token ${c.target.slice(0, 6)}…`;
    return `send ${what} to ${to.slice(0, 6)}…${to.slice(-4)}`;
  }
  return `call ${c.target.slice(0, 6)}…${c.target.slice(-4)} ${c.data.slice(0, 10)}`;
}

// ---------------------------------------------------------------- the stand-in wedgie (a raw P-256 key in this browser)

const WEDGIE_KEY = "iw3.standin-wedgie";

export function standInKey(): Hex {
  try {
    const have = localStorage.getItem(WEDGIE_KEY);
    if (have) return have as Hex;
  } catch {}
  const sk = bytesToHex(p256.utils.randomSecretKey());
  try {
    localStorage.setItem(WEDGIE_KEY, sk);
  } catch {}
  return sk;
}

export function rawPublicKey(sk: Hex): { qx: Hex; qy: Hex; id: Address } {
  const pub = p256.getPublicKey(hexToBytes(sk), false);
  const hex = bytesToHex(pub);
  const qx = `0x${hex.slice(4, 68)}` as Hex;
  const qy = `0x${hex.slice(68)}` as Hex;
  return { qx, qy, id: signerIdOf(qx, qy) };
}

/** A KeySigner for sendCalls that signs digests raw with `sk` (low-s, r ‖ s), exactly what a wedgie returns. */
export function rawSigner(sk: Hex): KeySigner {
  const { id } = rawPublicKey(sk);
  const skb = hexToBytes(sk);
  return {
    signerId: id,
    sign: async (digest: Hex) => {
      const b = p256.sign(hexToBytes(digest), skb, { prehash: false, lowS: true, format: "compact" }) as Uint8Array;
      const r = vBytesToHex(b.slice(0, 32));
      const s = bigintToHex32(toLowS(BigInt(vBytesToHex(b.slice(32)))));
      return `${r}${s.slice(2)}` as Hex;
    },
    dummy: () => `0x${"11".repeat(64)}` as Hex,
  };
}
