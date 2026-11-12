import "server-only";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type Address, type Hex, createPublicClient, getAddress, http, isAddress, isHex } from "viem";
import { base } from "viem/chains";
import { mustRpc } from "./rpcServer";
import { abi, safeAddress, signerAddress } from "./safe/core";
import { once } from "./safe/relayGuard";
import { P256_N, base64urlToBytes, hexToBytes } from "./webauthn";

const MAX_AGE_S = 120;

/**
 * "This request came from that wallet's own passkey": a Face ID signature (body: address, ts, qx, qy, r, s,
 * authenticatorData, clientDataJSON) over the challenge the route expects, made on this site in the last two
 * minutes, used once, from a passkey whose Safe signer owns `address` on Base (or, for a Safe not deployed yet,
 * whose counterfactual Safe IS `address`). `want` builds the challenge from the address and time in the body.
 * `use` keeps one route's signatures apart from another's.
 */
export async function passkeyOwner(req: Request, b: any, use: string, want: (address: Address, ts: number) => Hex): Promise<{ address: Address } | { error: string; status: number }> {
  const bad = (error: string, status = 400) => ({ error, status });
  const ts = Number(b?.ts);
  if (!b || ![b.qx, b.qy, b.r, b.s, b.authenticatorData].every(v => isHex(v)) || typeof b.clientDataJSON !== "string") return bad("Passkey signature required", 401);
  if (!isAddress(b.address || "")) return bad("address?");
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_AGE_S) return bad("Signature expired. Try again.");
  const address = getAddress(b.address);

  // the passkey signed this exact request, on this site
  const host = req.headers.get("host") || "";
  let cd: any;
  try {
    cd = JSON.parse(b.clientDataJSON);
    if (cd.type !== "webauthn.get" || new URL(cd.origin).host !== host) return bad("Wrong site");
  } catch {
    return bad("signature?");
  }
  if (typeof cd.challenge !== "string" || bytesHex(base64urlToBytes(cd.challenge)) !== want(address, ts).toLowerCase()) return bad("Signature is for a different request");
  const authData = hexToBytes(b.authenticatorData);
  if (bytesHex(authData.slice(0, 32)) !== bytesHex(sha256(new TextEncoder().encode(host.split(":")[0])))) return bad("Wrong site");
  if (!(authData[32] & 0x04)) return bad("Face ID required");
  const msg = sha256(concatBytes(authData, sha256(new TextEncoder().encode(b.clientDataJSON))));
  if (!verifyP256(b.qx, b.qy, b.r, b.s, msg)) return bad("Bad signature");
  // one use per signature: r is fresh for every signature (s alone can be flipped)
  try {
    if (!(await once(`${use}:${b.r.toLowerCase()}`, MAX_AGE_S * 2))) return bad("Signature already used", 409);
  } catch {
    return bad("Try again", 503);
  }

  // ...and that passkey is this wallet's owner
  const signer = signerAddress(b.qx, b.qy);
  try {
    const client = createPublicClient({ chain: base, transport: http(mustRpc(8453)) });
    const code = await client.getCode({ address });
    const owns =
      code && code !== "0x"
        ? (await client.readContract({ address, abi: abi.safe, functionName: "getOwners" })).some(o => o.toLowerCase() === signer.toLowerCase())
        : safeAddress(signer) === address;
    if (!owns) return bad("This passkey isn't an owner of that wallet", 403);
  } catch {
    return bad("Couldn't check the wallet. Try again.", 502);
  }
  return { address };
}

const bytesHex = (u: Uint8Array) => "0x" + Buffer.from(u).toString("hex");

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** P-256 over msg (already hashed), either s (WebAuthn doesn't promise low-s). */
function verifyP256(qx: Hex, qy: Hex, r: Hex, s: Hex, msg: Uint8Array): boolean {
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(hexToBytes(qx), 1);
  pub.set(hexToBytes(qy), 33);
  for (const sB of [BigInt(s), P256_N - BigInt(s)]) {
    const sig = new Uint8Array(64);
    sig.set(hexToBytes(r), 0);
    sig.set(hexToBytes(`0x${sB.toString(16).padStart(64, "0")}`), 32);
    try {
      if (p256.verify(sig, msg, pub, { prehash: false, lowS: false })) return true;
    } catch {}
  }
  return false;
}
