import { type Address, type Hex, encodeAbiParameters, encodePacked, keccak256, toBytes } from "viem";

/** Pure helpers shared by the page, the signing worker and the forge tests (no browser APIs). See hybrid.ts. */

/** PRF salt for hash key i. Any device the passkey syncs to derives the same keys. */
export const pqSalt = (i: bigint) => toBytes(keccak256(encodePacked(["string", "uint256"], ["instant-wallet pq-hybrid v1", i])));

const DOMAIN = keccak256(toBytes("instant-wallet.pq-hybrid.v1"));

/** HybridPQSigner.pqMessage: what hash key `index` signs. */
export function pqMessage(chainId: number, signer: Address, index: bigint, safeTxHash: Hex, next: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
      [DOMAIN, BigInt(chainId), signer, index, safeTxHash, next],
    ),
  );
}

export const commitOf = (pkSeed: Hex, pkRoot: Hex) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [pkSeed, pkRoot]));

export type WorkerReq =
  | { kind: "pub"; material: Uint8Array }
  | { kind: "sign"; material: Uint8Array; nextMaterial: Uint8Array; chainId: number; signer: Address; index: string; safeTxHash: Hex };
export type WorkerRes =
  | { ok: true; pkSeed: Hex; pkRoot: Hex; next?: Hex; sig?: Hex; ms: { next?: number; key: number; sign?: number } }
  | { ok: false; error: string };
