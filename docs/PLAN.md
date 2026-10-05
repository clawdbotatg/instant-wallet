# Instant Wallet — the plan

2026-10-05. **This is the master doc.** It replaces the rules in `ROLES.md` and `COLD-STORAGE.md` (no more
"one key waits 48 h"). Details: `SAFE.md` (research), `WEDGIE-SAFE.md` (wedgie as owner, tested),
`LEVELS.md` (dials), `GAS.md` (fees). Our own `InstantWallet` 3.2 contract is shelved, never deployed.

## In one paragraph

You open instantwallet.io, Face ID, and you have a wallet: a **Gnosis Safe** controlled by a passkey on your
phone. Later you add MetaMask, then a wedgie. Each key you add makes it harder to steal. Big moves need two
keys; the phone keeps a daily spending limit. If you lose keys, your recovery address gives you new ones
after 7 days. If you die, a death switch hands it to your heir after 6 months. Every contract is audited
code that already exists. We write no contracts.

## The pieces (all audited, all already deployed on Base)

| piece | job | audited by |
|---|---|---|
| Safe 1.4.1 | the wallet: holds the money, list of owners, how many must sign | Safe (many) |
| Safe passkey signer v0.2.1 | lets a passkey or a wedgie be a Safe owner | Certora, Nethermind, Hats |
| Zodiac Roles v2.1 | gives a key limited powers without making it an owner (daily budgets) | G0, Omniscia |
| Candide Social Recovery (×2) | recovery (7 days) and death switch (6 months) | Ackee, Nethermind, Certora |
| Safe4337Module | optional: send through public 4337 bundlers | Ackee, Certora, Nethermind |

The death switch needs our own deployment of Candide's audited code with a 6-month delay (theirs ship
3/7/14 days). Same code, different number.

What is ours (not contracts, still must be reviewed): the app, the relay, the alert watcher, and the wedgie
`safe` app (firmware).

## The keys

| key | what it is | how it signs |
|---|---|---|
| **Burner** | passkey made on your phone by Face ID | WebAuthn, through Safe's passkey signer |
| **Hot** | MetaMask / Rainbow / any wallet you already have, usually by ENS | normal Ethereum signature |
| **Cold** | wedgie. Trust M chip makes the key; it never leaves the chip | press A; firmware wraps it as a passkey signature (tested on Base) |
| **Recovery** | an address that can replace your keys after 7 days | starts as dao.buidlguidl.eth (4 of 8), you swap in your own |
| **Death switch** | an address that can hand the wallet to your heir after 6 months | dao.buidlguidl.eth; optional |

## Levels (how the Safe is set up at each one)

Your address never changes. Each step is one transaction signed by the current owners.

| level | who can do anything together | burner alone | recovery | death switch |
|---|---|---|---|---|
| 1 Burner | burner | everything (it's the only key) | DAO, 7 d | DAO, 6 mo |
| 2 Hot | burner + hot | $100/day | DAO, 7 d | DAO, 6 mo |
| 3 Cold | wedgie + (burner or hot). **Not** burner + hot | $100/day | DAO, 7 d | DAO, 6 mo |
| 4 Own recovery | same as 3 | $100/day | yours (friend, second wedgie, your Safe) | DAO, 6 mo |
| 5 Full self-custody | same as 3 | $100/day | yours | none, or your own heir address |

**How level 3 works with plain Safe (no custom code): the wedgie counts twice.** The wedgie is added as two
owners: two of Safe's passkey-signer contracts for the same chip key (different verifier settings give
different addresses). The Safe needs 3 signatures. Wedgie (2) + burner or hot (1) = 3. Burner + hot = 2, not
enough. Wedgie alone = 2, not enough. One press on the wedgie: the same signature fills both slots.

The app nudges you up by balance ("$500 in here, add MetaMask"). Level 1 is only for spending money.

## Who can do what (level 3+)

| action | who |
|---|---|
| spend up to the daily limit | burner alone, instant |
| spend anything, any action | wedgie + burner, or wedgie + hot, instant |
| change a limit, add/remove a key, change recovery | wedgie + burner, or wedgie + hot |
| stop the burner (revoke its budget) | hot alone or wedgie alone, instant ("protect" role) |
| replace keys | recovery, after 7 days; wedgie + one other can cancel |
| hand everything to your heir | death switch, after 6 months; owners can cancel |

The "protect" role: a Zodiac Roles permission that lets one key do exactly one thing, switch off the burner's
budget. Protecting is instant and needs one key; weakening needs two.

**Optional delay (idea, not decided).** Two kinds:
- *Wedgie alone, after a wait* (e.g. 48 h): for when burner and hot are both gone. Zodiac Delay can queue it.
  **Catch:** cancelling a queued move needs the owners (wedgie + one other). If a thief has your wedgie, they
  use this same path and you can't cancel without the wedgie. Only safe if the wait is longer than recovery
  (e.g. 14 d wait, 7 d recovery: recovery gives you a new wedgie, then you cancel). And whenever you have a
  recovery address, recovery already covers "burner and hot both gone". Austin likes it; not decided.
  Zodiac Delay's current version has no fresh audit.
- *A wait even with two keys* (anti-"$5 wrench"): Safe can't force this without a guard, which is custom code.

The daily limit is per token, resets daily, and the user can set it to anything (the owners sign).

## Sending (who pays gas)

| mode | how | cost | trusts |
|---|---|---|---|
| A Our relay (default) | we submit; the last action in the batch pays us in USDC | cheapest | us |
| B 4337 | public bundlers + Circle paymaster (USDC gas) | more | no single party |
| C Self-send | your MetaMask pays ETH gas | gas only | nobody |

4337 only accepts owner signatures. From level 2 up, the burner's daily spends go through a relay or self-send,
and anyone can submit them, not only us. If our relay dies, nothing is stuck.

## Security model

1. **No custom contracts.** Everything on chain is audited code that already holds real money.
2. **One key is never enough for a big move** (level 2+). A thief needs two keys, and from level 3 one of
   them must be the wedgie.
3. **Protecting is one key; weakening is two.**
4. **Recovery is slow and loud.** 7 days, an alert the moment it starts, and your owners can cancel.
5. **The DAO is trusted until you replace it.** At levels 1–3 the DAO could reset your keys if you ignore
   the alert for 7 days. That's the deal for a free backup on spending money. Level 4 removes it.
6. **Alerts are required.** A wait you don't hear about protects nothing. Push, email, Telegram, and the
   watcher is open source so you can run your own.
7. **The wedgie key never leaves the chip.** You confirm by pressing A after reading the screen (no PIN). Any
   wedgie app can use the key, so a wallet wedgie only runs reviewed apps.
8. **There's a way out.** Safe's own tools can open your Safe if instantwallet.io disappears.

## What happens if it leaks (stolen)

| stolen | level 1 | level 2 | level 3+ |
|---|---|---|---|
| burner | **everything** (spending money only) | $100/day; hot stops it; recovery replaces it in 7 d | $100/day; hot or wedgie stops it; wedgie + hot replace it |
| hot | — | nothing alone; recovery replaces it in 7 d | nothing alone; wedgie + burner replace it, now |
| wedgie | — | — | nothing alone; burner + hot can't remove it, so recovery replaces it in 7 d |
| burner + hot | — | **everything** | $100/day; wedgie stops it; recovery replaces both in 7 d |
| burner + wedgie | — | — | **everything**. Keep your wedgie and phone apart |
| hot + wedgie | — | — | **everything**. Keep your wedgie and seed phrase apart |
| recovery (DAO or yours) | takeover waits 7 d; burner cancels | burner + hot cancel | wedgie + one other cancel |
| death switch | waits 6 mo; owners cancel | same | same |

A thief holding one key can't block recovery: cancelling needs the owners' full signatures.
A thief holding hot or the wedgie alone can switch off your burner's budget. That's annoying, not theft.

## What happens if you lose it

| lost | level 1 | level 2 | level 3+ |
|---|---|---|---|
| burner (passkey synced to iCloud/Google) | open the app on the new phone | same | same |
| burner (not synced) | recovery gives you a new one in 7 d | recovery, 7 d | wedgie + hot add a new one, now |
| hot | — | recovery replaces it in 7 d; burner keeps $100/day | wedgie + burner replace it, now |
| wedgie | — | — | recovery replaces it in 7 d; burner keeps $100/day |
| hot + wedgie, or burner + wedgie | — | — | recovery, 7 d |
| every key | recovery, 7 d | recovery, 7 d | recovery, 7 d |
| every key + recovery | death switch, 6 mo → heir | same | same |
| recovery | burner sets a new one | burner + hot | wedgie + one other |
| you (death) | death switch → heir after 6 mo | same | same |

Lose the wedgie and big moves wait for recovery (7 days). Lose the burner or hot and nothing waits.

## Open decisions

1. ~~Death switch length~~ **Decided: 6 months** (Austin, 10-05).
2. ~~Death switch destination~~ **Decided (Austin, 10-05):** the user sets an heir **on chain**, public; the
   DAO can overrule it at the time, but anyone can see it did. How, with no custom contract: the Safe posts an
   **EAS attestation** "heir = 0x…" (Ethereum Attestation Service, audited, built into Base, also on Ethereum).
   Changing the heir = a new attestation (owners sign). When the DAO starts the death switch, Candide records
   the proposed new owner on chain; the app and the alert compare it with the attested heir and say loudly
   if they differ. 6-month wait; owners can cancel.
3. ~~Level 2~~ **Decided (Austin, 10-05):** with only burner + hot, the two together can do anything. Once a
   wedgie is added, anything big needs the wedgie + burner or hot. The app nudges "add a wedgie" above ~$1,000.
4. **Default daily limit:** $100 per token.
5. **Wedgie-alone delay:** add it (14 d, longer than recovery) or skip it. See "Optional delay" above.

## Not proven yet (Base-fork spike first)

1. Burner budget: Roles with a passkey-signer member, signed by the phone, submitted by a relay. Includes
   replay protection, and which Roles version is deployed on Base and Ethereum.
2. The "protect" role: Roles letting one key switch off the burner (a call from the Safe back into Roles).
3. The wedgie counting twice: two passkey-signer owners for one chip key, threshold 3, one press fills both
   (only threshold 1 was tested).
4. Candide with the DAO Safe as guardian; our 6-month deployment.
5. Each level change as one batched transaction.
6. 4337 + Circle paymaster with passkey owners.
7. Safe app as an escape hatch (issue #8808: passkey owners with 2+ signatures may fail there).
8. EAS heir attestation made by the Safe itself (attester = the Safe), and reading it back.
9. Ethereum mainnet: check every piece is deployed there too, not just Base.

## Build order

1. **Spike** on a Base fork: prove the list above. Fix the plan where it breaks.
2. **Level 1 app:** Face ID → Safe (created on first deposit), scan, send, our relay with USDC fee.
3. **Levels 2–3:** add MetaMask (ENS), pair the wedgie (`wedgie-safe` app, code in `WEDGIE-SAFE.md`).
4. **Recovery, death switch, alerts** (watcher + push/email/Telegram).
5. **Levels 4–5** and sending modes B and C.
6. **Ethereum mainnet.**
7. Review of our code: app, relay, watcher, wedgie firmware.
