#!/usr/bin/env node
/**
 * Cross-check every app-side digest builder against the contract's hash* views on anvil (v2), and
 * prove both signature encodings verify on chain:
 *
 *   1. deploy a wallet through the Factory with a software P-256 key (kind = RAW)
 *   2. for each EIP-712 type (incl. SetLimit): local digest === contract view (random fields/nonce/deadline)
 *      + the same for a COUNTERFACTUAL wallet through a code override (what the server's walletView does)
 *   3. hashCalls: local === contract; adminCalls() round-trips through decodeAdminCalls()
 *   4. RAW signature (r ‖ s, low-s) -> isValidSignature true; tampered digest -> false
 *   5. WebAuthn: add a second software key as a passkey spender (metaAddSigner + metaSetLimit relayed by
 *      the facilitator, signed RAW), synthesize the assertion exactly like the Foundry test's
 *      `webauthnSigFlags`, encode with utils/webauthn.ts -> isValidSignature true with flags 0x05,
 *      false with 0x01 (no UV), false with a swapped challenge; then relay a real USDC metaTransfer
 *      with that WebAuthn signature and check balances + the per-asset allowance moved.
 *   6. ETH is an asset: owner metaTransfer(asset = 0x0) moves ETH; spender with no ETH limit is refused.
 *   7. matchCode(digest) matches docs/matchwords.json byte for byte.
 *
 * Usage: node --no-warnings scripts/check-digests.mjs   (anvil on 127.0.0.1:8545 with the contracts deployed)
 */
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import * as D from "../utils/digests.ts";
import { matchCode } from "../utils/matchwords.ts";
import { bytesToBase64url, bytesToHex, encodeRawSignature, encodeWebAuthnSignature, hexToBytes, syntheticAssertion, toLowS } from "../utils/webauthn.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");

// ---------------------------------------------------------------- env + addresses
function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(join(pkg, f), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
      }
    } catch {}
  }
}
loadEnv();

const RPC = process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
const PK = process.env.FACILITATOR_PRIVATE_KEY;
if (!PK) throw new Error("FACILITATOR_PRIVATE_KEY missing (packages/nextjs/.env.local)");

function addressesFromDeployedContracts() {
  const src = readFileSync(join(pkg, "contracts/deployedContracts.ts"), "utf8");
  const block = src.slice(src.indexOf("31337:"));
  const grab = name => block.match(new RegExp(`${name}:\\s*\\{\\s*address:\\s*"(0x[0-9a-fA-F]{40})"`))?.[1];
  return { factory: grab("Factory"), usdc: grab("MockUSDC") };
}
const { factory, usdc } = addressesFromDeployedContracts();
if (!factory || !usdc) throw new Error("Factory/MockUSDC not found in contracts/deployedContracts.ts for 31337");

const walletAbi = parseAbi([
  "function signerIdOf(bytes32 qx, bytes32 qy) pure returns (address)",
  "function nonce() view returns (uint256)",
  "function domainSeparator() view returns (bytes32)",
  "function hashTransfer(address asset, address to, uint256 amount, uint256 fee, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashCalls((address target, uint256 value, bytes data)[] calls) pure returns (bytes32)",
  "function hashExecute(bytes32 callsHash, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashAddSigner(bytes32 qx, bytes32 qy, uint8 kind, uint8 role, bytes32 credentialIdHash, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashUpdateSigner(address signerId, uint8 role, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashSetLimit(address signerId, address asset, uint128 limit, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashRemoveSigner(address signerId, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashSetRecovery(address recoveryAddress, uint64 recoveryDelay, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashCancelRecovery(uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function isValidSignature(address signerId, bytes32 digest, bytes signature) view returns (bool)",
  "function metaAddSigner(bytes32 qx, bytes32 qy, uint8 kind, uint8 role, bytes32 credentialIdHash, address signerId, uint256 deadline, bytes signature)",
  "function metaSetLimit(address targetSignerId, address asset, uint128 limit, address signerId, uint256 deadline, bytes signature)",
  "function metaTransfer(address asset, address to, uint256 amount, uint256 fee, address signerId, uint256 deadline, bytes signature)",
  "function metaExecute((address target, uint256 value, bytes data)[] calls, address signerId, uint256 deadline, bytes signature)",
  "function remainingAllowance(address signerId, address asset) view returns (uint256)",
  "function getLimits(address signerId) view returns (address[] assets, (uint128 limit, uint128 spent, uint64 windowStart)[] list)",
  "function getSigner(address signerId) view returns ((bytes32 qx, bytes32 qy, uint8 kind, uint8 role, uint64 addedAt))",
  "error OverLimit(address signerId, address asset, uint256 wanted, uint256 remaining)",
  "error NotOwner(address signerId)",
  "error UnknownSigner(address signerId)",
  "error BadSignature()",
  "error Expired(uint256 deadline, uint256 nowTs)",
]);
const factoryAbi = parseAbi([
  "function createWallet(bytes32 salt, bytes32 qx, bytes32 qy, uint8 kind, bytes32 credentialIdHash) returns (address)",
  "function getWalletAddress(bytes32 qx, bytes32 qy, bytes32 salt) view returns (address)",
  "function isDeployed(bytes32 qx, bytes32 qy, bytes32 salt) view returns (bool)",
  "function implementation() view returns (address)",
]);
const usdcAbi = parseAbi(["function mint(address to, uint256 amount)"]);

const pc = createPublicClient({ chain: foundry, transport: http(RPC) });
const account = privateKeyToAccount(PK);
const wc = createWalletClient({ chain: foundry, transport: http(RPC), account });
const CHAIN_ID = foundry.id;
const ETH = D.ETH_ASSET;

// ---------------------------------------------------------------- helpers
let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
}
function eq(name, a, b) {
  check(name, String(a).toLowerCase() === String(b).toLowerCase(), a === b ? "" : `${a} vs ${b}`);
}
const rnd = n => BigInt("0x" + bytesToHex(crypto.getRandomValues(new Uint8Array(n))).slice(2));
const rndAddr = () => `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(20))).slice(2)}`;
const rnd32 = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

function softKey() {
  const priv = p256.utils.randomSecretKey();
  const pub = p256.getPublicKey(priv, false); // 04 || x || y
  const qx = bytesToHex(pub.slice(1, 33));
  const qy = bytesToHex(pub.slice(33, 65));
  return { priv, qx, qy, signerId: D.signerIdOf(qx, qy) };
}
/** Sign a 32-byte hash, return low-s (r, s). */
function signHash(priv, hash32) {
  const sig = p256.sign(hash32, priv, { prehash: false, lowS: true });
  const r = bytesToHex(sig.slice(0, 32));
  const s = `0x${toLowS(BigInt(bytesToHex(sig.slice(32, 64)))).toString(16).padStart(64, "0")}`;
  return { r, s };
}
const read = (address, functionName, args = []) => pc.readContract({ address, abi: walletAbi, functionName, args });
async function send(address, abi, functionName, args) {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account });
  const hash = await wc.writeContract(request);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}
async function expectRevert(name, fn, re) {
  try {
    await fn();
    check(name, false, "did not revert");
  } catch (e) {
    const msg = [e?.shortMessage, e?.message, e?.details, ...(e?.metaMessages ?? [])].filter(Boolean).join(" ");
    check(name, re.test(msg), re.test(msg) ? "" : msg.slice(0, 200));
  }
}
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const rawSig = (priv, digest) => {
  const { r, s } = signHash(priv, hexToBytes(digest));
  return encodeRawSignature(r, s);
};

// ---------------------------------------------------------------- 1. deploy
console.log("1. deploy a wallet through the Factory (RAW software key)");
const A = softKey();
const predicted = await pc.readContract({ address: factory, abi: factoryAbi, functionName: "getWalletAddress", args: [A.qx, A.qy, D.ZERO_BYTES32] });
check("isDeployed(A) = false before", !(await pc.readContract({ address: factory, abi: factoryAbi, functionName: "isDeployed", args: [A.qx, A.qy, D.ZERO_BYTES32] })));
await send(factory, factoryAbi, "createWallet", [D.ZERO_BYTES32, A.qx, A.qy, D.KIND_RAW, D.ZERO_BYTES32]);
const wallet = predicted;
eq("signerIdOf matches contract", A.signerId, await read(wallet, "signerIdOf", [A.qx, A.qy]));
check("wallet deployed at predicted address", (await pc.getCode({ address: wallet })) !== undefined);
check("isDeployed(A) = true after", await pc.readContract({ address: factory, abi: factoryAbi, functionName: "isDeployed", args: [A.qx, A.qy, D.ZERO_BYTES32] }));
await send(factory, factoryAbi, "createWallet", [D.ZERO_BYTES32, A.qx, A.qy, D.KIND_RAW, D.ZERO_BYTES32]);
check("createWallet is idempotent (second call does not revert)", true);

// ---------------------------------------------------------------- 2. digests
console.log("2. EIP-712 digests (v2): local vs contract views");
const nonce0 = rnd(4);
const dl0 = rnd(5);
const sample = {
  t: { asset: rndAddr(), to: rndAddr(), amount: rnd(12), fee: rnd(6), nonce: nonce0, deadline: dl0 },
  a: { qx: rnd32(), qy: rnd32(), kind: 1, role: 0, credentialIdHash: rnd32(), nonce: nonce0, deadline: dl0 },
  u: { signerId: rndAddr(), role: 1, nonce: nonce0, deadline: dl0 },
  l: { signerId: rndAddr(), asset: rndAddr(), limit: rnd(15), nonce: nonce0, deadline: dl0 },
  rm: { signerId: rndAddr(), nonce: nonce0, deadline: dl0 },
  sr: { recoveryAddress: rndAddr(), recoveryDelay: rnd(7), nonce: nonce0, deadline: dl0 },
};
async function checkDigests(label, w, opts = {}) {
  const view = (fn, args) => pc.readContract({ address: w, abi: walletAbi, functionName: fn, args, ...opts });
  const { t, a, u, l, rm, sr } = sample;
  eq(`${label} hashTransfer`, D.hashTransfer(CHAIN_ID, w, t), await view("hashTransfer", [t.asset, t.to, t.amount, t.fee, nonce0, dl0]));
  const te = { ...t, asset: ETH };
  eq(`${label} hashTransfer (asset = ETH 0x0)`, D.hashTransfer(CHAIN_ID, w, te), await view("hashTransfer", [ETH, t.to, t.amount, t.fee, nonce0, dl0]));
  const calls = [
    { target: rndAddr(), value: 7n, data: "0xdeadbeef" },
    { target: rndAddr(), value: 0n, data: "0x" },
    { target: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [rndAddr(), 5n] }) },
  ];
  const callsHash = D.hashCalls(calls);
  eq(`${label} hashCalls`, callsHash, await view("hashCalls", [calls]));
  eq(`${label} hashExecute`, D.hashExecute(CHAIN_ID, w, { callsHash, nonce: nonce0, deadline: dl0 }), await view("hashExecute", [callsHash, nonce0, dl0]));
  eq(`${label} hashAddSigner`, D.hashAddSigner(CHAIN_ID, w, a), await view("hashAddSigner", [a.qx, a.qy, a.kind, a.role, a.credentialIdHash, nonce0, dl0]));
  eq(`${label} hashUpdateSigner`, D.hashUpdateSigner(CHAIN_ID, w, u), await view("hashUpdateSigner", [u.signerId, u.role, nonce0, dl0]));
  eq(`${label} hashSetLimit`, D.hashSetLimit(CHAIN_ID, w, l), await view("hashSetLimit", [l.signerId, l.asset, l.limit, nonce0, dl0]));
  eq(`${label} hashRemoveSigner`, D.hashRemoveSigner(CHAIN_ID, w, rm), await view("hashRemoveSigner", [rm.signerId, nonce0, dl0]));
  eq(`${label} hashSetRecovery`, D.hashSetRecovery(CHAIN_ID, w, sr), await view("hashSetRecovery", [sr.recoveryAddress, sr.recoveryDelay, nonce0, dl0]));
  eq(`${label} hashCancelRecovery`, D.hashCancelRecovery(CHAIN_ID, w, { nonce: nonce0, deadline: dl0 }), await view("hashCancelRecovery", [nonce0, dl0]));
}
await checkDigests("deployed:", wallet);
{
  // Counterfactual: a fresh key's predicted wallet has no code; override it with the clone bytecode for the call.
  const C = softKey();
  const cf = await pc.readContract({ address: factory, abi: factoryAbi, functionName: "getWalletAddress", args: [C.qx, C.qy, D.ZERO_BYTES32] });
  check("counterfactual wallet has no code", (await pc.getCode({ address: cf })) === undefined);
  const impl = await pc.readContract({ address: factory, abi: factoryAbi, functionName: "implementation" });
  const code = concatHex(["0x363d3d373d3d3d363d73", impl, "0x5af43d82803e903d91602b57fd5bf3"]);
  await checkDigests("counterfactual (code override):", cf, { stateOverride: [{ address: cf, code }] });
  check("digests differ per wallet (verifyingContract)", D.hashTransfer(CHAIN_ID, cf, sample.t) !== D.hashTransfer(CHAIN_ID, wallet, sample.t));
}

// ---------------------------------------------------------------- 3. admin batch helpers
console.log("3. adminCalls() self-call batch round-trips and hashes like the contract");
{
  const K = softKey();
  const ops = [
    { op: "addSigner", qx: K.qx, qy: K.qy, kind: 1, role: 1, credentialIdHash: D.ZERO_BYTES32 },
    { op: "updateSigner", signerId: A.signerId, role: 0 },
    { op: "setLimit", signerId: A.signerId, asset: usdc, limit: 500_000_000n },
    { op: "setLimit", signerId: A.signerId, asset: ETH, limit: parseEther("0.1") },
    { op: "removeSigner", signerId: rndAddr() },
    { op: "setRecovery", recoveryAddress: rndAddr(), recoveryDelay: 86400n },
  ];
  const calls = D.adminCalls(wallet, ops);
  check("every call targets the wallet with value 0", calls.every(c => c.target === wallet && c.value === 0n));
  const back = D.decodeAdminCalls(wallet, calls);
  eq("decodeAdminCalls(adminCalls(ops)) == ops", JSON.stringify(back, (k, v) => (typeof v === "bigint" ? v.toString() : v)), JSON.stringify(ops, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
  eq("hashCalls(adminCalls) matches contract", D.hashCalls(calls), await read(wallet, "hashCalls", [calls]));
  check("decodeAdminCalls rejects a foreign target", D.decodeAdminCalls(wallet, [{ target: usdc, value: 0n, data: calls[0].data }]) === null);
}

// ---------------------------------------------------------------- 4. raw signature
console.log("4. RAW signature (r ‖ s, low-s) verifies on chain");
{
  const nonce = await read(wallet, "nonce");
  const dl = deadline();
  const digest = D.hashTransfer(CHAIN_ID, wallet, { asset: usdc, to: rndAddr(), amount: 1n, fee: 0n, nonce, deadline: dl });
  const { r, s } = signHash(A.priv, hexToBytes(digest));
  const sig = encodeRawSignature(r, s);
  check("raw signature is 64 bytes", sig.length === 2 + 128);
  check("isValidSignature(raw) = true", await read(wallet, "isValidSignature", [A.signerId, digest, sig]));
  check("isValidSignature(raw, other digest) = false", !(await read(wallet, "isValidSignature", [A.signerId, rnd32(), sig])));
  const highS = `0x${(D_N() - BigInt(s)).toString(16).padStart(64, "0")}`;
  check("encoder normalizes high-s", encodeRawSignature(r, highS) === sig);
}
function D_N() {
  return 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
}

// ---------------------------------------------------------------- 5. webauthn
console.log("5. WebAuthn flat-tuple signature verifies on chain (same shape as the Foundry test)");
const B = softKey();
{
  // A (owner, RAW) adds B as a WebAuthn spender, then gives it a $500 USDC limit — two relayed meta calls.
  let nonce = await read(wallet, "nonce");
  let dl = deadline();
  const credHash = keccak256(toHex("cred"));
  const fields = { qx: B.qx, qy: B.qy, kind: D.KIND_WEBAUTHN, role: D.ROLE_SPENDER, credentialIdHash: credHash, nonce, deadline: dl };
  await send(wallet, walletAbi, "metaAddSigner", [B.qx, B.qy, 0, 0, credHash, A.signerId, dl, rawSig(A.priv, D.hashAddSigner(CHAIN_ID, wallet, fields))]);
  eq("B added as spender with no limits", (await read(wallet, "getLimits", [B.signerId]))[0].length, 0);
  eq("remainingAllowance(B, USDC) = 0 before a limit", await read(wallet, "remainingAllowance", [B.signerId, usdc]), 0n);
  nonce = await read(wallet, "nonce");
  dl = deadline();
  const lim = { signerId: B.signerId, asset: usdc, limit: 500_000_000n, nonce, deadline: dl };
  await send(wallet, walletAbi, "metaSetLimit", [B.signerId, usdc, 500_000_000n, A.signerId, dl, rawSig(A.priv, D.hashSetLimit(CHAIN_ID, wallet, lim))]);
  eq("metaSetLimit: remainingAllowance(B, USDC) = 500", await read(wallet, "remainingAllowance", [B.signerId, usdc]), 500_000_000n);
  eq("remainingAllowance(A owner, USDC) = max", await read(wallet, "remainingAllowance", [A.signerId, usdc]), 2n ** 256n - 1n);
}
function webauthnSig(priv, digest, flags) {
  const { authData, clientDataJSON } = syntheticAssertion(digest, flags);
  const cdh = sha256(new TextEncoder().encode(clientDataJSON));
  const msg = sha256(new Uint8Array([...authData, ...cdh]));
  const { r, s } = signHash(priv, msg);
  const challengeIndex = clientDataJSON.indexOf('"challenge"');
  const typeIndex = clientDataJSON.indexOf('"type"');
  return {
    sig: encodeWebAuthnSignature({ r, s, challengeIndex: BigInt(challengeIndex), typeIndex: BigInt(typeIndex), authenticatorData: bytesToHex(authData), clientDataJSON }),
    challengeIndex,
    typeIndex,
    clientDataJSON,
  };
}
{
  const nonce = await read(wallet, "nonce");
  const dl = deadline();
  const to = rndAddr();
  const digest = D.hashTransfer(CHAIN_ID, wallet, { asset: usdc, to, amount: 45_000_000n, fee: 20_000n, nonce, deadline: dl });
  const good = webauthnSig(B.priv, digest, 0x05);
  check("challengeIndex = 23 and typeIndex = 1 (as in InstantWallet.t.sol)", good.challengeIndex === 23 && good.typeIndex === 1);
  check("clientDataJSON challenge is base64url(digest)", good.clientDataJSON.includes(`"challenge":"${bytesToBase64url(hexToBytes(digest))}"`));
  // Layout: 6 head words (r, s, challengeIndex, typeIndex, offset(authData)=0xc0, offset(clientData)) -> no leading struct offset
  const words = good.sig.slice(2).match(/.{64}/g);
  check("flat tuple: word[4] is the authenticatorData offset 0xc0", BigInt("0x" + words[4]) === 0xc0n, words[4]);
  check("flat tuple: word[5] offset points past authData (0xc0 + 0x20 + 0x40)", BigInt("0x" + words[5]) === 0x120n, words[5]);
  check("isValidSignature(webauthn, UP|UV) = true", await read(wallet, "isValidSignature", [B.signerId, digest, good.sig]));
  const noUV = webauthnSig(B.priv, digest, 0x01);
  check("isValidSignature(webauthn, UP only) = false (requireUV)", !(await read(wallet, "isValidSignature", [B.signerId, digest, noUV.sig])));
  const swapped = webauthnSig(B.priv, rnd32(), 0x05);
  check("isValidSignature(webauthn, other challenge) = false", !(await read(wallet, "isValidSignature", [B.signerId, digest, swapped.sig])));
  check("isValidSignature(webauthn sig, raw signer) = false", !(await read(wallet, "isValidSignature", [A.signerId, digest, good.sig])));

  // Now relay the real transfer with the WebAuthn signature and check balances.
  await send(usdc, usdcAbi, "mint", [wallet, 100_000_000n]);
  const before = await pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  const feeBefore = await pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  await send(wallet, walletAbi, "metaTransfer", [usdc, to, 45_000_000n, 20_000n, B.signerId, dl, good.sig]);
  const after = await pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  const feeAfter = await pc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  eq("metaTransfer(webauthn) moved 45 USDC", after - before, 45_000_000n);
  eq("relayer received the 0.02 fee", feeAfter - feeBefore, 20_000n);
  eq("spender USDC allowance dropped by amount + fee", await read(wallet, "remainingAllowance", [B.signerId, usdc]), 500_000_000n - 45_020_000n);
}

// ---------------------------------------------------------------- 6. ETH as an asset
console.log("6. ETH is an asset (asset = 0x0)");
{
  const fundHash = await wc.sendTransaction({ to: wallet, value: parseEther("1") });
  await pc.waitForTransactionReceipt({ hash: fundHash });
  const to = rndAddr();
  let nonce = await read(wallet, "nonce");
  let dl = deadline();
  const digest = D.hashTransfer(CHAIN_ID, wallet, { asset: ETH, to, amount: parseEther("0.25"), fee: 0n, nonce, deadline: dl });
  await send(wallet, walletAbi, "metaTransfer", [ETH, to, parseEther("0.25"), 0n, A.signerId, dl, rawSig(A.priv, digest)]);
  eq("owner metaTransfer(ETH) moved 0.25 ETH", await pc.getBalance({ address: to }), parseEther("0.25"));
  // B (spender) has a USDC limit but no ETH limit -> OverLimit
  nonce = await read(wallet, "nonce");
  dl = deadline();
  const d2 = D.hashTransfer(CHAIN_ID, wallet, { asset: ETH, to, amount: 1n, fee: 0n, nonce, deadline: dl });
  const w2 = webauthnSig(B.priv, d2, 0x05);
  await expectRevert("spender with no ETH limit is refused (OverLimit)", () => send(wallet, walletAbi, "metaTransfer", [ETH, to, 1n, 0n, B.signerId, dl, w2.sig]), /OverLimit/);
  // One Execute of self-calls: give B an ETH limit AND bump USDC, signed by the owner
  nonce = await read(wallet, "nonce");
  dl = deadline();
  const calls = D.adminCalls(wallet, [
    { op: "setLimit", signerId: B.signerId, asset: ETH, limit: parseEther("0.1") },
    { op: "setLimit", signerId: B.signerId, asset: usdc, limit: 1_000_000_000n },
  ]);
  const d3 = D.hashExecute(CHAIN_ID, wallet, { callsHash: D.hashCalls(calls), nonce, deadline: dl });
  await send(wallet, walletAbi, "metaExecute", [calls, A.signerId, dl, rawSig(A.priv, d3)]);
  const [assets] = await read(wallet, "getLimits", [B.signerId]);
  check("execute(self-calls) set two limits on B", assets.length === 2 && assets.map(a => a.toLowerCase()).includes(ETH) && assets.map(a => a.toLowerCase()).includes(usdc.toLowerCase()));
  eq("remainingAllowance(B, ETH) = 0.1", await read(wallet, "remainingAllowance", [B.signerId, ETH]), parseEther("0.1"));
  eq("remainingAllowance(B, USDC) reset to 1000 (setLimit restarts the window)", await read(wallet, "remainingAllowance", [B.signerId, usdc]), 1_000_000_000n);
}

// ---------------------------------------------------------------- 7. match code
console.log("7. match code");
{
  const words = JSON.parse(readFileSync(join(pkg, "../../docs/matchwords.json"), "utf8"));
  const digest = rnd32();
  const b = hexToBytes(digest);
  const expected = `${words[b[0]]} ${words[b[1]]} ${b[2] % 100}`;
  eq("matchCode(digest) == docs/matchwords.json derivation", matchCode(digest), expected);
  const { MATCH_WORDS } = await import("../utils/matchwords.ts");
  check("word list identical to docs/matchwords.json", MATCH_WORDS.length === 256 && MATCH_WORDS.every((w, i) => w === words[i]));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall v2 digests and signature encodings match the contract");
process.exit(failures ? 1 : 0);
