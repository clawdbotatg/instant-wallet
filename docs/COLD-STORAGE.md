# Cold storage — the plan

Goal: cold storage that is dead simple to set up and very hard to steal from. One contract, every number
a per-wallet setting, sensible presets. Nobody has to deploy anything to get their own rules.

## The one idea

**Anything that weakens the wallet is slow. Anything that protects it is instant.**

| kind of action | examples | who | speed |
|---|---|---|---|
| protect | freeze, cancel a pending action, lower a limit | any one key or guardian | instant |
| small spend | send / swap within the hot limit | passkey | instant |
| big spend | anything over the limit | wedgie | after the **delay** (cancelable) |
| big spend, both present | anything | passkey + wedgie together | instant |
| weaken | raise a limit, add a key, remove a guardian, shorten a delay, upgrade, unfreeze | wedgie | after the delay — or instant with both keys |
| recover | replace a lost key | a guardian | after the recovery delay (owner cancels) |

A thief never gets more than the hot limit without waiting out a delay that you (or your guardians) can
cancel. Settings changes follow the same rule, so a thief can't quietly raise the limit or shorten the delay.

## Keys

- **Passkey (hot):** Face ID on your phone. Daily limit per asset (default $100 USDC, a small ETH amount).
- **Wedgie (cold):** Trust M chip, physical A press, shows what it signs. Owner, but alone it waits.
- **Guardians (optional):** addresses that can freeze, cancel, and (slowly) replace a lost key. Default:
  dao.buidlguidl.eth. Can be friends, a Safe, your own second wedgie. They can't spend.

## What a thief gets

| they have | they get |
|---|---|
| your phone / passkey | one day's limit. You freeze, then the wedgie removes the passkey. |
| your wedgie | nothing: their send waits; your passkey cancels and freezes. |
| both | nothing if your guardians cancel during the delay. |
| your guardian(s) | nothing: they can't spend; their key replacement waits; you cancel. |
| you, under duress ($5 wrench) | the hot limit now; everything else is delayed and cancelable by guardians. |

## Losing things

| lost | what you do | how long |
|---|---|---|
| **phone, passkey synced** (iCloud / Google) | open Instant Wallet on the new phone, "I already have one". Nothing else. | now |
| **phone, someone has it unlocked** | freeze (wedgie, or any guardian), then the wedgie removes that passkey. | freeze now |
| **passkey gone for good** (not synced) | the wedgie adds a new passkey. Adding a key is "weaken", so it waits. | cold delay (48 h) |
| **wedgie** (lost, broken, chip wiped) | your passkey keeps spending its limit. A guardian proposes your new wedgie. If you find the old one, it cancels. | recovery delay (7 d) |
| **wedgie, and no guardians** | your passkey can still move everything out, one daily limit at a time. | limit / day |
| **wedgie, a thief has it** | their sends wait; you cancel and freeze with the passkey; then replace the wedgie as above. | — |
| **both** | guardians replace both keys. With no guardians, the money is gone: the app warns about this at setup. | recovery delay |
| **a guardian goes bad** | it can only propose a replacement (you get an alert, the wedgie cancels) or freeze (expires after 7 d; both keys unfreeze at once). The wedgie then removes it. | — |
| **you** (death) | name an heir as a guardian. If nobody cancels for the recovery delay, their key is added. | recovery delay |

Rules this needs: a spender can't cancel a recovery (or a thief with your phone could block it); a
guardian's freeze expires; removing a guardian is instant with both keys, delayed with the wedgie alone.

## Settings (per wallet, chosen at setup, changeable under the rules above)

| setting | default | range |
|---|---|---|
| hot limit (per asset, rolling 24h) | $100 USDC | 0 – anything |
| cold delay | 48 h | 1 h – 30 d |
| recovery delay | 7 d | 1 d – 90 d |
| guardians | dao.buidlguidl.eth | 0–16 addresses |
| who can cancel | any key + any guardian | — |

Presets in the app:
- **Simple** — passkey only, owner. (Today's wallet.)
- **Cold storage** — wedgie owner, passkey $100/day, 48 h delay, DAO guardian. *(recommended)*
- **Vault** — cold storage + 2+ guardians you pick, 7 d delay.

"Deploy your own": the contracts are open source and the Factory takes the settings, so anyone can run
their own factory with different defaults — but the app's settings screen covers almost everyone.

## Alerts (required — a delay you don't hear about is useless)

Every pending action emits an event. A small open-source watcher sends: push (PWA), email, Telegram.
We run a default one; anyone can run their own. The app shows pending actions with a big Cancel.

## Delight (Austin, 10-04: most hardware wallets aren't; this one must be)

- **You rarely touch it.** Daily life is the passkey. The wedgie comes out for big moves only.
- **No install, no drivers, no seed phrase.** Plug it in, Chrome, one tap. The wedgie wallet app installs
  from wedgie.dev in one click.
- **Pairing = one look, one press.** Phone/laptop and wedgie show the same picture (blockie + 3 words).
  Same? Press A. One Face ID. Done.
- **The wedgie shows what you're doing, in words.** "Send $2,000 USDC to atg.eth on Base", the
  recipient's blockie, and "arrives in 48 h" or "instant". Never a hex blob.
- **The wait feels like safety, not friction.** A countdown card on the phone with a big Cancel, and
  "Skip the wait": Face ID + A on the wedgie.
- **One choice at setup:** Simple / Cold storage / Vault. Numbers editable later, never required.
- **Plain words everywhere:** "Plug in your wedgie", "Press A", "Your passkey can spend $100 a day".
- **The wedgie's home screen is the vault:** total balance, a green light when it's paired, pending
  actions with their countdown.
- **Recovery is a sentence, not a ceremony:** "Lost your wedgie? Your guardians can add a new one in 7 days."

## Contract changes (an upgrade of v3; addresses don't change)

1. A **queue**: `propose(calls) → id, executeAfter`; `execute(id)` after the delay; `cancel(id)` by any key or guardian.
2. `metaExecute` by a **spender** within its limits (balance-delta check, no leftover approvals).
3. **Two-key** path: passkey + wedgie signatures on one digest skip the delay.
4. **Freeze**: any key or guardian; only spends and weakening actions are blocked; unfreeze = weaken rule.
5. Settings (`coldDelay`, guardians, limits) behind the weaken/protect rule.
6. Guardian powers split: cancel/freeze (instant) vs replace key (delayed).

## Wedgie side

- Key in Trust M `KEY2`; lock the slot after keygen so no other app can replace it.
- Only install apps from wedgie.dev's reviewed list on a wallet wedgie (any app can *use* the slot).
- Screen shows: action, amount, recipient, chain, and "waits 48 h" / "instant (both keys)".

## Open questions

- Limits in dollars across all tokens needs a price oracle; v1 is per-asset.
- Should the passkey be able to cancel a guardian's key replacement? (Yes, if it's the owner; if it's only
  a spender, a thief with your phone could block your recovery. Proposal: spenders can't cancel recovery.)
- Alerts identity: how a watcher knows how to reach you without a server knowing your wallet.
