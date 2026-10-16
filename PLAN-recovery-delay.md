> **10-15: done another way.** Wallets still start on 7 days (addresses unchanged); pairing the wedgie moves the wallet
> to the 14-day module in the same batch. We replayed Candide's deploy on Robinhood, Sonic and Arc (code hash checked
> against Base). The wedgie app knows both (wedgie-safe 5a76f0d, on wedgie.dev). Branch `recovery-14d` is obsolete.

# Plan: recovery delay 7 days → 14 days (DROPPED)

**Austin, 10-13 (later): leave recovery at 7 days. Not doing this.** Kept for reference.

Austin, 10-13: go to 14 days eventually; stay on 7 for now.

## Why not now

Candide's 14-day module (0x9BacD92F4687Db306D7ded5d4513a51EA05df25b) is on 12 of our 15 chains. Missing on
Robinhood, Sonic and Arc. Ship it there and new wallets on those chains get no working recovery.
The 7-day module (0x088f6cfD8BB1dDb1BB069CCb3fc1A98927D233f2) is on all 15.

No custom module: only Candide's audited, already-deployed contracts.

## The code is done

Branch `recovery-14d` (commit 2945595): module swap, tests (38 pass on a Base fork), UI text, docs.
Rebase it onto main when ready.

## Before shipping

1. Get the 14-day module on Robinhood, Sonic and Arc. Either:
   - Candide deploys it (ask them), or
   - we replay Candide's own deploy: tx 0xe210eb27…95a4 on Ethereum (block 20619208), sent to the Safe
     singleton factory 0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7. Same input on each chain = same address,
     same code. The factory is on all 3. A few dollars of gas.
2. Check `eth_getCode` for 0x9BacD92F… on every chain in `web/lib/chains.ts`.
3. Rebase `recovery-14d`, run the Safe fork tests, ship.

## Changing the module changes every wallet address

- **No users yet (today):** fine. Sweep your own wallet out first, then back in after shipping, and re-add the
  wedgie / MetaMask / paper backup.
- **Once there are users:** don't just swap the constant. Version the first setup (v1 = 7 d, v2 = 14 d), save the
  version with the account, and make every `RECOVERY_*` and `safeAddress()` caller use it: `state.ts`
  (`loadAccount` recomputes the address), `SafeWelcome.tsx` login check, `RecoverTool.tsx`, `RecoveryAlert.tsx`,
  `connect.ts`, `relayGuard.ts`, `core.ts` `setGuardianCalls`, `/api/onramp`, `/api/safe/relay`, the wallet card
  and indexer data.

So the cheapest time to switch is before the first real user.

## Don't

- Don't ship before step 2 passes on every chain.
- Don't change "7 days" in the wallet-lock text (`docs/PLAN.md` ~244). That's a different delay.
