// The passkey check behind alerts and drops (lib/alerts.ts `authorize`), with made-up signatures and no app running:
// a signature from another site's page, a passkey made for another site, or one with no Face ID is refused.
// Reads the chains (the wallet must not be deployed), so it needs ALCHEMY_API_KEY.
//   npx tsx --conditions=react-server --env-file=.env.local tools/passkey-site-check.mts
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak256, toBytes, toHex } from "viem";
import { safeAddress, signerAddress } from "../lib/safe/core";
const { authorize } = await import("../lib/alerts");
let bad = 0;
const ok = (c: boolean, m: string) => {
  console.log((c ? "PASS " : "FAIL ") + m);
  if (!c) bad++;
};
const pk = p256.utils.randomSecretKey();
const pub = p256.getPublicKey(pk, false);
const qx = toHex(pub.slice(1, 33)), qy = toHex(pub.slice(33));
const wallet = safeAddress(signerAddress(qx, qy));
const change = '{"op":"email-off"}';
function sign(origin: string, rp: string, flags: number) {
  const ts = Date.now();
  const h = keccak256(toBytes("Instant Wallet alerts\n" + wallet.toLowerCase() + "\n" + change + "\n" + ts));
  const authData = new Uint8Array([...sha256(new TextEncoder().encode(rp)), flags, 0, 0, 0, 0]);
  const fields = '"origin":"' + origin + '","crossOrigin":false';
  const json = '{"type":"webauthn.get","challenge":"' + Buffer.from(toBytes(h)).toString("base64url") + '",' + fields + "}";
  const msg = sha256(new Uint8Array([...authData, ...sha256(new TextEncoder().encode(json))]));
  const sig = p256.sign(msg, pk, { prehash: false, format: "compact" });
  return { qx, qy, authenticatorData: toHex(authData), clientDataFields: fields, r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32)), ts };
}
const H = "instantwallet.io";
let r = await authorize(wallet, change, sign("https://evil.example", H, 5), H);
ok(r === "Wrong site.", "signed on another site's page: " + r);
r = await authorize(wallet, change, sign("https://instantwallet.io", "evil.example", 5), H);
ok(r === "Wrong site.", "a passkey made for another site: " + r);
r = await authorize(wallet, change, sign("https://xdai.io", "xdai.io", 5), H);
ok(r === "Wrong site.", "signed on xdai.io, sent to instantwallet.io: " + r);
r = await authorize(wallet, change, sign("https://instantwallet.io", H, 1), H);
ok(!!r && /didn't check/.test(r), "touch only, no Face ID: " + r);
r = await authorize(wallet, change, sign("https://instantwallet.io", H, 5), "");
ok(r === "Wrong site.", "no Host header: " + r);
r = await authorize(wallet, change, sign("https://xdai.io", "xdai.io", 5), "xdai.io");
ok(r === null, "xdai.io to xdai.io: " + (r ?? "allowed"));
r = await authorize(wallet, change, sign("http://localhost:3100", "localhost", 5), "localhost:3100");
ok(r === null, "localhost with a port: " + (r ?? "allowed"));
const good = sign("https://instantwallet.io", H, 5);
r = await authorize(wallet, change, good, H);
ok(r === null, "the right site, with Face ID: " + (r ?? "allowed"));
r = await authorize(wallet, change, good, H);
ok(r === "Already used. Try again.", "the same signature again: " + r);
process.exit(bad ? 1 : 0);
