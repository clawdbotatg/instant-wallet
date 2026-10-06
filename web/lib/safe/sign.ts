import { type Address, type Hex, bytesToHex } from "viem";
import { assertChallenge } from "../passkey";
import { bytesToBase64url, hexToBytes } from "../webauthn";
import { type Sig, type WebAuthnSig, encodeWebAuthn } from "./core";

/**
 * A passkey signature in the shape Safe's passkey signer checks: it rebuilds clientDataJSON as
 * `{"type":"webauthn.get","challenge":"<b64url(hash)>",` + clientDataFields + `}` and verifies P-256 over
 * sha256(authenticatorData ‖ sha256(clientDataJSON)). So we send everything after the challenge as the fields.
 */
export function toWebAuthnSig(authenticatorData: Uint8Array, clientDataJSON: Uint8Array, r: Hex, s: Hex, challenge: Hex): WebAuthnSig {
  const json = new TextDecoder().decode(clientDataJSON);
  const prefix = `{"type":"webauthn.get","challenge":"${bytesToBase64url(hexToBytes(challenge))}",`;
  if (!json.startsWith(prefix) || !json.endsWith("}")) throw new Error("This browser's passkey format isn't supported yet (clientDataJSON order).");
  return { authenticatorData: bytesToHex(authenticatorData), clientDataFields: json.slice(prefix.length, -1), r: BigInt(r), s: BigInt(s) };
}

/** Face ID over `hash`; returns the Safe contract signature for `signer` (the burner's signer contract). */
export async function passkeySign(credentialId: string, signer: Address, hash: Hex): Promise<Sig> {
  const a = await assertChallenge(credentialId, hash);
  return { signer, data: encodeWebAuthn(toWebAuthnSig(a.authenticatorData, a.clientDataJSON, a.r, a.s, hash)), kind: "contract" };
}

/** The raw WebAuthn signature bytes (for Roles' signed calls, which take the signer's bytes directly). */
export async function passkeySignRaw(credentialId: string, hash: Hex): Promise<Hex> {
  const a = await assertChallenge(credentialId, hash);
  return encodeWebAuthn(toWebAuthnSig(a.authenticatorData, a.clientDataJSON, a.r, a.s, hash));
}
