import { type Address, type Hex, decodeFunctionData, getAddress, hexToBigInt, size, slice, zeroAddress } from "viem";
import { MULTICALL3, MULTISEND_CALL_ONLY } from "./config";
import { type Call, abi } from "./core";

/**
 * The relay's fee: the user's own signed batch ends with a payment to the relayer, in USDC or ETH. No refund
 * mechanism, no paymaster: the relayer only sends what pays it (docs/PLAN.md "Sending").
 *
 * Gas budgets are upper bounds per kind of send (Base: P-256 precompile; the wedgie's second slot verifies in
 * Solidity, ~350k). The quote = budget × gas price × 1.25, plus a cent; the relay re-checks with the real estimate.
 */
export type SendKind = "first" | "exec" | "roles" | "exec-wedgie" | "setup" | "first-setup";
export const GAS_BUDGET: Record<SendKind, bigint> = {
  first: 900_000n, // deploy signer + Safe (setup with Candide) + the first tx
  exec: 350_000n,
  roles: 400_000n,
  "exec-wedgie": 1_100_000n, // the wedgie's second slot verifies P-256 in Solidity
  setup: 1_800_000n, // a level change (deploy Roles + wire it, or add the wedgie's signers)
  "first-setup": 2_600_000n,
};

/** Gas a send of each kind really uses (measured on Base forks and mainnet); the fee is this × gas price × 1.5. */
export const GAS_TYPICAL: Record<SendKind, bigint> = {
  first: 600_000n, // live first sends used ~570k
  exec: 200_000n,
  roles: 300_000n,
  "exec-wedgie": 650_000n,
  setup: 1_000_000n,
  "first-setup": 1_600_000n,
};

export type Quote = {
  chainId: number;
  relayer: Address;
  kind: SendKind;
  gasPrice: string; // wei
  ethUsd: number;
  feeEth: string; // wei
  feeUsdc: string; // 6 decimals
  until: number; // ms
};

/** Unpack a MultiSendCallOnly payload into calls. */
export function unpackMultiSend(data: Hex): Call[] {
  const { args } = decodeFunctionData({ abi: abi.multiSend, data });
  const packed = args[0] as Hex;
  const out: Call[] = [];
  let o = 0;
  const n = size(packed);
  while (o < n) {
    const op = Number(hexToBigInt(slice(packed, o, o + 1)));
    if (op !== 0) throw new Error("only calls in a batch");
    const to = getAddress(slice(packed, o + 1, o + 21));
    const value = hexToBigInt(slice(packed, o + 21, o + 53));
    const len = Number(hexToBigInt(slice(packed, o + 53, o + 85)));
    const data = len ? slice(packed, o + 85, o + 85 + len) : "0x";
    out.push({ to, value, data });
    o += 85 + len;
  }
  return out;
}

/** What a batch pays `relayer`: the LAST call must be the fee (USDC transfer or plain ETH). */
export function feePaid(calls: Call[], relayer: Address, usdc: Address | undefined): { usdc: bigint; eth: bigint } {
  const last = calls[calls.length - 1];
  if (!last) return { usdc: 0n, eth: 0n };
  if (last.to.toLowerCase() === relayer.toLowerCase() && last.data === "0x") return { usdc: 0n, eth: last.value };
  if (usdc && last.to.toLowerCase() === usdc.toLowerCase() && last.value === 0n) {
    try {
      const d = decodeFunctionData({ abi: abi.erc20, data: last.data });
      if (d.functionName === "transfer" && (d.args[0] as Address).toLowerCase() === relayer.toLowerCase())
        return { usdc: d.args[1] as bigint, eth: 0n };
    } catch {}
  }
  return { usdc: 0n, eth: 0n };
}

/**
 * The calls inside a burner's Roles spend, after checking the call is exactly what the app makes (review: with
 * shouldRevert = false a failing inner call returns false instead of reverting, and the relay would be paid nothing).
 */
export function rolesCalls(calldata: Hex, roleKey: Hex): Call[] {
  const d = decodeFunctionData({ abi: abi.roles, data: calldata });
  if (d.functionName !== "execTransactionWithRole") throw new Error("not a role call");
  const [to, value, data, op, key, shouldRevert] = d.args as [Address, bigint, Hex, number, Hex, boolean];
  if (shouldRevert !== true) throw new Error("role calls must revert on failure");
  if (key.toLowerCase() !== roleKey.toLowerCase()) throw new Error("unknown role");
  if (to.toLowerCase() === MULTISEND_CALL_ONLY.toLowerCase()) {
    if (op !== 1 || value !== 0n) throw new Error("bad batch");
    return unpackMultiSend(data);
  }
  if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
    if (op !== 0) throw new Error("bad ETH send");
    const m = decodeFunctionData({ abi: abi.multicall3, data });
    if (m.functionName !== "aggregate3Value") throw new Error("unexpected Multicall3 call");
    const calls = m.args[0] as readonly { target: Address; allowFailure: boolean; value: bigint; callData: Hex }[];
    if (calls.some(c => c.allowFailure || c.callData !== "0x")) throw new Error("ETH sends only, none may fail");
    if (calls.reduce((t, c) => t + c.value, 0n) !== value) throw new Error("ETH amounts don't add up");
    return calls.map(c => ({ to: c.target, value: c.value, data: c.callData }));
  }
  throw new Error("unexpected role target");
}

export const ZERO = zeroAddress;
