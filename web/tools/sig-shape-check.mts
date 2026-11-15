// A passkey signature can't be used twice by cutting it differently (audit 11-13, IW-16). The server joined r and s
// and remembered "used" by r: the same 64 bytes with r one byte shorter and s one longer verified again under a new
// key. Now r, s, qx, qy must each be exactly 32 bytes. Seconds, no network.
//   npx tsx tools/sig-shape-check.mts
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, toHex } from "viem";
import { keyAndSig, word32 } from "../lib/sigShape";

let bad = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) bad++;
};
const pk = p256.utils.randomSecretKey(); // made here, used once
const pub = p256.getPublicKey(pk, false);
const msg = sha256(new TextEncoder().encode("hi"));
const sig = p256.sign(msg, pk, { prehash: false, format: "compact" });
const real = { qx: toHex(pub.slice(1, 33)), qy: toHex(pub.slice(33)), r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32)) };
const cut = { ...real, r: toHex(sig.slice(0, 31)), s: toHex(sig.slice(31)) };
// the old way of checking: glue r and s
const glued = (o: typeof real) => p256.verify(new Uint8Array([...hexToBytes(o.r as `0x${string}`), ...hexToBytes(o.s as `0x${string}`)]), msg, pub, { prehash: false, lowS: false });
ok(glued(real) && glued(cut) && cut.r !== real.r, "(the test's own check) the same signature cut at byte 31 still verifies when glued, under another r");
ok(keyAndSig(real), "a real key and signature pass");
ok(!keyAndSig(cut), "the same signature cut at another place is refused");
ok(!keyAndSig({ ...real, r: real.r + "00" }) && !keyAndSig({ ...real, s: "0x" }) && !keyAndSig({ ...real, qx: real.qx.slice(0, -2) }), "longer, empty or shorter words are refused");
ok(!keyAndSig({ ...real, r: 5 as any }) && !keyAndSig(null) && !word32("0x" + "zz".repeat(32)), "not hex, not text, nothing: refused");
for (const f of ["lib/alerts.ts", "lib/passkeyAuth.ts"]) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  ok(src.includes("keyAndSig(") && src.indexOf("keyAndSig(") < src.indexOf("p256.verify"), `${f}: the shape is checked before the signature is`);
}
if (bad) {
  console.error(`${bad} failed`);
  process.exit(1);
}
console.log("ok");
