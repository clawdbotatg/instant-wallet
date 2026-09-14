import { type Address, type Hex, concatHex, encodeAbiParameters, hashTypedData, keccak256 } from "viem";

/**
 * EIP-712 digest builders for every InstantWallet meta action (docs/PROTOCOL.md section 3).
 * Pure functions, no aliases, no runtime dependencies beyond viem, so scripts/*.mjs can import
 * this file directly under Node's type stripping and cross-check it against the contract views.
 */

export const KIND_WEBAUTHN = 0;
export const KIND_RAW = 1;
export const ROLE_SPENDER = 0;
export const ROLE_OWNER = 1;

export type Call = { target: Address; value: bigint; data: Hex };

export const TYPES = {
  Transfer: [
    { name: "token", type: "address" },
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
    { name: "dailyLimit", type: "uint128" },
    { name: "credentialIdHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  UpdateSigner: [
    { name: "signerId", type: "address" },
    { name: "role", type: "uint8" },
    { name: "dailyLimit", type: "uint128" },
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
  return { name: "InstantWallet", version: "1", chainId, verifyingContract: wallet } as const;
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
  token: Address;
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
  dailyLimit: bigint;
  credentialIdHash: Hex;
  nonce: bigint;
  deadline: bigint;
};
export function hashAddSigner(chainId: number, wallet: Address, m: AddSignerFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "AddSigner", message: m });
}

export type UpdateSignerFields = {
  signerId: Address;
  role: number;
  dailyLimit: bigint;
  nonce: bigint;
  deadline: bigint;
};
export function hashUpdateSigner(chainId: number, wallet: Address, m: UpdateSignerFields): Hex {
  return hashTypedData({ domain: domain(chainId, wallet), types: TYPES, primaryType: "UpdateSigner", message: m });
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
