import type { StoredAccount } from "./accounts";
import { api } from "./api";
import type { Address, Hex } from "viem";
import { chainId } from "~~/utils/chain";
import {
  type Call,
  hashAddSigner,
  hashCalls,
  hashCancelRecovery,
  hashExecute,
  hashRemoveSigner,
  hashSetRecovery,
  hashTransfer,
  hashUpdateSigner,
} from "~~/utils/digests";
import { signDigest } from "~~/utils/passkey";

/**
 * A meta action the user wants to perform, in typed form. The same object drives both signer
 * paths: the passkey path signs the digest here and posts to /api/facilitate; the device path
 * posts the raw fields to /api/requests and waits for the device.
 */
export type MetaAction =
  | { fn: "metaTransfer"; token: Address; to: Address; amount: bigint; fee: bigint; toName?: string }
  | { fn: "metaExecute"; calls: Call[] }
  | {
      fn: "metaAddSigner";
      qx: Hex;
      qy: Hex;
      kind: number;
      role: number;
      dailyLimit: bigint;
      credentialIdHash: Hex;
      label?: string;
    }
  | { fn: "metaUpdateSigner"; targetSignerId: Address; role: number; dailyLimit: bigint }
  | { fn: "metaRemoveSigner"; targetSignerId: Address }
  | { fn: "metaSetRecovery"; recoveryAddress: Address; recoveryDelay: bigint }
  | { fn: "metaCancelRecovery" };

export const REQUEST_KIND: Record<MetaAction["fn"], string> = {
  metaTransfer: "transfer",
  metaExecute: "execute",
  metaAddSigner: "addSigner",
  metaUpdateSigner: "updateSigner",
  metaRemoveSigner: "removeSigner",
  metaSetRecovery: "setRecovery",
  metaCancelRecovery: "cancelRecovery",
};

/** JSON args for /api/facilitate (bigints as decimal strings). */
export function metaArgs(a: MetaAction): unknown[] {
  switch (a.fn) {
    case "metaTransfer":
      return [a.token, a.to, a.amount.toString(), a.fee.toString()];
    case "metaExecute":
      return [a.calls.map(c => ({ target: c.target, value: c.value.toString(), data: c.data }))];
    case "metaAddSigner":
      return [a.qx, a.qy, a.kind, a.role, a.dailyLimit.toString(), a.credentialIdHash];
    case "metaUpdateSigner":
      return [a.targetSignerId, a.role, a.dailyLimit.toString()];
    case "metaRemoveSigner":
      return [a.targetSignerId];
    case "metaSetRecovery":
      return [a.recoveryAddress, a.recoveryDelay.toString()];
    case "metaCancelRecovery":
      return [];
  }
}

/** Body for POST /api/requests (the device queue). */
export function requestBody(a: MetaAction, wallet: Address, signerId: Address, note?: string): Record<string, unknown> {
  const base = { wallet, signerId, kind: REQUEST_KIND[a.fn], note };
  switch (a.fn) {
    case "metaTransfer":
      return {
        ...base,
        token: a.token,
        to: a.to,
        toName: a.toName,
        amount: a.amount.toString(),
        fee: a.fee.toString(),
      };
    case "metaExecute":
      return { ...base, calls: a.calls.map(c => ({ target: c.target, value: c.value.toString(), data: c.data })) };
    case "metaAddSigner":
      return {
        ...base,
        qx: a.qx,
        qy: a.qy,
        signerKind: a.kind,
        role: a.role,
        dailyLimit: a.dailyLimit.toString(),
        credentialIdHash: a.credentialIdHash,
        label: a.label,
      };
    case "metaUpdateSigner":
      return { ...base, targetSignerId: a.targetSignerId, role: a.role, dailyLimit: a.dailyLimit.toString() };
    case "metaRemoveSigner":
      return { ...base, targetSignerId: a.targetSignerId };
    case "metaSetRecovery":
      return { ...base, recoveryAddress: a.recoveryAddress, recoveryDelay: a.recoveryDelay.toString() };
    case "metaCancelRecovery":
      return base;
  }
}

export function metaDigest(wallet: Address, a: MetaAction, nonce: bigint, deadline: bigint): Hex {
  switch (a.fn) {
    case "metaTransfer":
      return hashTransfer(chainId, wallet, { token: a.token, to: a.to, amount: a.amount, fee: a.fee, nonce, deadline });
    case "metaExecute":
      return hashExecute(chainId, wallet, { callsHash: hashCalls(a.calls), nonce, deadline });
    case "metaAddSigner":
      return hashAddSigner(chainId, wallet, {
        qx: a.qx,
        qy: a.qy,
        kind: a.kind,
        role: a.role,
        dailyLimit: a.dailyLimit,
        credentialIdHash: a.credentialIdHash,
        nonce,
        deadline,
      });
    case "metaUpdateSigner":
      return hashUpdateSigner(chainId, wallet, {
        signerId: a.targetSignerId,
        role: a.role,
        dailyLimit: a.dailyLimit,
        nonce,
        deadline,
      });
    case "metaRemoveSigner":
      return hashRemoveSigner(chainId, wallet, { signerId: a.targetSignerId, nonce, deadline });
    case "metaSetRecovery":
      return hashSetRecovery(chainId, wallet, {
        recoveryAddress: a.recoveryAddress,
        recoveryDelay: a.recoveryDelay,
        nonce,
        deadline,
      });
    case "metaCancelRecovery":
      return hashCancelRecovery(chainId, wallet, { nonce, deadline });
  }
}

/** Only owners may do anything other than a token transfer. */
export function needsOwner(a: MetaAction): boolean {
  return a.fn !== "metaTransfer";
}

/**
 * Passkey path: fresh nonce -> digest -> Face ID -> /api/facilitate. Resolves to the tx hash.
 * The WebAuthn challenge is the raw digest; the browser signs; the contract verifies.
 */
export async function signAndFacilitate(
  wallet: Address,
  passkey: StoredAccount,
  action: MetaAction,
): Promise<{ txHash: Hex }> {
  const { nonce } = await api.nonce(wallet);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
  const digest = metaDigest(wallet, action, BigInt(nonce), deadline);
  const { signature } = await signDigest(passkey.credentialId, digest);
  const res = await api.facilitate({
    wallet,
    chainId,
    functionName: action.fn,
    args: metaArgs(action),
    signerId: passkey.signerId,
    deadline: deadline.toString(),
    signature,
    label: action.fn === "metaAddSigner" ? action.label : undefined,
  });
  return { txHash: res.txHash };
}
