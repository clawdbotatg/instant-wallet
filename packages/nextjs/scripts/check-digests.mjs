#!/usr/bin/env node
/**
 * Cross-check every app-side digest builder against the contract's hash* views on anvil, and
 * prove both signature encodings verify on chain:
 *
 *   1. deploy a wallet through the Factory with a software P-256 key (kind = RAW)
 *   2. for each EIP-712 type: local digest === contract view (random fields, random nonce/deadline)
 *   3. hashCalls: local === contract
 *   4. RAW signature (r ‖ s, low-s) -> isValidSignature true; tampered digest -> false
 *   5. WebAuthn: add a second software key as a passkey signer (metaAddSigner relayed by the
 *      facilitator, signed RAW), synthesize the assertion exactly like the Foundry test's
 *      `webauthnSigFlags` (authData = 32 zero bytes ‖ flags ‖ 4 zero bytes, clientDataJSON with the
 *      base64url digest), encode with utils/webauthn.ts -> isValidSignature true with flags 0x05,
 *      false with 0x01 (no UV), false with a swapped challenge; then relay a real metaTransfer
 *      with that WebAuthn signature and check balances moved.
 *   6. matchCode(digest) matches docs/matchwords.json byte for byte.
 *
 * Usage: yarn check:digests   (anvil on 127.0.0.1:8545 with the contracts deployed)
 */
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
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
  "function hashTransfer(address token, address to, uint256 amount, uint256 fee, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashCalls((address target, uint256 value, bytes data)[] calls) pure returns (bytes32)",
  "function hashExecute(bytes32 callsHash, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashAddSigner(bytes32 qx, bytes32 qy, uint8 kind, uint8 role, uint128 dailyLimit, bytes32 credentialIdHash, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashUpdateSigner(address signerId, uint8 role, uint128 dailyLimit, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashRemoveSigner(address signerId, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashSetRecovery(address recoveryAddress, uint64 recoveryDelay, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function hashCancelRecovery(uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function isValidSignature(address signerId, bytes32 digest, bytes signature) view returns (bool)",
  "function metaAddSigner(bytes32 qx, bytes32 qy, uint8 kind, uint8 role, uint128 dailyLimit, bytes32 credentialIdHash, address signerId, uint256 deadline, bytes signature)",
  "function metaTransfer(address token, address to, uint256 amount, uint256 fee, address signerId, uint256 deadline, bytes signature)",
  "function remainingAllowance(address signerId) view returns (uint256)",
]);
const factoryAbi = parseAbi([
  "function createWallet(bytes32 salt, bytes32 qx, bytes32 qy, uint8 kind, bytes32 credentialIdHash) returns (address)",
  "function getWalletAddress(bytes32 qx, bytes32 qy, bytes32 salt) view returns (address)",
]);
const usdcAbi = parseAbi(["function mint(address to, uint256 amount)"]);

const pc = createPublicClient({ chain: foundry, transport: http(RPC) });
const account = privateKeyToAccount(PK);
const wc = createWalletClient({ chain: foundry, transport: http(RPC), account });
const CHAIN_ID = foundry.id;

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
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

// ---------------------------------------------------------------- 1. deploy
console.log("1. deploy a wallet through the Factory (RAW software key)");
const A = softKey();
const predicted = await pc.readContract({ address: factory, abi: factoryAbi, functionName: "getWalletAddress", args: [A.qx, A.qy, D.ZERO_BYTES32] });
await send(factory, factoryAbi, "createWallet", [D.ZERO_BYTES32, A.qx, A.qy, D.KIND_RAW, D.ZERO_BYTES32]);
const wallet = predicted;
eq("signerIdOf matches contract", A.signerId, await read(wallet, "signerIdOf", [A.qx, A.qy]));
check("wallet deployed at predicted address", (await pc.getCode({ address: wallet })) !== undefined);

// ---------------------------------------------------------------- 2. digests
console.log("2. EIP-712 digests: local vs contract views");
{
  const nonce = rnd(4);
  const dl = rnd(5);
  const t = { token: rndAddr(), to: rndAddr(), amount: rnd(12), fee: rnd(6), nonce, deadline: dl };
  eq("hashTransfer", D.hashTransfer(CHAIN_ID, wallet, t), await read(wallet, "hashTransfer", [t.token, t.to, t.amount, t.fee, nonce, dl]));

  const calls = [
    { target: rndAddr(), value: 7n, data: "0xdeadbeef" },
    { target: rndAddr(), value: 0n, data: "0x" },
    { target: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [rndAddr(), 5n] }) },
  ];
  const callsHash = D.hashCalls(calls);
  eq("hashCalls", callsHash, await read(wallet, "hashCalls", [calls]));
  eq("hashExecute", D.hashExecute(CHAIN_ID, wallet, { callsHash, nonce, deadline: dl }), await read(wallet, "hashExecute", [callsHash, nonce, dl]));

  const a = { qx: rnd32(), qy: rnd32(), kind: 1, role: 0, dailyLimit: rnd(15), credentialIdHash: rnd32(), nonce, deadline: dl };
  eq(
    "hashAddSigner",
    D.hashAddSigner(CHAIN_ID, wallet, a),
    await read(wallet, "hashAddSigner", [a.qx, a.qy, a.kind, a.role, a.dailyLimit, a.credentialIdHash, nonce, dl]),
  );
  const u = { signerId: rndAddr(), role: 1, dailyLimit: rnd(10), nonce, deadline: dl };
  eq("hashUpdateSigner", D.hashUpdateSigner(CHAIN_ID, wallet, u), await read(wallet, "hashUpdateSigner", [u.signerId, u.role, u.dailyLimit, nonce, dl]));
  const rm = { signerId: rndAddr(), nonce, deadline: dl };
  eq("hashRemoveSigner", D.hashRemoveSigner(CHAIN_ID, wallet, rm), await read(wallet, "hashRemoveSigner", [rm.signerId, nonce, dl]));
  const sr = { recoveryAddress: rndAddr(), recoveryDelay: rnd(7), nonce, deadline: dl };
  eq("hashSetRecovery", D.hashSetRecovery(CHAIN_ID, wallet, sr), await read(wallet, "hashSetRecovery", [sr.recoveryAddress, sr.recoveryDelay, nonce, dl]));
  eq("hashCancelRecovery", D.hashCancelRecovery(CHAIN_ID, wallet, { nonce, deadline: dl }), await read(wallet, "hashCancelRecovery", [nonce, dl]));
}

// ---------------------------------------------------------------- 3/4. raw signature
console.log("3. RAW signature (r ‖ s, low-s) verifies on chain");
{
  const nonce = await read(wallet, "nonce");
  const dl = deadline();
  const digest = D.hashTransfer(CHAIN_ID, wallet, { token: usdc, to: rndAddr(), amount: 1n, fee: 0n, nonce, deadline: dl });
  const { r, s } = signHash(A.priv, hexToBytes(digest));
  const sig = encodeRawSignature(r, s);
  check("raw signature is 64 bytes", sig.length === 2 + 128);
  check("isValidSignature(raw) = true", await read(wallet, "isValidSignature", [A.signerId, digest, sig]));
  check("isValidSignature(raw, other digest) = false", !(await read(wallet, "isValidSignature", [A.signerId, rnd32(), sig])));
  // high-s variant must be normalized by the encoder
  const highS = `0x${(D_N() - BigInt(s)).toString(16).padStart(64, "0")}`;
  check("encoder normalizes high-s", encodeRawSignature(r, highS) === sig);
}
function D_N() {
  return 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
}

// ---------------------------------------------------------------- 5. webauthn
console.log("4. WebAuthn flat-tuple signature verifies on chain (same shape as the Foundry test)");
const B = softKey();
{
  // A (owner, RAW) adds B as a WebAuthn spender with a $500 limit — relayed for real.
  const nonce = await read(wallet, "nonce");
  const dl = deadline();
  const credHash = keccak256(toHex("cred"));
  const fields = { qx: B.qx, qy: B.qy, kind: D.KIND_WEBAUTHN, role: D.ROLE_SPENDER, dailyLimit: 500_000_000n, credentialIdHash: credHash, nonce, deadline: dl };
  const digest = D.hashAddSigner(CHAIN_ID, wallet, fields);
  const { r, s } = signHash(A.priv, hexToBytes(digest));
  await send(wallet, walletAbi, "metaAddSigner", [B.qx, B.qy, 0, 0, 500_000_000n, credHash, A.signerId, dl, encodeRawSignature(r, s)]);
  eq("B added as spender with $500 limit", await read(wallet, "remainingAllowance", [B.signerId]), 500_000_000n);
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
  const digest = D.hashTransfer(CHAIN_ID, wallet, { token: usdc, to, amount: 45_000_000n, fee: 20_000n, nonce, deadline: dl });
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
  eq("spender allowance dropped by amount + fee", await read(wallet, "remainingAllowance", [B.signerId]), 500_000_000n - 45_020_000n);
}

// ---------------------------------------------------------------- 6. match code
console.log("5. match code");
{
  const words = JSON.parse(readFileSync(join(pkg, "../../docs/matchwords.json"), "utf8"));
  const digest = rnd32();
  const b = hexToBytes(digest);
  const expected = `${words[b[0]]} ${words[b[1]]} ${b[2] % 100}`;
  eq("matchCode(digest) == docs/matchwords.json derivation", matchCode(digest), expected);
  const { MATCH_WORDS } = await import("../utils/matchwords.ts");
  check("word list identical to docs/matchwords.json", MATCH_WORDS.length === 256 && MATCH_WORDS.every((w, i) => w === words[i]));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall digests and signature encodings match the contract");
process.exit(failures ? 1 : 0);
