# Wedgie key rolling (idea, not built)

The worry: a public key that has signed something is out in the open, and a future attacker who can break
elliptic-curve keys (a quantum computer) could recover the private key from it. A key whose public half has never
been shown is safer. So: use each wedgie key once, and replace it in the same transaction it signs.

## Today

- The wedgie is one P-256 key added as **two** Safe owners (two `SafeWebAuthnSignerProxy` contracts, same x/y,
  different verifier slots), so it carries 2 votes. Instant 1, hot wallet 1, threshold 3 with all three keys:
  every big move needs the wedgie.
- Each owner address is a CREATE2 hash of the key, but we deploy the proxy when the wedgie is added
  (`createSigner(x, y, verifiers)`), which puts x/y on chain from day one. So the key is public before it ever signs.

## The idea: a rolling signer contract

Replace the two passkey proxies with our own signer contract (two instances, one per vote).

- **Stores** `commit = keccak256(x, y)` of the current wedgie key. Never the key itself.
- **`isValidSignature(hash, sig)`** (EIP-1271, what the Safe calls): `sig` carries `x, y, r, s` (plus WebAuthn
  data if we keep that format). Check `keccak256(x, y) == commit`, then verify the P-256 signature with the
  precompile (RIP-7212 on Base, EIP-7951 on Ethereum).
- **`rotate(newCommit)`**: only callable by the Safe itself. Sets `commit = newCommit`.

Every wedgie-signed Safe batch ends with `rotate(next)` on both instances:

```
MultiSend [ the user's move, signerA.rotate(H(key n+1)), signerB.rotate(H(key n+1)) ]
```

The current key signs a batch that retires itself. Its public half goes on chain in that same transaction,
when it no longer controls anything.

## Wedgie side

- Keys come from one seed in order: `key_n = derive(seed, n)`. The seed backup still recovers everything.
- To sign, the wedgie returns the signature plus `H(key n+1)` for the batch. (The app has to know the next
  commit before the batch is signed, so ask the wedgie for it first, then build and sign.)
- No counter to keep in sync: the wedgie finds `n` by matching `H(key n)` against the commit on chain. A
  transaction that fails or never lands leaves the old commit in place, so you just sign again.
- Recovery from seed: walk `n` upward until `H(key n)` matches the commit on chain.

## Why this shape

- One contract per vote, deployed once: owner addresses never change, so there are no owner swaps and the app
  doesn't notice. Each roll costs one storage write per instance.
- The other options are worse:
  - Deploying a fresh proxy for each new key at first use works, but costs a contract creation every
    transaction (cents on Base, dollars on Ethereum).
  - secp256k1 owners on the wedgie (address = hash, key hidden until it signs) need no contract, but rolling
    them is an owner swap each time, and the wedgie would need secp256k1 support.

## Limits and open questions

- Instant (passkey) and the hot wallet can't roll this way: their keys are already public. They make 2 votes,
  short of 3, so they still can't move funds over the daily limit without the wedgie. Breaking Instant alone
  still drains up to the daily limit, as it would today.
- This is our own security contract replacing Safe's audited one: it needs a careful review before real money.
- Both instances could share one key and one commit; whether that's one contract with two owner addresses or two
  contracts is open.
- Gas: one extra cheap call per instance per wedgie transaction.
- Wedgie firmware: deterministic key derivation, a "next commit" command, and finding `n` from the chain commit.
- Migration: an existing wallet swaps its two passkey proxy owners for the two rolling signers once (signed by
  the wedgie and another key).
