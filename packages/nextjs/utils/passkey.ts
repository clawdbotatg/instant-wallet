import { p256 } from "@noble/curves/nist.js";
import { type Address, type Hex, keccak256 } from "viem";
import { signerIdOf } from "~~/utils/digests";
import {
  P256_N,
  type WebAuthnAuth,
  base64urlToBytes,
  buildWebAuthnAuth,
  bytesToBase64url,
  bytesToHex,
  encodeWebAuthnSignature,
  hexToBytes,
  parseDerSignature,
} from "~~/utils/webauthn";
import { type AssertionResult, isWebAuthnAvailable, webauthnCreate, webauthnGet } from "~~/utils/webauthnBridge";

/**
 * Passkey layer (browser only).
 *
 *  - createPasskey(): a new platform credential (Face ID / Touch ID / Windows Hello), ES256.
 *  - loginWithPasskey(): recover (qx, qy) from two assertions — WebAuthn never returns the public
 *    key after creation, but an ECDSA signature yields <= 4 candidate keys and a second signature
 *    picks the one that verifies both (docs/PasskeyDerivation.md).
 *  - signDigest(): sign a 32-byte digest; the WebAuthn challenge IS the raw digest bytes, and the
 *    result is the flat-tuple encoding the contract's `_verify` decodes.
 *
 * All three WebAuthn calls go through utils/webauthnBridge.ts: `navigator.credentials` in a browser,
 * the `window.InstantNativePasskey` plugin inside a Capacitor shell (contract documented there).
 */

export const RP_NAME = "Instant Wallet";

export type Passkey = {
  credentialId: string; // base64url
  qx: Hex;
  qy: Hex;
  signerId: Address;
};

export function isWebAuthnSupported(): boolean {
  return isWebAuthnAvailable();
}

function rpId(): string {
  return window.location.hostname;
}

function randomChallenge(): Uint8Array {
  const c = new Uint8Array(32);
  crypto.getRandomValues(c);
  return c;
}

export function credentialIdHash(credentialId: string): Hex {
  return keccak256(bytesToHex(base64urlToBytes(credentialId)));
}

export async function createPasskey(label = "Instant Wallet"): Promise<Passkey> {
  const created = await webauthnCreate({
    challenge: randomChallenge(),
    rp: { name: RP_NAME, id: rpId() },
    user: {
      id: crypto.getRandomValues(new Uint8Array(16)),
      name: `${label} · ${new Date().toISOString().slice(0, 10)}`,
      displayName: label,
    },
    timeout: 60_000,
  });
  let qx: Hex;
  let qy: Hex;
  if (created.publicKeySpki) {
    const key = await crypto.subtle.importKey(
      "spki",
      created.publicKeySpki,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (!jwk.x || !jwk.y) throw new Error("Could not extract P-256 coordinates");
    qx = bytesToHex(base64urlToBytes(jwk.x));
    qy = bytesToHex(base64urlToBytes(jwk.y));
  } else if (created.attestationObject) {
    ({ qx, qy } = coseKeyFromAttestation(created.attestationObject));
  } else {
    throw new Error("Authenticator did not return a public key");
  }
  return { credentialId: bytesToBase64url(created.rawId), qx, qy, signerId: signerIdOf(qx, qy) };
}

/**
 * Pull the ES256 public key out of a CBOR attestation object (native bridges that only return
 * `attestationObject`). Minimal CBOR walk: map -> "authData" bytes -> credential public key (COSE),
 * where the x/y coordinates are the -2 / -3 entries, 32 bytes each.
 */
function coseKeyFromAttestation(att: Uint8Array): { qx: Hex; qy: Hex } {
  let o = 0;
  const u8 = () => att[o++];
  const len = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return u8();
    if (info === 25) return (u8() << 8) | u8();
    if (info === 26) return ((u8() << 24) | (u8() << 16) | (u8() << 8) | u8()) >>> 0;
    throw new Error("CBOR: unsupported length");
  };
  const skip = (): void => {
    const b = u8();
    const major = b >> 5;
    const info = b & 31;
    if (major === 0 || major === 1) {
      len(info);
      return;
    }
    if (major === 2 || major === 3) {
      o += len(info);
      return;
    }
    if (major === 4) {
      const n = len(info);
      for (let i = 0; i < n; i++) skip();
      return;
    }
    if (major === 5) {
      const n = len(info);
      for (let i = 0; i < n; i++) {
        skip();
        skip();
      }
      return;
    }
    if (major === 7) {
      if (info >= 25) o += info === 25 ? 2 : info === 26 ? 4 : 8;
      return;
    }
    throw new Error("CBOR: unsupported major type");
  };
  const readText = (): string => {
    const b = u8();
    if (b >> 5 !== 3) throw new Error("CBOR: expected text");
    const n = len(b & 31);
    const t = new TextDecoder().decode(att.slice(o, o + n));
    o += n;
    return t;
  };
  const head = u8();
  if (head >> 5 !== 5) throw new Error("CBOR: attestation is not a map");
  const entries = len(head & 31);
  let authData: Uint8Array | undefined;
  for (let i = 0; i < entries; i++) {
    const key = readText();
    if (key === "authData") {
      const b = u8();
      if (b >> 5 !== 2) throw new Error("CBOR: authData is not bytes");
      const n = len(b & 31);
      authData = att.slice(o, o + n);
      o += n;
    } else skip();
  }
  if (!authData) throw new Error("attestation has no authData");
  // authData: rpIdHash(32) flags(1) counter(4) [aaguid(16) credIdLen(2) credId credentialPublicKey(COSE)]
  const credIdLen = (authData[53] << 8) | authData[54];
  const cose = authData.slice(55 + credIdLen);
  // Search the COSE map for the -2 (x) and -3 (y) byte strings (each 0x58 0x20 + 32 bytes).
  const find = (label: number): Uint8Array => {
    for (let i = 0; i < cose.length - 34; i++) {
      if (cose[i] === label && cose[i + 1] === 0x58 && cose[i + 2] === 0x20) return cose.slice(i + 3, i + 35);
    }
    throw new Error("COSE key: coordinate not found");
  };
  return { qx: bytesToHex(find(0x21)), qy: bytesToHex(find(0x22)) }; // -2 -> 0x21, -3 -> 0x22
}

async function webauthnMessage(authData: Uint8Array, clientDataJSON: Uint8Array): Promise<Uint8Array> {
  const cdh = await crypto.subtle.digest("SHA-256", clientDataJSON as BufferSource);
  const combined = new Uint8Array(authData.byteLength + cdh.byteLength);
  combined.set(authData, 0);
  combined.set(new Uint8Array(cdh), authData.byteLength);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
}

function recoverCandidates(r: Hex, s: Hex, msg: Uint8Array): { qx: Hex; qy: Hex }[] {
  const out: { qx: Hex; qy: Hex }[] = [];
  const rB = BigInt(r);
  for (const sB of [BigInt(s), P256_N - BigInt(s)]) {
    for (const recovery of [0, 1]) {
      try {
        const sig = new p256.Signature(rB, sB, recovery);
        const hex = sig.recoverPublicKey(msg).toHex(false);
        out.push({ qx: `0x${hex.slice(2, 66)}`, qy: `0x${hex.slice(66)}` });
      } catch {
        // not a valid recovery id for this r
      }
    }
  }
  return out;
}

export function verifyP256(qx: Hex, qy: Hex, r: Hex, s: Hex, msg: Uint8Array): boolean {
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
    } catch {
      // fallthrough
    }
  }
  return false;
}

async function getAssertion(challenge: Uint8Array, allow?: Uint8Array): Promise<AssertionResult> {
  return webauthnGet({ challenge, rpId: rpId(), allow, timeout: 60_000 });
}

/**
 * Sign in with an existing passkey. `known` lets a single assertion suffice when one of the
 * candidate keys is already known (e.g. an account list in localStorage); otherwise a second
 * assertion disambiguates.
 */
export async function loginWithPasskey(known?: (signerId: Address) => boolean | Promise<boolean>): Promise<Passkey> {
  const r1 = await getAssertion(randomChallenge());
  const credentialId = bytesToBase64url(r1.rawId);
  const sig1 = parseDerSignature(r1.signature);
  const m1 = await webauthnMessage(r1.authenticatorData, r1.clientDataJSON);
  const candidates = recoverCandidates(sig1.r, sig1.s, m1).filter(c => verifyP256(c.qx, c.qy, sig1.r, sig1.s, m1));
  if (!candidates.length) throw new Error("Could not recover a public key from the assertion");

  if (known) {
    for (const c of candidates) {
      const id = signerIdOf(c.qx, c.qy);
      if (await known(id)) return { credentialId, qx: c.qx, qy: c.qy, signerId: id };
    }
  }
  if (candidates.length === 1) {
    const c = candidates[0];
    return { credentialId, qx: c.qx, qy: c.qy, signerId: signerIdOf(c.qx, c.qy) };
  }

  const r2 = await getAssertion(randomChallenge(), r1.rawId);
  const sig2 = parseDerSignature(r2.signature);
  const m2 = await webauthnMessage(r2.authenticatorData, r2.clientDataJSON);
  for (const c of candidates) {
    if (verifyP256(c.qx, c.qy, sig2.r, sig2.s, m2)) {
      return { credentialId, qx: c.qx, qy: c.qy, signerId: signerIdOf(c.qx, c.qy) };
    }
  }
  throw new Error("The two assertions came from different keys");
}

/** Sign a 32-byte digest. The WebAuthn challenge is the raw digest bytes (base64url'd by the browser). */
export async function signDigest(credentialId: string, digest: Hex): Promise<{ auth: WebAuthnAuth; signature: Hex }> {
  const challenge = hexToBytes(digest);
  if (challenge.length !== 32) throw new Error("digest must be 32 bytes");
  const res = await getAssertion(challenge, base64urlToBytes(credentialId));
  const { r, s } = parseDerSignature(res.signature);
  const clientDataJSON = new TextDecoder().decode(res.clientDataJSON);
  const auth = buildWebAuthnAuth(res.authenticatorData, clientDataJSON, r, s);
  return { auth, signature: encodeWebAuthnSignature(auth) };
}
