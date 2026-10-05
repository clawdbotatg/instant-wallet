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

**Under discussion (Austin, 10-05): a 48 h wait on two-key moves, instant with all three.**

Why: the Bybit attack. The owners signed what their screen showed, the screen was hacked, and the money was
gone instantly. With a wait, a signed move shows up in the app first: "In 48 h, all your money goes to
0x… [Cancel]".

| who signs | what happens |
|---|---|
| burner alone | up to the daily limit, instant |
| wedgie + burner, or wedgie + hot | anything, after 48 h, cancelable |
| all three | anything, instant |
| wedgie alone | nothing (needs a second signature) |

What it buys: two stolen keys are no longer an instant loss. Only all three are.
Lose one key and you can still move everything with the other two; it just waits 48 h.

**Rejected: wedgie alone after a wait.** A thief who steals your wedgie could take everything in 48 h,
because cancelling would need the wedgie. Any delayed path needs a second signature.

**The hard part: who can cancel.** It has to be any one key (the one the thief doesn't have). Nothing
audited does that:
- Zodiac Delay: cancelling needs the Safe owners (here, all three), and whoever can cancel can also change
  the delay.
- Optimism's TimelockGuard: any one owner can cancel, but every move waits (no instant path). It only sees
  normal Safe transactions (4337 and module transactions skip it), and we couldn't find its audit report.
- A small custom "canceller" (~40 lines): the one thing it does is let any key cancel a queued move.
  Everything else stays with the owners. This would be our only custom contract.

**Idea (Austin, 10-05): travel lock.** "For the next week, at most $2,000 can leave, no matter who signs."
Even all three keys can't go over it, and nobody can switch it off early, so a $5 wrench gets $2,000.
- Turning it on is protecting, so any one key can do it. It ends on its own; it can't be lifted early.
- Safe owners can normally do anything, and only a **guard** can stop them. That's custom code, and it needs
  Safe 1.5, which can guard module transactions too (Roles, recovery). Recovery still works during a lock:
  new keys, same cap until it ends.
- Risk: a buggy guard can freeze a Safe. Ending on its own limits that.
- It fits in the same small custom contract as the canceller: **one contract, two jobs** (any key cancels; travel lock).
- **Provable to an attacker** (Austin, 10-05). The lock must be checkable by anyone:
  - The contract is verified on Basescan / Etherscan. `lockStatus(safe)` returns the cap and the end time,
    and a `TravelLocked(safe, until, cap)` event is emitted.
  - The app has a big red "LOCKED until Fri, max $2,000" screen, with a link to the chain explorer.
    Show it to anyone; they can check it themselves.
  - Keep the cap simple so it's easy to prove: e.g. "USDC ≤ $2,000, everything else 0". A dollar cap across
    all tokens would need a price oracle, which is one more thing to trust and one more thing to explain.

## Sending (who pays gas)

| mode | how | cost | trusts |
|---|---|---|---|
| A Our relay (default) | we submit; the last action in the batch pays us in USDC | cheapest | us |
| B 4337 | public bundlers + Circle paymaster (USDC gas) | more | no single party |
| C Self-send | your MetaMask pays ETH gas | gas only | nobody |

4337 only accepts owner signatures. From level 2 up, the burner's daily spends go through a relay or self-send,
and anyone can submit them, not only us. If our relay dies, nothing is stuck.

## Group wallets (idea, Austin 10-05)

Three buddies, one Safe, e.g. 2 of 3 must sign. **The owners of the group Safe are each member's own Instant
Wallet Safe**, not their keys. Safe supports a Safe owning a Safe (contract signatures, EIP-1271).

- A member signs for the group with their own wallet's rule: wedgie + phone (or + hot).
- Lose your wedgie? You fix it inside your own wallet (wedgie + other key, or your recovery). The group Safe
  never changes and the others do nothing.
- The group can have its own recovery, death switch, daily limits (Roles) and travel lock, the same pieces.

To check:
- Signing a group tx = each member's Safe validating a signature. That skips the member's own 48 h wait
  and travel lock (those cover the member's moves, not their signatures). So put any wait or lock on the
  group Safe itself.
- 4337 bundlers may reject nested-Safe signatures (storage rules), so group txs go via relay or self-send.
- The app needs a "pending group transactions" view (Safe's Transaction Service already stores proposals and
  confirmations from passkey signers; see `WEDGIE-SAFE.md`).

## Many chains, same address (Austin 10-05)

Goal: the wallet on lots of chains, added as you go, at the same address. Some chains will need a different one.

- **Same address:** a Safe's address comes from Safe's factory plus its *first* setup (first owners, modules,
  a salt). Safe's contracts sit at the same addresses on most EVM chains, so the same first setup gives the
  same address everywhere. Funds sent before it's deployed on a chain are safe: deploy later, same address.
- **Different address:** chains that compute addresses differently (zkSync Era and similar). The app keeps a
  per-chain address list and shows the right one.
- **Adding a chain** = deploy with the *first* setup, then replay every change since (owners added, limits,
  recovery) in one batch. The relay does it, paid in USDC.
- **Danger: an old setup is reborn.** The first setup has the burner as the only owner. If that burner was
  stolen and later removed on Base, the thief could deploy the Safe on a new chain with the first setup and
  own it there, along with anything sent there. Fixes (pick in the spike):
  1. Deploy on every supported chain right at signup, while the burner is fresh (cheap on L2s; skip Ethereum).
  2. The app only shows your address on chains where it's deployed with your current keys, and warns
     loudly before anyone sends to a chain where it isn't.
- **Passkey/wedgie signers must use the same settings everywhere,** or their addresses (and so the Safe's)
  change. Use the P-256 precompile *plus* a fallback verifier on every chain, because not every chain has
  the precompile. (The Base test in `WEDGIE-SAFE.md` used the precompile only; that signer won't work on a
  chain without it.)
- **Per chain, check:** Safe, passkey signer, Roles, Candide, EAS (different address off the OP Stack),
  our one custom contract (deploy it with the same deterministic deployer), USDC + Circle paymaster for 4337,
  and a funded relay.

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
5. **48 h wait on two-key moves, instant with all three** (see "Under discussion"). If yes: custom canceller,
   OP TimelockGuard, or accept Zodiac Delay's limits.
6. **Travel lock** (see above): with the canceller, our one small custom contract (needs Safe 1.5).

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
9. Group wallet: a Safe owned by members' Safes (each with a wedgie owner), 2 of 3 signing via relay.
10. Same address on a second chain (e.g. Optimism): first setup + replay, signer with precompile + fallback.
11. Ethereum mainnet: check every piece is deployed there too, not just Base.

## Build order

1. **Spike** on a Base fork: prove the list above. Fix the plan where it breaks.
2. **Level 1 app:** Face ID → Safe (created on first deposit), scan, send, our relay with USDC fee.
3. **Levels 2–3:** add MetaMask (ENS), pair the wedgie (`wedgie-safe` app, code in `WEDGIE-SAFE.md`).
4. **Recovery, death switch, alerts** (watcher + push/email/Telegram).
5. **Levels 4–5** and sending modes B and C.
6. **Ethereum mainnet.**
7. Review of our code: app, relay, watcher, wedgie firmware.
