# Custody model

Austin, 2026-10-28. A proposal, not decided. Decide before launch: old wallets can switch later (one signing
per chain, same address), but every wallet made before then has to do that.

## Today (as built)

A plain Gnosis Safe with three audited add-ons. No contracts of ours.

- **Owners + rule.** Phone passkey (1 vote). Optional MetaMask (1 vote). Wedgie = **2 owner slots** (same key,
  two verifier settings). With a wedgie the rule is 3: passkey + wedgie = 3 of 3; add MetaMask = 3 of 4. The
  double vote makes the wedgie required for every big move (passkey + MetaMask can't sweep without it).
- **Daily limit (Zodiac Roles).** Only the phone passkey has one. Only ETH sends and USDC `transfer`s,
  100 USDC + 0.04 ETH a day by default (`setBudgetCalls`, `feeAllowanceCalls` in `web/lib/safe/core.ts`).
- **Recovery (Candide).** DAO, 7 days. After pairing a wedgie: your own address 14 days, the DAO 60 days.
- Each chain has its own owner list; the address is the same everywhere.

Problems:
- Passkey + wedgie with no spare key: lose either one and you wait for recovery (days). Rolling a bad key
  should be instant with your other keys; the long wait should be for "lost everything / died".
- "3 of 4" for 3 people confuses anyone who knows multisigs.
- The app only knows passkey, one MetaMask and the wedgie. Any other owner is never asked to sign.
- The daily limit only sends. No swaps, no LP.

## Proposed

**A normal Safe: one vote per key, M of N, one key with a daily limit, recovery for when too many keys are lost.**

1. **First setup stays tiny and never changes.** It sets the address. Passkey as the only owner, rule 1 of 1,
   recovery (DAO, 7 days; that module is on all 15 chains). Everything else is added later.
2. **One vote per key.** Drop the wedgie's second slot. Lose a key → the others replace it right away. Also
   cheaper: the second slot verifies P-256 in Solidity (~1.1M gas, `web/lib/safe/fee.ts`).
   Cost: passkey + backup can move money without the wedgie. Keep the backup offline.
   If "wedgie required" comes back later, add it as a small contract (a guard). Don't bake it into the owners.
   Note: whoever can swap keys can take everything, so "any 2 can replace a key" = "any 2 can sweep".
3. **Default with a wedgie:** passkey + wedgie + backup (laptop passkey, MetaMask or paper seed), any 2 of 3.
4. **Spending vs Savings: one passkey per wallet.** Spending = its own passkey, 1 of 1, do anything with a
   small amount. Savings = another passkey + wedgie + backup. Passkey names show which is which (below).
5. **Other signers** (friends, more keys) are plain Safe owners. App work needed: a signer list, a rule
   picker, and a "sign this" link for someone else.

## Built 10-28: a plain multisig

- A signer is an address. No kinds. How it signs is worked out per address (`howSigns` in
  `web/lib/safe/send.ts`): this phone's Face ID, the wedgie, or a browser wallet.
- Settings: Edit signers → add any address, remove one, pick M of N. Going past 1 of N sets up Face ID's daily limit.
- A new wedgie is one signer (2 of 2 with Face ID). Older wallets have it twice; remove one slot to fix.
- Recovery is the DAO only (7 or 60 days). Own recovery addresses can't be added any more; old ones still show.

## Daily limit beyond sends (Roles)

Roles can give any key (not just the phone) a limit, and can allow calls to set contracts with checked inputs.

Example: up to ~$100 into Uniswap v3 LP from Face ID alone.
1. Approve USDC / WETH only to the v3 position manager, amount counted against the token's allowance.
2. `mint` only for allowed pairs, `recipient` = the Safe.
3. `decreaseLiquidity` / `collect` back to the Safe: allowed, not counted.

Transactions: setup = one owners transaction per chain. Each LP = one Face ID, one batch (approve + mint via
MultiSendCallOnly, which `rolesSpendCall` already does for token calls).

Catches: the limit counts tokens, not dollars (100 USDC + 0.03 WETH, not "$100"). WETH, not ETH (the ETH
path is a multicall, hard to pin). Uniswap v4 packs its calls, much harder to check. One rule set per protocol.
A thief with the phone can still LP into a bad pool, but only up to the limit.
Same idea for swaps: `docs/SWAP.md`, option a.

Learn Roles: https://docs.roles.gnosisguild.org · https://github.com/gnosisguild/zodiac-modifier-roles

## Passkey names (built 10-27/28)

The passkey is renamed (WebAuthn Signal API) to "name · ENS or 0xabcd…1234 · ~$50". The name is the user's,
or Spending account / Savings account by balance (under ~$200 = Spending). The balance is rough and sticky
(changes when it halves or doubles), because every rename can pop an iOS notification. Code:
`renamePasskey` in `web/lib/passkey.ts`, the rename effect in `web/components/safe/SafeApp.tsx`.
Next: a public name = an ENS subdomain.

Deleting a test wallet's passkey: Passwords app (iPhone/Mac) or chrome://password-manager. Empty it first.

## Moving existing wallets

One owners transaction per chain: remove the wedgie's second slot, add a backup key, set the rule to 2.

## Open

- Wedgie required (guard contract) or plain 2 of 3?
- Keep Roles on Savings at all, or let the Spending wallet be the daily money?
- How the app shows Spending vs Savings (colors: Savings blue, Spending orange?).
