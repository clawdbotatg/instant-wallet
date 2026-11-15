// The relay reads who a swap pays from the swap's own receiver field (audit 11-13, IW-14). It used to pass any swap
// with the Safe's address anywhere in its calldata: one that pays someone else passes by naming the Safe in a field
// nobody reads.
//   npx tsx tools/swap-check.mts              the rule, no network
//   LIVE=1 npx tsx tools/swap-check.mts       also LI.FI's real quotes (a swap, a bridge): each is read, each pays the Safe
import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { abi } from "../lib/safe/core";
import { ADDRESS_THIS, LIFI_DIAMOND, UNI, checkSwap, swapReceivers, uniAbi } from "../lib/safe/swap";

let bad = 0;
const ok = (c: boolean, m: string) => (console.log((c ? "PASS " : "FAIL ") + m), c || bad++);
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const me: Address = "0x00000000000000000000000000000000000000aa", thief: Address = "0x00000000000000000000000000000000000000bb";
const usdc: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const S = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)";
const B = "(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)";
const lifi = parseAbi([`function swapTokensMultipleV3ERC20ToNative(bytes32 id, string integrator, string referrer, address receiver, uint256 minOut, ${S}[] swaps)`,
  `function startBridgeTokensViaAcrossV3(${B} bridgeData, (address a, bytes32 b, uint256 c) acrossData) payable`]);
const id = ("0x" + "11".repeat(32)) as Hex;
// the Safe's address sits in an unused field (referrer text, callTo): the old test's whole proof
const swapTo = (receiver: Address) => ({ to: LIFI_DIAMOND, value: 0n, data: encodeFunctionData({ abi: lifi, functionName: "swapTokensMultipleV3ERC20ToNative",
  args: [id, "instant-wallet", me, receiver, 1n, [{ callTo: me, approveTo: me, sendingAssetId: usdc, receivingAssetId: zeroAddress, fromAmount: 5n, callData: "0x", requiresDeposit: true }]] }) });
const bridgeTo = (receiver: Address) => ({ to: LIFI_DIAMOND, value: 0n, data: encodeFunctionData({ abi: lifi, functionName: "startBridgeTokensViaAcrossV3",
  args: [{ transactionId: id, bridge: "across", integrator: "instant-wallet", referrer: me, sendingAssetId: usdc, receiver, minAmount: 5n, destinationChainId: 42161n, hasSourceSwaps: false, hasDestinationCall: false }, { a: me, b: id, c: 1n }] }) });
const router = Object.values(UNI)[0].router;
const uni = (recipient: Address, unwrapTo?: Address) => ({ to: router, value: 0n, data: encodeFunctionData({ abi: uniAbi, functionName: "multicall", args: [9999999999n,
  [encodeFunctionData({ abi: uniAbi, functionName: "exactInput", args: [{ path: ("0x" + me.slice(2) + "000bb8" + usdc.slice(2)) as Hex, recipient, amountIn: 5n, amountOutMinimum: 1n }] }),
    ...(unwrapTo ? [encodeFunctionData({ abi: uniAbi, functionName: "unwrapWETH9", args: [1n, unwrapTo] })] : [])]] }) });
const appr = (n: bigint) => ({ to: usdc, value: 0n, data: encodeFunctionData({ abi: abi.erc20, functionName: "approve", args: [LIFI_DIAMOND, n] }) });

ok(checkSwap(me, [appr(5n), swapTo(me), appr(0n)]) === true, "a LI.FI swap that pays the Safe: accepted");
ok(swapTo(thief).data.toLowerCase().includes(me.slice(2)) && throws(() => checkSwap(me, [appr(5n), swapTo(thief), appr(0n)])), "a LI.FI swap that pays someone else, the Safe's address in its other fields: refused");
ok(checkSwap(me, [bridgeTo(me)]) === true && throws(() => checkSwap(me, [bridgeTo(thief)])), "a bridge: its BridgeData's receiver is the one that counts");
ok(checkSwap(me, [uni(me)]) === true && throws(() => checkSwap(me, [uni(thief)])), "Uniswap: exactInput's recipient");
ok(checkSwap(me, [uni(ADDRESS_THIS, me)]) === true && throws(() => checkSwap(me, [uni(ADDRESS_THIS, thief)])) && throws(() => checkSwap(me, [uni(ADDRESS_THIS)])), "Uniswap to ETH: the unwrap must send it to the Safe, and there must be one");
ok(throws(() => checkSwap(me, [appr(5n), swapTo(me)])), "an approval left behind is still refused");
ok(swapReceivers({ to: LIFI_DIAMOND, value: 0n, data: "0x12345678" }) === null, "a call it can't read says so (null), it doesn't guess");

if (process.env.LIVE) {
  const safe: Address = "0x000000000000000000000000000000000000bEEF", Z = zeroAddress, ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  for (const [what, q] of [["swap ETH→USDC on Base", { fromChain: 8453, toChain: 8453, fromToken: Z, toToken: usdc, fromAmount: 10n ** 15n }], ["swap USDC→ETH on Base", { fromChain: 8453, toChain: 8453, fromToken: usdc, toToken: Z, fromAmount: 5_000_000n }],
    ["bridge USDC Base→Arbitrum", { fromChain: 8453, toChain: 42161, fromToken: usdc, toToken: ARB_USDC, fromAmount: 5_000_000n }], ["bridge ETH Base→Ethereum", { fromChain: 8453, toChain: 1, fromToken: Z, toToken: Z, fromAmount: 10n ** 16n }]] as const) {
    const u = new URL("https://li.quest/v1/quote");
    for (const [k, v] of Object.entries({ ...q, fromAddress: safe, toAddress: safe, slippage: 0.005, integrator: "instant-wallet" })) u.searchParams.set(k, String(v));
    const j: any = await (await fetch(u)).json();
    const t = j.transactionRequest;
    if (!t) { console.log(`  (no quote for ${what}: ${String(j.message).slice(0, 80)})`); continue; }
    const who = swapReceivers({ to: t.to, value: 0n, data: t.data });
    ok(!!who && who.length === 1 && who[0] === safe.toLowerCase(), `live, ${what} (${j.tool}, ${t.data.slice(0, 10)}): read, pays the Safe (${who})`);
    await new Promise(r => setTimeout(r, 1500));
  }
}
process.exit(bad ? 1 : 0);
