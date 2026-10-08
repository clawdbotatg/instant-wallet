# Post-quantum passkey (experimental, off by default)

2026-10-08. Prototype. **Not audited, not in the app, not for real money.**

## Why

Passkeys sign with P-256, an elliptic curve. If curves break (a quantum computer, or Justin Drake's
2026-10-07 warning that AI-found math could do it first), anyone can forge a passkey signature. Apple and
Google don't offer post-quantum passkeys yet.

## The idea

One Face ID, two signatures, and the wallet needs both:

1. **The normal passkey signature** (P-256). Its key never leaves the phone's chip.
2. **A hash-only signature** (SPHINCS- C11). Its key comes from the passkey's PRF secret: the passkey
   hands back 32 secret bytes for any input we choose. Only hashes protect it, so it's post-quantum.

An attacker has to beat both: break the curve **and** steal the hash secret. The hash secret passes through
the web page, so a hacked site could steal it during a tap, but a hacked site can already get a normal
passkey to sign, so this gives nothing up.

**Rolling keys** (Drake's "use keys that aren't exposed"): the contract stores only a hash of the current
hash key. Each transaction uses key N and moves the contract to key N+1, all in the same transaction. Each
public key is seen once, then retired. The user still has one passkey: key N is the PRF secret for input N.
One tap returns both PRF outputs (key N and key N+1). The passkey's own P-256 key can't roll, but that's fine,
because an attacker needs both.

Rolling also lets us use C11, which signs about 30× faster than C13. C11 is full 128-bit security up to 2^14
signatures per key, and each key here signs about once (twice if a transaction gets stuck and is signed again).

## How it works

- `packages/foundry/contracts/pq/HybridPQSigner.sol`: a Safe owner. Holds `commit` (hash of the current hash
  key) and `index`. The relayer sends one transaction (Multicall3):
  1. `approve(safeTxHash, pkSeed, pkRoot, pqSig, next)`: checks that the hash key matches `commit`, checks
     its signature over `(chain, signer, index, safeTxHash, next)`, rolls to `next`, and marks `safeTxHash`
     in transient storage.
  2. `safe.execTransaction(...)`: the Safe calls `isValidSignature`, which needs the mark **and** a valid
     P-256 signature. The P-256 check uses Safe's audited passkey signer for the same passkey.

  The mark is transient, so it can't outlive the transaction.
- `packages/foundry/contracts/pq/SphincsC11Asm.sol`: the verifier, vendored unchanged from
  nconsigny/SPHINCS- @ 55b2f3e.
- `web/lib/safe/pq/`: `sphincs.ts` is the signer, ported from the SPHINCS- spec and byte-identical to the
  reference test vectors. `hybrid.ts` does the one-tap flow (`hybridSign`). `worker.ts` signs off the main
  thread. `message.ts` holds the shared pure helpers.
- `web/lib/passkey.ts`: `assertChallengePrf` asks the passkey for two PRF salts in one tap. Existing wallets'
  passkeys were already created with PRF on.
- `/pq`: lab page, not linked from the app. Tap once and it times each step on that device. Nothing is sent.

Why not just put the roll in the Safe batch: the P-256 signature has to sign the tx hash **before** the tap,
but the next key only exists **after** the tap. So the hash key signs `next`, and `approve` rolls.

## Cost

| | gas |
|---|---|
| SPHINCS- C11 verify | ≈ 118K |
| `approve` total (verify + roll) | ≈ 145K |
| signature calldata (3,976 bytes) | ≈ 64K |
| **extra per transaction vs a plain passkey** | **≈ 210K** |

On Base that's a fraction of a cent. Forge's Base fork has no P-256 precompile, so the test's exec number
includes Daimo's Solidity fallback (~350K). On Base itself the precompile makes the P-256 check a few thousand gas.

Signing time: about 2.1 s total in headless Chrome on a Mac (Face ID 0.06 s, next key 0.25 s, this key 0.23 s,
signature 1.55 s). **Not measured on a phone yet**: open `/pq` on one. Ways to speed it up: reuse the top tree
from keygen (≈0.2 s), or build the signer as WASM (several times faster).

## Live runs (2026-10-08, `packages/foundry/script/PQHybridLive.s.sol`)

A real Safe on each chain, a software P-256 key standing in for the phone (same on-chain path). Paid by the
facilitator `0x4cFaB32186e65E2A39EC0e882e11380cbf2f8A2f`: 0.0000156 ETH on Base, 0.0048653 ETH on Ethereum (≈ $12 total).
Facilitator left after: 0.0048 ETH on Base, 0.0068 ETH on Ethereum. Rerun: `PQ_TAG=<new tag> forge script
script/PQHybridLive.s.sol --ffi --rpc-url <rpc> --private-key <facilitator> --broadcast --slow`; records in
`packages/foundry/broadcast/PQHybridLive.s.sol/{8453,1}/`.
Each send = one Multicall3 tx (`approve` + `execTransaction`), zero-value, rolls the key.

| | gas | Base | Ethereum (2.4 gwei, ETH $2,413) |
|---|---|---|---|
| **each send** | ≈ 290–305K | ≈ $0.006 | ≈ $1.75 |
| hybrid signer deploy (per wallet; a minimal proxy would be ≈ 50K) | 412K | ≈ $0.008 | ≈ $2.50 |
| SPHINCS- verifier deploy (once, shared) | 307K | | ≈ $1.93 |

A plain passkey Safe send is ≈ 90K, so the hybrid adds ≈ 200K per send.

- Base: Safe `0x3628dBDc63A6ddCc87b6656C35EDe87B9C14157e`, hybrid `0x6b9787Ce825BF3721810694CF4C54D56D7dB120D`,
  verifier `0xe6A3E8Cc39323A83e764Cf9D8F997a2D7C3EACf2`; sends `0xc7b61942…`, `0x6d5c9560…`.
- Ethereum: hybrid `0xaa61d011d9bd752f364cc4f4f0fdb99afecbbb26`, verifier `0xb2c5a3b689793f186891158f69a651e431aa972c`; sends `0x1c82c4be…`, `0x761c441f…`.

## Tests

- `cd packages/foundry && forge test --ffi --match-path test/safe/PQHybrid.fork.t.sol` (needs `BASE_RPC_URL`):
  8 tests on a real Safe on a Base fork. Opt-in swap, three sends that roll keys, a retired key rejected, the
  passkey alone rejected, the wrong passkey rejected, the approval not outliving its tx, `next` bound to the
  signature, the app's message equal to the contract's, and a gas breakdown. The SPHINCS- signatures come from
  the web signer through `web/tools/pq-sign.mts`, so browser and chain are proven to agree.
- `web/tools/pq-lab-probe.mjs`: `/pq` in headless Chromium with a virtual PRF passkey.

## Limits / not done

- **Unaudited.** SPHINCS- is research (not FIPS 205), and so is our contract.
- Only the relayer path works: `approve` and exec in one transaction. Roles budget sends, the wedgie, and the
  other owners' flows don't go through the hybrid yet.
- Not in the app: no Keys switch, the relay doesn't accept `approve` yet, and nothing deploys the signer.
  The opt-in step (the passkey owner swaps itself for the hybrid) is tested on a fork only.
- If the PRF secret is ever lost (a passkey provider that drops PRF), the hash key is lost. Recovery
  (7 days) still works because it doesn't use the hash key.
- Passkey sync between devices (iCloud, Google) may itself use curve crypto. Not checked.
- The rest of the Safe (MetaMask owner, wedgie, recovery) is still elliptic-curve.

## Next

1. Time `/pq` on a real iPhone and Android.
2. Speed up if needed (WASM).
3. Keys → "Experimental: post-quantum" switch, off by default. It deploys the hybrid and swaps the owner.
4. The relay accepts `[approve, execTransaction]`, and `send.ts` uses `hybridSign` when the owner is a hybrid.
