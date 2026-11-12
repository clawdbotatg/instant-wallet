// Public names (alice.inst.eth): who may take one, that it's first come, that a rename keeps the old one.
// A software P-256 key stands in for Face ID (the server checks the signature, not the device).
//   RELAY_KV_URL= RELAY_KV_TOKEN= npx next dev -p 3111 &     (an empty store in memory, not the live one)
//   npx tsx tools/names-check.mts [http://localhost:3111]
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type Address, toHex } from "viem";
import { MAX_NAMES, nameChallenge } from "../lib/names";
import { safeAddress, signerAddress } from "../lib/safe/core";

const APP = process.argv[2] || "http://localhost:3111";
const b64url = (u: Uint8Array) => Buffer.from(u).toString("base64url");
let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};

function key() {
  const sk = p256.utils.randomSecretKey();
  const pub = p256.getPublicKey(sk, false);
  const qx = toHex(pub.slice(1, 33)), qy = toHex(pub.slice(33, 65));
  return { sk, qx, qy, wallet: safeAddress(signerAddress(qx, qy)) };
}
type Key = ReturnType<typeof key>;

/** A claim, signed the way the browser's WebAuthn assertion is. `signed`: the label the passkey saw, when it isn't the one sent. */
function claim(k: Key, label: string, o: { address?: Address; ts?: number; origin?: string; signed?: string } = {}) {
  const address = o.address ?? k.wallet, ts = o.ts ?? Math.floor(Date.now() / 1000), origin = o.origin ?? APP;
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: b64url(Buffer.from(nameChallenge(address, o.signed ?? label, ts).slice(2), "hex")), origin });
  const authData = new Uint8Array([...sha256(new TextEncoder().encode(new URL(origin).hostname)), 0x05, 0, 0, 0, 1]); // UP + UV
  const msg = sha256(new Uint8Array([...authData, ...sha256(new TextEncoder().encode(clientDataJSON))]));
  const sig = p256.sign(msg, k.sk, { prehash: false, format: "compact" } as any) as Uint8Array;
  return { label, address, ts, qx: k.qx, qy: k.qy, r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32)), authenticatorData: toHex(authData), clientDataJSON };
}
async function post(body: unknown) {
  const r = await fetch(`${APP}/api/names`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => null) };
}
const get = (path: string) => fetch(`${APP}${path}`).then(r => r.json());

const tag = Math.random().toString(36).slice(2, 8);
const me = key(), other = key();
const first = `alice-${tag}`, second = `bob-${tag}`;
console.log(`app ${APP}\nwallet ${me.wallet}\nnames ${first}, ${second}\n`);

let j = await get(`/api/names?name=${first}`);
ok(j.free === true && j.name === `${first}.inst.eth`, `a new name is free`);
j = await get(`/api/names?name=Alice ${tag}.inst.eth`);
ok(j.label === first, `"Alice ${tag}.inst.eth" is read as ${first}`);
for (const [bad, why] of [["ab", "too short"], ["support", "ours"], ["official-alice", "leans on 'official'"], ["0xabc123", "looks like an address"], ["-abc", "dash at the end"], ["a--b", "doubled dash"],
  ["supp0rt", "a number for a letter"], ["adm1n", "1 for i"], ["c0inbase", "0 for o"], ["instant-wa11et", "1 for l"], ["coinbase-pay", "a company plus a word"], ["metamask-team", "a wallet plus a word"], ["help-desk", "a dash inside"], ["vitalik-eth", "reads as vitalik.eth"], ["alice-3th", "reads as alice.eth"]])
  ok((await get(`/api/names?name=${bad}`)).free === false, `${bad} can't be taken (${why})`);
for (const fine of ["seth", "basement", "solo-trip", "ethan", "pineapple", "method", "l33t-coder", "my-wallet"])
  ok((await get(`/api/names?name=${fine}-${tag}`)).free === true && (await get(`/api/names?name=${fine}`)).problem !== "Can't end in -eth", `${fine} is an ordinary name`);

let r = await post({ label: first, address: me.wallet });
ok(r.status === 401, `no signature: ${r.status} (want 401)`);
r = await post(claim(me, first, { signed: second }));
ok(r.status === 400, `signed for another name: ${r.status} (want 400)`);
r = await post(claim(me, first, { ts: Math.floor(Date.now() / 1000) - 300 }));
ok(r.status === 400, `signed 5 minutes ago: ${r.status} (want 400)`);
r = await post(claim(me, first, { origin: "https://evil.example" }));
ok(r.status === 400, `signed on another site: ${r.status} (want 400)`);
r = await post(claim(other, first, { address: me.wallet }));
ok(r.status === 403, `another passkey claims for this wallet: ${r.status} (want 403)`);
r = await post(claim(me, "support"));
ok(r.status === 400, `a held-back name, signed right: ${r.status} (want 400)`);
r = await post(claim(me, "Alice"));
ok(r.status === 400, `a label that isn't tidy, signed right: ${r.status} (want 400)`);
ok((await get(`/api/names?name=${first}`)).free === true, `none of those took the name`);

const good = claim(me, first);
r = await post(good);
ok(r.status === 200 && r.j?.name === `${first}.inst.eth`, `the wallet's own passkey takes it: ${r.status} ${JSON.stringify(r.j)}`);
r = await post(good);
ok(r.status === 409, `the same signature again: ${r.status} (want 409)`);
r = await post(claim(other, first));
ok(r.status === 409 && r.j?.error === "Taken", `another wallet wants it: ${r.status} ${r.j?.error}`);
j = await get(`/api/names?name=${first}&address=${me.wallet}`);
ok(j.free === false && j.yours === true, `it's taken, and it's yours`);
j = await get(`/api/names?name=${first}&address=${other.wallet}`);
ok(j.free === false && j.yours === false && j.problem === "Taken", `to anyone else it says Taken`);
j = await get(`/api/ens?name=${first}.inst.eth`);
ok(j.address?.toLowerCase() === me.wallet.toLowerCase(), `the name looks up to the wallet`);
j = await get(`/api/ens?address=${me.wallet}&fresh=${Date.now()}`);
ok(j.name === `${first}.inst.eth`, `the wallet looks up to the name: ${j.name}`);
j = await get(`/api/ens?name=sub.${first}.inst.eth`);
ok(!j.address, `a name under it is nobody's`);

r = await post(claim(me, second));
ok(r.status === 200 && r.j?.name === `${second}.inst.eth` && r.j?.names?.length === 2, `a rename: ${r.status} ${JSON.stringify(r.j)}`);
j = await get(`/api/ens?name=${first}.inst.eth`);
ok(j.address?.toLowerCase() === me.wallet.toLowerCase(), `the old name still pays the wallet`);
r = await post(claim(other, first));
ok(r.status === 409, `and nobody else can take the old name: ${r.status}`);
j = await get(`/api/names?address=${me.wallet}`);
ok(j.name === `${second}.inst.eth`, `the wallet shows the new name`);
r = await post(claim(me, first));
ok(r.status === 200 && r.j?.name === `${first}.inst.eth` && r.j?.names?.length === 2, `back to the old name: ${r.status} ${JSON.stringify(r.j)}`);

for (let i = 2; i < MAX_NAMES; i++) r = await post(claim(me, `n${i}-${tag}`));
ok(r.status === 200 && r.j?.names?.length === MAX_NAMES, `${MAX_NAMES} names: ${r.status}`);
r = await post(claim(me, `one-more-${tag}`));
ok(r.status === 409, `one more than ${MAX_NAMES}: ${r.status} (want 409)`);
ok((await get(`/api/names?name=one-more-${tag}`)).free === true, `and that name stays free`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
