import { p256 } from "@noble/curves/nist.js";
import { type Hex, keccak256, toBytes } from "viem";
import { signerIdOf } from "./address";
import {
  P256_N,
  base64urlToBytes,
  buildWebAuthnAuth,
  bytesToBase64url,
  bytesToHex,
  encodeWebAuthnSignature,
  hexToBytes,
  parseDerSignature,
} from "./webauthn";

/**
 * Passkeys (browser only). Ported from progressive-self-custody / Instant Wallet v2.
 *
 *  - createPasskey: a new platform credential (Face ID / Touch ID / Windows Hello), ES256, user verification.
 *  - recoverKeys: WebAuthn never returns the public key after creation, but one ECDSA signature yields ≤4
 *    candidate keys (docs/PasskeyDerivation.md). The caller picks one (known / deployed / funded) and only
 *    asks for a second signature if still ambiguous (confirmKey).
 *  - signDigest: the WebAuthn challenge IS the 32-byte digest; returns the flat-tuple encoding the contract's
 *    OZ WebAuthn verifier decodes.
 *
 * Every ceremony also asks for the PRF extension with a fixed salt. Where the platform supports it (iCloud
 * Keychain, Google Password Manager), that gives the same 32 secret bytes on every device the passkey syncs
 * to (unused since v3.1 dropped the gas key; kept so a later feature can derive per-user secrets).
 */

export const RP_NAME = "Instant Wallet";
const PRF_SALT = toBytes(keccak256(toBytes("instant-wallet gas key v1")));

export type NewPasskey = { credentialId: string; qx: Hex; qy: Hex; prf?: Uint8Array };
export type Candidate = { qx: Hex; qy: Hex };

export function webauthnAvailable(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

/**
 * The browser inside a wallet app (Rainbow, MetaMask, Coinbase Wallet…), or null. On a phone only those inject
 * `window.ethereum`. Their web views can't use passkeys: iOS only lets an app run WebAuthn for its own domains,
 * so every ceremony fails at once with NotAllowedError, which reads like the user cancelled.
 */
export function walletAppBrowser(): string | null {
  if (typeof window === "undefined") return null;
  const eth = (window as any).ethereum;
  const ua = navigator.userAgent;
  const phone = /iPhone|iPad|iPod|Android/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  if (!phone) return null; // a desktop extension also injects window.ethereum, and passkeys work there
  if (eth?.isRainbow || /Rainbow/i.test(ua)) return "Rainbow";
  if (eth?.isCoinbaseWallet || /CoinbaseWallet/i.test(ua)) return "Coinbase Wallet";
  if (eth?.isTrust || /Trust/i.test(ua)) return "Trust Wallet";
  if (eth?.isMetaMask || /MetaMaskMobile/i.test(ua)) return "MetaMask";
  return eth ? "this wallet app" : null;
}

/** Runs a ceremony; a NotAllowedError in under 0.5 s gets `blocked` (no prompt was shown, so no one cancelled). */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await run();
  } catch (e: any) {
    if (e?.name === "NotAllowedError" && performance.now() - t0 < 500) e.blocked = true;
    throw e;
  }
}

const rpId = () => window.location.hostname;
const random32 = () => crypto.getRandomValues(new Uint8Array(32));

export function credentialIdHash(credentialId: string): Hex {
  return keccak256(base64urlToBytes(credentialId));
}

function prfOf(cred: PublicKeyCredential, which: "first" | "second" = "first"): Uint8Array | undefined {
  const r = (cred.getClientExtensionResults() as any)?.prf?.results?.[which];
  return r ? new Uint8Array(r) : undefined;
}

/** credentialId -> the passkey's user.id (base64url), which renamePasskey needs. Saved at creation and on every
 *  sign-in (assertions return it), so passkeys made before this get it at their next Face ID. */
const HANDLES = "iws.userHandles";
function loadHandles(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(HANDLES) || "{}");
  } catch {
    return {};
  }
}
function saveHandle(credentialId: string, userId: Uint8Array) {
  try {
    const h = loadHandles();
    const v = bytesToBase64url(userId);
    if (h[credentialId] === v) return;
    localStorage.setItem(HANDLES, JSON.stringify({ ...h, [credentialId]: v }));
  } catch {}
}

/**
 * Renames a passkey in the user's password manager (WebAuthn Signal API: Chrome 132+, Safari 26+). Best effort:
 * no prompt, and a browser or password manager may ignore it. False when unsupported or the user.id is unknown.
 */
export async function renamePasskey(credentialId: string, name: string): Promise<boolean> {
  const signal = (window.PublicKeyCredential as any)?.signalCurrentUserDetails;
  const userId = loadHandles()[credentialId];
  if (!signal || !userId) return false;
  try {
    await signal.call(window.PublicKeyCredential, { rpId: rpId(), userId, name, displayName: name });
    return true;
  } catch {
    return false;
  }
}

export async function createPasskey(label = "Instant Wallet"): Promise<NewPasskey> {
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = (await ceremony(() => navigator.credentials.create({
    publicKey: {
      challenge: random32(),
      rp: { name: RP_NAME, id: rpId() },
      user: { id: userId, name: `${label} · ${new Date().toISOString().slice(0, 10)}`, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
      // Windows: first-time Hello/PIN setup and the "where to save" picker can take over a minute; 60 s timed out
      // mid-setup and read as "Cancelled.". client-device steers Chrome/Edge to Windows Hello before the phone QR.
      timeout: 300_000,
      ...({ hints: ["client-device"] } as object),
      extensions: { prf: { eval: { first: PRF_SALT } } } as any,
    },
  }))) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created");
  const res = cred.response as AuthenticatorAttestationResponse;
  const spki = res.getPublicKey?.();
  if (!spki) throw new Error("This browser did not return the passkey's public key");
  const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (!jwk.x || !jwk.y) throw new Error("Could not read the passkey's public key");
  saveHandle(bytesToBase64url(new Uint8Array(cred.rawId)), userId);
  return {
    credentialId: bytesToBase64url(new Uint8Array(cred.rawId)),
    qx: bytesToHex(base64urlToBytes(jwk.x)),
    qy: bytesToHex(base64urlToBytes(jwk.y)),
    prf: prfOf(cred),
  };
}

type Assertion = {
  credentialId: string;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
  prf?: Uint8Array;
  prfSecond?: Uint8Array;
};

type Salts = { first: Uint8Array; second?: Uint8Array };

async function assert(challenge: Uint8Array<ArrayBuffer>, credentialId?: string, salts: Salts = { first: PRF_SALT }): Promise<Assertion> {
  const cred = (await ceremony(() => navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: rpId(),
      userVerification: "required",
      allowCredentials: credentialId ? [{ type: "public-key", id: base64urlToBytes(credentialId) as Uint8Array<ArrayBuffer> }] : undefined,
      timeout: 300_000,
      extensions: { prf: { eval: salts } } as any,
    },
  }))) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey signature");
  const r = cred.response as AuthenticatorAssertionResponse;
  if (r.userHandle) saveHandle(bytesToBase64url(new Uint8Array(cred.rawId)), new Uint8Array(r.userHandle));
  return {
    credentialId: bytesToBase64url(new Uint8Array(cred.rawId)),
    authenticatorData: new Uint8Array(r.authenticatorData),
    clientDataJSON: new Uint8Array(r.clientDataJSON),
    signature: new Uint8Array(r.signature),
    prf: prfOf(cred),
    prfSecond: prfOf(cred, "second"),
  };
}

async function message(a: Assertion): Promise<Uint8Array> {
  const cdh = new Uint8Array(await crypto.subtle.digest("SHA-256", a.clientDataJSON as BufferSource));
  const all = new Uint8Array(a.authenticatorData.length + 32);
  all.set(a.authenticatorData, 0);
  all.set(cdh, a.authenticatorData.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

function verify(c: Candidate, r: Hex, s: Hex, msg: Uint8Array): boolean {
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(hexToBytes(c.qx), 1);
  pub.set(hexToBytes(c.qy), 33);
  for (const sB of [BigInt(s), P256_N - BigInt(s)]) {
    const sig = new Uint8Array(64);
    sig.set(hexToBytes(r), 0);
    sig.set(hexToBytes(`0x${sB.toString(16).padStart(64, "0")}`), 32);
    try {
      if (p256.verify(sig, msg, pub, { prehash: false, lowS: false })) return true;
    } catch {
      // try the other s
    }
  }
  return false;
}

/** One Face ID: which passkey was used, and the ≤4 public keys that could have made its signature. */
export async function recoverKeys(): Promise<{ credentialId: string; candidates: Candidate[]; prf?: Uint8Array }> {
  const a = await assert(random32());
  const { r, s } = parseDerSignature(a.signature);
  const msg = await message(a);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const sB of [BigInt(s), P256_N - BigInt(s)]) {
    for (const rec of [0, 1]) {
      try {
        const hex = new p256.Signature(BigInt(r), sB, rec).recoverPublicKey(msg).toHex(false);
        const c = { qx: `0x${hex.slice(2, 66)}` as Hex, qy: `0x${hex.slice(66)}` as Hex };
        if (!seen.has(c.qx + c.qy) && verify(c, r, s, msg)) {
          seen.add(c.qx + c.qy);
          candidates.push(c);
        }
      } catch {
        // not a valid recovery id for this r
      }
    }
  }
  if (!candidates.length) throw new Error("Could not read a public key from that passkey");
  return { credentialId: a.credentialId, candidates, prf: a.prf };
}

/** A second Face ID with the same passkey picks the one candidate that verifies both signatures. */
export async function confirmKey(credentialId: string, candidates: Candidate[]): Promise<Candidate> {
  const a = await assert(random32(), credentialId);
  const { r, s } = parseDerSignature(a.signature);
  const msg = await message(a);
  const hit = candidates.find(c => verify(c, r, s, msg));
  if (!hit) throw new Error("The two signatures came from different passkeys");
  return hit;
}

/** One Face ID over a 32-byte challenge, unprocessed (the Safe build encodes it its own way: lib/safe/sign.ts). */
export async function assertChallenge(credentialId: string | undefined, digest: Hex) {
  const challenge = hexToBytes(digest) as Uint8Array<ArrayBuffer>;
  if (challenge.length !== 32) throw new Error("digest must be 32 bytes");
  const a = await assert(challenge, credentialId);
  return { credentialId: a.credentialId, authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, ...parseDerSignature(a.signature) };
}

/** assertChallenge plus the PRF outputs for two caller-chosen salts (the post-quantum hybrid: lib/safe/pq). */
export async function assertChallengePrf(credentialId: string | undefined, digest: Hex, first: Uint8Array, second: Uint8Array) {
  const challenge = hexToBytes(digest) as Uint8Array<ArrayBuffer>;
  if (challenge.length !== 32) throw new Error("digest must be 32 bytes");
  const a = await assert(challenge, credentialId, { first, second });
  return {
    credentialId: a.credentialId,
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    ...parseDerSignature(a.signature),
    prf: a.prf,
    prfSecond: a.prfSecond,
  };
}

/** Sign a 32-byte digest with Face ID. Returns the contract encoding and, if supported, the PRF output. */
export async function signDigest(credentialId: string, digest: Hex): Promise<{ signature: Hex; prf?: Uint8Array }> {
  const challenge = hexToBytes(digest) as Uint8Array<ArrayBuffer>;
  if (challenge.length !== 32) throw new Error("digest must be 32 bytes");
  const a = await assert(challenge, credentialId);
  const { r, s } = parseDerSignature(a.signature);
  const auth = buildWebAuthnAuth(a.authenticatorData, new TextDecoder().decode(a.clientDataJSON), r, s);
  return { signature: encodeWebAuthnSignature(auth), prf: a.prf };
}

export { signerIdOf };
