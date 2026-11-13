// The relay's defences, against a local dev server on a fork (see safe-e2e.mjs for the setup):
//   a valid first send works; the same signed body again is refused; a call into the wallet itself is refused;
//   a Roles call that could fail silently (shouldRevert = false), a wrong role, or ETH that doesn't add up is refused;
//   a swap batch must pay this wallet and leave no approval behind;
//   audit 11-13: a contract that isn't a Safe gets nothing sent for it; one signed tx goes out once however its
//   signature bytes are padded; a call that only works in the estimate isn't sent; a Roles call for a wallet with no
//   Roles module isn't sent.
//   APP=http://localhost:3100 RPC=http://127.0.0.1:8545 CHAIN=8453 FUNDER_KEY=<anvil #1> npx tsx tools/safe-relay-check.mts
import { createHash } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Hex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";
import { abi, batch, encodeSignatures, encodeWebAuthn, safeAddress, safeTxHash, signerAddress, transfer } from "../lib/safe/core";
import { MULTICALL3, MULTISEND_CALL_ONLY, ROLE_BURNER } from "../lib/safe/config";
import { multiSendData } from "../lib/safe/core";
import { rolesCalls } from "../lib/safe/fee";
import { LIFI_DIAMOND, checkSwap } from "../lib/safe/swap";

const APP = process.env.APP!;
const CHAIN = Number(process.env.CHAIN || 8453);
const chain = CHAIN === 1 ? mainnet : base;
const pc = createPublicClient({ chain, transport: http(process.env.RPC) });
const funder = privateKeyToAccount(process.env.FUNDER_KEY as Hex);
const wc = createWalletClient({ chain, transport: http(process.env.RPC), account: funder });
const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const hex = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as Hex;
let bad = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) bad++;
};
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

// ---- unit: Roles call shapes the relay must refuse
const ms = (calls: any[]) => multiSendData(calls);
const fine = encodeFunctionData({ abi: abi.roles, functionName: "execTransactionWithRole", args: [MULTISEND_CALL_ONLY, 0n, ms([transfer(zeroAddress, funder.address, 1n)]), 1, ROLE_BURNER, true] });
ok(!throws(() => rolesCalls(fine, ROLE_BURNER)), "roles: the app's own shape is accepted");
const silent = encodeFunctionData({ abi: abi.roles, functionName: "execTransactionWithRole", args: [MULTISEND_CALL_ONLY, 0n, ms([transfer(zeroAddress, funder.address, 1n)]), 1, ROLE_BURNER, false] });
ok(throws(() => rolesCalls(silent, ROLE_BURNER)), "roles: shouldRevert = false is refused");
const otherRole = encodeFunctionData({ abi: abi.roles, functionName: "execTransactionWithRole", args: [MULTISEND_CALL_ONLY, 0n, ms([transfer(zeroAddress, funder.address, 1n)]), 1, ("0x" + "11".repeat(32)) as Hex, true] });
ok(throws(() => rolesCalls(otherRole, ROLE_BURNER)), "roles: another role is refused");
const eth = (allowFailure: boolean, value: bigint) =>
  encodeFunctionData({
    abi: abi.roles,
    functionName: "execTransactionWithRole",
    args: [MULTICALL3, value, encodeFunctionData({ abi: abi.multicall3, functionName: "aggregate3Value", args: [[{ target: funder.address, allowFailure, value: 5n, callData: "0x" }]] }), 0, ROLE_BURNER, true],
  });
ok(!throws(() => rolesCalls(eth(false, 5n), ROLE_BURNER)), "roles: an ETH send is accepted");
ok(throws(() => rolesCalls(eth(true, 5n), ROLE_BURNER)), "roles: an ETH send that may fail is refused");
ok(throws(() => rolesCalls(eth(false, 6n), ROLE_BURNER)), "roles: ETH that doesn't add up is refused");

// ---- unit: swap batches
{
  const me = "0x00000000000000000000000000000000000000aa" as const;
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
  const appr = (spender: Hex, n: bigint) => ({ to: usdc, value: 0n, data: encodeFunctionData({ abi: abi.erc20, functionName: "approve", args: [spender, n] }) });
  const pays = (who: string) => ({ to: LIFI_DIAMOND, value: 0n, data: ("0x12345678" + "0".repeat(24) + who.slice(2)) as Hex });
  ok(checkSwap(me, [appr(LIFI_DIAMOND, 5n), pays(me), appr(LIFI_DIAMOND, 0n)]) === true, "swap: approve exact → swap → approve 0 is accepted");
  ok(throws(() => checkSwap(me, [appr(LIFI_DIAMOND, 5n), pays(me)])), "swap: an approval left behind is refused");
  ok(throws(() => checkSwap(me, [appr(LIFI_DIAMOND, 5n), pays(funder.address), appr(LIFI_DIAMOND, 0n)])), "swap: one that pays someone else is refused");
  ok(checkSwap(me, [transfer(zeroAddress, funder.address, 1n)]) === false, "swap: a plain send isn't a swap");
}

// ---- live against the dev server
const pk = p256.utils.randomSecretKey();
const pub = p256.getPublicKey(pk, false);
const x = hex(pub.slice(1, 33)), y = hex(pub.slice(33));
const signer = signerAddress(x, y);
const safe = safeAddress(signer);
const q = await fetch(`${APP}/api/safe/relay?chainId=${CHAIN}&kind=first`).then(r => r.json());
await pc.waitForTransactionReceipt({ hash: await wc.sendTransaction({ to: safe, value: BigInt(q.feeEth) * 40n }) });

function sign(t: ReturnType<typeof batch>) {
  const h = safeTxHash(CHAIN, safe, t);
  const authData = new Uint8Array([...sha(new TextEncoder().encode("instantwallet.io")), 5, 0, 0, 0, 1]);
  const fields = '"origin":"https://instantwallet.io","crossOrigin":false';
  const json = `{"type":"webauthn.get","challenge":"${Buffer.from(h.slice(2), "hex").toString("base64url")}",${fields}}`;
  const sig = p256.sign(sha(new Uint8Array([...authData, ...sha(new TextEncoder().encode(json))])), pk, { prehash: false, format: "compact" });
  return encodeSignatures([{ signer, data: encodeWebAuthn({ authenticatorData: hex(authData), clientDataFields: fields, r: BigInt(hex(sig.slice(0, 32))), s: BigInt(hex(sig.slice(32))) }), kind: "contract" }]);
}
// each case comes from its own address: one case's refused IP must not be what refuses the next
let from = 0;
const post = (body: unknown) =>
  fetch(`${APP}/api/safe/relay`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.0.${from}` },
    body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  }).then(async r => ({ status: r.status, j: await r.json() }));

// a site's call into the wallet itself (setGuard: could brick it): refused before anything is spent. Other arbitrary
// calls are a site's (WalletConnect), owner-signed, and allowed: safe-wc-e2e.mjs sends one
const t0 = batch([{ to: safe, value: 0n, data: ("0xe19a9dd9" + "0".repeat(24) + funder.address.slice(2)) as Hex }, transfer(zeroAddress, q.relayer, BigInt(q.feeEth))], 0n);
const r0 = await post({ chainId: CHAIN, kind: "exec", safe, tx: t0, signatures: sign(t0), burner: { x, y } });
ok(r0.status === 400 && /only sends transfers/.test(r0.j.error), `a call into the wallet itself is refused (${r0.status} ${r0.j.error})`);

// a swap that pays someone else: refused before anything is spent
const tw = batch([{ to: LIFI_DIAMOND, value: 1000n, data: ("0x12345678" + "0".repeat(24) + funder.address.slice(2)) as Hex }, transfer(zeroAddress, q.relayer, BigInt(q.feeEth))], 0n);
const rw = await post({ chainId: CHAIN, kind: "exec", safe, tx: tw, signatures: sign(tw), burner: { x, y } });
ok(rw.status === 400 && /won't send this swap/.test(rw.j.error), `a swap paying someone else is refused (${rw.status} ${rw.j.error})`);

const t = batch([transfer(zeroAddress, funder.address, 1000n), transfer(zeroAddress, q.relayer, BigInt(q.feeEth))], 0n);
const body = { chainId: CHAIN, kind: "exec", safe, tx: t, signatures: sign(t), burner: { x, y } };
// the relayer's gas money: a refused request must leave it exactly as it was
const relayBal = () => pc.getBalance({ address: q.relayer });
const settle = () => new Promise(r => setTimeout(r, 2500)); // a sent tx is mined (anvil: at once) and the relay's own look at it is done
const deploy = async (init: Hex) => (await pc.waitForTransactionReceipt({ hash: await wc.sendTransaction({ data: init }) })).contractAddress!;
const quoteOf = (kind: string) => fetch(`${APP}/api/safe/relay?chainId=${CHAIN}&kind=${kind}`).then(r => r.json());

from++;
// a contract whose every call "succeeds" (fallback returns true) named as the wallet: the relay paid its gas and
// was never paid (audit IW-1)
{
  const yes = await deploy("0x69600160005260206000f3600052600a6016f3");
  const qe = await quoteOf("exec");
  const tf = batch([transfer(zeroAddress, funder.address, 1n), transfer(zeroAddress, q.relayer, BigInt(qe.feeEth))], 0n);
  const was = await relayBal();
  const rf = await post({ chainId: CHAIN, kind: "exec", safe: yes, tx: tf, signatures: "0x" + "00".repeat(65) });
  await settle();
  ok(rf.status === 400 && (await relayBal()) === was, `a contract that isn't a Safe: nothing is sent for it (${rf.status} ${rf.j.error || rf.j.hash})`);
}

from++;
// one signed tx, six requests at once, each with more padding after its signatures (the Safe ignores it): one send
const burst = await Promise.all([0, 1, 2, 3, 4, 5].map(i => post({ ...body, signatures: (body.signatures + "00".repeat(32 * i)) as Hex })));
const went = burst.filter(r => r.status === 200 && r.j.hash);
ok(went.length === 1, `a valid first send is relayed, once, however its signatures are padded (${burst.map(r => r.status).join(" ")})`);
const r1 = went[0] ?? burst[0];
await settle();
from++;
const r2 = await post(body);
ok(r2.status === 409 || /Already sent|would fail/.test(r2.j.error), `the same signed body again is refused (${r2.status} ${r2.j.error})`);

// no fee: refused
const t3 = batch([transfer(zeroAddress, funder.address, 1000n)], 1n);
const r3 = await post({ chainId: CHAIN, kind: "exec", safe, tx: t3, signatures: sign(t3), burner: { x, y } });
ok(r3.status === 402, `a batch without the fee is refused (${r3.status} ${r3.j.error})`);

from++;
// a call that works only while the relay estimates (it reads the tip the estimate used to hard-code) and fails in
// the real tx: the relay paid for the revert (audit IW-9)
{
  const evil = await deploy("0x6b483a03600114600a57fe5b00600052600c6014f3"); // tx.gasprice - block.basefee == 1 ? stop : invalid
  const qd = await quoteOf("dapp");
  const td = batch([{ to: evil, value: 0n, data: "0x12345678" as Hex }, transfer(zeroAddress, q.relayer, BigInt(qd.feeEth))], 1n);
  const was = await relayBal();
  const rd = await post({ chainId: CHAIN, kind: "exec", safe, tx: td, signatures: sign(td) });
  await settle();
  ok(rd.status === 400 && (await relayBal()) === was, `a call that only works in the estimate isn't sent (${rd.status} ${rd.j.error || rd.j.hash})`);
}

from++;
// a Roles spend for a wallet with no Roles module: the call goes to an address with no code, "succeeds", pays nothing (audit IW-2)
{
  const qr = await quoteOf("roles");
  const call = encodeFunctionData({ abi: abi.roles, functionName: "execTransactionWithRole", args: [MULTISEND_CALL_ONLY, 0n, ms([transfer(zeroAddress, funder.address, 1n), transfer(zeroAddress, q.relayer, BigInt(qr.feeEth))]), 1, ROLE_BURNER, true] });
  const was = await relayBal();
  const rr = await post({ chainId: CHAIN, kind: "roles", safe, call, signer: funder.address, signature: "0x" + "11".repeat(65), salt: "0x" + "22".repeat(32) });
  await settle();
  ok(rr.status === 400 && (await relayBal()) === was, `a Roles call for a wallet with no Roles module isn't sent (${rr.status} ${rr.j.error || rr.j.hash})`);
}
process.exit(bad ? 1 : 0);
