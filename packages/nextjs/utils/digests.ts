import {
  type Address,
  type Hex,
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbi,
} from "viem";

/**
 * EIP-712 digest builders for every InstantWallet meta action (docs/PROTOCOL.md section 3, v2).
 * Pure functions, no aliases, no runtime dependencies beyond viem, so scripts/*.mjs can import
 * this file directly under Node's type stripping and cross-check it against the contract views.
 */

export const KIND_WEBAUTHN = 0;
export const KIND_RAW = 1;
export const ROLE_SPENDER = 0;
export const ROLE_OWNER = 1;

/** The asset address that means native ETH (InstantWallet.ETH). */
export const ETH_ASSET: Address = "0x0000000000000000000000000000000000000000";
export const isEth = (asset: string) => asset.toLowerCase() === ETH_ASSET;

export type Call = { target: Address; value: bigint; data: Hex };

export const TYPES = {
  Transfer: [
    { name: "asset", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "fee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Execute: [
    { name: "callsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  AddSigner: [
    { name: "qx", type: "bytes32" },
    { name: "qy", type: "bytes32" },
    { name: "kind", type: "uint8" },
    { name: "role", type: "uint8" },
    { name: "credentialIdHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  UpdateSigner: [
    { name: "signerId", type: "address" },
    { name: "role", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  SetLimit: [
    { name: "signerId", type: "address" },
    { name: "asset", type: "address" },
    { name: "limit", type: "uint128" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  RemoveSigner: [
    { name: "signerId", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  SetRecovery: [
    { name: "recoveryAddress", type: "address" },
    { name: "recoveryDelay", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  CancelRecovery: [
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function domain(chainId: number, wallet: Address) {
  return { name: "InstantWallet", version: "2", chainId, verifyingContract: wallet } as const;
}

/** signerId = address(uint160(uint256(keccak256(abi.encodePacked(qx, qy))))) */
export function signerIdOf(qx: Hex, qy: Hex): Address {
  const h = keccak256(concatHex([qx, qy]));
  return `0x${h.slice(-40)}` as Address;
}

/** callsHash = keccak256(concat(keccak256(abi.encode(target, value, keccak256(data))) ...)) */
export function hashCalls(calls: readonly Call[]): Hex {
  const parts = calls.map(c =>
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        [c.target, c.value, keccak256(c.data)],
      ),
    ),
  );
  return keccak256(parts.length ? concatHex(parts) : "0x");
}

export type TransferFields = {
  asset: Address;
  to: Address;
  amount: bigint;
  fee: bigint;
  nonce: bigint;
  deadline: bigint;
};
export function hashTransfer(chainId: number, wallet: Address, m: TransferFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "Transfer", message: m });
}

export type ExecuteFields = { callsHash: Hex; nonce: bigint; deadline: bigint };
export function hashExecute(chainId: number, wallet: Address, m: ExecuteFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "Execute", message: m });
}

export type AddSignerFields = {
  qx: Hex;
  qy: Hex;
  kind: number;
  role: number;
  credentialIdHash: Hex;
  nonce: bigint;
  deadline: bigint;
};
export function hashAddSigner(chainId: number, wallet: Address, m: AddSignerFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "AddSigner", message: m });
}

export type UpdateSignerFields = { signerId: Address; role: number; nonce: bigint; deadline: bigint };
export function hashUpdateSigner(chainId: number, wallet: Address, m: UpdateSignerFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "UpdateSigner", message: m });
}

export type SetLimitFields = { signerId: Address; asset: Address; limit: bigint; nonce: bigint; deadline: bigint };
export function hashSetLimit(chainId: number, wallet: Address, m: SetLimitFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "SetLimit", message: m });
}

export type RemoveSignerFields = { signerId: Address; nonce: bigint; deadline: bigint };
export function hashRemoveSigner(chainId: number, wallet: Address, m: RemoveSignerFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "RemoveSigner", message: m });
}

export type SetRecoveryFields = { recoveryAddress: Address; recoveryDelay: bigint; nonce: bigint; deadline: bigint };
export function hashSetRecovery(chainId: number, wallet: Address, m: SetRecoveryFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "SetRecovery", message: m });
}

export type CancelRecoveryFields = { nonce: bigint; deadline: bigint };
export function hashCancelRecovery(chainId: number, wallet: Address, m: CancelRecoveryFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "CancelRecovery", message: m });
}

/** Match code: WORDS[d0] WORDS[d1] d2%100 — see utils/matchwords.ts (kept there so the word list has one home). */
export const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ---------------------------------------------------------------- self-call admin batch
//
// Every admin action also exists as a plain function the wallet may call on itself (onlySelf), so an
// owner batches several in ONE metaExecute whose calls all target the wallet. Pairing a device is
// `Execute([addSigner(chip, owner), updateSigner(passkey, spender), setLimit(passkey, USDC, 500e6), ...])`.

export const SELF_ABI = parseAbi([
  "function addSigner(bytes32 qx, bytes32 qy, uint8 kind, uint8 role, bytes32 credentialIdHash)",
  "function updateSigner(address targetSignerId, uint8 role)",
  "function setLimit(address targetSignerId, address asset, uint128 limit)",
  "function removeSigner(address targetSignerId)",
  "function setRecovery(address recoveryAddress, uint64 recoveryDelay)",
]);

export type AdminOp =
  | { op: "addSigner"; qx: Hex; qy: Hex; kind: number; role: number; credentialIdHash: Hex }
  | { op: "updateSigner"; signerId: Address; role: number }
  | { op: "setLimit"; signerId: Address; asset: Address; limit: bigint }
  | { op: "removeSigner"; signerId: Address }
  | { op: "setRecovery"; recoveryAddress: Address; recoveryDelay: bigint };

function adminData(o: AdminOp): Hex {
  switch (o.op) {
    case "addSigner":
      return encodeFunctionData({
        abi: SELF_ABI,
        functionName: "addSigner",
        args: [o.qx, o.qy, o.kind, o.role, o.credentialIdHash],
      });
    case "updateSigner":
      return encodeFunctionData({ abi: SELF_ABI, functionName: "updateSigner", args: [o.signerId, o.role] });
    case "setLimit":
      return encodeFunctionData({ abi: SELF_ABI, functionName: "setLimit", args: [o.signerId, o.asset, o.limit] });
    case "removeSigner":
      return encodeFunctionData({ abi: SELF_ABI, functionName: "removeSigner", args: [o.signerId] });
    case "setRecovery":
      return encodeFunctionData({
        abi: SELF_ABI,
        functionName: "setRecovery",
        args: [o.recoveryAddress, o.recoveryDelay],
      });
  }
}

/** The `Call[]` for `metaExecute` that performs `ops` on the wallet itself, in order. */
export function adminCalls(wallet: Address, ops: readonly AdminOp[]): Call[] {
  return ops.map(o => ({ target: wallet, value: 0n, data: adminData(o) }));
}

/** Inverse of adminCalls: the ops when EVERY call targets the wallet and decodes; otherwise null. */
export function decodeAdminCalls(wallet: Address, calls: readonly Call[]): AdminOp[] | null {
  const out: AdminOp[] = [];
  for (const c of calls) {
    if (c.target.toLowerCase() !== wallet.toLowerCase() || c.value !== 0n) return null;
    try {
      const d = decodeFunctionData({ abi: SELF_ABI, data: c.data });
      const a = d.args as readonly unknown[];
      switch (d.functionName) {
        case "addSigner":
          out.push({
            op: "addSigner",
            qx: a[0] as Hex,
            qy: a[1] as Hex,
            kind: Number(a[2]),
            role: Number(a[3]),
            credentialIdHash: a[4] as Hex,
          });
          break;
        case "updateSigner":
          out.push({ op: "updateSigner", signerId: a[0] as Address, role: Number(a[1]) });
          break;
        case "setLimit":
          out.push({ op: "setLimit", signerId: a[0] as Address, asset: a[1] as Address, limit: a[2] as bigint });
          break;
        case "removeSigner":
          out.push({ op: "removeSigner", signerId: a[0] as Address });
          break;
        case "setRecovery":
          out.push({ op: "setRecovery", recoveryAddress: a[0] as Address, recoveryDelay: a[1] as bigint });
          break;
      }
    } catch {
      return null;
    }
  }
  return out;
}
