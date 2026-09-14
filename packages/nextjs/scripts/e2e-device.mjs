#!/usr/bin/env node
/**
 * End-to-end device-queue test against the running dev server (yarn start, port 3000) and anvil.
 * No browser: the wallet's first signer is a software RAW key (kind = 1), so this script plays
 * both the phone (creating requests) and the device (polling, rebuilding the digest from the raw
 * fields, signing with noble P-256, posting the signature).
 *
 *   1. deploy a wallet via POST /api/deploy-wallet (kind = 1), fund it via POST /api/fund
 *   2. announce as the device (POST /api/device) -> paired, wallet matches
 *   3. transfer: POST /api/requests -> poll ?status=pending&signerId -> rebuild digest -> sign -> confirmed;
 *      recipient balance moved, relayer got the fee, matchCode === matchCode(digest)
 *   4. two queued transfers signed oldest-first (nonce = onchain + inFlight)
 *   5. addSigner (a second raw key as spender) + updateSigner (new limit) — both via the device
 *   6. execute (owner batch) — callsHash rebuilt locally
 *   7. reject with a device-supplied error; expiry (local-only ttlSeconds) -> expired, signature -> 410
 *
 * Usage: yarn e2e:device   (APP_URL overrides http://localhost:3000)
 */
import { p256 } from "@noble/curves/nist.js";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseAbi } from "viem";
import { foundry } from "viem/chains";
import * as D from "../utils/digests.ts";
import { matchCode } from "../utils/matchwords.ts";
import { bytesToHex, hexToBytes, toLowS } from "../utils/webauthn.ts";

const BASE = process.env.APP_URL || "http://localhost:3000";
const RPC = process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
const pc = createPublicClient({ chain: foundry, transport: http(RPC) });

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

/** The device: rebuild the digest from the raw fields (never trust request.digest). */
function rebuildDigest(r) {
  const nonce = BigInt(r.nonce);
  const deadline = BigInt(r.deadline);
  switch (r.kind) {
    case "transfer":
      return D.hashTransfer(r.chainId, r.wallet, { token: r.token, to: r.to, amount: BigInt(r.amount), fee: BigInt(r.fee), nonce, deadline });
    case "execute": {
      const callsHash = D.hashCalls(r.calls.map(c => ({ target: c.target, value: BigInt(c.value), data: c.data })));
      if (callsHash.toLowerCase() !== r.callsHash.toLowerCase()) throw new Error("callsHash mismatch");
      return D.hashExecute(r.chainId, r.wallet, { callsHash, nonce, deadline });
    }
    case "addSigner":
      return D.hashAddSigner(r.chainId, r.wallet, { qx: r.qx, qy: r.qy, kind: r.signerKind, role: r.role, dailyLimit: BigInt(r.dailyLimit), credentialIdHash: r.credentialIdHash, nonce, deadline });
    case "updateSigner":
      return D.hashUpdateSigner(r.chainId, r.wallet, { signerId: r.targetSignerId, role: r.role, dailyLimit: BigInt(r.dailyLimit), nonce, deadline });
    case "removeSigner":
      return D.hashRemoveSigner(r.chainId, r.wallet, { signerId: r.targetSignerId, nonce, deadline });
    case "setRecovery":
      return D.hashSetRecovery(r.chainId, r.wallet, { recoveryAddress: r.recoveryAddress, recoveryDelay: BigInt(r.recoveryDelay), nonce, deadline });
    case "cancelRecovery":
      return D.hashCancelRecovery(r.chainId, r.wallet, { nonce, deadline });
  }
}

/** Act as the device for one request id: poll pending, rebuild, sign, post, wait for a terminal state. */
async function deviceSign(dev, id, label) {
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

// ------------------------------------------------------------------ 1. wallet
console.log("1. deploy + fund (RAW software key as first signer)");
console.log(`   app ${BASE}`);
const dev = softKey();
const dep = await api("POST", "/api/deploy-wallet", { qx: dev.qx, qy: dev.qy, kind: 1, credentialIdHash: D.ZERO_BYTES32 });
check("deploy-wallet ok", dep.http === 200 && !!dep.wallet, dep.error ?? dep.wallet);
const wallet = dep.wallet;
console.log(`   wallet ${wallet}`);
eq("signerId matches local derivation", dep.signerId, dev.signerId);
const funded = await api("POST", "/api/fund", { wallet, amount: "100" });
check("fund ok", funded.http === 200, funded.error ?? funded.balanceFormatted);

// ------------------------------------------------------------------ 2. device announce
console.log("2. device announce");
const ann = await api("POST", "/api/device", { name: "e2e device", qx: dev.qx, qy: dev.qy, chipSerial: "0123456789ab", firmware: "e2e" });
check("POST /api/device -> paired", ann.paired === true, JSON.stringify(ann));
eq("POST /api/device -> wallet", ann.wallet, wallet);
eq("POST /api/device -> signerId", ann.signerId, dev.signerId);
const state = await api("GET", `/api/state?wallet=${wallet}`);
check("GET /api/state has the device as owner", state.signers?.some(s => s.signerId.toLowerCase() === dev.signerId.toLowerCase() && s.role === 1), state.error ?? "");
eq("GET /api/state balance 100", state.wallet?.balanceFormatted, "100");
check("GET /api/state pendingRecovery null", state.pendingRecovery === null);
const token = state.token.address;
const relayer = state.relayer.address;
const dev2 = await api("GET", `/api/device?wallet=${wallet}`);
check("GET /api/device lists the device online", dev2.devices?.some(d => d.signerId.toLowerCase() === dev.signerId.toLowerCase() && d.online === true));

// ------------------------------------------------------------------ 3. transfer
console.log("3. transfer through the device queue");
{
  const to = rndAddr();
  const before = await balanceOf(token, to);
  const feeBefore = await balanceOf(token, relayer);
  const created = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, to, toName: "alice", amount: "45000000" });
  check("POST /api/requests -> 201 {request}", created.http === 201 && !!created.request, created.error ?? "");
  const req = created.request;
  eq("request.kind", req.kind, "transfer");
  eq("request.amount", req.amount, "45000000");
  eq("request.fee = 0.02 USDC", req.fee, "20000");
  eq("request.matchCode == matchCode(request.digest)", req.matchCode, matchCode(req.digest));
  const final = await deviceSign(dev, req.id, "transfer");
  const after = await balanceOf(token, to);
  const feeAfter = await balanceOf(token, relayer);
  eq("recipient received 45 USDC", after - before, 45_000_000n);
  eq("relayer received the 0.02 fee", feeAfter - feeBefore, 20_000n);
  if (final) {
    const receipt = await pc.getTransactionReceipt({ hash: final.txHash });
    eq("tx receipt success", receipt.status, "success");
  }
  // replay: the same signature again must be refused (status is no longer pending)
  const again = await api("POST", `/api/requests/${req.id}/signature`, { r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32) });
  eq("second signature on a confirmed request -> 409", again.http, 409);
}

// ------------------------------------------------------------------ 4. queue of two
console.log("4. two queued requests, nonce = onchain + inFlight, signed oldest first");
{
  const a = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, to: rndAddr(), amount: "1000000" });
  const b = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, to: rndAddr(), amount: "2000000" });
  eq("second request nonce = first + 1", BigInt(b.request.nonce), BigInt(a.request.nonce) + 1n);
  const list = await api("GET", `/api/requests?status=pending&signerId=${dev.signerId}`);
  const ids = list.requests.map(r => r.id);
  check("pending list is oldest first", ids.indexOf(a.request.id) < ids.indexOf(b.request.id));
  await deviceSign(dev, a.request.id, "queued #1");
  await deviceSign(dev, b.request.id, "queued #2");
}

// ------------------------------------------------------------------ 5. addSigner + updateSigner
console.log("5. addSigner + updateSigner via the device");
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
    dailyLimit: "500000000",
    credentialIdHash: D.ZERO_BYTES32,
    label: "e2e spender",
  });
  check("addSigner request created", created.http === 201, created.error ?? "");
  await deviceSign(dev, created.request.id, "addSigner");
  const st = await api("GET", `/api/wallet?address=${wallet}`); // uncached read (state is cached ~4 s for the device)
  const s = st.signers.find(x => x.signerId.toLowerCase() === spender.signerId.toLowerCase());
  check("new signer present as spender with $500 limit", !!s && s.role === 0 && s.dailyLimit === "500000000");
  eq("label stored", s?.label, "e2e spender");

  const upd = await api("POST", "/api/requests", { kind: "updateSigner", wallet, signerId: dev.signerId, targetSignerId: spender.signerId, role: 0, dailyLimit: "100000000" });
  check("updateSigner request created", upd.http === 201, upd.error ?? "");
  await deviceSign(dev, upd.request.id, "updateSigner");
  const st2 = await api("GET", `/api/wallet?address=${wallet}`);
  eq("limit updated to $100", st2.signers.find(x => x.signerId.toLowerCase() === spender.signerId.toLowerCase())?.dailyLimit, "100000000");

  // the spender (limit $100) can sign a $45 transfer through the queue too
  const sp = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: spender.signerId, to: rndAddr(), amount: "45000000" });
  check("spender transfer request created", sp.http === 201, sp.error ?? "");
  await deviceSign(spender, sp.request.id, "spender transfer");
  const st3 = await api("GET", `/api/wallet?address=${wallet}`);
  eq("spender remaining allowance = 100 - 45.02", st3.signers.find(x => x.signerId.toLowerCase() === spender.signerId.toLowerCase())?.remainingAllowance, "54980000");
  // over the limit: the relay refuses at simulation, request fails
  const over = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: spender.signerId, to: rndAddr(), amount: "60000000" });
  const pend = (await api("GET", `/api/requests?status=pending&signerId=${spender.signerId}`)).requests.find(r => r.id === over.request.id);
  const { r, s: sv } = signDigest(spender.priv, rebuildDigest(pend));
  const res = await api("POST", `/api/requests/${over.request.id}/signature`, { r, s: sv });
  eq("over-limit spender transfer -> failed", res.status, "failed");
  check("failure names OverLimit", /OverLimit/i.test(res.error ?? ""), res.error);
}

// ------------------------------------------------------------------ 6. execute
console.log("6. execute (owner batch) via the device");
{
  const to = rndAddr();
  const calls = [{ target: token, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 1_000_000n] }) }];
  const created = await api("POST", "/api/requests", { kind: "execute", wallet, signerId: dev.signerId, calls });
  check("execute request created", created.http === 201, created.error ?? "");
  eq("callsHash matches local hashCalls", created.request.callsHash, D.hashCalls(calls.map(c => ({ ...c, value: 0n }))));
  await deviceSign(dev, created.request.id, "execute");
  eq("execute moved 1 USDC", await balanceOf(token, to), 1_000_000n);
}

// ------------------------------------------------------------------ 7. reject + expiry + bad signature
console.log("7. reject, expiry, bad signature");
{
  const rej = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, to: rndAddr(), amount: "1000000" });
  const r1 = await api("POST", `/api/requests/${rej.request.id}/reject`, { by: "e2e device", error: "digest mismatch: device 0xabc vs app 0xdef" });
  eq("reject -> rejected", r1.status, "rejected");
  const got = await api("GET", `/api/requests/${rej.request.id}`);
  check("device-supplied error stored", /digest mismatch/.test(got.request?.error ?? ""), got.request?.error);
  const r2 = await api("POST", `/api/requests/${rej.request.id}/reject`, { by: "e2e device" });
  eq("second reject -> 409", r2.http, 409);

  const exp = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, to: rndAddr(), amount: "1000000", ttlSeconds: 2 });
  check("short-ttl request created (local only)", exp.http === 201, exp.error ?? "");
  await sleep(3200);
  const e1 = await api("GET", `/api/requests/${exp.request.id}`);
  eq("expired after the deadline", e1.request?.status, "expired");
  const e2 = await api("POST", `/api/requests/${exp.request.id}/signature`, { r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32) });
  check("signature after expiry refused (409/410)", e2.http === 409 || e2.http === 410, String(e2.http));

  const bad = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, to: rndAddr(), amount: "1000000" });
  const wrongKey = softKey();
  const { r, s } = signDigest(wrongKey.priv, bad.request.digest);
  const b1 = await api("POST", `/api/requests/${bad.request.id}/signature`, { r, s });
  eq("signature from the wrong key -> 400 failed", b1.http, 400);
  const b2 = await api("GET", `/api/requests/${bad.request.id}`);
  eq("request marked failed", b2.request?.status, "failed");

  // nonce accounting recovers: a fresh request lands on the live nonce and confirms
  const live = await pc.readContract({ address: wallet, abi: parseAbi(["function nonce() view returns (uint256)"]), functionName: "nonce" });
  const fresh = await api("POST", "/api/requests", { kind: "transfer", wallet, signerId: dev.signerId, to: rndAddr(), amount: "1000000" });
  eq("fresh request uses the live nonce (queue drained)", fresh.request.nonce, live.toString());
  await deviceSign(dev, fresh.request.id, "after failures");
}

// ------------------------------------------------------------------ wallet view
console.log("8. GET /api/wallet activity reflects the flows");
{
  const w = await api("GET", `/api/wallet?address=${wallet}`);
  check("wallet deployed with 2 signers", w.deployed === true && w.signers?.length === 2);
  check("activity includes sent, received, keyAdded, keyUpdated, executed", ["sent", "received", "keyAdded", "keyUpdated", "executed"].every(t => w.activity?.some(a => a.type === t)), (w.activity ?? []).map(a => a.type).join(","));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\ndevice queue end-to-end: all checks passed");
process.exit(failures ? 1 : 0);
