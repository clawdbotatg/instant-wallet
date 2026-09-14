import { base64urlToBytes, bytesToBase64url } from "./webauthn";

/**
 * WebAuthn adapter: the browser's `navigator.credentials` or, inside a Capacitor shell, a native
 * plugin. Capacitor itself is NOT a dependency here — the shell injects the bridge at runtime.
 *
 * Native contract (`window.InstantNativePasskey`), all binary fields base64url strings with the
 * same semantics as the browser API (WebAuthn Level 2):
 *
 *   create(options) -> { credentialId, attestationObject?, publicKey? }
 *     options: { challenge, rp: {name, id}, user: {id, name, displayName},
 *               pubKeyCredParams: [{type:"public-key", alg:-7}], userVerification: "required",
 *               attestation: "none", timeout }
 *     - credentialId: the credential's raw id
 *     - publicKey: the ES256 key as SPKI DER (what `AuthenticatorAttestationResponse.getPublicKey()`
 *       returns) — preferred; or
 *     - attestationObject: the CBOR attestation object; the app extracts the COSE key from authData.
 *       At least one of the two must be present.
 *
 *   get(options) -> { credentialId, authenticatorData, clientDataJSON, signature }
 *     options: { challenge, rpId, userVerification: "required", allowCredentials?: [{type:"public-key", id}], timeout }
 *     - challenge is the RAW 32-byte digest (base64url'd) — the native side must put it into
 *       clientDataJSON as `"challenge":"<base64url(challenge)>"` exactly like a browser would, since
 *       the contract recomputes that string.
 *     - authenticatorData: raw bytes; flags must carry UP|UV (0x05) for the contract to accept it.
 *     - clientDataJSON: the exact bytes that were hashed (base64url of the UTF-8 JSON).
 *     - signature: DER-encoded ECDSA signature, as the platform returns it.
 *
 * Detection: `window.Capacitor?.isNativePlatform?.() === true` and the bridge object exists.
 * Errors are thrown as normal Errors (e.g. user cancelled).
 */

export type NativeCreateOptions = {
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  userVerification: "required";
  attestation: "none";
  timeout: number;
};
export type NativeCreateResult = { credentialId: string; attestationObject?: string; publicKey?: string };
export type NativeGetOptions = {
  challenge: string;
  rpId: string;
  userVerification: "required";
  allowCredentials?: { type: "public-key"; id: string }[];
  timeout: number;
};
export type NativeGetResult = {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
};

export interface InstantNativePasskey {
  create(options: NativeCreateOptions): Promise<NativeCreateResult>;
  get(options: NativeGetOptions): Promise<NativeGetResult>;
}

declare global {
  interface Window {
    Capacitor?: { isNativePlatform?: () => boolean };
    InstantNativePasskey?: InstantNativePasskey;
  }
}

/** Uniform results the passkey layer consumes, whichever side produced them. */
export type CreateResult = { rawId: Uint8Array; publicKeySpki?: ArrayBuffer; attestationObject?: Uint8Array };
export type AssertionResult = {
  rawId: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
};

export function isNative(): boolean {
  return (
    typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() === true && !!window.InstantNativePasskey
  );
}

export function isWebAuthnAvailable(): boolean {
  if (typeof window === "undefined") return false;
  if (isNative()) return true;
  return !!window.PublicKeyCredential && !!navigator.credentials;
}

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export async function webauthnCreate(o: {
  challenge: Uint8Array;
  rp: { name: string; id: string };
  user: { id: Uint8Array; name: string; displayName: string };
  timeout: number;
}): Promise<CreateResult> {
  if (isNative()) {
    const r = await window.InstantNativePasskey!.create({
      challenge: bytesToBase64url(o.challenge),
      rp: o.rp,
      user: { id: bytesToBase64url(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      userVerification: "required",
      attestation: "none",
      timeout: o.timeout,
    });
    if (!r.publicKey && !r.attestationObject)
      throw new Error("native create returned neither publicKey nor attestationObject");
    return {
      rawId: base64urlToBytes(r.credentialId),
      publicKeySpki: r.publicKey ? buf(base64urlToBytes(r.publicKey)) : undefined,
      attestationObject: r.attestationObject ? base64urlToBytes(r.attestationObject) : undefined,
    };
  }
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: buf(o.challenge),
      rp: o.rp,
      user: { id: buf(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred",
      },
      timeout: o.timeout,
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No credential returned");
  const res = credential.response as AuthenticatorAttestationResponse;
  return {
    rawId: new Uint8Array(credential.rawId),
    publicKeySpki: res.getPublicKey() ?? undefined,
    attestationObject: new Uint8Array(res.attestationObject),
  };
}

export async function webauthnGet(o: {
  challenge: Uint8Array;
  rpId: string;
  allow?: Uint8Array;
  timeout: number;
}): Promise<AssertionResult> {
  if (isNative()) {
    const r = await window.InstantNativePasskey!.get({
      challenge: bytesToBase64url(o.challenge),
      rpId: o.rpId,
      userVerification: "required",
      allowCredentials: o.allow ? [{ type: "public-key", id: bytesToBase64url(o.allow) }] : undefined,
      timeout: o.timeout,
    });
    return {
      rawId: base64urlToBytes(r.credentialId),
      authenticatorData: base64urlToBytes(r.authenticatorData),
      clientDataJSON: base64urlToBytes(r.clientDataJSON),
      signature: base64urlToBytes(r.signature),
    };
  }
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: buf(o.challenge),
      rpId: o.rpId,
      userVerification: "required",
      timeout: o.timeout,
      allowCredentials: o.allow ? [{ type: "public-key", id: buf(o.allow) }] : undefined,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No credential returned");
  const res = credential.response as AuthenticatorAssertionResponse;
  return {
    rawId: new Uint8Array(credential.rawId),
    authenticatorData: new Uint8Array(res.authenticatorData),
    clientDataJSON: new Uint8Array(res.clientDataJSON),
    signature: new Uint8Array(res.signature),
  };
}
