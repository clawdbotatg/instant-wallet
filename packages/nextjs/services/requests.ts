import { facilitatorFee, isDeployed, isLocal, tokenMeta } from "./chain";
import { type MetaFunction, contractDigest, normalizeMeta } from "./relay";
import { addRequest, expireStale, listRequests, newId, setLabel } from "./store";
import { IN_FLIGHT, type WalletRequest } from "./types";
import { onchainNonce, readSigner } from "./wallet";
import { type Address, formatUnits, getAddress, isAddress } from "viem";
import { chainId } from "~~/utils/chain";
import { hashCalls } from "~~/utils/digests";
import { matchCode } from "~~/utils/matchwords";

/**
 * Create a device-queue request (docs/PROTOCOL.md section 5). The server recomputes the digest
 * itself, cross-checks it with the contract's view, and only then stores it. Names and formatted
 * amounts are display hints; the device rebuilds the digest from the raw fields.
 */

export const DEADLINE_SECONDS = Number(process.env.REQUEST_TTL_SECONDS || 10 * 60);

const KIND_TO_FN: Record<string, MetaFunction> = {
  transfer: "metaTransfer",
  execute: "metaExecute",
  addSigner: "metaAddSigner",
  updateSigner: "metaUpdateSigner",
  removeSigner: "metaRemoveSigner",
  setRecovery: "metaSetRecovery",
  cancelRecovery: "metaCancelRecovery",
};

export async function inFlightFor(wallet: Address): Promise<WalletRequest[]> {
  return (await listRequests()).filter(r => r.wallet.toLowerCase() === wallet.toLowerCase() && IN_FLIGHT.has(r.status));
}

export async function createRequest(body: any): Promise<WalletRequest> {
  const kind = String(body?.kind ?? "transfer");
  const fn = KIND_TO_FN[kind];
  if (!fn) throw new Error(`unknown kind: ${kind}`);
  if (!isAddress(body?.wallet)) throw new Error("wallet must be an address");
  if (!isAddress(body?.signerId)) throw new Error("signerId must be an address");
  const wallet = getAddress(body.wallet);
  const signerId = getAddress(body.signerId);
  if (!(await isDeployed(wallet))) throw new Error("wallet is not deployed");
  const signer = await readSigner(wallet, signerId);
  if (!signer) throw new Error("signerId is not a signer of this wallet");

  const token = await tokenMeta();

  // Build the meta args from the request body
  let args: unknown[];
  let extra: Record<string, unknown> = {};
  switch (kind) {
    case "transfer": {
      const tokenAddr =
        typeof body.token === "string" && isAddress(body.token) ? getAddress(body.token) : token.address;
      if (!isAddress(body.to)) throw new Error("to must be an address");
      let units: bigint;
      if (typeof body.amount === "string" && /^\d+$/.test(body.amount)) units = BigInt(body.amount);
      else throw new Error("amount must be an integer string in token base units");
      if (units <= 0n) throw new Error("amount must be greater than zero");
      const fee =
        typeof body.fee === "string" && /^\d+$/.test(body.fee) ? BigInt(body.fee) : facilitatorFee(token.decimals);
      args = [tokenAddr, getAddress(body.to), units, fee];
      extra = {
        token: tokenAddr,
        tokenSymbol: tokenAddr.toLowerCase() === token.address.toLowerCase() ? token.symbol : "TOKEN",
        tokenDecimals: token.decimals,
        to: getAddress(body.to),
        toName: typeof body.toName === "string" && body.toName.trim() ? body.toName.trim().slice(0, 128) : undefined,
        amount: units.toString(),
        amountFormatted: formatUnits(units, token.decimals),
        fee: fee.toString(),
      };
      break;
    }
    case "execute": {
      args = [body.calls];
      break;
    }
    case "addSigner": {
      args = [
        body.qx,
        body.qy,
        body.signerKind ?? body.kindOfKey ?? 0,
        body.role ?? 0,
        body.dailyLimit ?? "0",
        body.credentialIdHash,
      ];
      extra = { label: typeof body.label === "string" ? body.label.slice(0, 64) : undefined };
      break;
    }
    case "updateSigner":
      args = [body.targetSignerId, body.role ?? 0, body.dailyLimit ?? "0"];
      break;
    case "removeSigner":
      args = [body.targetSignerId];
      break;
    case "setRecovery":
      args = [body.recoveryAddress, body.recoveryDelay];
      break;
    default:
      args = [];
  }

  const norm = normalizeMeta(fn, args);
  await expireStale();
  const inFlight = await inFlightFor(wallet);
  const nonce = (await onchainNonce(wallet)) + BigInt(inFlight.length);
  // Local chain only: a per-request TTL so tests can exercise expiry without waiting 10 minutes.
  const ttl =
    isLocal && typeof body.ttlSeconds === "number" && Number.isFinite(body.ttlSeconds) && body.ttlSeconds >= 1
      ? Math.floor(body.ttlSeconds)
      : DEADLINE_SECONDS;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + ttl);
  const digest = norm.digest(wallet, nonce, deadline);
  const fromContract = await contractDigest(wallet, fn, norm.args, nonce, deadline);
  if (fromContract.toLowerCase() !== digest.toLowerCase()) {
    throw new Error(`digest mismatch: app ${digest} vs contract ${fromContract}`);
  }

  const now = Date.now();
  const base = {
    id: newId(),
    chainId,
    wallet,
    signerId,
    nonce: nonce.toString(),
    deadline: Number(deadline),
    digest,
    matchCode: matchCode(digest),
    status: "pending" as const,
    createdAt: now,
    updatedAt: now,
    note: typeof body.note === "string" ? body.note.slice(0, 200) : undefined,
  };

  let request: WalletRequest;
  switch (fn) {
    case "metaTransfer":
      request = { ...base, kind: "transfer", ...(extra as any) };
      break;
    case "metaExecute": {
      const calls = norm.args[0] as { target: Address; value: bigint; data: `0x${string}` }[];
      request = {
        ...base,
        kind: "execute",
        calls: calls.map(c => ({ target: c.target, value: c.value.toString(), data: c.data })),
        callsHash: hashCalls(calls),
      };
      break;
    }
    case "metaAddSigner": {
      const [qx, qy, k, role, dailyLimit, cih] = norm.args as readonly [any, any, number, number, bigint, any];
      request = {
        ...base,
        kind: "addSigner",
        qx,
        qy,
        signerKind: k,
        role,
        dailyLimit: dailyLimit.toString(),
        credentialIdHash: cih,
        label: extra.label as string | undefined,
      };
      break;
    }
    case "metaUpdateSigner": {
      const [target, role, dailyLimit] = norm.args as readonly [Address, number, bigint];
      request = { ...base, kind: "updateSigner", targetSignerId: target, role, dailyLimit: dailyLimit.toString() };
      break;
    }
    case "metaRemoveSigner":
      request = { ...base, kind: "removeSigner", targetSignerId: norm.args[0] as Address };
      break;
    case "metaSetRecovery": {
      const [addr, delay] = norm.args as readonly [Address, bigint];
      request = { ...base, kind: "setRecovery", recoveryAddress: addr, recoveryDelay: Number(delay) };
      break;
    }
    default:
      request = { ...base, kind: "cancelRecovery" };
  }

  await addRequest(request);
  if (request.kind === "addSigner" && request.label) {
    const { signerIdOf } = await import("~~/utils/digests");
    await setLabel(wallet, signerIdOf(request.qx, request.qy), request.label);
  }
  return request;
}

/** Meta args for a stored request (what the relay needs to submit it). */
export function metaArgsOf(r: WalletRequest): { fn: MetaFunction; args: unknown[] } {
  switch (r.kind) {
    case "transfer":
      return { fn: "metaTransfer", args: [r.token, r.to, r.amount, r.fee] };
    case "execute":
      return { fn: "metaExecute", args: [r.calls] };
    case "addSigner":
      return { fn: "metaAddSigner", args: [r.qx, r.qy, r.signerKind, r.role, r.dailyLimit, r.credentialIdHash] };
    case "updateSigner":
      return { fn: "metaUpdateSigner", args: [r.targetSignerId, r.role, r.dailyLimit] };
    case "removeSigner":
      return { fn: "metaRemoveSigner", args: [r.targetSignerId] };
    case "setRecovery":
      return { fn: "metaSetRecovery", args: [r.recoveryAddress, r.recoveryDelay] };
    case "cancelRecovery":
      return { fn: "metaCancelRecovery", args: [] };
  }
}
