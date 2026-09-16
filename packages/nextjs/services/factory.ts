import {
  facilitatorClient,
  factoryAbi,
  instantWalletAbi,
  isDeployed,
  publicClient,
  requireFactory,
  targetChain,
} from "./chain";
import { getFirstKey, setFirstKey, setPairing } from "./store";
import type { FirstKey } from "./types";
import { type Address, type Hex, concatHex, getAddress } from "viem";
import { ZERO_BYTES32, signerIdOf } from "~~/utils/digests";
import { getParsedError } from "~~/utils/scaffold-eth/getParsedError";

/**
 * Counterfactual wallets (docs/PROTOCOL.md section 1/6). The address is Factory.getWalletAddress(qx, qy, 0)
 * the moment the passkey exists; `createWallet` is idempotent and the facilitator calls it right before
 * the wallet's first outbound action. The first key is registered off chain when the passkey is created
 * (and sent along with the first meta call as a fallback) so the server can deploy without the browser.
 */

export const SALT = ZERO_BYTES32;

export async function predictWallet(qx: Hex, qy: Hex): Promise<Address> {
  return (await publicClient().readContract({
    address: requireFactory(),
    abi: factoryAbi,
    functionName: "getWalletAddress",
    args: [qx, qy, SALT],
  })) as Address;
}

export type FirstKeyInput = { qx: Hex; qy: Hex; kind: number; credentialIdHash: Hex };

/** Register `key` as the first key of the wallet it predicts. Returns the wallet. */
export async function registerFirstKey(key: FirstKeyInput): Promise<{ wallet: Address; deployed: boolean }> {
  const wallet = await predictWallet(key.qx, key.qy);
  await setFirstKey(wallet, key);
  if (key.kind === 1) await setPairing(signerIdOf(key.qx, key.qy), wallet);
  return { wallet, deployed: await isDeployed(wallet) };
}

/** The registered first key of a wallet, or `candidate` if it predicts the wallet (and then register it). */
export async function firstKeyFor(wallet: Address, candidate?: FirstKeyInput | null): Promise<FirstKey | undefined> {
  const known = await getFirstKey(wallet);
  if (known) return known;
  if (candidate) {
    const predicted = await predictWallet(candidate.qx, candidate.qy).catch(() => undefined);
    if (predicted && predicted.toLowerCase() === wallet.toLowerCase()) {
      await setFirstKey(wallet, candidate);
      return { ...candidate, registeredAt: Date.now() };
    }
  }
  return undefined;
}

/**
 * Deploy the wallet if it has no code yet (Factory.createWallet, idempotent). `candidate` is the first
 * key the client sent along; it is only used when it predicts this very address.
 */
export async function ensureDeployed(
  wallet: Address,
  candidate?: FirstKeyInput | null,
): Promise<{ deployed: true; txHash?: Hex }> {
  if (await isDeployed(wallet)) return { deployed: true };
  const key = await firstKeyFor(wallet, candidate);
  if (!key) throw new Error("wallet is not deployed and its first key is unknown; register it first");
  const pc = publicClient();
  const fc = facilitatorClient();
  try {
    const { request } = await pc.simulateContract({
      address: requireFactory(),
      abi: factoryAbi,
      functionName: "createWallet",
      args: [SALT, key.qx, key.qy, key.kind, key.credentialIdHash],
      account: fc.account!,
    });
    const txHash = await fc.writeContract({ ...request, chain: targetChain, account: fc.account! } as any);
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("Factory.createWallet reverted");
    if (!(await isDeployed(wallet))) throw new Error("createWallet succeeded but no code at the predicted address");
    return { deployed: true, txHash };
  } catch (e) {
    throw new Error(getParsedError(e));
  }
}

// ---------------------------------------------------------------- counterfactual reads

let _implementation: Address | undefined;
async function implementation(): Promise<Address> {
  if (!_implementation)
    _implementation = getAddress(
      (await publicClient().readContract({
        address: requireFactory(),
        abi: factoryAbi,
        functionName: "implementation",
      })) as Address,
    );
  return _implementation;
}

/** EIP-1167 runtime bytecode of a clone pointing at `impl` (what Clones.cloneDeterministic leaves at the address). */
export function cloneRuntimeCode(impl: Address): Hex {
  return concatHex(["0x363d3d373d3d3d363d73", impl, "0x5af43d82803e903d91602b57fd5bf3"]);
}

/**
 * Read a pure/view function of the wallet that depends only on chainid + address(this) — the hash*
 * views and hashCalls — even before the wallet is deployed, by overriding the address's code with the
 * clone bytecode for the call. Storage-backed views (nonce, isSigner, …) are NOT valid this way.
 */
export async function walletView<T = unknown>(
  wallet: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<T> {
  const read = publicClient().readContract as (p: any) => Promise<unknown>;
  const base = { address: wallet, abi: instantWalletAbi, functionName, args };
  if (await isDeployed(wallet)) return (await read(base)) as T;
  const code = cloneRuntimeCode(await implementation());
  return (await read({ ...base, stateOverride: [{ address: wallet, code }] })) as T;
}
