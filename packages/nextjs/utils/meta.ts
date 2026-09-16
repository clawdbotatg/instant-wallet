import type { StoredAccount } from "./accounts";
import { api } from "./api";
import type { Address, Hex } from "viem";
import { chainId } from "~~/utils/chain";
import {
  type AdminOp,
  type Call,
  adminCalls,
  hashAddSigner,
  hashCalls,
  hashCancelRecovery,
  hashExecute,
  hashRemoveSigner,
  hashSetLimit,
  hashSetRecovery,
  hashTransfer,
  hashUpdateSigner,
} from "~~/utils/digests";
import { credentialIdHash, signDigest } from "~~/utils/passkey";

/**
 * A meta action the user wants to perform, in typed form. The same object drives both signer
 * paths: the passkey path signs the digest here and posts to /api/facilitate; the device path
 * posts the raw fields to /api/requests and waits for the device.
 *
 * `assetSymbol` / `assetDecimals` on a transfer or setLimit are display hints only (what the device
 * shows); the digest is built from the raw fields.
 */
export type MetaAction =
  | {
      fn: "metaTransfer";
      asset: Address;
      to: Address;
      amount: bigint;
      fee: bigint;
      toName?: string;
      assetSymbol?: string;
      assetDecimals?: number;
    }
  | { fn: "metaExecute"; calls: Call[]; labels?: Record<string, string> }
  | {
      fn: "metaAddSigner";
      qx: Hex;
      qy: Hex;
      kind: number;
      role: number;
      credentialIdHash: Hex;
      label?: string;
    }
  | { fn: "metaUpdateSigner"; targetSignerId: Address; role: number; label?: string }
  | {
      fn: "metaSetLimit";
      targetSignerId: Address;
      asset: Address;
      limit: bigint;
      assetSymbol?: string;
      assetDecimals?: number;
      label?: string;
    }
  | { fn: "metaRemoveSigner"; targetSignerId: Address; label?: string }
  | { fn: "metaSetRecovery"; recoveryAddress: Address; recoveryDelay: bigint }
  | { fn: "metaCancelRecovery" };

export const REQUEST_KIND: Record<MetaAction["fn"], string> = {
  metaTransfer: "transfer",
  metaExecute: "execute",
  metaAddSigner: "addSigner",
  metaUpdateSigner: "updateSigner",
  metaSetLimit: "setLimit",
  metaRemoveSigner: "removeSigner",
  metaSetRecovery: "setRecovery",
  metaCancelRecovery: "cancelRecovery",
};

/**
 * Several admin changes as ONE action: a single change is its own meta call (one signature, and the
 * device can decode it), several are batched into one metaExecute of self-calls (one Face ID).
 */
export function adminAction(
  wallet: Address,
  ops: AdminOp[],
  hints?: { assetSymbol?: string; assetDecimals?: number; labels?: Record<string, string> },
): MetaAction {
  const labelOf = (id: Address) => hints?.labels?.[id] ?? hints?.labels?.[id.toLowerCase()];
  if (ops.length === 1) {
    const o = ops[0];
    switch (o.op) {
      case "addSigner":
        return {
          fn: "metaAddSigner",
          qx: o.qx,
          qy: o.qy,
          kind: o.kind,
          role: o.role,
          credentialIdHash: o.credentialIdHash,
        };
      case "updateSigner":
        return { fn: "metaUpdateSigner", targetSignerId: o.signerId, role: o.role, label: labelOf(o.signerId) };
      case "setLimit":
        return {
          fn: "metaSetLimit",
          targetSignerId: o.signerId,
          asset: o.asset,
          limit: o.limit,
          assetSymbol: hints?.assetSymbol,
          assetDecimals: hints?.assetDecimals,
          label: labelOf(o.signerId),
        };
      case "removeSigner":
        return { fn: "metaRemoveSigner", targetSignerId: o.signerId, label: labelOf(o.signerId) };
      case "setRecovery":
        return { fn: "metaSetRecovery", recoveryAddress: o.recoveryAddress, recoveryDelay: o.recoveryDelay };
    }
  }
  return { fn: "metaExecute", calls: adminCalls(wallet, ops), labels: hints?.labels };
}

/** Mirror of the server's facilitatorFee() from the policy the snapshot carries (default: 0). */
export function feeFor(
  policy: { bps: number; flatStable: string } | undefined,
  asset: Address,
  amount: bigint,
  stable?: Address,
): bigint {
  if (!policy) return 0n;
  if (policy.bps > 0) return (amount * BigInt(policy.bps)) / 10_000n;
  if (policy.flatStable !== "0" && stable && asset.toLowerCase() === stable.toLowerCase())
    return BigInt(policy.flatStable);
  return 0n;
}

/** JSON args for /api/facilitate (bigints as decimal strings). */
export function metaArgs(a: MetaAction): unknown[] {
  switch (a.fn) {
    case "metaTransfer":
      return [a.asset, a.to, a.amount.toString(), a.fee.toString()];
    case "metaExecute":
      return [a.calls.map(c => ({ target: c.target, value: c.value.toString(), data: c.data }))];
    case "metaAddSigner":
      return [a.qx, a.qy, a.kind, a.role, a.credentialIdHash];
    case "metaUpdateSigner":
      return [a.targetSignerId, a.role];
    case "metaSetLimit":
      return [a.targetSignerId, a.asset, a.limit.toString()];
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
        asset: a.asset,
        to: a.to,
        toName: a.toName,
        amount: a.amount.toString(),
        fee: a.fee.toString(),
      };
    case "metaExecute":
      return {
        ...base,
        calls: a.calls.map(c => ({ target: c.target, value: c.value.toString(), data: c.data })),
        labels: a.labels,
      };
    case "metaAddSigner":
      return {
        ...base,
        qx: a.qx,
        qy: a.qy,
        signerKind: a.kind,
        role: a.role,
        credentialIdHash: a.credentialIdHash,
        label: a.label,
      };
    case "metaUpdateSigner":
      return { ...base, targetSignerId: a.targetSignerId, role: a.role, label: a.label };
    case "metaSetLimit":
      return { ...base, targetSignerId: a.targetSignerId, asset: a.asset, limit: a.limit.toString(), label: a.label };
    case "metaRemoveSigner":
      return { ...base, targetSignerId: a.targetSignerId, label: a.label };
    case "metaSetRecovery":
      return { ...base, recoveryAddress: a.recoveryAddress, recoveryDelay: a.recoveryDelay.toString() };
    case "metaCancelRecovery":
      return base;
  }
}

export function metaDigest(wallet: Address, a: MetaAction, nonce: bigint, deadline: bigint): Hex {
  switch (a.fn) {
    case "metaTransfer":
      return hashTransfer(chainId, wallet, { asset: a.asset, to: a.to, amount: a.amount, fee: a.fee, nonce, deadline });
    case "metaExecute":
      return hashExecute(chainId, wallet, { callsHash: hashCalls(a.calls), nonce, deadline });
    case "metaAddSigner":
      return hashAddSigner(chainId, wallet, {
        qx: a.qx,
        qy: a.qy,
        kind: a.kind,
        role: a.role,
        credentialIdHash: a.credentialIdHash,
        nonce,
        deadline,
      });
    case "metaUpdateSigner":
      return hashUpdateSigner(chainId, wallet, { signerId: a.targetSignerId, role: a.role, nonce, deadline });
    case "metaSetLimit":
      return hashSetLimit(chainId, wallet, {
        signerId: a.targetSignerId,
        asset: a.asset,
        limit: a.limit,
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

/** Only owners may do anything other than a transfer. */
export function needsOwner(a: MetaAction): boolean {
  return a.fn !== "metaTransfer";
}

/** The first key of a counterfactual wallet, so the facilitator can deploy it on the fly (PROTOCOL section 6). */
export function firstKeyOf(passkey: StoredAccount) {
  return { qx: passkey.qx, qy: passkey.qy, kind: 0, credentialIdHash: credentialIdHash(passkey.credentialId) };
}

/**
 * Passkey path: fresh nonce -> digest -> Face ID -> /api/facilitate. Resolves to the tx hash.
 * The WebAuthn challenge is the raw digest; the browser signs; the contract verifies. The passkey's
 * public key rides along as `firstKey`: if the wallet has no code yet, the server checks that this
 * key predicts the wallet's address and calls Factory.createWallet before the meta call.
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
    firstKey: firstKeyOf(passkey),
    label: action.fn === "metaAddSigner" ? action.label : undefined,
    labels: action.fn === "metaExecute" ? action.labels : undefined,
  });
  return { txHash: res.txHash };
}
