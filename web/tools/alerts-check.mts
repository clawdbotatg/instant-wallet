// Recovery alerts against a local app on a Base fork: who may change a wallet's contacts, and the watcher seeing a
// recovery start.
//   anvil --fork-url <base rpc> --port 8545 &
//   NEXT_PUBLIC_CHAINS=8453 BASE_RPC_URL=http://127.0.0.1:8545 ALERT_MAIL_USER=x@example.com ALERT_MAIL_PASS=fake npx next dev -p 3100 &
//   npx tsx tools/alerts-check.mts
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { execSync } from "node:child_process";
import { keccak256, toBytes, toHex } from "viem";
import { RECOVERY_7D, DAO } from "../lib/safe/config";
import { deploySafeCall, safeAddress, signerAddress } from "../lib/safe/core";

const APP = process.env.APP || "http://localhost:3100";
const RPC = "http://127.0.0.1:8545";
const cast = (a: string) => execSync(`cast ${a} --rpc-url ${RPC}`, { encoding: "utf8" }).trim();
let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function key() {
  const pk = p256.utils.randomSecretKey();
  const pub = p256.getPublicKey(pk, false);
  const qx = toHex(pub.slice(1, 33)), qy = toHex(pub.slice(33));
  return { pk, qx, qy, wallet: safeAddress(signerAddress(qx, qy)) };
}

// a passkey signature, built the way a browser's WebAuthn assertion is
function sign(k: ReturnType<typeof key>, wallet: string, change: string, ts = Date.now()) {
  const h = keccak256(toBytes(`Instant Wallet alerts\n${wallet.toLowerCase()}\n${change}\n${ts}`));
  const authData = new Uint8Array([...sha256(new TextEncoder().encode("instantwallet.io")), 5, 0, 0, 0, 0]);
  const fields = '"origin":"https://instantwallet.io","crossOrigin":false';
  const json = `{"type":"webauthn.get","challenge":"${b64url(toBytes(h))}",${fields}}`;
  const msg = sha256(new Uint8Array([...authData, ...sha256(new TextEncoder().encode(json))]));
  const sig = p256.sign(msg, k.pk, { prehash: false, format: "compact" });
  return { qx: k.qx, qy: k.qy, authenticatorData: toHex(authData), clientDataFields: fields, r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32)), ts };
}

async function post(wallet: string, change: object, sig: object) {
  const r = await fetch(`${APP}/api/alerts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, change: JSON.stringify(change), sig }) });
  return { status: r.status, j: await r.json() };
}

const me = key();
const other = key();
const ch = { op: "email", email: "owner@example.com" };

let r = await post(me.wallet, ch, sign(other, me.wallet, JSON.stringify(ch)));
ok(r.status === 403, `another passkey can't change this wallet's alerts (${r.j.error})`);
r = await post(me.wallet, ch, sign(me, me.wallet, JSON.stringify({ op: "email-off" })));
ok(r.status === 403, `a signature over a different change is refused (${r.j.error})`);
r = await post(me.wallet, ch, sign(me, me.wallet, JSON.stringify(ch), Date.now() - 10 * 60_000));
ok(r.status === 403, `an old signature is refused (${r.j.error})`);
const good = sign(me, me.wallet, JSON.stringify(ch));
r = await post(me.wallet, ch, good);
ok(r.status === 200 && r.j.contacts.email === "ow…@example.com", `the wallet's own passkey sets the email (${JSON.stringify(r.j.contacts)})`);
ok(r.j.errors.length > 0, "it tried to send the confirmation email (fake Gmail login here)");
r = await post(me.wallet, ch, good);
ok(r.status === 403, `the same signature can't be used twice (${r.j.error})`);
const g = await fetch(`${APP}/api/alerts?wallet=${me.wallet}`).then(x => x.json());
ok(g.contacts.email === "ow…@example.com" && !JSON.stringify(g).includes("owner@"), "GET shows it masked");

// the watcher: deploy the wallet, the DAO starts a recovery, the next run sends once
const d = deploySafeCall(signerAddress(me.qx, me.qy));
cast(`send ${d.to} ${d.data} --unlocked --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`);
cast(`rpc anvil_impersonateAccount ${DAO}`);
cast(`rpc anvil_setBalance ${DAO} 0xde0b6b3a7640000`);
const thief = key();
cast(`send ${RECOVERY_7D} "confirmRecovery(address,address[],uint256,bool)" ${me.wallet} "[${signerAddress(thief.qx, thief.qy)}]" 1 true --unlocked --from ${DAO}`);
await new Promise(res => setTimeout(res, 51_000)); // one run per 50 s
const c1 = await fetch(`${APP}/api/alerts/check`).then(x => x.json());
ok(c1.sent?.some((s: string) => s.startsWith(`8453:${me.wallet.toLowerCase()}:`)), `the watcher sees the recovery and alerts (${JSON.stringify(c1).slice(0, 160)})`);
ok(c1.errors?.length > 0, "it tried the email (fake Gmail login here)");
const c2 = await fetch(`${APP}/api/alerts/check`).then(x => x.json());
ok(!!c2.skipped, "a second hit within 50 s doesn't run again");
await new Promise(res => setTimeout(res, 51_000));
const c3 = await fetch(`${APP}/api/alerts/check`).then(x => x.json());
ok(Array.isArray(c3.sent) && !c3.sent.length, "the next run doesn't send it again");

// taking the email away: refused without the passkey, and the old email is told when it's the owner
r = await post(me.wallet, { op: "email-off" }, sign(me, me.wallet, JSON.stringify({ op: "email-off" })));
ok(r.status === 200 && !r.j.contacts.email, "the owner removes the email");

// once a recovery replaces it, the old passkey has no say (though the address is still its counterfactual one)
cast("rpc evm_increaseTime 604801");
cast("rpc evm_mine");
cast(`send ${RECOVERY_7D} "finalizeRecovery(address)" ${me.wallet} --unlocked --from ${DAO}`);
r = await post(me.wallet, ch, sign(me, me.wallet, JSON.stringify(ch)));
ok(r.status === 403, `a replaced passkey can't change alerts (${r.j.error})`);

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
