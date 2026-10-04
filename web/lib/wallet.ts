import { type Address, type Hash, type Hex, encodeFunctionData, erc20Abi, keccak256, numberToHex, pad, parseAbi } from "viem";
import { factoryAbi } from "./abi";
import { KIND_WEBAUTHN } from "./address";
import { FACTORY, chainById, publicClient } from "./chains";
import { signDigest } from "./passkey";
import type { Account } from "./types";
import {
  type Call,
  type Gas,
  type RpcUserOp,
  CIRCLE_PAYMASTER,
  ENTRY_POINT,
  GAS_ALLOWANCE,
  USDC_ALLOWANCE_SLOT,
  executeCallData,
  maxCost,
  prepare,
} from "./userop";
import { dummyWebAuthnSignature } from "./webauthn";

export type { Call };
export type Stage = "signing" | "sending" | "confirming";

/**
 * Sending from an InstantWallet v3.1: one ERC-4337 user op (any number of calls, one Face ID), gas paid in USDC by
 * Circle Paymaster, submitted by a bundler through /api/bundler/<chainId>. A wallet with no code yet is deployed
 * by its first op; that op also carries a USDC permit to the paymaster, under the same passkey signature.
 */

const VALID_FOR_S = 180;
const POST_OP_GAS = 40_000n; // ≥ Circle's additionalGasCharge (35k), ≤ its 40k unused-gas penalty threshold

async function bundler<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  const j = await fetch(`/api/bundler/${chainId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then(r => r.json());
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result as T;
}

export async function isDeployed(chainId: number, wallet: Address): Promise<boolean> {
  const code = await publicClient(chainId).getCode({ address: wallet });
  return !!code && code !== "0x";
}

const usdcOf = (chainId: number) => {
  const usdc = chainById(chainId)?.usdc;
  if (!usdc) throw new Error("No USDC on this chain to pay the fee");
  return usdc;
};

export async function usdcBalance(chainId: number, wallet: Address): Promise<bigint> {
  return publicClient(chainId).readContract({ address: usdcOf(chainId), abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
}

/**
 * Face ID, then a bundler submits. Resolves with the transaction hash once it's mined.
 * `sweepUsdcTo`: append a final transfer of all the USDC left after the fee's prefund (Send all).
 */
export async function sendCalls(
  chainId: number,
  acct: Account,
  calls: Call[],
  opts: { onStage?: (s: Stage, hash?: Hash) => void; sweepUsdcTo?: Address; ethUsd?: number } = {},
): Promise<Hash> {
  const pc = publicClient(chainId);
  const usdc = usdcOf(chainId);
  const deployed = await isDeployed(chainId, acct.address);
  const [nonce, allowance, usdcNonce, usdcDomain, usdcBal, prices] = await Promise.all([
    pc.readContract({
      address: ENTRY_POINT,
      abi: parseAbi(["function getNonce(address,uint192) view returns (uint256)"]),
      functionName: "getNonce",
      args: [acct.address, BigInt(acct.signerId)],
    }),
    deployed ? pc.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [acct.address, CIRCLE_PAYMASTER] }) : 0n,
    pc.readContract({ address: usdc, abi: parseAbi(["function nonces(address) view returns (uint256)"]), functionName: "nonces", args: [acct.address] }),
    pc.readContract({ address: usdc, abi: parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)"]), functionName: "DOMAIN_SEPARATOR" }),
    usdcBalance(chainId, acct.address),
    bundler<{ fast: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } }>(chainId, "pimlico_getUserOperationGasPrice", []),
  ]);
  let permit = allowance < GAS_ALLOWANCE / 2n ? { usdc, usdcDomain, usdcNonce, amount: GAS_ALLOWANCE } : undefined;
  const base = {
    chainId,
    wallet: acct.address,
    signerId: acct.signerId,
    nonce,
    factory: deployed
      ? undefined
      : {
          address: FACTORY,
          data: encodeFunctionData({ abi: factoryAbi, functionName: "createWallet", args: [acct.qx, acct.qy, KIND_WEBAUTHN, acct.credentialIdHash] }),
        },
    validUntil: BigInt(Math.floor(Date.now() / 1000) + VALID_FOR_S),
  };
  const sweep = (amount: bigint): Call[] =>
    opts.sweepUsdcTo
      ? [...calls, { target: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [opts.sweepUsdcTo, amount] }) }]
      : calls;

  // estimate with a well-formed throwaway signature (same verification work, fails at the very end); a first op is
  // estimated as if its permit already set the allowance
  let g: Gas = {
    maxFeePerGas: BigInt(prices.fast.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(prices.fast.maxPriorityFeePerGas),
    verificationGasLimit: 800_000n,
    callGasLimit: 300_000n,
    preVerificationGas: 150_000n,
    paymasterVerificationGasLimit: 500_000n,
    paymasterPostOpGasLimit: POST_OP_GAS,
  };
  const trial = prepare({ ...base, permit, callData: executeCallData(sweep(usdcBal / 2n)) }, g);
  const overrides = permit
    ? {
        [usdc]: {
          stateDiff: {
            [allowanceSlot(acct.address, CIRCLE_PAYMASTER)]: pad(numberToHex(GAS_ALLOWANCE)),
          },
        },
      }
    : undefined;
  const est = await bundler<Record<string, Hex>>(chainId, "eth_estimateUserOperationGas", [
    trial.op(dummyWebAuthnSignature(trial.digest, window.location.origin)),
    ENTRY_POINT,
    ...(overrides ? [overrides] : []),
  ]);
  g = {
    ...g,
    verificationGasLimit: (BigInt(est.verificationGasLimit) * 13n) / 10n + 30_000n,
    callGasLimit: (BigInt(est.callGasLimit) * 12n) / 10n + 10_000n,
    preVerificationGas: (BigInt(est.preVerificationGas) * 11n) / 10n,
    paymasterVerificationGasLimit:
      (BigInt(est.paymasterVerificationGasLimit ?? "0x30000") * 12n) / 10n + (permit ? 250_000n : 0n),
  };

  // the paymaster pulls the worst-case fee in USDC before running the calls (then refunds the rest), so its
  // allowance must cover that; no price known = assume a very expensive ETH and reserve more
  const prefundUsdc = BigInt(Math.ceil(Number(maxCost(g)) * 1e-18 * (opts.ethUsd ?? 10_000) * 1e6 * 1.15)) + 2_000n;
  if (prefundUsdc > (permit ? permit.amount : allowance)) {
    if (!permit) g = { ...g, paymasterVerificationGasLimit: g.paymasterVerificationGasLimit + 250_000n };
    permit = { usdc, usdcDomain, usdcNonce, amount: prefundUsdc * 2n > GAS_ALLOWANCE ? prefundUsdc * 2n : GAS_ALLOWANCE };
  }
  const spendUsdc = calls.reduce((s, c) => s + (c.target === usdc && c.data.startsWith("0xa9059cbb") ? BigInt(`0x${c.data.slice(74, 138)}`) : 0n), 0n);
  const left = usdcBal - spendUsdc - prefundUsdc;
  if (left < 0n) throw new Error("Not enough USDC for the network fee (it's paid in USDC)");
  const { digest, op } = prepare({ ...base, permit, callData: executeCallData(sweep(left)) }, g);

  opts.onStage?.("signing");
  const { signature } = await signDigest(acct.credentialId, digest);
  opts.onStage?.("sending");
  const userOp: RpcUserOp = op(signature);
  const opHash = await bundler<Hex>(chainId, "eth_sendUserOperation", [userOp, ENTRY_POINT]);
  opts.onStage?.("confirming");
  for (let i = 0; i < 90; i++) {
    const r = await bundler<{ success: boolean; receipt: { transactionHash: Hash } } | null>(chainId, "eth_getUserOperationReceipt", [opHash]);
    if (r) {
      if (!r.success) throw new Error("The send reverted (the fee was still paid)");
      opts.onStage?.("confirming", r.receipt.transactionHash);
      return r.receipt.transactionHash;
    }
    await new Promise(res => setTimeout(res, 1500));
  }
  throw new Error("Not confirmed after 2 minutes. Check the explorer before trying again.");
}

/** One ETH or ERC-20 transfer as a call. */
export function transferCall(asset: Address, to: Address, amount: bigint): Call {
  if (/^0x0{40}$/i.test(asset)) return { target: to, value: amount, data: "0x" };
  return { target: asset, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
}

function allowanceSlot(owner: Address, spender: Address): Hex {
  const enc = (a: Hex, b: Hex) => keccak256(`0x${a.slice(2).padStart(64, "0")}${b.slice(2).padStart(64, "0")}`);
  return enc(spender, enc(owner, pad(numberToHex(USDC_ALLOWANCE_SLOT))));
}

/** Rough fee in USD for the confirm screen: first op deploys + permits. */
export async function feeEstimateUsd(chainId: number, deployed: boolean, ethUsd: number): Promise<number> {
  const fees = await publicClient(chainId).estimateFeesPerGas();
  const gas = deployed ? 260_000n : 750_000n;
  return Number(gas * (fees.maxFeePerGas ?? 0n)) * 1e-18 * ethUsd;
}
