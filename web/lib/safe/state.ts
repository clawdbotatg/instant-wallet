import { type Address, type Hex, getAddress, keccak256, size, toBytes, zeroAddress } from "viem";
import { CHAINS, publicClient } from "../chains";
import { DAO, KEY_ETH, KEY_FEE_USDC, KEY_USDC, RECOVERY_14D, RECOVERY_60D, RECOVERY_7D, RECOVERY_DAYS, RECOVERY_MODULES } from "./config";
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
  recovered?: boolean; // a new phone taking over an existing wallet: `address` is that wallet, not this key's own
};

export function accountFor(credentialId: string, qx: Hex, qy: Hex, recovering?: Address): SafeAccount {
  const burnerSigner = signerAddress(qx, qy);
  if (recovering) return { credentialId, qx, qy, burnerSigner, address: getAddress(recovering), recovered: true };
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
    // addresses are recomputed, never trusted from storage (except a recovered wallet's, which no key derives)
    return { ...a, ...accountFor(a.credentialId, a.qx, a.qy, a.recovered ? a.address : undefined) };
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

/** The name the user gave this wallet (this browser only, private), or null: we name it (defaultWalletName). */
export function loadWalletName(address: Address): string | null {
  try {
    return localStorage.getItem(`iws.name.${address.toLowerCase()}`);
  } catch {
    return null;
  }
}
export function saveWalletName(address: Address, name: string | null) {
  try {
    if (name) localStorage.setItem(`iws.name.${address.toLowerCase()}`, name);
    else localStorage.removeItem(`iws.name.${address.toLowerCase()}`);
  } catch {}
}
export const defaultWalletName = (hasWedgie: boolean) => (hasWedgie ? "Savings account" : "Spending account");

export type Recovery = { newOwners: Address[]; newThreshold: number; executeAfter: number; approvals: number } | null;
/** One enabled recovery module: who can recover, after how long, and its running request. */
export type RecoveryOn = { module: Address; days: number; guardians: Address[] | null; request: Recovery };

/** One chain's view of the wallet. */
export type ChainState = {
  chainId: number;
  deployed: boolean;
  owners: Address[];
  threshold: number;
  nonce: bigint;
  guardians: Address[] | null; // your own recovery address(es), on recoveryModule (null = couldn't read them)
  recoveryModule: Address; // where your own recovery address goes: 7 days, or 14 once the wedgie is paired
  recoveryDays: number;
  recoveries: RecoveryOn[]; // every recovery module on (with the wedgie: 14 days for yours, 60 for the DAO)
  stored: Record<Address, Address[]> | null; // each recovery module's guardians, on or off (null = a read failed)
  has60: boolean; // the 60-day module is deployed on this chain
  modules: Address[]; // every module on (the order matters to turn one off)
  recovery: Recovery; // the first running request (recoveries has each)
  roles: Address | null; // enabled Roles modifier (the burner's budget)
  staleBudget: boolean; // Roles is on and some other key is its member (a lost phone's budget, after a recovery)
  rolesMembers: Address[] | null; // the keys with a burner budget (null = couldn't read)
  rolesDeployed: boolean;
  budget: { usdc: bigint; eth: bigint; usdcMax: bigint; ethMax: bigint; feeUsdc: bigint | null } | null;
  hasHot: boolean;
  hasWedgie: boolean;
  hot?: Address; // the hot wallet's address, when there is one
  wedgie?: Address; // the wedgie's first owner slot, when it's on
  level: 1 | 2 | 3; // how many signing keys: the Instant wallet, + a hot wallet, + the wedgie (any order; paper isn't a signer)
};

export async function readChain(chainId: number, a: SafeAccount): Promise<ChainState> {
  const pc = publicClient(chainId);
  const safe = a.address;
  const [code, code60] = await Promise.all([pc.getCode({ address: safe }).catch(() => undefined), pc.getCode({ address: RECOVERY_60D }).catch(() => undefined)]);
  const deployed = !!code && code !== "0x";
  const has60 = !!code60 && code60 !== "0x";
  if (!deployed)
    return {
      chainId,
      deployed,
      owners: a.recovered ? [] : [a.burnerSigner],
      threshold: 1,
      nonce: 0n,
      guardians: [DAO],
      recoveryModule: RECOVERY_7D,
      recoveryDays: 7,
      recoveries: [{ module: RECOVERY_7D, days: 7, guardians: [DAO], request: null }],
      stored: { [RECOVERY_7D]: [DAO] },
      has60,
      modules: [RECOVERY_7D],
      recovery: null,
      roles: null,
      staleBudget: false,
      rolesMembers: null,
      rolesDeployed: false,
      budget: null,
      hasHot: false,
      hasWedgie: false,
      level: 1,
    };
  const read = (functionName: any, args: any[] = [], address: Address = safe, ab: any = abi.safe) =>
    pc.readContract({ address, abi: ab, functionName, args } as any) as Promise<any>;
  const roles = rolesAddress(safe);
  const [owners, threshold, nonce, rolesOn, mods] = await Promise.all([
    read("getOwners"),
    read("getThreshold"),
    read("nonce"),
    read("isModuleEnabled", [roles]),
    read("getModulesPaginated", ["0x0000000000000000000000000000000000000001", 20n]),
  ]);
  const modules = (mods[0] as string[]).map(x => getAddress(x));
  // your own recovery address: the 14-day module once it's on, else the 7-day one
  const rm = modules.includes(RECOVERY_14D) ? RECOVERY_14D : RECOVERY_7D;
  const recs = await Promise.all(
    RECOVERY_MODULES.map(async m => {
      const [g, r] = await Promise.all([read("getGuardians", [safe], m, abi.recovery).catch(() => null), read("getRecoveryRequest", [safe], m, abi.recovery).catch(() => null)]);
      return { module: m, days: RECOVERY_DAYS[m], guardians: g ? (g as string[]).map(x => getAddress(x)) : null, request: toRecovery(r) };
    }),
  );
  const recoveries = recs.filter(r => modules.includes(r.module));
  const stored = recs.every(r => r.guardians) ? Object.fromEntries(recs.map(r => [r.module, r.guardians!])) : null;
  let budget: ChainState["budget"] = null;
  const rolesCode = await pc.getCode({ address: roles }).catch(() => undefined);
  const members: Address[] | null =
    rolesCode && rolesCode !== "0x"
      ? await read("getModulesPaginated", ["0x0000000000000000000000000000000000000001", 20n], roles, abi.roles)
          .then((r: any) => (r[0] as string[]).map(x => getAddress(x)))
          .catch(() => null)
      : [];
  const member = !!members?.some(m => m.toLowerCase() === a.burnerSigner.toLowerCase());
  if (rolesOn && member) {
    const [u, e, f] = await Promise.all([
      read("allowances", [KEY_USDC], roles, abi.roles).catch(() => null),
      read("allowances", [KEY_ETH], roles, abi.roles).catch(() => null),
      read("allowances", [KEY_FEE_USDC], roles, abi.roles).catch(() => null),
    ]);
    // the fee allowance: null on a wallet set up before it existed (its USDC fee still comes off the limit)
    if (u && e) budget = { usdc: avail(u), eth: avail(e), usdcMax: u[1], ethMax: e[1], feeUsdc: f && f[2] > 0n ? avail(f) : null };
  }
  const o = (owners as string[]).map(x => getAddress(x));
  const g = recs.find(r => r.module === rm)!.guardians;
  // another device may have added the keys: the shape says it too (only the wedgie takes the threshold to 3)
  const known = !!a.wedgie && wedgieSigners(a.wedgie).every(w => o.includes(w));
  const hasWedgie = known || Number(threshold) >= 3;
  // the hot wallet is the owner that's an account, not a passkey signer (the wedgie's slots are passkey signers,
  // 236-byte proxies): so it's found even on a device that never paired the wedgie
  const mine = [a.burnerSigner, ...(a.wedgie ? wedgieSigners(a.wedgie) : [])].map(x => x.toLowerCase());
  const others = o.filter(x => !mine.includes(x.toLowerCase()));
  const codes = await Promise.all(others.map(x => pc.getCode({ address: x }).catch(() => "0x00" as Hex)));
  const hot = others.find((_, i) => !codes[i] || codes[i] === "0x" || size(codes[i]!) !== PASSKEY_SIGNER_SIZE);
  const hasHot = !!hot;
  const wedgie = known ? wedgieSigners(a.wedgie!)[0] : others.find((_, i) => !!codes[i] && size(codes[i]!) === PASSKEY_SIGNER_SIZE);
  const level = (1 + Number(hasHot) + Number(hasWedgie)) as ChainState["level"];
  return {
    chainId,
    deployed,
    owners: o,
    threshold: Number(threshold),
    nonce,
    guardians: g,
    recoveryModule: rm,
    recoveryDays: RECOVERY_DAYS[rm],
    recoveries,
    stored,
    has60,
    modules,
    recovery: recoveries.find(r => r.request)?.request ?? null,
    roles: rolesOn ? roles : null,
    staleBudget: !!rolesOn && !!members && members.some(m => m.toLowerCase() !== a.burnerSigner.toLowerCase()),
    rolesMembers: members,
    rolesDeployed: !!rolesCode && rolesCode !== "0x",
    budget,
    hasHot,
    hasWedgie,
    hot,
    wedgie: hasWedgie ? wedgie : undefined,
    level,
  };
}

function toRecovery(req: any): Recovery {
  return req && Number(req.executeAfter) > 0
    ? {
        newOwners: req.newOwners.map((x: string) => getAddress(x)),
        newThreshold: Number(req.newThreshold),
        executeAfter: Number(req.executeAfter) * 1000,
        approvals: Number(req.guardiansApprovalCount),
      }
    : null;
}

/** With the wedgie: the DAO on the 60-day module (else wherever it is, on an older or wedgie-less wallet). */
export const daoDays = (st: ChainState) => st.recoveries.find(r => r.guardians?.some(g => g.toLowerCase() === DAO.toLowerCase()))?.days ?? null;
/** A wedgie wallet whose recovery isn't the 14 + 60-day layout yet (paired before it existed). */
export const oldLayout = (st: ChainState) => st.hasWedgie && !st.modules.includes(RECOVERY_60D);

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

/** The hot wallet on this chain: the owner that's an account, not the burner or a wedgie slot. */
export function hotOf(a: SafeAccount, st: ChainState): Address | undefined {
  if (a.hot && st.owners.some(o => o.toLowerCase() === a.hot!.toLowerCase())) return a.hot;
  return st.hot;
}

/** SafeWebAuthnSignerProxy's runtime size (the burner and both wedgie slots; checked on a Base fork 2026-10-06). */
const PASSKEY_SIGNER_SIZE = 236;

export const salt = (): Hex => keccak256(toBytes(`${Date.now()}-${Math.random()}`));
export { zeroAddress };
