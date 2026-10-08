# Hand-off, 2026-10-08: wedgie screens, daily limit, wedgie hand-off

Written on heart (clawd's Mac) for an agent on **head** (the machine with the wedgie.dev release key).
Live app: https://instant-wallet-b2jn.vercel.app (Vercel project instant-wallet-b2jn, root `web/`,
push to main = deploy). Austin wants answers short and plain.

## First job on head: put the new Safe signer on wedgie.dev

The wedgie app lives in **github.com/clawdbotatg/wedgie-safe**. Commit **319156a** (pushed) has the
clearer pages (below). Pushing that repo puts nothing on wedgies: the wedgie.dev shelf serves only the
commit it signed, and it is still at **20cb4b1** (2026-10-05, before even the plain-words commit
b4e86f8). In a **wedgie-dev** checkout (github.com/clawdbotatg/wedgie-dev, `docs/APPS.md`):

```
node tools/community.mjs status                          # wedgie-safe: shelf 20cb4b1, GitHub 319156a
node tools/community.mjs update clawdbotatg/wedgie-safe
git diff community/                                      # read it: it runs on people's wedgies
node tools/sign.mjs                                      # runs tools/gate.mjs first; needs the release key
git add community.json community/ release/ && git commit && git push      # push = deploy
curl -s https://wedgie.dev/fw/release.txt | cmp - release/firmware.txt    # live?
```

No firmware `VERSION` bump (app-only change). Then on Austin's wedgie: wedgie.dev → the Safe signer
→ **Update**. Optional checks first: `node tools/safechip.mjs --app <wedgie-safe checkout>` (virtual
RP2040; passed on heart: every signing path, 100 KB free, same speed as before).

## What wedgie-safe 319156a changes (safe.py, new safe_blockie.py)

- Amounts in big text (3x when ≤10 characters).
- Every address in full with its **blockie** beside it: `safe_blockie.py` is a port of `blo`
  (the app's `Blockie`); the pattern and HSL match blo exactly (checked on 6 addresses), colors are the
  nearest of the wedgie's 16-color palette, so close, not identical.
- The first page shows a **blockie of the Safe tx hash** ("tx 0x241b..bba7"); the app draws the same
  one (`TxPicture`, `web/components/safe/WedgieButton.tsx`) on the phone's "Now the wedgie" screen and
  the waiting card. Same picture = the computer didn't swap the transaction.
- Instant Wallet in plain words, decoded on the wedgie (never host text): `daily limit 3 USDC`,
  `fee cap 1 USDC` (KEY_FEE_USDC), the USDC fee rule ("fees, up to the fee cap, to the Instant relay;
  others: up to the daily limit"), the ETH rule, a fee transfer = "fee 0.02 USDC to the Instant relay".
  The relay 0x4cFaB32186e65E2A39EC0e882e11380cbf2f8A2f is built in as "the Instant relay".
  A Roles rule it can't read is red.
- Page preview: heart rendered pages with MicroPython's framebuf (real font, real palette); not
  committed. `web/tools/wedgie/serve.py` + `WEDGIE_SAFE=<checkout> npx tsx web/tools/wedgie-app-check.mts`
  is the committed text-only check (passes).

## What else shipped in the app (all pushed, all live)

- **Wedgie button**, bottom left (`web/components/safe/WedgieButton.tsx`, `Wedgie.peek/watch/pick`
  in `web/lib/safe/wedgie.ts`): solid when this wallet's wedgie is plugged in; faded when none; a dot
  when silent / wrong app / no key / a different wedgie. Web Serial only (Chrome/Edge on a computer);
  nothing touches serial until the browser asked for a wedgie once (macOS Bluetooth prompt).
- **Wedgie hand-off** (phone → computer): a big send on a phone (no Web Serial) signs with Face ID
  and parks at `/api/safe/pending` (`web/app/api/safe/pending/route.ts`, Upstash `iws:relay:pending:*`,
  7 days; the server checks the signature with Safe's `checkNSignatures` before storing). Home card
  "Waiting for your wedgie"; on the computer the same card → Sign and send → A. Swaps can't park.
  Tested by Austin on his real wallet. Fork test: `web/tools/safe-park-e2e.mjs` (9/9).
- **Daily limit** in Settings: "Daily limit (1 of N keys)", left/limit, Edit (USDC over ETH), owners
  sign (`setBudgetCalls` in `web/lib/safe/core.ts`).
- **Fee off the limit**: the burner's USDC transfers are scoped
  `Or(transfer(relay, ≤ fee cap), transfer(anyone, ≤ daily limit))` (`feeAllowanceCalls`), fee cap 1
  USDC/day Base, 20 Ethereum (`FEE_ALLOWANCE`, `web/lib/safe/config.ts`). New wallets get it with their
  first second key; existing ones on any daily-limit save. Austin sent exactly 3 of 3 USDC on Face ID.
  ETH sends still count the fee. A limit save is a 5-action batch (could be 3: the rule needn't be
  rewritten each time).
- Send: token is a select box; amount in dollars by default, USD ⇅ token converts; the scanner swiped
  away goes back to Send (`useSheetBack` in `web/components/bits.tsx`).

## Later (specced in docs/WEDGIE-SAFE.md, not built)

- Wedgie summary page first; joystick **down = more**, **up = less**; red on the summary if unreadable.
- Wedgie: check a Roles call's target is this Safe's own Roles (ModuleProxyFactory CREATE2) before
  calling it "budget".
- Phone ↔ wedgie directly (WedgieDrive iOS app in wedgie-dev `ios/`).
- wedgie-safe takes at most 8000 bytes of tx data (pieces); a big LI.FI bridge batch may not fit.

## Testing notes

- Fork e2e: anvil fork of Base on its own port + `next dev` with `NEXT_PUBLIC_CHAINS=8453
  BASE_RPC_URL=… LOCAL_TOKENS_ONLY=1 LOCAL_TOKENS=<USDC> RELAYER_PRIVATE_KEY=<anvil #0>
  NEXT_PUBLIC_TEST_FEE_ALLOWANCE=10000000` (the fork's 1 gwei tip makes fees ~$2.5). If the relay says
  "gas required exceeds allowance: 0", fund the relayer address the app actually uses on the fork
  (`anvil_setBalance`). Desktop Chrome has real Web Serial: a "phone" test must delete
  `Navigator.prototype.serial`.
- Other sessions work in this repo at the same time: stage only your own files.
