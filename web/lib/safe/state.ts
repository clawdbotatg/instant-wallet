import { type Address, type Hex, getAddress, keccak256, toBytes, zeroAddress } from "viem";
import { CHAINS, publicClient } from "../chains";
import { DAO, KEY_ETH, KEY_USDC, RECOVERY_7D } from "./config";
import { abi, rolesAddress, safeAddress, signerAddress } from "./core";
import { VERIFIERS_SLOT2 } from "./config";

/** This device's wallet: the burner passkey, and what it learned about the other keys. Stored in localStorage. */
export type SafeAccount = {
  credentialId: string;
  qx: Hex;
  qy: Hex;
  burnerSigner: Address;
  address: Address;
  hot?: Address; // MetaMask etc., once added
  wedgie?: { x: Hex; y: Hex }; // the wedgie's key, once paired
  paper?: Address; // the paper seed's address, once it's the recovery address
};

export function accountFor(credentialId: string, qx: Hex, qy: Hex): SafeAccount {
  const burnerSigner = signerAddress(qx, qy);
  return { credentialId, qx, qy, burnerSigner, address: safeAddress(burnerSigner) };
}

export function wedgieSigners(w: { x: Hex; y: Hex }): [Address, Address] {
  return [signerAddress(w.x, w.y), signerAddress(w.x, w.y, VERIFIERS_SLOT2)];
}

const KEY = "iws.account";
export function loadAccount(): SafeAccount | null {
  try {
    const v = localStorage.getItem(KEY);
    if (!v) return null;
    const a = JSON.parse(v) as SafeAccount;
    return { ...a, ...accountFor(a.credentialId, a.qx, a.qy) }; // addresses are recomputed, never trusted from storage
  } catch {
    return null;
  }
}
export function saveAccount(a: SafeAccount | null) {
  try {
    if (a) localStorage.setItem(KEY, JSON.stringify(a));
    else localStorage.removeItem(KEY);
  } catch {}
}

export type Recovery = { newOwners: Address[]; executeAfter: number; approvals: number } | null;

/** One chain's view of the wallet. */
export type ChainState = {
  chainId: number;
  deployed: boolean;
  owners: Address[];
  threshold: number;
  nonce: bigint;
  guardians: Address[];
  recovery: Recovery;
  roles: Address | null; // enabled Roles modifier (the burner's budget)
  budget: { usdc: bigint; eth: bigint; usdcMax: bigint; ethMax: bigint } | null;
  level: 1 | 2 | 3 | 4 | 5;
};

export async function readChain(chainId: number, a: SafeAccount): Promise<ChainState> {
  const pc = publicClient(chainId);
  const safe = a.address;
  const code = await pc.getCode({ address: safe }).catch(() => undefined);
  const deployed = !!code && code !== "0x";
  if (!deployed)
    return {
      chainId,
      deployed,
      owners: [a.burnerSigner],
      threshold: 1,
      nonce: 0n,
      guardians: [DAO],
      recovery: null,
      roles: null,
      budget: null,
      level: 1,
    };
  const read = (functionName: any, args: any[] = [], address: Address = safe, ab: any = abi.safe) =>
    pc.readContract({ address, abi: ab, functionName, args } as any) as Promise<any>;
  const roles = rolesAddress(safe);
  const [owners, threshold, nonce, rolesOn, guardians, req] = await Promise.all([
    read("getOwners"),
    read("getThreshold"),
    read("nonce"),
    read("isModuleEnabled", [roles]),
    read("getGuardians", [safe], RECOVERY_7D, abi.recovery).catch(() => []),
    read("getRecoveryRequest", [safe], RECOVERY_7D, abi.recovery).catch(() => null),
  ]);
  let budget: ChainState["budget"] = null;
  if (rolesOn) {
    const [u, e] = await Promise.all([
      read("allowances", [KEY_USDC], roles, abi.roles).catch(() => null),
      read("allowances", [KEY_ETH], roles, abi.roles).catch(() => null),
    ]);
    if (u && e) budget = { usdc: avail(u), eth: avail(e), usdcMax: u[1], ethMax: e[1] };
  }
  const recovery: Recovery =
    req && Number(req.executeAfter) > 0
      ? { newOwners: req.newOwners.map((x: string) => getAddress(x)), executeAfter: Number(req.executeAfter) * 1000, approvals: Number(req.guardiansApprovalCount) }
      : null;
  const o = (owners as string[]).map(x => getAddress(x));
  const g = (guardians as string[]).map(x => getAddress(x));
  // another device may have added the keys: the shape says it too (level 4 = 4 owners, threshold 3)
  const hasWedgie = (!!a.wedgie && wedgieSigners(a.wedgie).every(w => o.includes(w))) || (o.length >= 4 && Number(threshold) >= 3);
  const daoGuardian = g.some(x => x.toLowerCase() === DAO.toLowerCase());
  const level: ChainState["level"] = hasWedgie ? (daoGuardian ? 4 : 5) : o.length >= 2 ? (daoGuardian ? 2 : 3) : 1;
  return { chainId, deployed, owners: o, threshold: Number(threshold), nonce, guardians: g, recovery, roles: rolesOn ? roles : null, budget, level };
}

/** Zodiac Roles allowance available now: balance plus refills since the last timestamp, capped at maxRefill. */
function avail(x: readonly [bigint, bigint, bigint, bigint, bigint]): bigint {
  const [refill, maxRefill, period, balance, timestamp] = x;
  if (period === 0n) return balance;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const elapsed = now > timestamp ? (now - timestamp) / period : 0n;
  const b = balance + elapsed * refill;
  return b > maxRefill ? (balance > maxRefill ? balance : maxRefill) : b;
}

export async function readAll(a: SafeAccount): Promise<ChainState[]> {
  return Promise.all(CHAINS.map(c => readChain(c.id, a).catch(() => null))).then(r => r.filter((x): x is ChainState => !!x));
}

/** The hot wallet on this chain: the owner that isn't the burner or a wedgie slot. */
export function hotOf(a: SafeAccount, st: ChainState): Address | undefined {
  const known = [a.burnerSigner, ...(a.wedgie ? wedgieSigners(a.wedgie) : [])].map(x => x.toLowerCase());
  const rest = st.owners.filter(o => !known.includes(o.toLowerCase()));
  return a.hot ?? (rest.length === 1 ? rest[0] : undefined);
}

export const LEVEL_NAME: Record<number, string> = {
  1: "Burner",
  2: "Hot wallet added",
  3: "Paper backup",
  4: "Wedgie",
  5: "Full self-custody",
};

export const salt = (): Hex => keccak256(toBytes(`${Date.now()}-${Math.random()}`));
export { zeroAddress };
