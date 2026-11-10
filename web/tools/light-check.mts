// lib/safe/light.ts on real mainnet Safes: a send, batches (a delegatecall), a revert. Nothing is sent.
// ALCHEMY_API_KEY=… npx tsx tools/light-check.mts <safe> [<safe>…]
import { encodeFunctionData, parseAbi } from "viem";
const { lightRun } = await import("../lib/safe/light.ts");
const { asSafeTx } = await import("clear-signing-safe-kit");
const rpc = `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const post = (m: string, p: unknown[]) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then(r => r.json()).then(j => j.result);
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", bob = "0x0000000000000000000000000000000000000b0b";
const erc = parseAbi(["function transfer(address,uint256)", "function deposit() payable", "function withdraw(uint256)"]);
for (const safe of process.argv.slice(2)) {
  console.log("safe", safe, "threshold", Number(await post("eth_call", [{ to: safe, data: "0xe75235b8" }, "latest"])), "eth", Number(BigInt(await post("eth_getBalance", [safe, "latest"]))) / 1e18);
  const t = async (label: string, tx: any) => { const s = Date.now(); try { const a = await lightRun({ chainId: 1, safe, tx, rpc }); console.log(" ", label, Date.now() - s, "ms", JSON.stringify(a)); } catch (e: any) { console.log(" ", label, "ERR", String(e.message || e).replace(process.env.ALCHEMY_API_KEY!, "KEY").slice(0, 300)); } };
  await t("send 0.001 ETH", asSafeTx([{ to: bob, value: 10n ** 15n, data: "0x" }]));
  await t("batch: wrap 0.001, send 0.0004 WETH, 1 USDC out", asSafeTx([{ to: WETH, value: 10n ** 15n, data: encodeFunctionData({ abi: erc, functionName: "deposit" }) }, { to: WETH, value: 0n, data: encodeFunctionData({ abi: erc, functionName: "transfer", args: [bob, 4n * 10n ** 14n] }) }, { to: USDC, value: 0n, data: encodeFunctionData({ abi: erc, functionName: "transfer", args: [bob, 1_000_000n] }) }]));
  await t("batch: wrap then unwrap", asSafeTx([{ to: WETH, value: 10n ** 15n, data: encodeFunctionData({ abi: erc, functionName: "deposit" }) }, { to: WETH, value: 0n, data: encodeFunctionData({ abi: erc, functionName: "withdraw", args: [10n ** 15n] }) }]));
  await t("too much USDC", asSafeTx([{ to: USDC, value: 0n, data: encodeFunctionData({ abi: erc, functionName: "transfer", args: [bob, 10n ** 30n] }) }]));
}
process.exit(0);
