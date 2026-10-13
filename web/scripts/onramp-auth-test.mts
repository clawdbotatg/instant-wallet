/**
 * Proves /api/onramp only hands out a Coinbase link to the wallet's own passkey.
 * A software P-256 key stands in for Face ID (the server checks the signature, not the device).
 *   npx tsx scripts/onramp-auth-test.mts [https://instantwallet.io]
 */
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type Address, toHex } from "viem";
import { DAO } from "../lib/safe/config";
import { safeAddress, signerAddress } from "../lib/safe/core";
import { onrampChallenge } from "../lib/onramp";

const BASE = process.argv[2] || "https://instantwallet.io";
const host = new URL(BASE).host;
const b64url = (u: Uint8Array) => Buffer.from(u).toString("base64url");

const sk = p256.utils.randomSecretKey();
const pub = p256.getPublicKey(sk, false);
const qx = toHex(pub.slice(1, 33));
const qy = toHex(pub.slice(33, 65));
const wallet = safeAddress(signerAddress(qx, qy));

/** A WebAuthn assertion, the way the browser builds one. */
function sign(address: Address, ts: number, origin = BASE) {
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: b64url(Buffer.from(onrampChallenge(address, "USDC", ts).slice(2), "hex")), origin });
  const authData = new Uint8Array([...sha256(new TextEncoder().encode(new URL(origin).hostname)), 0x05, 0, 0, 0, 1]); // UP + UV
  const msg = sha256(new Uint8Array([...authData, ...sha256(new TextEncoder().encode(clientDataJSON))]));
  const sig = p256.sign(msg, sk, { prehash: false, format: "compact" } as any) as Uint8Array;
  return { address, asset: "USDC", ts, qx, qy, r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32)), authenticatorData: toHex(authData), clientDataJSON };
}

async function post(body: unknown) {
  const r = await fetch(`${BASE}/api/onramp`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const now = () => Math.floor(Date.now() / 1000);
const good = sign(wallet, now());
const forged = sign(wallet, now());
const cases: [string, unknown, number][] = [
  ["no auth (address only)", { address: wallet, asset: "USDC" }, 401],
  ["invalid signature", { ...forged, s: toHex(BigInt(forged.s) ^ 1n, { size: 32 }) }, 400],
  ["expired (signed 5 min ago)", sign(wallet, now() - 300), 400],
  ["signed for another site", sign(wallet, now(), "https://evil.example"), 400],
  ["signature moved to another address", { ...sign(wallet, now()), address: DAO }, 400],
  ["key isn't an owner of that wallet", sign(DAO, now()), 403],
  ["valid", good, 200],
  ["replay of the valid request", good, 409],
];

console.log(`endpoint ${BASE}/api/onramp\ntest wallet ${wallet} (owner: a fresh P-256 key)\nother wallet ${DAO}\n`);
let fail = 0;
for (const [name, body, want] of cases) {
  const { status, body: res } = await post(body);
  const ok = status === want;
  if (!ok) fail++;
  const shown = res?.url ? { url: res.url.replace(/sessionToken=[^&]+/, "sessionToken=<redacted>") } : res;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${status} (want ${want}) ${JSON.stringify(shown)}`);
}
process.exit(fail ? 1 : 0);
