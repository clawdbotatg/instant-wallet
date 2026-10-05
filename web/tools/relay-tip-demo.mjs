// Tipped relaying on a Base fork: the wallet signs a batch that ends with a USDC tip to tx.origin and a 60s
// deadline; a "stranger" relayer bot (ETH only, no relationship with us) simulates each posted job, prices it
// at LIVE Base gas, and submits only if the tip beats its gas. Usage: node tools/relay-tip-demo.mjs [forkRpc]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import {
  createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, encodeFunctionData, erc20Abi,
  formatUnits, http, keccak256, parseAbi, serializeTransaction, toHex, publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { instantWalletAbi, factoryAbi } from "../lib/abi.ts";

const LIVE = "https://mainnet.base.org";
const FORK_FROM = process.argv[2] || LIVE;
const PORT = 8611;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACTORY = "0x0Dedc086740f95fc3cd7B5b46cE0EB91b00A318F";
const ORACLE = "0x420000000000000000000000000000000000000F";
const RAW = 1;
// anvil's default keys: #0 funds things, #1 is the stranger relayer
const FUNDER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const RELAYER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9ee71ae7d4e95b2abba3d6c4a3e57c");
const BOB = "0x000000000000000000000000000000000000b0b0";

const anvil = spawn("anvil", ["--fork-url", FORK_FROM, "--network", "optimism", "--port", String(PORT), "--silent"], { stdio: "inherit" });
process.on("exit", () => anvil.kill());
const fork = `http://127.0.0.1:${PORT}`;
for (let i = 0; ; i++) {
  try { await fetch(fork, { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', headers: { "content-type": "application/json" } }); break; }
  catch { if (i > 100) throw new Error("anvil didn't start"); await new Promise(r => setTimeout(r, 200)); }
}
const chain = { ...base, rpcUrls: { default: { http: [fork] } } };
const pub = createPublicClient({ chain, transport: http(fork) });
const test = createTestClient({ chain, mode: "anvil", transport: http(fork) }).extend(publicActions);
const funder = createWalletClient({ chain, account: FUNDER, transport: http(fork) });
const relayerWallet = createWalletClient({ chain, account: RELAYER, transport: http(fork) });
const live = createPublicClient({ chain: base, transport: http(LIVE) });

// --- live economics: Base gas right now + ETH price
const [block, tipWei, ethUsd] = await Promise.all([
  live.getBlock(), live.request({ method: "eth_maxPriorityFeePerGas" }).then(BigInt),
  fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot").then(r => r.json()).then(j => Number(j.data.amount)),
]);
const gasPrice = block.baseFeePerGas + tipWei;
console.log(`live Base: base fee ${formatUnits(block.baseFeePerGas, 9)} gwei + priority ${formatUnits(tipWei, 9)} gwei, ETH $${ethUsd}`);
const usd = wei => Number(formatUnits(wei, 18)) * ethUsd;

// --- setup on the fork: a wallet with a raw P-256 key (a wedgie stands in for the passkey), 100 real USDC
const sk = p256.utils.randomSecretKey();
const pk = p256.getPublicKey(sk, false);
const qx = toHex(pk.slice(1, 33)), qy = toHex(pk.slice(33, 65));
const zero = "0x" + "0".repeat(64);
await pub.waitForTransactionReceipt({ hash: await funder.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "createWallet", args: [qx, qy, RAW, zero] }) });
const wallet = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getAddress", args: [qx, qy, RAW, zero] });
const signerId = await pub.readContract({ address: wallet, abi: instantWalletAbi, functionName: "signerIdOf", args: [qx, qy] });
// FiatToken balances live at mapping slot 9
await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [wallet, 9n])), value: toHex(100_000_000n, { size: 32 }) });
const tipArt = JSON.parse(readFileSync(new URL("../../packages/foundry/out/RelayTip.sol/RelayTip.json", import.meta.url)));
const r = await pub.waitForTransactionReceipt({ hash: await funder.deployContract({ abi: tipArt.abi, bytecode: tipArt.bytecode.object }) });
const TIP = r.contractAddress;
await test.setBalance({ address: RELAYER.address, value: 10n ** 16n }); // 0.01 ETH, no USDC
const usdcOf = a => pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });
console.log(`wallet ${wallet}  USDC ${formatUnits(await usdcOf(wallet), 6)}  ·  RelayTip ${TIP}  ·  relayer ${RELAYER.address}\n`);

// --- the wallet side: sign "send X USDC to bob, tip T USDC to whoever lands this within `ttl` seconds"
const tipCalls = micro => [
  { target: USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TIP, BigInt(micro)] }) },
  { target: TIP, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function pay(address)"]), functionName: "pay", args: [USDC] }) },
];
const board = []; // stands in for a public job board / p2p topic relayers watch
let nonce = 0n;
async function post(label, sendUsdc, tipMicro, ttl) {
  const calls = [
    { target: USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [BOB, BigInt(sendUsdc * 1e6)] }) },
    ...tipCalls(tipMicro),
  ];
  const now = (await pub.getBlock()).timestamp;
  const deadline = now + BigInt(ttl);
  const callsHash = await pub.readContract({ address: wallet, abi: instantWalletAbi, functionName: "hashCalls", args: [calls] });
  const digest = await pub.readContract({ address: wallet, abi: instantWalletAbi, functionName: "hashExecute", args: [callsHash, nonce++, deadline] });
  const sig = toHex(p256.sign(Buffer.from(digest.slice(2), "hex"), sk, { prehash: false, lowS: true }));
  board.push({ label, args: [calls, signerId, deadline, sig], tipUsdc: tipMicro / 1e6 });
}

// --- the stranger relayer: knows nothing about us except "metaExecute payloads that tip tx.origin in USDC"
async function relayerTick() {
  for (const job of board.splice(0)) {
    const data = encodeFunctionData({ abi: instantWalletAbi, functionName: "metaExecute", args: job.args });
    let gas;
    try { gas = await pub.estimateGas({ account: RELAYER.address, to: wallet, data }); }
    catch (e) { console.log(`  ✗ ${job.label}: simulation reverts (${e.shortMessage?.split("\n")[0] ?? e.message}) — skip`); continue; }
    // what it would cost on LIVE Base: L2 execution + L1 data fee for these exact bytes
    const unsigned = serializeTransaction({ chainId: 8453, type: "eip1559", to: wallet, data, gas, nonce: 0, maxFeePerGas: gasPrice, maxPriorityFeePerGas: tipWei });
    const l1Fee = await live.readContract({ address: ORACLE, abi: parseAbi(["function getL1Fee(bytes) view returns (uint256)"]), functionName: "getL1Fee", args: [unsigned] });
    const costUsd = usd(gas * gasPrice + l1Fee);
    const profit = job.tipUsdc - costUsd;
    const line = `gas ${gas} → cost $${costUsd.toFixed(5)} (L2 $${usd(gas * gasPrice).toFixed(5)} + L1 $${usd(l1Fee).toFixed(5)}), tip $${job.tipUsdc.toFixed(4)}`;
    if (profit <= 0) { console.log(`  ✗ ${job.label}: ${line} — unprofitable, skip`); continue; }
    const before = await usdcOf(RELAYER.address);
    const rc = await pub.waitForTransactionReceipt({ hash: await relayerWallet.sendTransaction({ to: wallet, data, gas: gas * 12n / 10n }) });
    const got = (await usdcOf(RELAYER.address)) - before;
    console.log(`  ✓ ${job.label}: ${line} — submitted (${rc.status}, gasUsed ${rc.gasUsed}), relayer got ${formatUnits(got, 6)} USDC, profit ≈ $${profit.toFixed(4)}`);
  }
}

console.log("job 1: send 1 USDC, tip 5¢, 60s deadline");
await post("job 1", 1, 50_000, 60);
await relayerTick();

console.log("job 2: send 1 USDC, tip 5¢, 60s deadline — but nobody looks for 61s");
await post("job 2", 1, 50_000, 60);
await test.increaseTime({ seconds: 61 }); await test.mine({ blocks: 1 });
await relayerTick();

console.log("job 3: send 1 USDC, tip 0.01¢ (less than the gas) — job 2 never landed, so its nonce is reused");
nonce = 1n;
await post("job 3", 1, 100, 60);
await relayerTick();

console.log("job 4: same send, tip 1¢, 60s deadline (nonce 1 again: job 3 never landed either)");
nonce = 1n;
await post("job 4", 1, 10_000, 60);
await relayerTick();

console.log(`\nbob ${formatUnits(await usdcOf(BOB), 6)} USDC · wallet ${formatUnits(await usdcOf(wallet), 6)} USDC · relayer ${formatUnits(await usdcOf(RELAYER.address), 6)} USDC · RelayTip holds ${formatUnits(await usdcOf(TIP), 6)}`);
process.exit(0);
