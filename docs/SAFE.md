# Instant Wallet on a Gnosis Safe — what's best

2026-10-05. Austin: build on a Safe because it's audited; custom code only where nothing audited fits.
Research: Safe, Zodiac and Rhinestone source code, audit PDFs, and on-chain code checks on Base + Ethereum.

## TLDR

One plain Safe with two audited add-ons. **No custom contracts.**

- **Big moves need two keys** (hot + cold). This replaces "one key waits 48 h". Nothing audited does a 48 h
  wait that any single key can cancel, and two keys gets the same protection more simply.
- **Burner:** $100/day, resets daily → **Zodiac Roles** (audited).
- **Recovery (7 days) and death switch (1 year)** → **Candide Social Recovery** (audited).
- Wedgie: the firmware wraps its signature as a passkey signature, so Safe's own audited passkey signer accepts it.

Rhinestone was my earlier pick. It's out: its spending limit never resets, its recovery has no delay and
no cancel, and it likely breaks the Safe app.

## How each role maps

| role | how | audited by |
|---|---|---|
| Cold (wedgie) | Safe owner via Safe's passkey signer. Firmware builds the passkey envelope and sets flag 0x05 | Safe passkey module v0.2.1: Certora, Nethermind, Hats |
| Hot (MetaMask) | Safe owner, a plain address | Safe core |
| Burner | Zodiac Roles member, allowance $100/day per token that refills daily. Signs, a relayer submits | Roles v2.1: G0, Omniscia |
| Recovery | Candide module, 7-day deployment. Guardian = DAO, swapped later for the user's own | Candide: Ackee, Nethermind, Certora |
| Death switch | Candide module again, with a 1-year delay. Guardian = DAO | same code; a 1-year copy must be deployed |

## Growing up

1. **Land:** burner = the only owner, threshold 1. It's also the Roles member. DAO = recovery.
2. **Add hot:** owners = burner + hot, both must sign. Burner alone = $100/day.
3. **Add cold:** owners = hot + cold, both must sign. Burner removed as an owner, keeps $100/day.

## Stolen / lost (after step 3)

| | stolen | lost |
|---|---|---|
| burner | $100/day until hot + cold remove it | hot + cold add a new one |
| hot or cold | thief can't move anything alone | burner still spends; recovery replaces the key in 7 d |
| hot + cold | thief takes everything. Keep them apart | recovery replaces both in 7 d |
| recovery | its takeover waits 7 d; hot + cold cancel | hot + cold set a new one |

This closes the old gap. Cancelling a recovery needs both keys, so a thief holding one key can't block it.
The trade-off: with one key lost, a big send waits for recovery (7 d).

## What doesn't fit (and why)

- **Safe AllowanceModule** (Safe's spending limit): rejects passkey signatures.
- **Rhinestone Smart Sessions:** the spending limit is a lifetime total, with no daily reset. Still marked beta.
- **Rhinestone SocialRecovery:** no delay, no cancel, and it can't change Safe owners.
- **Rhinestone DeadmanSwitch / ColdStorageHook:** the switch only sees 7579 transactions, and the hook only
  pays out to one fixed address. Neither is on Ethereum mainnet.
- **Safe7579 adapter:** replaces Safe's fallback handler, which likely breaks message signing and the Safe app.
- **Zodiac Delay** (48 h queue): cancelling needs full owner signatures, not any single key, and the current
  version has no audit.

## Still unverified (prove on a Base fork before building)

1. Roles with a passkey-signer member, signed off-chain and submitted by a relayer, end to end. Includes
   replay protection on the signed calls (zodiac-core v3) and which Roles version is deployed on Base/Ethereum.
2. Burner gas. Roles calls aren't 4337, so the relayer pays; the burner tips the relayer in USDC inside its
   allowance (see the RelayTip spike).
3. ~~A wedgie signing the faked passkey envelope against the deployed passkey signer.~~ **Done, on Base:
   see `WEDGIE-SAFE.md`** (threshold 1 only).
4. DAO Safe as a Candide guardian (EIP-1271 confirm). Candide's 1-year deployment for the death switch.
5. Safe app as an escape hatch: one open issue (#8808) says a passkey owner with threshold ≥ 2 fails there.
6. A death switch Austin can live with: Candide's is "start, then wait 1 year, owners cancel". Using the
   wallet doesn't reset it.

## Open decision

The death-switch destination is picked by the DAO when it triggers. Safer: the user names an heir in advance.
Candide guardians propose the new owners, so naming in advance means the DAO only signs what was named.
That part is off-chain.
