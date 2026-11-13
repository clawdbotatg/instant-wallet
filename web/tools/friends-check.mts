// Invited signers (app/api/safe/signers): only a wallet's own passkey may say "this signer is a person, not a wedgie".
// A software P-256 key stands in for Face ID (the server checks the signature, not the device).
//   RELAY_KV_URL= RELAY_KV_TOKEN= npx next dev -p 3111 &     (an empty store in memory, not the live one)
//   npx tsx tools/friends-check.mts [http://localhost:3111]
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type Address, toHex } from "viem";
import { friendChallenge, safeAddress, signerAddress } from "../lib/safe/core";

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
  return { sk, qx, qy, signer: signerAddress(qx, qy), wallet: safeAddress(signerAddress(qx, qy)) };
}
type Key = ReturnType<typeof key>;

/** "This key is a person", signed the way the browser's WebAuthn assertion is. `signed`: what the passkey saw, when it isn't what is sent. */
function say(k: Key, f: Key, name: string, o: { address?: Address; ts?: number; signed?: { signer?: Address; name?: string } } = {}) {
  const address = o.address ?? k.wallet, ts = o.ts ?? Math.floor(Date.now() / 1000);
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: b64url(Buffer.from(friendChallenge(address, o.signed?.signer ?? f.signer, o.signed?.name ?? name, ts).slice(2), "hex")), origin: APP });
  const authData = new Uint8Array([...sha256(new TextEncoder().encode(new URL(APP).hostname)), 0x05, 0, 0, 0, 1]); // UP + UV
  const msg = sha256(new Uint8Array([...authData, ...sha256(new TextEncoder().encode(clientDataJSON))]));
  const sig = p256.sign(msg, k.sk, { prehash: false, format: "compact" } as any) as Uint8Array;
  return { address, x: f.qx, y: f.qy, name, ts, qx: k.qx, qy: k.qy, r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32)), authenticatorData: toHex(authData), clientDataJSON };
}
async function post(body: unknown) {
  const r = await fetch(`${APP}/api/safe/signers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => null) };
}
const list = async (safe: string) => ((await fetch(`${APP}/api/safe/signers?safe=${safe}`).then(r => r.json())).friends ?? []) as { x: string; y: string; name?: string }[];

const me = key(), friend = key(), stranger = key(), wedgie = key();
console.log(`app ${APP}\nwallet ${me.wallet}\n`);

ok((await list(me.wallet)).length === 0, "a wallet starts with no invited signers");

// a stranger can't name a wallet's wedgie a "friend" (it would stop that wallet asking its wedgie)
let r = await post(say(stranger, wedgie, "x", { address: me.wallet }));
ok(r.status === 403, `a passkey that doesn't own the wallet is refused (${r.status} ${r.j?.error})`);
r = await post({ ...say(me, friend, "Al"), x: wedgie.qx, y: wedgie.qy });
ok(r.status === 400 && /different request/.test(r.j?.error ?? ""), `a signature for one key can't name another (${r.status})`);
r = await post({ ...say(me, friend, "Al"), name: "Mallory" });
ok(r.status === 400, `nor carry another name (${r.status})`);
r = await post(say(me, friend, "Al", { ts: Math.floor(Date.now() / 1000) - 600 }));
ok(r.status === 400 && /expired/i.test(r.j?.error ?? ""), `an old signature is refused (${r.status})`);
r = await post({ address: me.wallet, x: friend.qx, y: friend.qy });
ok(r.status === 401, `no signature, no entry (${r.status})`);
ok((await list(me.wallet)).length === 0, "none of those wrote anything");

// the owner says it
const good = say(me, friend, "Al");
r = await post(good);
ok(r.status === 200 && r.j?.ok, `the wallet's own passkey names its invited signer (${r.status} ${r.j?.error ?? ""})`);
let l = await list(me.wallet);
ok(l.length === 1 && l[0].x === friend.qx && l[0].y === friend.qy && l[0].name === "Al", "another device reads the key and the name");
ok(signerAddress(l[0].x as any, l[0].y as any) === friend.signer, "and works the signer out from the key itself");
r = await post(good);
ok(r.status === 409, `the same signature can't be sent twice (${r.status})`);
r = await post(say(me, friend, "Alice"));
l = await list(me.wallet);
ok(r.status === 200 && l.length === 1 && l[0].name === "Alice", "naming them again changes the name, no second row");
ok((await list(stranger.wallet)).length === 0, "another wallet's list is its own");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
