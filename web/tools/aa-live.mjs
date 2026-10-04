// One real ERC-4337 send on Base: a fresh raw-P-256 wallet (no ETH anywhere) sends USDC, deployed by the op itself,
// gas paid in USDC via Circle Paymaster, submitted by Pimlico's public bundler.
// Usage: node tools/aa-live.mjs <keyfile> <to> <usdcAmount>   (keyfile is created on first run; fund the printed
// address with a little USDC, then run again)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import {
  concat, createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, http, keccak256,
  numberToHex, pad, parseAbi, parseUnits, toHex,
} from "viem";
import { base } from "viem/chains";

const [keyfile, TO, AMOUNT] = process.argv.slice(2);
const BUNDLER = "https://public.pimlico.io/v2/8453/rpc";
const FACTORY = "0x896c8D40022A79FC1228dB800FD3aaf7f21d7469";
const EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const PM = "0x0578cFB241215b77442a541325d6A4E6dFE700Ec";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RAW = 1, ZERO = pad("0x0");
const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const bundler = async (method, params) => {
  const j = await fetch(BUNDLER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};

if (!existsSync(keyfile)) writeFileSync(keyfile, toHex(p256.utils.randomSecretKey()), { mode: 0o600 });
const sk = Buffer.from(readFileSync(keyfile, "utf8").trim().slice(2), "hex");
const pk = p256.getPublicKey(sk, false);
const qx = toHex(pk.slice(1, 33)), qy = toHex(pk.slice(33, 65));
const factoryAbi = parseAbi(["function getAddress(bytes32,bytes32,uint8,bytes32) view returns (address)", "function createWallet(bytes32,bytes32,uint8,bytes32) returns (address)"]);
const wallet = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getAddress", args: [qx, qy, RAW, ZERO] });
const signerId = "0x" + keccak256(concat([qx, qy])).slice(-40);
const bal = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
console.log(`wallet ${wallet}  USDC ${formatUnits(bal, 6)}  ETH ${formatUnits(await pub.getBalance({ address: wallet }), 18)}`);
const amount = parseUnits(AMOUNT, 6);
if (bal < amount + 100_000n) { console.log(`fund it with at least ${formatUnits(amount + 100_000n, 6)} USDC on Base, then run again`); process.exit(0); }

// --- digests (docs: InstantWallet.hashUserOp / hashPair / hashMessage)
const tk = s => keccak256(toHex(s));
const domain = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
  [tk("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), tk("InstantWallet"), tk("3"), 8453n, wallet]));
const typed = h => keccak256(concat(["0x1901", domain, h]));
const enc = (types, vals) => keccak256(encodeAbiParameters(types.map(type => ({ type })), vals));
const sign = d => toHex(p256.sign(Buffer.from(d.slice(2), "hex"), sk, { prehash: false, lowS: true }));

const deployed = (await pub.getCode({ address: wallet }))?.length > 2;
const allowance = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [wallet, PM] });
const needPermit = allowance < 500_000n;
const calls = [{ target: USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TO, amount] }) }];
const callData = concat(["0x" + keccak256(toHex("executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)")).slice(2, 10),
  encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], [calls])]);
const factoryData = deployed ? undefined : encodeFunctionData({ abi: factoryAbi, functionName: "createWallet", args: [qx, qy, RAW, ZERO] });
const nonce = await pub.readContract({ address: EP, abi: parseAbi(["function getNonce(address,uint192) view returns (uint256)"]), functionName: "getNonce", args: [wallet, BigInt(signerId)] });
const usdcNonce = await pub.readContract({ address: USDC, abi: parseAbi(["function nonces(address) view returns (uint256)"]), functionName: "nonces", args: [wallet] });
const permitAmount = 1_000_000n;
const validUntil = BigInt(Math.floor(Date.now() / 1000) + 120);

function build(g) {
  const initCode = deployed ? "0x" : concat([FACTORY, factoryData]);
  const accountGasLimits = concat([pad(numberToHex(g.verificationGasLimit), { size: 16 }), pad(numberToHex(g.callGasLimit), { size: 16 })]);
  const gasFees = concat([pad(numberToHex(g.maxPriorityFeePerGas), { size: 16 }), pad(numberToHex(g.maxFeePerGas), { size: 16 })]);
  let pmHead = concat([PM, pad(numberToHex(g.paymasterVerificationGasLimit), { size: 16 }), pad(numberToHex(g.paymasterPostOpGasLimit), { size: 16 }), "0x00"]);
  if (needPermit) pmHead = concat([pmHead, USDC, pad(numberToHex(permitAmount))]);
  const cut = BigInt((pmHead.length - 2) / 2);
  const opHash = enc(["uint256", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "bytes32", "uint256"],
    [nonce, keccak256(initCode), keccak256(callData), accountGasLimits, g.preVerificationGas, gasFees, keccak256(pmHead), cut]);
  const opDigest = typed(enc(["bytes32", "bytes32", "uint48"], [tk("UserOp(bytes32 opHash,uint48 validUntil)"), opHash, validUntil]));
  let pairWith = ZERO, keySig, paymasterData = needPermit ? concat(["0x00", USDC, pad(numberToHex(permitAmount))]) : "0x00";
  if (needPermit) {
    const usdcDomain = "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f";
    const permit = keccak256(concat(["0x1901", usdcDomain, enc(["bytes32", "address", "address", "uint256", "uint256", "uint256"],
      [tk("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), wallet, PM, permitAmount, usdcNonce, 2n ** 256n - 1n])]));
    pairWith = typed(enc(["bytes32", "bytes32"], [tk("InstantWalletMessage(bytes32 hash)"), permit]));
    const PAIR = tk("Pair(bytes32 a,bytes32 b)");
    keySig = sign(typed(enc(["bytes32", "bytes32", "bytes32"], [PAIR, opDigest, pairWith])));
    paymasterData = concat([paymasterData, signerId, PAIR, opDigest, keySig]);
  } else keySig = sign(opDigest);
  const signature = concat([pad(numberToHex(validUntil), { size: 6 }), pad(numberToHex(cut), { size: 2 }), pairWith, keySig]);
  const hex = v => numberToHex(v);
  return {
    sender: wallet, nonce: hex(nonce), ...(deployed ? {} : { factory: FACTORY, factoryData }), callData,
    callGasLimit: hex(g.callGasLimit), verificationGasLimit: hex(g.verificationGasLimit), preVerificationGas: hex(g.preVerificationGas),
    maxFeePerGas: hex(g.maxFeePerGas), maxPriorityFeePerGas: hex(g.maxPriorityFeePerGas), paymaster: PM,
    paymasterVerificationGasLimit: hex(g.paymasterVerificationGasLimit), paymasterPostOpGasLimit: hex(g.paymasterPostOpGasLimit),
    paymasterData, signature,
  };
}
// sanity: our USDC domain constant matches the chain
const dsep = await pub.readContract({ address: USDC, abi: parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)"]), functionName: "DOMAIN_SEPARATOR" });
if (dsep !== "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f") throw new Error(`USDC domain ${dsep}`);

const price = (await bundler("pimlico_getUserOperationGasPrice", [])).fast;
let g = { maxFeePerGas: BigInt(price.maxFeePerGas), maxPriorityFeePerGas: BigInt(price.maxPriorityFeePerGas),
  verificationGasLimit: 600_000n, callGasLimit: 200_000n, preVerificationGas: 200_000n, paymasterVerificationGasLimit: 200_000n, paymasterPostOpGasLimit: 40_000n };
const est = await bundler("eth_estimateUserOperationGas", [build(g), EP]);
console.log("estimate", Object.fromEntries(Object.entries(est).map(([k, v]) => [k, BigInt(v).toString()])));
const up = v => BigInt(v) * 12n / 10n;
g = { ...g, verificationGasLimit: up(est.verificationGasLimit), callGasLimit: up(est.callGasLimit), preVerificationGas: up(est.preVerificationGas),
  paymasterVerificationGasLimit: up(est.paymasterVerificationGasLimit ?? g.paymasterVerificationGasLimit), paymasterPostOpGasLimit: g.paymasterPostOpGasLimit };
const hash = await bundler("eth_sendUserOperation", [build(g), EP]);
console.log("userOpHash", hash);
for (let i = 0; i < 60; i++) {
  const r = await bundler("eth_getUserOperationReceipt", [hash]);
  if (r) {
    console.log(`success=${r.success} tx https://basescan.org/tx/${r.receipt.transactionHash} gasUsed=${BigInt(r.actualGasUsed)} gasCost=${formatUnits(BigInt(r.actualGasCost), 18)} ETH`);
    const after = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
    console.log(`USDC ${formatUnits(bal, 6)} → ${formatUnits(after, 6)}: sent ${AMOUNT}, gas ${formatUnits(bal - after - amount, 6)} USDC; wallet ETH ${formatUnits(await pub.getBalance({ address: wallet }), 18)}`);
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 2000));
}
console.log("no receipt after 2 min");
