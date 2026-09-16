#!/usr/bin/env node
/**
 * End-to-end device-queue test against the running dev server (port 3000) and anvil, v2.
 * No browser: the wallet's first signer is a software RAW key (kind = 1), so this script plays
 * both the phone (creating requests) and the device (polling, rebuilding the digest from the raw
 * fields, signing with noble P-256, posting the signature).
 *
 *   1. counterfactual: POST /api/register (kind = 1) -> address, NOT deployed; GET /api/wallet works
 *      (deployed:false, nonce 0, the key as sole owner); fund USDC + ETH at the bare address
 *   2. announce as the device (POST /api/device) -> paired, wallet matches; /api/state v2 shape
 *   3. FIRST send through the queue deploys the wallet on the fly (createWallet, then metaTransfer);
 *      recipient balance moved, matchCode === matchCode(digest)
 *   4. ETH transfer (asset = 0x0)
 *   5. two queued transfers signed oldest-first (nonce = onchain + inFlight)
 *   6. addSigner (spender, no limit) + setLimit request (USDC) — spender within / over its limit,
 *      and refused on an asset with no limit (ETH)
 *   7. one-Execute admin batch (add key + two limits + role change), labels ride along
 *   8. execute (arbitrary call) — callsHash rebuilt locally
 *   9. reject with a device-supplied error; expiry (local-only ttlSeconds) -> expired, signature -> 410
 *  10. GET /api/wallet activity reflects the flows (incl. limitSet)
 *
 * Usage: node --no-warnings scripts/e2e-device.mjs   (APP_URL overrides http://localhost:3000)
 */
import { p256 } from "@noble/curves/nist.js";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseAbi, parseEther } from "viem";
import { foundry } from "viem/chains";
import * as D from "../utils/digests.ts";
import { matchCode } from "../utils/matchwords.ts";
import { bytesToHex, hexToBytes, toLowS } from "../utils/webauthn.ts";

const BASE = process.env.APP_URL || "http://localhost:3000";
const RPC = process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
const pc = createPublicClient({ chain: foundry, transport: http(RPC) });
const ETH = D.ETH_ASSET;

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const eq = (name, a, b) => check(name, String(a).toLowerCase() === String(b).toLowerCase(), String(a) === String(b) ? "" : `${a} vs ${b}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { http: res.status, ...json };
}

function softKey() {
  const priv = p256.utils.randomSecretKey();
  const pub = p256.getPublicKey(priv, false);
  const qx = bytesToHex(pub.slice(1, 33));
  const qy = bytesToHex(pub.slice(33, 65));
  return { priv, qx, qy, signerId: D.signerIdOf(qx, qy) };
}
function signDigest(priv, digest) {
  const sig = p256.sign(hexToBytes(digest), priv, { prehash: false, lowS: true });
  const r = bytesToHex(sig.slice(0, 32));
  const s = `0x${toLowS(BigInt(bytesToHex(sig.slice(32, 64)))).toString(16).padStart(64, "0")}`;
  return { r, s };
}
const rndAddr = () => `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(20))).slice(2)}`;
const balanceOf = (token, who) => pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const hasCode = async a => ((await pc.getCode({ address: a })) ?? "0x") !== "0x";
const signerOf = (w, id) => w.signers?.find(x => x.signerId.toLowerCase() === id.toLowerCase());
const limitOf = (s, asset) => s?.limits?.find(l => l.asset.toLowerCase() === asset.toLowerCase());

/** The device: rebuild the digest from the raw fields (never trust request.digest). */
function rebuildDigest(r) {
  const nonce = BigInt(r.nonce);
  const deadline = BigInt(r.deadline);
  switch (r.kind) {
    case "transfer":
      return D.hashTransfer(r.chainId, r.wallet, { asset: r.asset, to: r.to, amount: BigInt(r.amount), fee: BigInt(r.fee), nonce, deadline });
    case "execute": {
      const callsHash = D.hashCalls(r.calls.map(c => ({ target: c.target, value: BigInt(c.value), data: c.data })));
      if (callsHash.toLowerCase() !== r.callsHash.toLowerCase()) throw new Error("callsHash mismatch");
      return D.hashExecute(r.chainId, r.wallet, { callsHash, nonce, deadline });
    }
    case "addSigner":
      return D.hashAddSigner(r.chainId, r.wallet, { qx: r.qx, qy: r.qy, kind: r.signerKind, role: r.role, credentialIdHash: r.credentialIdHash, nonce, deadline });
    case "updateSigner":
      return D.hashUpdateSigner(r.chainId, r.wallet, { signerId: r.targetSignerId, role: r.role, nonce, deadline });
    case "setLimit":
      return D.hashSetLimit(r.chainId, r.wallet, { signerId: r.targetSignerId, asset: r.asset, limit: BigInt(r.limit), nonce, deadline });
    case "removeSigner":
      return D.hashRemoveSigner(r.chainId, r.wallet, { signerId: r.targetSignerId, nonce, deadline });
    case "setRecovery":
      return D.hashSetRecovery(r.chainId, r.wallet, { recoveryAddress: r.recoveryAddress, recoveryDelay: BigInt(r.recoveryDelay), nonce, deadline });
    case "cancelRecovery":
      return D.hashCancelRecovery(r.chainId, r.wallet, { nonce, deadline });
  }
}

/** Act as the device for one request id: poll pending, rebuild, sign, post, wait for a terminal state. */
async function deviceSign(dev, id, label, expect = "confirmed") {
  let pending;
  for (let i = 0; i < 20 && !pending; i++) {
    const list = await api("GET", `/api/requests?status=pending&signerId=${dev.signerId}`);
    pending = (list.requests ?? []).find(r => r.id === id);
    if (!pending) await sleep(300);
  }
  check(`${label}: request visible to the device via ?status=pending&signerId`, !!pending);
  if (!pending) return null;
  eq(`${label}: request.signerId is the device`, pending.signerId, dev.signerId);
  const digest = rebuildDigest(pending);
  eq(`${label}: digest rebuilt from raw fields matches request.digest`, digest, pending.digest);
  eq(`${label}: matchCode == matchCode(rebuilt digest)`, pending.matchCode, matchCode(digest));
  const { r, s } = signDigest(dev.priv, digest);
  const posted = await api("POST", `/api/requests/${id}/signature`, { r, s });
  if (expect !== "confirmed") return posted;
  check(`${label}: POST signature accepted`, posted.http === 200 && ["signed", "relaying", "confirmed"].includes(posted.status), `${posted.http} ${posted.status} ${posted.error ?? ""}`);
  let final;
  for (let i = 0; i < 40; i++) {
    const { request } = await api("GET", `/api/requests/${id}`);
    final = request;
    if (["confirmed", "failed", "rejected", "expired"].includes(request.status)) break;
    await sleep(500);
  }
  eq(`${label}: status confirmed`, final?.status, "confirmed");
  check(`${label}: txHash present`, !!final?.txHash);
  return final;
}

// ------------------------------------------------------------------ 1. counterfactual wallet
console.log("1. counterfactual wallet: register the first key, fund the bare address");
console.log(`   app ${BASE}`);
const dev = softKey();
const reg = await api("POST", "/api/register", { qx: dev.qx, qy: dev.qy, kind: 1, credentialIdHash: D.ZERO_BYTES32 });
check("register ok", reg.http === 200 && !!reg.wallet, reg.error ?? reg.wallet);
const wallet = reg.wallet;
console.log(`   wallet ${wallet}`);
eq("signerId matches local derivation", reg.signerId, dev.signerId);
check("register: deployed = false", reg.deployed === false);
check("no code at the address yet", !(await hasCode(wallet)));
{
  const w = await api("GET", `/api/wallet?address=${wallet}`);
  check("GET /api/wallet works before deployment", w.http === 200, w.error ?? "");
  check("wallet.deployed = false", w.deployed === false);
  eq("wallet.nonce = 0", w.nonce, "0");
  check("first key is the sole owner signer", w.signers?.length === 1 && w.signers[0].signerId.toLowerCase() === dev.signerId.toLowerCase() && w.signers[0].role === 1);
  check("recovery shows the factory defaults", !!w.recovery?.recoveryAddress && w.recovery.recoveryDelay >= 3600);
  eq("fee policy default 0", w.fee?.bps, 0);
}
const funded = await api("POST", "/api/fund", { wallet, amount: "100" });
check("fund USDC ok (to the bare address)", funded.http === 200, funded.error ?? funded.balanceFormatted);
const fundedEth = await api("POST", "/api/fund", { wallet, amount: "1", asset: "ETH" });
check("fund ETH ok", fundedEth.http === 200, fundedEth.error ?? fundedEth.balanceFormatted);
const token = funded.asset;

// ------------------------------------------------------------------ 2. device announce + state
console.log("2. device announce + /api/state (v2 shape)");
const ann = await api("POST", "/api/device", { name: "e2e device", qx: dev.qx, qy: dev.qy, chipSerial: "0123456789ab", firmware: "e2e" });
check("POST /api/device -> paired (counterfactual wallet, via the registered first key)", ann.paired === true, JSON.stringify(ann));
eq("POST /api/device -> wallet", ann.wallet, wallet);
eq("POST /api/device -> signerId", ann.signerId, dev.signerId);
const state = await api("GET", `/api/state?wallet=${wallet}`);
check("GET /api/state has the device as owner", state.signers?.some(s => s.signerId.toLowerCase() === dev.signerId.toLowerCase() && s.role === 1), state.error ?? "");
check("GET /api/state wallet.deployed = false", state.wallet?.deployed === false);
check("GET /api/state wallet.assets has USDC 100 and ETH 1", (() => {
  const a = state.wallet?.assets ?? [];
  const u = a.find(x => x.asset.toLowerCase() === token.toLowerCase());
  const e = a.find(x => x.asset === ETH);
  return u?.balanceFormatted === "100" && e?.balanceFormatted === "1";
})(), JSON.stringify(state.wallet?.assets));
check("GET /api/state balanceUsd counts USDC at $1", Number(state.wallet?.balanceUsd) >= 100);
check("GET /api/state signers[].limits is an array", Array.isArray(state.signers?.[0]?.limits));
check("GET /api/state pendingRecovery null", state.pendingRecovery === null);
const relayer = state.relayer.address;
const dev2 = await api("GET", `/api/device?wallet=${wallet}`);
check("GET /api/device lists the device online + paired", dev2.devices?.some(d => d.signerId.toLowerCase() === dev.signerId.toLowerCase() && d.online === true && d.paired === true));

// ------------------------------------------------------------------ 3. first send deploys
console.log("3. first transfer through the queue deploys the wallet on the fly");
{
  const to = rndAddr();
  const before = await balanceOf(token, to);
  const created = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, asset: token, to, toName: "alice", amount: "45000000" });
  check("POST /api/requests -> 201 {request} (undeployed wallet, digest cross-checked via code override)", created.http === 201 && !!created.request, created.error ?? "");
  const req = created.request;
  eq("request.kind", req.kind, "transfer");
  eq("request.asset", req.asset, token);
  eq("request.assetSymbol", req.assetSymbol, "USDC");
  eq("request.assetDecimals", req.assetDecimals, 6);
  eq("request.amount", req.amount, "45000000");
  eq("request.fee = 0 (default)", req.fee, "0");
  eq("request.nonce = 0", req.nonce, "0");
  eq("request.matchCode == matchCode(request.digest)", req.matchCode, matchCode(req.digest));
  const final = await deviceSign(dev, req.id, "first transfer");
  check("wallet has code after the first send", await hasCode(wallet));
  eq("recipient received 45 USDC", (await balanceOf(token, to)) - before, 45_000_000n);
  if (final) {
    const receipt = await pc.getTransactionReceipt({ hash: final.txHash });
    eq("tx receipt success", receipt.status, "success");
  }
  const w = await api("GET", `/api/wallet?address=${wallet}`);
  check("wallet.deployed = true now", w.deployed === true);
  eq("on-chain nonce = 1", w.nonce, "1");
  check("owner still the sole signer, from chain now", w.signers?.length === 1 && w.signers[0].role === 1);
  const again = await api("POST", `/api/requests/${req.id}/signature`, { r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32) });
  eq("second signature on a confirmed request -> 409", again.http, 409);
}

// ------------------------------------------------------------------ 4. ETH transfer
console.log("4. ETH transfer (asset = 0x0)");
{
  const to = rndAddr();
  const created = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, asset: ETH, to, amount: parseEther("0.25").toString() });
  check("ETH transfer request created", created.http === 201, created.error ?? "");
  eq("request.asset = 0x0", created.request?.asset, ETH);
  eq("request.assetSymbol = ETH", created.request?.assetSymbol, "ETH");
  eq("request.amountFormatted", created.request?.amountFormatted, "0.25");
  await deviceSign(dev, created.request.id, "eth transfer");
  eq("recipient received 0.25 ETH", await pc.getBalance({ address: to }), parseEther("0.25"));
  const relayBefore = await pc.getBalance({ address: relayer });
  check("relayer address known", relayBefore > 0n);
}

// ------------------------------------------------------------------ 5. queue of two
console.log("5. two queued requests, nonce = onchain + inFlight, signed oldest first");
{
  const a = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, asset: token, to: rndAddr(), amount: "1000000" });
  const b = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, asset: token, to: rndAddr(), amount: "2000000" });
  eq("second request nonce = first + 1", BigInt(b.request.nonce), BigInt(a.request.nonce) + 1n);
  const list = await api("GET", `/api/requests?status=pending&signerId=${dev.signerId}`);
  const ids = list.requests.map(r => r.id);
  check("pending list is oldest first", ids.indexOf(a.request.id) < ids.indexOf(b.request.id));
  await deviceSign(dev, a.request.id, "queued #1");
  await deviceSign(dev, b.request.id, "queued #2");
}

// ------------------------------------------------------------------ 6. addSigner + setLimit
console.log("6. addSigner (spender) + setLimit via the device; per-asset limits");
const spender = softKey();
{
  const created = await api("POST", "/api/requests", {
    kind: "addSigner",
    wallet,
    signerId: dev.signerId,
    qx: spender.qx,
    qy: spender.qy,
    signerKind: 1,
    role: 0,
    credentialIdHash: D.ZERO_BYTES32,
    label: "e2e spender",
  });
  check("addSigner request created (no dailyLimit field)", created.http === 201 && created.request.dailyLimit === undefined, created.error ?? "");
  await deviceSign(dev, created.request.id, "addSigner");
  let st = await api("GET", `/api/wallet?address=${wallet}`);
  let s = signerOf(st, spender.signerId);
  check("new signer present as spender with no limits", !!s && s.role === 0 && Array.isArray(s.limits) && s.limits.length === 0);
  eq("label stored", s?.label, "e2e spender");

  // a spender with no limit on USDC cannot move it: the relay refuses at simulation
  const none = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: spender.signerId, asset: token, to: rndAddr(), amount: "1000000" });
  const r0 = await deviceSign(spender, none.request.id, "spender without a limit", "failed");
  eq("no-limit spender transfer -> failed", r0?.status, "failed");
  check("failure names OverLimit", /OverLimit/i.test(r0?.error ?? ""), r0?.error);

  const lim = await api("POST", "/api/requests", { kind: "setLimit", wallet, signerId: dev.signerId, targetSignerId: spender.signerId, asset: token, limit: "100000000" });
  check("setLimit request created", lim.http === 201, lim.error ?? "");
  eq("setLimit request kind", lim.request?.kind, "setLimit");
  eq("setLimit request.assetSymbol", lim.request?.assetSymbol, "USDC");
  eq("setLimit request.limit", lim.request?.limit, "100000000");
  eq("setLimit request.label = the target's stored label", lim.request?.label, "e2e spender");
  await deviceSign(dev, lim.request.id, "setLimit");
  st = await api("GET", `/api/wallet?address=${wallet}`);
  s = signerOf(st, spender.signerId);
  const l = limitOf(s, token);
  check("spender now has a USDC limit of 100 with 100 remaining", l?.limit === "100000000" && l?.remaining === "100000000", JSON.stringify(s?.limits));

  // within the limit
  const sp = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: spender.signerId, asset: token, to: rndAddr(), amount: "45000000" });
  check("spender transfer request created", sp.http === 201, sp.error ?? "");
  await deviceSign(spender, sp.request.id, "spender transfer");
  st = await api("GET", `/api/wallet?address=${wallet}`);
  eq("spender remaining USDC allowance = 100 - 45", limitOf(signerOf(st, spender.signerId), token)?.remaining, "55000000");
  // over the limit
  const over = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: spender.signerId, asset: token, to: rndAddr(), amount: "60000000" });
  const r1 = await deviceSign(spender, over.request.id, "over-limit spender", "failed");
  eq("over-limit spender transfer -> failed", r1?.status, "failed");
  check("failure names OverLimit", /OverLimit/i.test(r1?.error ?? ""), r1?.error);
  // an asset with no limit at all (ETH)
  const noEth = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: spender.signerId, asset: ETH, to: rndAddr(), amount: "1" });
  const r2 = await deviceSign(spender, noEth.request.id, "spender ETH without a limit", "failed");
  eq("spender ETH transfer without a limit -> failed", r2?.status, "failed");
  check("failure names OverLimit (ETH)", /OverLimit/i.test(r2?.error ?? ""), r2?.error);
  // a spender may not set limits
  const bad = await api("POST", "/api/requests", { kind: "setLimit", wallet, signerId: spender.signerId, targetSignerId: spender.signerId, asset: ETH, limit: "1" });
  const r3 = await deviceSign(spender, bad.request.id, "spender setLimit", "failed");
  check("spender-signed setLimit -> NotOwner", r3?.status === "failed" && /NotOwner/i.test(r3?.error ?? ""), r3?.error);
}

// ------------------------------------------------------------------ 7. one-Execute admin batch
console.log("7. one Execute of self-calls: add a key, two limits, a role change");
const K = softKey();
{
  const ops = [
    { op: "addSigner", qx: K.qx, qy: K.qy, kind: 1, role: 0, credentialIdHash: D.ZERO_BYTES32 },
    { op: "setLimit", signerId: K.signerId, asset: token, limit: 50_000_000n },
    { op: "setLimit", signerId: K.signerId, asset: ETH, limit: parseEther("0.01") },
    { op: "updateSigner", signerId: spender.signerId, role: 1 },
  ];
  const calls = D.adminCalls(wallet, ops).map(c => ({ target: c.target, value: c.value.toString(), data: c.data }));
  const created = await api("POST", "/api/requests", { kind: "execute", wallet, signerId: dev.signerId, calls, labels: { [K.signerId]: "e2e batch key" } });
  check("execute (admin batch) request created", created.http === 201, created.error ?? "");
  eq("callsHash matches local hashCalls", created.request.callsHash, D.hashCalls(D.adminCalls(wallet, ops)));
  const decoded = D.decodeAdminCalls(wallet, created.request.calls.map(c => ({ ...c, value: BigInt(c.value) })));
  check("device can decode the batch into 4 admin lines", decoded?.length === 4 && decoded[0].op === "addSigner" && decoded[3].op === "updateSigner");
  await deviceSign(dev, created.request.id, "admin batch");
  const st = await api("GET", `/api/wallet?address=${wallet}`);
  const k = signerOf(st, K.signerId);
  check("batch: K added as spender", !!k && k.role === 0);
  eq("batch: K label from `labels`", k?.label, "e2e batch key");
  check("batch: K has USDC 50 + ETH 0.01 limits", limitOf(k, token)?.limit === "50000000" && limitOf(k, ETH)?.limit === parseEther("0.01").toString(), JSON.stringify(k?.limits));
  check("batch: spender promoted to owner (limits cleared from view)", signerOf(st, spender.signerId)?.role === 1 && signerOf(st, spender.signerId)?.limits.length === 0);
  check("3 signers on the wallet", st.signers?.length === 3);
  // K can now spend 0.005 ETH (under its 0.01 limit)
  const to = rndAddr();
  const t = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: K.signerId, asset: ETH, to, amount: parseEther("0.005").toString() });
  await deviceSign(K, t.request.id, "K spends ETH within its limit");
  eq("K's ETH landed", await pc.getBalance({ address: to }), parseEther("0.005"));
  eq("K remaining ETH = 0.005", limitOf(signerOf(await api("GET", `/api/wallet?address=${wallet}`), K.signerId), ETH)?.remaining, parseEther("0.005").toString());
}

// ------------------------------------------------------------------ 8. arbitrary execute
console.log("8. execute (arbitrary call) via the device");
{
  const to = rndAddr();
  const calls = [{ target: token, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 1_000_000n] }) }];
  const created = await api("POST", "/api/requests", { kind: "execute", wallet, signerId: dev.signerId, calls });
  check("execute request created", created.http === 201, created.error ?? "");
  eq("callsHash matches local hashCalls", created.request.callsHash, D.hashCalls(calls.map(c => ({ ...c, value: 0n }))));
  await deviceSign(dev, created.request.id, "execute");
  eq("execute moved 1 USDC", await balanceOf(token, to), 1_000_000n);
}

// ------------------------------------------------------------------ 9. reject + expiry + bad signature
console.log("9. reject, expiry, bad signature");
{
  const rej = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, asset: token, to: rndAddr(), amount: "1000000" });
  const r1 = await api("POST", `/api/requests/${rej.request.id}/reject`, { by: "e2e device", error: "digest mismatch: device 0xabc vs app 0xdef" });
  eq("reject -> rejected", r1.status, "rejected");
  const got = await api("GET", `/api/requests/${rej.request.id}`);
  check("device-supplied error stored", /digest mismatch/.test(got.request?.error ?? ""), got.request?.error);
  const r2 = await api("POST", `/api/requests/${rej.request.id}/reject`, { by: "e2e device" });
  eq("second reject -> 409", r2.http, 409);

  const exp = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, asset: token, to: rndAddr(), amount: "1000000", ttlSeconds: 2 });
  check("short-ttl request created (local only)", exp.http === 201, exp.error ?? "");
  await sleep(3200);
  const e1 = await api("GET", `/api/requests/${exp.request.id}`);
  eq("expired after the deadline", e1.request?.status, "expired");
  const e2 = await api("POST", `/api/requests/${exp.request.id}/signature`, { r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32) });
  check("signature after expiry refused (409/410)", e2.http === 409 || e2.http === 410, String(e2.http));

  const bad = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, asset: token, to: rndAddr(), amount: "1000000" });
  const wrongKey = softKey();
  const { r, s } = signDigest(wrongKey.priv, bad.request.digest);
  const b1 = await api("POST", `/api/requests/${bad.request.id}/signature`, { r, s });
  eq("signature from the wrong key -> 400 failed", b1.http, 400);
  const b2 = await api("GET", `/api/requests/${bad.request.id}`);
  eq("request marked failed", b2.request?.status, "failed");

  // nonce accounting recovers: a fresh request lands on the live nonce and confirms
  const live = await pc.readContract({ address: wallet, abi: parseAbi(["function nonce() view returns (uint256)"]), functionName: "nonce" });
  const fresh = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, asset: token, to: rndAddr(), amount: "1000000" });
  eq("fresh request uses the live nonce (queue drained)", fresh.request.nonce, live.toString());
  await deviceSign(dev, fresh.request.id, "after failures");
}

// ------------------------------------------------------------------ 10. wallet view
console.log("10. GET /api/wallet reflects the flows");
{
  const w = await api("GET", `/api/wallet?address=${wallet}`);
  check("wallet deployed with 3 signers", w.deployed === true && w.signers?.length === 3);
  check("portfolio lists ETH and USDC with balances", ["ETH", "USDC"].every(sym => w.portfolio?.assets?.some(a => a.symbol === sym && BigInt(a.balance) > 0n)));
  check("activity includes sent, received, keyAdded, keyUpdated, limitSet, executed", ["sent", "received", "keyAdded", "keyUpdated", "limitSet", "executed"].every(t => w.activity?.some(a => a.type === t)), [...new Set((w.activity ?? []).map(a => a.type))].join(","));
  check("sent ETH row carries symbol/decimals", w.activity?.some(a => a.type === "sent" && a.asset === ETH && a.symbol === "ETH" && a.decimals === 18));
  const st = await api("GET", `/api/state?wallet=${wallet}`);
  check("/api/state signers[].limits carry asset/symbol/limit/remaining", st.signers?.some(s => s.limits?.some(l => l.asset && l.symbol && l.limit && l.remaining !== undefined)));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\ndevice queue end-to-end (v2): all checks passed");
process.exit(failures ? 1 : 0);
