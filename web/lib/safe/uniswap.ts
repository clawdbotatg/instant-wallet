import { type Address, type Hex, encodeFunctionData, encodePacked, zeroAddress } from "viem";
import { publicClient } from "../chains";
import { MULTICALL3 } from "./config";
import { ADDRESS_THIS, type SwapRoute, type Token, UNI, uniAbi } from "./swap";

/**
 * Uniswap v3, straight on chain: every plausible path (direct at each fee tier, or one hop through WETH or USDC)
 * quoted by QuoterV2 in one multicall, the best one built into a SwapRouter02 call. Nothing but an RPC.
 */
const FEES = [100, 500, 3000, 10000];
const HOP_FEES = [100, 500, 3000];

function paths(a: Address, b: Address, hops: Address[]): Hex[] {
  const out: Hex[] = FEES.map(f => encodePacked(["address", "uint24", "address"], [a, f, b]));
  for (const h of hops) {
    if (h.toLowerCase() === a.toLowerCase() || h.toLowerCase() === b.toLowerCase()) continue;
    for (const f1 of HOP_FEES)
      for (const f2 of HOP_FEES) out.push(encodePacked(["address", "uint24", "address", "uint24", "address"], [a, f1, h, f2, b]));
  }
  return out;
}

export async function uniswapRoute(opts: {
  safe: Address;
  from: Token;
  to: Token;
  amount: bigint;
  slippageBps: number;
  usdc?: Address;
}): Promise<SwapRoute | null> {
  const { safe, from, to, amount } = opts;
  const u = UNI[from.chainId];
  if (!u || from.chainId !== to.chainId || amount <= 0n) return null;
  const a = from.address === zeroAddress ? u.weth : from.address;
  const b = to.address === zeroAddress ? u.weth : to.address;
  if (a.toLowerCase() === b.toLowerCase()) return null; // ETH ↔ WETH is a wrap, not a swap
  const ps = paths(a, b, [u.weth, ...(opts.usdc ? [opts.usdc] : [])]);
  const res = await publicClient(from.chainId).multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: ps.map(p => ({ address: u.quoter, abi: uniAbi, functionName: "quoteExactInput" as const, args: [p, amount] as const })),
  });
  let best = -1;
  let out = 0n;
  let gas = 0n;
  res.forEach((r, i) => {
    if (r.status !== "success") return;
    const [amt, , , g] = r.result as unknown as [bigint, unknown, unknown, bigint];
    if (amt > out) [best, out, gas] = [i, amt, g];
  });
  if (best < 0 || out === 0n) return null;
  const min = (out * BigInt(10_000 - opts.slippageBps)) / 10_000n;
  const ethOut = to.address === zeroAddress;
  const swap = encodeFunctionData({
    abi: uniAbi,
    functionName: "exactInput",
    args: [{ path: ps[best], recipient: ethOut ? ADDRESS_THIS : safe, amountIn: amount, amountOutMinimum: min }],
  });
  const inner = ethOut ? [swap, encodeFunctionData({ abi: uniAbi, functionName: "unwrapWETH9", args: [min, safe] })] : [swap];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  return {
    via: "uniswap",
    tool: "Uniswap",
    from,
    to,
    fromAmount: amount.toString(),
    toAmount: out.toString(),
    toAmountMin: min.toString(),
    seconds: 0,
    gas: (gas + 80_000n).toString(), // QuoterV2's estimate is the pools only; + the router, the transfers, the unwrap
    tx: {
      to: u.router,
      data: encodeFunctionData({ abi: uniAbi, functionName: "multicall", args: [deadline, inner] }),
      value: from.address === zeroAddress ? amount.toString() : "0",
    },
    approval: from.address === zeroAddress ? undefined : u.router,
    until: Date.now() + 60_000,
  };
}
