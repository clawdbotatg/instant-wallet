import { type Hex, type PublicClient, parseAbi } from "viem";

/** The OP-stack chains the relay serves: each tx also pays Ethereum for its bytes (the L1 data fee). */
const OP_STACK = [8453, 10];
const ORACLE = "0x420000000000000000000000000000000000000F"; // GasPriceOracle, the same on every OP-stack chain
const oracleAbi = parseAbi(["function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)"]);
/** The most calldata the relay sends (bytes). The biggest real one is a swap, about 10 KB. */
export const MAX_DATA = 32_000;

/** What Ethereum will charge for a tx with this calldata, at most. null: not an OP-stack chain, or it can't be read. */
export async function l1Fee(pc: Pick<PublicClient, "readContract">, chainId: number, data: Hex): Promise<bigint | null> {
  if (!OP_STACK.includes(chainId)) return null;
  const size = BigInt((data.length - 2) / 2 + 120); // + the envelope: nonce, fees, to, signature
  return pc.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getL1FeeUpperBound", args: [size] }).catch(() => null);
}

/**
 * The L1 fee a send must cover. A normal send fits the flat allowance in its quote. One padded with tens of KB
 * (its signatures, or a dapp call) costs the relayer far more than that: it pays the real fee (audit 11-13).
 * Up to twice the allowance still rides on it, so a normal send on a busy day isn't turned away.
 */
export const l1Owed = (real: bigint | null, allowance: bigint) => (real !== null && real > 2n * allowance ? real : allowance);
