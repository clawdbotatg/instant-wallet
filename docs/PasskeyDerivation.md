# Passkey Public Key Recovery via Two Signatures

## The Problem

WebAuthn passkeys only expose the public key (Qx, Qy) during credential creation. After that, you can't get it back - the API only returns signatures.

## The Solution

**ECDSA signature recovery.** Given any ECDSA signature (r, s) and the message that was signed, you can mathematically recover candidate public keys that could have produced that signature.

### Why "candidates"?

On the P-256 curve, a single signature produces up to 4 possible public keys:

- **2 recovery bit values (0 or 1)** - the y-coordinate parity
- **2 S values (s and n-s)** - due to ECDSA signature malleability

## The Two-Signature Trick

1. **First signature:** User authenticates with their passkey (random challenge). Parse the DER signature to get (r, s). Compute `message = sha256(authenticatorData || sha256(clientDataJSON))`. Use `sig.recoverPublicKey(message)` for all 4 combinations → get up to 4 candidate (Qx, Qy) pairs.

2. **Second signature:** Request another signature with a different random challenge (same credential via `allowCredentials`).

3. **Verify:** For each candidate from step 1, verify if it validates the second signature using `p256.verify()`. Only the real public key will verify both signatures.

## Key Code (using @noble/curves v2.x)

### Important: Package Import Path

In `@noble/curves` v2.x, the import path changed:

```typescript
// v1.x (OLD - won't work)
import { p256 } from "@noble/curves/p256";

// v2.x (NEW - correct)
import { p256 } from "@noble/curves/nist.js";
```

### Constants

```typescript
// P-256 curve order (n) - needed for S-value normalization
const P256_CURVE_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
```

### Computing the WebAuthn Message Hash

WebAuthn signs `sha256(authenticatorData || sha256(clientDataJSON))`:

```typescript
async function computeWebAuthnMessage(
  authData: ArrayBuffer,
  clientDataJSON: ArrayBuffer
): Promise<Uint8Array> {
  const clientDataHash = await crypto.subtle.digest("SHA-256", clientDataJSON);
  const combined = new Uint8Array(authData.byteLength + clientDataHash.byteLength);
  combined.set(new Uint8Array(authData), 0);
  combined.set(new Uint8Array(clientDataHash), authData.byteLength);
  const messageHash = await crypto.subtle.digest("SHA-256", combined);
  return new Uint8Array(messageHash);
}
```

### Recovering Public Key Candidates

```typescript
import { p256 } from "@noble/curves/nist.js";

async function recoverPublicKeyCandidates(
  r: `0x${string}`,
  s: `0x${string}`,
  message: Uint8Array
): Promise<Array<{ qx: `0x${string}`; qy: `0x${string}` }>> {
  const rBigInt = BigInt(r);
  const sBigInt = BigInt(s);
  const candidates: Array<{ qx: `0x${string}`; qy: `0x${string}` }> = [];

  // Try both s values (original and flipped for malleability)
  const sValues = [sBigInt, P256_CURVE_ORDER - sBigInt];

  for (const tryS of sValues) {
    for (const recovery of [0, 1]) {
      try {
        const sig = new p256.Signature(rBigInt, tryS, recovery);
        const pubKey = sig.recoverPublicKey(message);
        const hex = pubKey.toHex(false); // uncompressed: 04 || x || y
        const qx = `0x${hex.slice(2, 66)}` as `0x${string}`;
        const qy = `0x${hex.slice(66)}` as `0x${string}`;
        candidates.push({ qx, qy });
      } catch {
        // Invalid recovery combination, skip
      }
    }
  }
  return candidates;
}
```

### Verifying Signatures

**Critical:** WebAuthn signatures may have "high-S" values. When verifying:
1. Set `prehash: false` because the message is already hashed
2. Set `lowS: false` to accept both high-S and low-S signatures
3. Try both the original S and the normalized S (n - s)

```typescript
async function verifySignature(
  qx: `0x${string}`,
  qy: `0x${string}`,
  r: `0x${string}`,
  s: `0x${string}`,
  message: Uint8Array
): Promise<boolean> {
  try {
    // Build uncompressed public key: 04 || x || y
    const pubKeyBytes = new Uint8Array(65);
    pubKeyBytes[0] = 0x04;
    pubKeyBytes.set(hexToBytes(qx), 1);
    pubKeyBytes.set(hexToBytes(qy), 33);

    const rBytes = hexToBytes(r);
    const sBigInt = BigInt(s);

    // Try both s values (original and normalized) since WebAuthn may return high-s
    const sValuesToTry = [sBigInt, P256_CURVE_ORDER - sBigInt];

    for (const tryS of sValuesToTry) {
      const trySBytes = bigIntToBytes32(tryS);
      
      // Build signature as 64-byte r||s concatenation (compact format)
      const sigBytes = new Uint8Array(64);
      sigBytes.set(rBytes, 0);
      sigBytes.set(trySBytes, 32);

      // IMPORTANT: prehash: false because message is already hashed
      // IMPORTANT: lowS: false to accept both high-S and low-S signatures
      const result = p256.verify(sigBytes, message, pubKeyBytes, { 
        prehash: false, 
        lowS: false 
      });
      
      if (result) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function bigIntToBytes32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
```

### Parsing DER Signatures

WebAuthn returns DER-encoded signatures that need to be parsed:

```typescript
function parseSignature(sig: Uint8Array): { r: `0x${string}`; s: `0x${string}` } {
  // DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
  let offset = 0;

  if (sig[offset++] !== 0x30) throw new Error("Invalid signature format");
  offset++; // Skip total length

  if (sig[offset++] !== 0x02) throw new Error("Invalid r marker");
  const rLen = sig[offset++];
  let r = sig.slice(offset, offset + rLen);
  offset += rLen;

  // Remove leading zero if present (DER uses signed integers)
  if (r[0] === 0 && r.length > 32) r = r.slice(1);
  // Pad to 32 bytes if needed
  if (r.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(r, 32 - r.length);
    r = padded;
  }

  if (sig[offset++] !== 0x02) throw new Error("Invalid s marker");
  const sLen = sig[offset++];
  let s = sig.slice(offset, offset + sLen);

  // Remove leading zero if present
  if (s[0] === 0 && s.length > 32) s = s.slice(1);
  // Pad to 32 bytes if needed
  if (s.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(s, 32 - s.length);
    s = padded;
  }

  return {
    r: bufferToHex(r),
    s: bufferToHex(s),
  };
}
```

## Credential ID

This is just `credential.rawId` from the WebAuthn response (available on every signature). Hash it with `keccak256` for on-chain use:

```typescript
function getCredentialIdHash(credentialId: string): `0x${string}` {
  const bytes = base64urlToBytes(credentialId);
  return keccak256(bufferToHex(bytes));
}
```

## Common Pitfalls

1. **Wrong import path**: Use `@noble/curves/nist.js` not `@noble/curves/p256` in v2.x
2. **Double hashing**: Don't let the library hash again - set `prehash: false`
3. **High-S rejection**: WebAuthn doesn't normalize S values - set `lowS: false` and try both S values
4. **Buffer views**: When logging/using `Uint8Array.buffer`, be aware it may return the underlying ArrayBuffer, not just the view's portion
5. **Different passkeys**: Users might select different passkeys for each signature - use `allowCredentials` to lock to the same credential for the second signature

## Full Login Flow

```typescript
async function loginWithPasskey(): Promise<{ qx, qy, credentialId, passkeyAddress }> {
  // 1. First signature - get candidates
  const challenge1 = crypto.getRandomValues(new Uint8Array(32));
  const credential1 = await navigator.credentials.get({
    publicKey: {
      challenge: challenge1,
      rpId: window.location.hostname,
      userVerification: "required",
    },
  });
  
  const response1 = credential1.response;
  const sig1 = parseSignature(new Uint8Array(response1.signature));
  const message1 = await computeWebAuthnMessage(
    response1.authenticatorData, 
    response1.clientDataJSON
  );
  
  const candidates = await recoverPublicKeyCandidates(sig1.r, sig1.s, message1);
  
  // 2. Second signature - verify which candidate is real
  const challenge2 = crypto.getRandomValues(new Uint8Array(32));
  const credential2 = await navigator.credentials.get({
    publicKey: {
      challenge: challenge2,
      rpId: window.location.hostname,
      userVerification: "required",
      // IMPORTANT: Lock to same credential
      allowCredentials: [{ type: "public-key", id: credential1.rawId }],
    },
  });
  
  const response2 = credential2.response;
  const sig2 = parseSignature(new Uint8Array(response2.signature));
  const message2 = await computeWebAuthnMessage(
    response2.authenticatorData,
    response2.clientDataJSON
  );
  
  // 3. Find the candidate that verifies against signature 2
  for (const candidate of candidates) {
    if (await verifySignature(candidate.qx, candidate.qy, sig2.r, sig2.s, message2)) {
      return {
        credentialId: bytesToBase64url(new Uint8Array(credential1.rawId)),
        qx: candidate.qx,
        qy: candidate.qy,
        passkeyAddress: derivePasskeyAddress(candidate.qx, candidate.qy),
      };
    }
  }
  
  throw new Error("Failed to recover public key from signatures");
}
```
