import { facilitatorClient, instantWalletAbi, publicClient, targetChain } from "./chain";
import { setLabel, setPairing } from "./store";
import { type Address, type Hex, getAddress, isAddress, isHex } from "viem";
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
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

/**
 * The facilitator: relays signed meta calls and pays gas. It holds no keys to the wallet and
 * cannot spend by itself — a bad facilitator can only refuse to relay. Every call is simulated
 * first so a revert surfaces as a readable error instead of a burned transaction.
 */

export const META_FUNCTIONS = [
  "metaTransfer",
  "metaExecute",
  "metaAddSigner",
  "metaUpdateSigner",
  "metaRemoveSigner",
  "metaSetRecovery",
  "metaCancelRecovery",
] as const;
export type MetaFunction = (typeof META_FUNCTIONS)[number];

export const isBytes32 = (v: unknown): v is Hex => typeof v === "string" && isHex(v) && v.length === 66;
const isAddr = (v: unknown): v is Address => typeof v === "string" && isAddress(v);
const big = (v: unknown, name: string): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`${name} must be a non-negative integer string`);
};
const small = (v: unknown, name: string, max: number): number => {
  const n = Number(big(v, name));
  if (n > max) throw new Error(`${name} out of range`);
  return n;
};

export function parseCalls(raw: unknown): Call[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) throw new Error("calls must be a non-empty array");
  return raw.map((c: any, i) => {
    if (!isAddr(c?.target)) throw new Error(`calls[${i}].target must be an address`);
    const data = typeof c.data === "string" && c.data ? c.data : "0x";
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || data.length > 32_770) throw new Error(`calls[${i}].data must be hex`);
    return { target: getAddress(c.target), value: big(c.value ?? "0", `calls[${i}].value`), data: data as Hex };
  });
}

/**
 * Normalize JSON args for a meta function (everything before signerId/deadline/signature) and
 * return both the typed args and a digest builder bound to (nonce, deadline).
 */
export function normalizeMeta(functionName: string, args: unknown) {
  if (!META_FUNCTIONS.includes(functionName as MetaFunction)) throw new Error(`function not allowed: ${functionName}`);
  const a = Array.isArray(args) ? args : [];
  switch (functionName as MetaFunction) {
    case "metaTransfer": {
      const [token, to, amount, fee] = a;
      if (!isAddr(token) || !isAddr(to)) throw new Error("token and to must be addresses");
      const typed = [getAddress(token), getAddress(to), big(amount, "amount"), big(fee ?? "0", "fee")] as const;
      return {
        args: typed,
        digest: (wallet: Address, nonce: bigint, deadline: bigint) =>
          hashTransfer(chainId, wallet, {
            token: typed[0],
            to: typed[1],
            amount: typed[2],
            fee: typed[3],
            nonce,
            deadline,
          }),
      };
    }
    case "metaExecute": {
      const calls = parseCalls(a[0]);
      return {
        args: [calls] as const,
        digest: (wallet: Address, nonce: bigint, deadline: bigint) =>
          hashExecute(chainId, wallet, { callsHash: hashCalls(calls), nonce, deadline }),
      };
    }
    case "metaAddSigner": {
      const [qx, qy, kind, role, dailyLimit, credentialIdHash] = a;
      if (!isBytes32(qx) || !isBytes32(qy)) throw new Error("qx and qy must be bytes32");
      const cih = credentialIdHash ?? `0x${"00".repeat(32)}`;
      if (!isBytes32(cih)) throw new Error("credentialIdHash must be bytes32");
      const typed = [
        qx,
        qy,
        small(kind, "kind", 1),
        small(role, "role", 1),
        big(dailyLimit ?? "0", "dailyLimit"),
        cih,
      ] as const;
      return {
        args: typed,
        digest: (wallet: Address, nonce: bigint, deadline: bigint) =>
          hashAddSigner(chainId, wallet, {
            qx: typed[0],
            qy: typed[1],
            kind: typed[2],
            role: typed[3],
            dailyLimit: typed[4],
            credentialIdHash: typed[5],
            nonce,
            deadline,
          }),
      };
    }
    case "metaUpdateSigner": {
      const [target, role, dailyLimit] = a;
      if (!isAddr(target)) throw new Error("targetSignerId must be an address");
      const typed = [getAddress(target), small(role, "role", 1), big(dailyLimit ?? "0", "dailyLimit")] as const;
      return {
        args: typed,
        digest: (wallet: Address, nonce: bigint, deadline: bigint) =>
          hashUpdateSigner(chainId, wallet, {
            signerId: typed[0],
            role: typed[1],
            dailyLimit: typed[2],
            nonce,
            deadline,
          }),
      };
    }
    case "metaRemoveSigner": {
      const [target] = a;
      if (!isAddr(target)) throw new Error("targetSignerId must be an address");
      const typed = [getAddress(target)] as const;
      return {
        args: typed,
        digest: (wallet: Address, nonce: bigint, deadline: bigint) =>
          hashRemoveSigner(chainId, wallet, { signerId: typed[0], nonce, deadline }),
      };
    }
    case "metaSetRecovery": {
      const [recoveryAddress, recoveryDelay] = a;
      if (!isAddr(recoveryAddress)) throw new Error("recoveryAddress must be an address");
      const typed = [getAddress(recoveryAddress), big(recoveryDelay, "recoveryDelay")] as const;
      return {
        args: typed,
        digest: (wallet: Address, nonce: bigint, deadline: bigint) =>
          hashSetRecovery(chainId, wallet, { recoveryAddress: typed[0], recoveryDelay: typed[1], nonce, deadline }),
      };
    }
    case "metaCancelRecovery":
      return {
        args: [] as const,
        digest: (wallet: Address, nonce: bigint, deadline: bigint) =>
          hashCancelRecovery(chainId, wallet, { nonce, deadline }),
      };
  }
}

/** The contract's own view of the same digest — the cross-check before anything is queued. */
export async function contractDigest(
  wallet: Address,
  functionName: MetaFunction,
  args: readonly unknown[],
  nonce: bigint,
  deadline: bigint,
): Promise<Hex> {
  const pc = publicClient();
  const view = {
    metaTransfer: "hashTransfer",
    metaExecute: "hashExecute",
    metaAddSigner: "hashAddSigner",
    metaUpdateSigner: "hashUpdateSigner",
    metaRemoveSigner: "hashRemoveSigner",
    metaSetRecovery: "hashSetRecovery",
    metaCancelRecovery: "hashCancelRecovery",
  }[functionName];
  let viewArgs: unknown[] = [...args, nonce, deadline];
  if (functionName === "metaExecute") {
    const callsHash = (await pc.readContract({
      address: wallet,
      abi: instantWalletAbi,
      functionName: "hashCalls",
      args: [args[0] as Call[]],
    })) as Hex;
    viewArgs = [callsHash, nonce, deadline];
  }
  return (await pc.readContract({
    address: wallet,
    abi: instantWalletAbi,
    functionName: view as any,
    args: viewArgs as any,
  })) as Hex;
}

export async function isValidSignature(
  wallet: Address,
  signerId: Address,
  digest: Hex,
  signature: Hex,
): Promise<boolean> {
  return (await publicClient().readContract({
    address: wallet,
    abi: instantWalletAbi,
    functionName: "isValidSignature",
    args: [signerId, digest, signature],
  })) as boolean;
}

export type RelayResult = {
  txHash: Hex;
  blockNumber: string;
  gasUsed: string;
  relayer: Address;
  status: "success" | "reverted";
};

/** Simulate, send, wait. Throws a parsed error on revert. */
export async function relayMeta(
  wallet: Address,
  functionName: MetaFunction,
  args: readonly unknown[],
  signerId: Address,
  deadline: bigint,
  signature: Hex,
): Promise<RelayResult> {
  const pc = publicClient();
  const fc = facilitatorClient();
  const full = [...args, signerId, deadline, signature];
  try {
    const { request } = await pc.simulateContract({
      address: wallet,
      abi: instantWalletAbi,
      functionName: functionName as any,
      args: full as any,
      account: fc.account!,
    });
    const txHash = await fc.writeContract({ ...request, chain: targetChain, account: fc.account! } as any);
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === "success") afterSuccess(wallet, functionName, args);
    return {
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      relayer: fc.account!.address,
      status: receipt.status,
    };
  } catch (e) {
    throw new Error(getParsedError(e));
  }
}

/** Bookkeeping that helps the device find its wallet after pairing. */
function afterSuccess(wallet: Address, functionName: MetaFunction, args: readonly unknown[]) {
  if (functionName === "metaAddSigner") {
    const [qx, qy, kind] = args as readonly [Hex, Hex, number, ...unknown[]];
    if (Number(kind) === 1) {
      // raw key = a device; remember which wallet it belongs to
      import("~~/utils/digests").then(({ signerIdOf }) => setPairing(signerIdOf(qx, qy), wallet)).catch(() => {});
    }
  }
}

export { setLabel };
