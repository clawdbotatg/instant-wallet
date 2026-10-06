import { type Address, type Hex, decodeFunctionData, encodeFunctionData, parseAbi, size, slice, zeroAddress } from "viem";
import { type Call, abi } from "./core";

/**
 * Swaps (docs/SWAP.md): any asset → any asset, same chain or across chains. Two sources, the better price wins:
 *   - Uniswap v3 straight on chain (QuoterV2 + SwapRouter02): no API, same chain only
 *   - LI.FI (through /api/swap/quote): DEX aggregation and bridges/solvers across chains
 * One Safe batch: [approve exact] → the swap → [approve 0] → the relay's fee. No allowance outlives the tx.
 */

/** LI.FI's diamond: the same address on every chain. */
export const LIFI_DIAMOND: Address = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

/** Uniswap v3 SwapRouter02 + QuoterV2 (checked on chain 2026-10-06: factory() and WETH9() match). */
export const UNI: Record<number, { router: Address; quoter: Address; weth: Address }> = {
  8453: {
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    weth: "0x4200000000000000000000000000000000000006",
  },
  1: {
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
};

/** Contracts a swap batch may call (and approve, exactly, for the length of the batch). */
const TARGETS = new Set([LIFI_DIAMOND, ...Object.values(UNI).map(u => u.router)].map(a => a.toLowerCase()));
export const isSwapTarget = (a: Address) => TARGETS.has(a.toLowerCase());

export type Token = { chainId: number; address: Address; symbol: string; decimals: number; logo?: string; priceUsd?: number };

/** The "To" list: the well-known tokens on each chain (anything else: paste its address). */
export const POPULAR: Record<number, Omit<Token, "chainId">[]> = {
  8453: [
    { address: zeroAddress, symbol: "ETH", decimals: 18 },
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
    { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
    { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", decimals: 6 },
  ],
  1: [
    { address: zeroAddress, symbol: "ETH", decimals: 18 },
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
    { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
    { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
    { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 },
  ],
};

/** A priced, ready-to-sign route. Amounts in base units (strings, so it survives JSON). */
export type SwapRoute = {
  via: "uniswap" | "lifi";
  tool: string; // what does the work: "Uniswap", "Across", "NearIntents", …
  from: Token;
  to: Token;
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  toUsd?: number;
  fromUsd?: number;
  seconds: number; // how long until it lands (0 = in this tx)
  gas: string; // the swap's own gas, on top of the Safe tx (for the relay's fee)
  tx: { to: Address; data: Hex; value: string };
  approval?: Address; // ERC-20 in: who to approve (exactly, then back to 0)
  until: number; // ms: don't sign a quote older than this
};

const approve = (token: Address, spender: Address, amount: bigint): Call => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({ abi: abi.erc20, functionName: "approve", args: [spender, amount] }),
});

/** The batch's calls (the relay's fee goes after these). */
export function swapCalls(r: SwapRoute): Call[] {
  const swap: Call = { to: r.tx.to, value: BigInt(r.tx.value), data: r.tx.data };
  if (r.from.address === zeroAddress || !r.approval) return [swap];
  return [approve(r.from.address, r.approval, BigInt(r.fromAmount)), swap, approve(r.from.address, r.approval, 0n)];
}

const APPROVE = "0x095ea7b3";
const sel = (d: Hex) => (size(d) >= 4 ? slice(d, 0, 4) : "0x");
const isApprove = (c: Call) => c.value === 0n && size(c.data) === 68 && sel(c.data) === APPROVE;
/** An exact approval to a swap router (whether it's reset is checkSwap's job). */
export const approvesRouter = (c: Call) => isApprove(c) && isSwapTarget(("0x" + c.data.slice(34, 74)) as Address);

/**
 * The relay's view of a swap batch: every swap call goes to a known router and names this Safe as the receiver
 * (its address is in the calldata), and every approval is to a router and set back to 0 before the batch ends.
 * Throws a plain-English reason, else returns whether the batch is a swap at all. (Any other call is checkCalls'.)
 */
export function checkSwap(safe: Address, calls: Call[]): boolean {
  const me = safe.slice(2).toLowerCase();
  let swap = false;
  const open = new Map<string, bigint>();
  for (const c of calls) {
    if (isSwapTarget(c.to)) {
      if (!c.data.toLowerCase().includes(me)) throw new Error("that swap doesn't pay this wallet");
      swap = true;
    } else if (approvesRouter(c)) {
      const d = decodeFunctionData({ abi: abi.erc20, data: c.data });
      const [spender, amount] = d.args as [Address, bigint];
      open.set(`${c.to.toLowerCase()}:${spender.toLowerCase()}`, amount);
    }
  }
  if ([...open.values()].some(v => v !== 0n)) throw new Error("an approval would outlive the swap");
  return swap;
}

/** SwapRouter02 + QuoterV2, only what we call. */
export const uniAbi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
]);

/** SwapRouter02's "the router itself" recipient: the swap lands there, then unwrapWETH9 sends ETH to the Safe. */
export const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
