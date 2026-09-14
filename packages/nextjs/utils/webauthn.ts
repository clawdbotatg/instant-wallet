import { type Hex, encodeAbiParameters } from "viem";

/**
 * WebAuthn signature encoding for InstantWallet (docs/PROTOCOL.md section 2).
 *
 * The contract's `_verify` calls OpenZeppelin `WebAuthn.tryDecodeAuth(signature)`, which reads a
 * FLAT tuple `abi.encode(bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex,
 * bytes authenticatorData, string clientDataJSON)` — the same bytes the Foundry test builds with
 * `abi.encode(r, s, uint256(23), uint256(1), authData, clientDataJSON)`. `encodeAbiParameters`
 * with these six parameter types produces exactly that layout (no leading struct offset).
 *
 * Pure viem, no aliases: scripts/check-digests.mjs imports this file and proves the bytes verify
 * on chain through `isValidSignature`.
 */

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export type WebAuthnAuth = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};

export function toLowS(s: bigint): bigint {
  return s > P256_N / 2n ? P256_N - s : s;
}

export function bigintToHex32(v: bigint): Hex {
  return `0x${v.toString(16).padStart(64, "0")}`;
}

export function encodeWebAuthnSignature(auth: WebAuthnAuth): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "string" },
    ],
    [
      auth.r,
      bigintToHex32(toLowS(BigInt(auth.s))),
      auth.challengeIndex,
      auth.typeIndex,
      auth.authenticatorData,
      auth.clientDataJSON,
    ],
  );
}

/** Raw (device) signature: exactly 64 bytes r || s, low-s. */
export function encodeRawSignature(r: Hex, s: Hex): Hex {
  return `0x${r.slice(2).padStart(64, "0")}${bigintToHex32(toLowS(BigInt(s))).slice(2)}`;
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4);
  const binary = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let s = "0x";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s as Hex;
}

/** DER ECDSA signature -> (r, s) as 32-byte hex. */
export function parseDerSignature(sig: Uint8Array): { r: Hex; s: Hex } {
  let o = 0;
  if (sig[o++] !== 0x30) throw new Error("bad DER: no sequence");
  o++; // sequence length
  if (sig[o++] !== 0x02) throw new Error("bad DER: no r");
  const rLen = sig[o++];
  let r: Uint8Array = sig.slice(o, o + rLen);
  o += rLen;
  if (sig[o++] !== 0x02) throw new Error("bad DER: no s");
  const sLen = sig[o++];
  let s: Uint8Array = sig.slice(o, o + sLen);
  const norm = (v: Uint8Array): Uint8Array => {
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length < 32) {
      const p = new Uint8Array(32);
      p.set(v, 32 - v.length);
      v = p;
    }
    return v;
  };
  r = norm(r);
  s = norm(s);
  return { r: bytesToHex(r), s: bytesToHex(s) };
}

/**
 * Build the WebAuthnAuth struct from an assertion. `challengeIndex`/`typeIndex` are the positions
 * of `"challenge"` and `"type"` in clientDataJSON, which is what OZ's verifier slices at.
 */
export function buildWebAuthnAuth(authenticatorData: Uint8Array, clientDataJSON: string, r: Hex, s: Hex): WebAuthnAuth {
  const challengeIndex = clientDataJSON.indexOf('"challenge"');
  const typeIndex = clientDataJSON.indexOf('"type"');
  if (challengeIndex < 0 || typeIndex < 0) throw new Error("clientDataJSON is missing challenge/type");
  return {
    r,
    s: bigintToHex32(toLowS(BigInt(s))),
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
    authenticatorData: bytesToHex(authenticatorData),
    clientDataJSON,
  };
}

/**
 * Synthesize a WebAuthn assertion for a software key (tests only): the same shape the Foundry test
 * `webauthnSigFlags` builds — authData = rpIdHash(32 zero bytes) ‖ flags ‖ counter(4 zero bytes),
 * clientDataJSON with the base64url digest as challenge. Returns what must be signed
 * (`sha256(authData ‖ sha256(clientDataJSON))`) and the pieces.
 */
export function syntheticAssertion(digest: Hex, flags = 0x05, origin = "https://instant.wallet") {
  const authData = new Uint8Array(37);
  authData[32] = flags;
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${bytesToBase64url(hexToBytes(digest))}","origin":"${origin}"}`;
  return { authData, clientDataJSON };
}
