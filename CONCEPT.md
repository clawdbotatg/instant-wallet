# Instant Wallet — concept

Progressive-self-custody (passkeys) + picowallet (a $35 hardware signer) = **one account,
many P-256 keys, tiered by trust.** Mockups: https://claude.ai/code/artifact/9773f7db-38db-4f51-abc8-1555086f2b35
(renders in `design/mockups/`, generator in `design/gen.py`).

## The one fact everything hangs on

Both signers are P-256 (secp256r1):

| signer | where the key lives | what it signs | on-chain check |
|---|---|---|---|
| Passkey (phone, laptop) | Secure Enclave / TPM, Face ID / Touch ID / Windows Hello | WebAuthn assertion: `sha256(authData ‖ sha256(clientDataJSON))`, challenge = our digest | `WebAuthn.verify` (OZ), as in PSC `SmartWallet.sol` |
| Device (ATECC608) | the chip, never extractable | the raw 32-byte EIP-712 digest | `P256.verify` (OZ, RIP-7212 precompile on Base), as in `ChipAccount.sol` |

So one contract can hold both kinds as **signers with roles**, instead of two wallets. Same
address, same balance, two windows onto it.

## Contract

Built: `packages/foundry/contracts/InstantWallet.sol`, spec in `docs/PROTOCOL.md`. In short: a
`Signer` is `(qx, qy, kind, role, dailyLimit)`; spenders may `metaTransfer` the wallet's token up to
a rolling 24h limit (amount + fee); owners may transfer anything, `metaExecute` batches, and
add/update/remove signers; a recovery address adds a new owner after a delay (default 1 day,
owner-set, min 1 hour) and any owner action cancels it. Both signer kinds verify against the same
EIP-712 digest: passkeys through OpenZeppelin `WebAuthn.verify`, chips through `P256.verify`.

## Off chain

- **Facilitator** (PSC's API): relays bundles, pays gas, takes a USDC fee inside the bundle.
  Also hosts the **device queue** (picowallet's `api/requests`) that the device polls over WiFi.
  If it dies anyone can relay; the device could also sign over USB to the desktop app.
- **Match code**: 3 words derived from the digest (e.g. BIP39-ish list, 11 bits each), rendered
  on the phone/desktop *and* the device. A relay that swaps the request can't fake it; the user
  compares by eye. This is the human-checkable version of picowallet's "digest checked on device".
- **Pairing**: the device shows its public key as a QR (it has a screen, no camera; the phone has
  a camera). Phone scans, passkey signs `addSigner`, facilitator relays, device sees itself on
  chain and flips its pairing dot green.
- **Lost phone**: from the device menu, "add key" shows the new phone's QR flow in reverse — the
  new phone generates a passkey, shows its `qx,qy` as a QR… the device has no camera. So instead
  the new phone posts its key to the queue and the **device screen shows "ADD KEY / iPhone Face
  ID / limit $500" with a match code**, green button approves. (Mockup: `DeviceAddKey`.)

## The ladder

1. **Instant** — Face ID makes a key; the address exists before any deposit. Fine for $50.
2. **Guarded** — the facilitator is the default recovery address (guardian); the user can set
   their own. Lost phone → recovery adds a new key after the delay.
3. **Hardened** — build the $35 device, scan it. It owns the account; Face ID keeps a $500/day
   allowance so daily life stays one-tap.
4. **Vault** — limit $0 for cold storage, or add a second device. Same address the whole way.

## Device

Same parts as picowallet (Pico 2 W + Waveshare 1.3" LCD + ATECC608, no solder). Button column on
the right, green **A = SIGN** at the top, red **Y = REJECT** at the bottom, as today. Home screen
per the concept renders: balance, delta, chart (the QR moves to a Receive screen on A). New
screens: `PAIR` (QR of pubkey), `ADD KEY` (approve a new passkey), `SIGN` gains the match code.

## Open questions

- Daily-limit accounting on-chain: decode `transfer` amounts from calldata (simple, one token)
  vs. balance-delta check around the batch (general, but a spender could route through a
  contract that returns value later). Start with the one-token decode.
- Desktop without a passkey (Linux, no TPM): the device over USB serial as the *only* signer.
- Does the facilitator fee count against the daily limit? (No — it's bounded and its own line.)
- Is "owner" a role or a threshold? A 2-of-2 (device + passkey) tier for very large amounts is a
  natural step 5 but adds UI. Skip for v1.
