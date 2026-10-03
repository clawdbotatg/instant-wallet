import {
  type Address,
  type Hash,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
} from "viem";
import { factoryAbi, instantWalletAbi } from "./abi";
import { KIND_WEBAUTHN } from "./address";
import { FACTORY, publicClient } from "./chains";
import { ensureGasKey, gasClient } from "./gasKey";
import { signDigest } from "./passkey";
import type { Account } from "./types";

/**
 * Talking to an InstantWallet v3: digests (EIP-712, domain = this wallet on this chain), passkey signing,
 * and submitting through the gas key. A wallet with no code yet is deployed in the same transaction as its
 * first call (Factory.createAndCall). Spec: packages/foundry/contracts/InstantWallet.sol.
 */

export type Call = { target: Address; value: bigint; data: Hex };

const domain = (chainId: number, wallet: Address) =>
  ({ name: "InstantWallet", version: "3", chainId, verifyingContract: wallet }) as const;

export function transferDigest(
  chainId: number,
  wallet: Address,
  m: { asset: Address; to: Address; amount: bigint; nonce: bigint; deadline: bigint },
): Hex {
  return hashTypedData({
    domain: domain(chainId, wallet),
    types: {
      Transfer: [
        { name: "asset", type: "address" },
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Transfer",
    message: m,
  });
}

/** callsHash = keccak256(concat(keccak256(abi.encode(target, value, keccak256(data))) ...)). */
export function callsHash(calls: Call[]): Hex {
  return keccak256(
    concat(
      calls.map(c =>
        keccak256(
          encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [c.target, c.value, keccak256(c.data)]),
        ),
      ),
    ),
  );
}

export function executeDigest(chainId: number, wallet: Address, calls: Call[], nonce: bigint, deadline: bigint): Hex {
  return hashTypedData({
    domain: domain(chainId, wallet),
    types: {
      Execute: [
        { name: "callsHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Execute",
    message: { callsHash: callsHash(calls), nonce, deadline },
  });
}

export async function isDeployed(chainId: number, wallet: Address): Promise<boolean> {
  const code = await publicClient(chainId).getCode({ address: wallet });
  return !!code && code !== "0x";
}

export async function nonceOf(chainId: number, acct: Account, deployed: boolean): Promise<bigint> {
  if (!deployed) return 0n;
  return publicClient(chainId).readContract({
    address: acct.address,
    abi: instantWalletAbi,
    functionName: "nonces",
    args: [acct.signerId],
  });
}

const deadlineIn = (s: number) => BigInt(Math.floor(Date.now() / 1000) + s);

/** Face ID, then the gas key sends it. Resolves when the transaction is mined. */
export async function sendTransfer(
  chainId: number,
  acct: Account,
  t: { asset: Address; to: Address; amount: bigint },
  onStage?: (s: "signing" | "sending" | "confirming", hash?: Hash) => void,
): Promise<Hash> {
  const deployed = await isDeployed(chainId, acct.address);
  const nonce = await nonceOf(chainId, acct, deployed);
  const deadline = deadlineIn(15 * 60);
  onStage?.("signing");
  const { signature, prf } = await signDigest(acct.credentialId, transferDigest(chainId, acct.address, { ...t, nonce, deadline }));
  if (prf) ensureGasKey(acct.address, prf);
  const data = encodeFunctionData({
    abi: instantWalletAbi,
    functionName: "metaTransfer",
    args: [t.asset, t.to, t.amount, acct.signerId, deadline, signature],
  });
  return submit(chainId, acct, deployed, data, onStage);
}

export async function sendCalls(
  chainId: number,
  acct: Account,
  calls: Call[],
  onStage?: (s: "signing" | "sending" | "confirming", hash?: Hash) => void,
): Promise<Hash> {
  const deployed = await isDeployed(chainId, acct.address);
  const nonce = await nonceOf(chainId, acct, deployed);
  const deadline = deadlineIn(15 * 60);
  onStage?.("signing");
  const { signature, prf } = await signDigest(acct.credentialId, executeDigest(chainId, acct.address, calls, nonce, deadline));
  if (prf) ensureGasKey(acct.address, prf);
  const data = encodeFunctionData({
    abi: instantWalletAbi,
    functionName: "metaExecute",
    args: [calls, acct.signerId, deadline, signature],
  });
  return submit(chainId, acct, deployed, data, onStage);
}

async function submit(
  chainId: number,
  acct: Account,
  deployed: boolean,
  walletCall: Hex,
  onStage?: (s: "signing" | "sending" | "confirming", hash?: Hash) => void,
): Promise<Hash> {
  if (!FACTORY) throw new Error("Factory not configured");
  const to = deployed ? acct.address : FACTORY;
  const data = deployed
    ? walletCall
    : encodeFunctionData({
        abi: factoryAbi,
        functionName: "createAndCall",
        args: [acct.qx, acct.qy, KIND_WEBAUTHN, acct.credentialIdHash, walletCall],
      });
  const client = gasClient(acct.address, chainId);
  const pc = publicClient(chainId);
  onStage?.("sending");
  // simulate first: a revert here costs nothing and gives a readable reason
  await pc.call({ account: client.account, to, data });
  const hash = await client.sendTransaction({ to, data });
  onStage?.("confirming", hash);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  return hash;
}

/** Gas estimate for a first send (deploy + transfer) vs a later one, in wei at current prices. */
export async function gasCost(chainId: number, deployed: boolean): Promise<bigint> {
  const fees = await publicClient(chainId).estimateFeesPerGas();
  const gas = deployed ? 120_000n : 450_000n;
  return gas * (fees.maxFeePerGas ?? 0n);
}
