# Proven balances (plan, 2026-11-13)

Home shows each balance at once, as today. A light client (Colibri) proves it in the background. The number is
faded until its proof lands, then full. A proof that contradicts the number turns the row red. Ethereum and Gnosis.
This is `docs/CROPS.md` §6 "Read" and "Indexing", done without slowing Home.

Built 11-13, steps 1 to 4, behind Settings → Your node (off by default): `<Proven>` in `components/bits.tsx`,
`tools/proven-e2e.mjs` in a browser. Step 0 measured on a laptop only (`tools/proven-measure.mts`), not yet on a phone.

## What exists

- `web/lib/safe/light.ts`: one Colibri client per network, `VerifiedOnly` (a failed proof throws). Used only for the
  tx preview (`lightRun`), and only when Settings → your node → "Check it in this browser" is on.
- Home's coins come from our server: `GET /api/portfolio` (Alchemy balances + prices), read in
  `SafeApp.tsx` `loadBalance`, drawn in the `card assets` rows.
- So today a balance is trusted twice: Alchemy, and our server.

## The rule

For each coin on Ethereum or Gnosis, the browser keeps: the number shown, when it first saw that number, and the
last proven number with its block.

| State | When | Look |
|---|---|---|
| Unchecked | no proof yet, or the shown number changed since the last proof | faded |
| Checked | the proven number equals the shown one (within 0.001%, for coins that grow every block: stETH, Aave) | full |
| Wrong | twice in a row, a proof disagreed with the shown number and then our server said that same number again, both proofs more than 2 minutes after the number first showed | red, and the proven number is shown |
| Can't check | prover down, proof too old, network without a light client | faded (same as unchecked) |

- A new payment is not a lie. The shown number changes, the row fades, the next proof agrees, it goes full.
  A proof can be for a block up to 90 s old, so for 2 minutes after a number shows up a proof that disagrees counts for
  nothing. After that it is only a doubt: it becomes a strike when the server, asked again after the proof, still says
  the same number. Two strikes (two different blocks) is Wrong. Only this device's own clock is used (how long since),
  never a block's time, so a phone's clock being off can't make a row red. Coming back to the tab, a network the read
  missed (`late`), a read that froze: none of them is the server saying its number again, so none can strike.
- A coin the server made up: its proven `balanceOf` is 0 or fails, so it goes Wrong. A coin the server left out is
  not caught (CROPS §6 allows that).
- Dollars can't be proven (a price isn't on chain). Full means the amount is proven, not the price.
- Signing is unchanged. The preview keeps its own switch and its own rule (never an unchecked answer).

## Steps

### 0. Measure first (half a day)

A script next to `web/tools/light-check.mts`: one proven Multicall3 call (`getEthBalance` + N × `balanceOf`) through
the existing client, N = 1, 20, 50, on Ethereum and Gnosis, on a laptop and a real phone. Record:

- seconds per call, cold (first proof of the page) and warm
- how many node calls one proof makes (`eth_createAccessList`, `eth_getProof` per coin): these go through our
  proxy to Alchemy, so this is the money cost per user per minute
- whether Colibri's prover limits us

Decides: coins per call, how often to re-check, and whether "on for everyone" is affordable. If one call of 20 coins
takes more than about 10 s on a phone, prove fewer per call, biggest first.

### 1. The engine, no UI (1 day)

- `light.ts`: `lightBalances(chainId, wallet, coins[])` → `{ block, time, balances }`. One Multicall3 `eth_call`
  through Colibri per network. Reads go where the wallet's reads go (your node if set, never a fallback to ours).
- `web/lib/safe/proven.ts`: the table above as a small store + `useProven(assets)` hook. Proves the biggest coins
  first; dust and anything under the fold only once it's on screen. Runs when a shown number changes and on a slow
  timer (from step 0) so a hidden spend is caught too. Stops when the tab is hidden.
- `web/tools/proven-check.mts`: the store against a fake portfolio: honest, a new payment mid-proof, a made-up coin,
  a wrong amount, a growing coin, the prover down. No browser.

### 2. The fade on Home (half a day)

- One shared part in `components/bits.tsx`, `<Proven>`, wraps a coin's two numbers. Faded is one CSS value: 60%
  (90% could not be seen on a phone, 11-13). Only the numbers fade, not the logo or name.
- Check it doesn't fight `card assets stale` (the whole card already dims while Home shows a saved portfolio).
- Ship behind a switch that is off, look at it live on a phone, then turn it on for everyone.

### 3. Wrong goes red (half a day)

- The row turns red and shows the proven number, with a red ! by it. No words in the row (Austin 11-13). A tap on
  the ! opens a sheet: our server's number struck out, the network's under it. The total counts the proven number.
- A lying-server test in the browser (`web/tools`, like `relay-ban-check.mts`): the page is fed a wrong amount and a
  made-up coin, and must show red.

### 4. Everywhere a balance shows, and the rule written down (1 day)

- Send's and Swap's coin pickers, Send everything, the total.
- `EXPECTATIONS.md` #1 and #2 (a balance is `<Proven>`), a `same-check.mjs` rule that fails on a balance drawn
  without it, and `CROPS.md` §6 "Now".
- Settings: one switch to turn the checking off, next to the preview's.

### Later, not in this plan

- The preview checked in this browser by default (today it's opt-in, and the wedgie's coins still come from clear-sim).
- A second prover.
- Base and the other networks: parked, see the note at the top of `light.ts`.
- Activity (could be proven through receipts and logs).

## Decisions for Austin

1. **Networks that can't be checked.** Recommended: one rule, full means proven, so Base's coins stay faded for
   good and a tap says why. The other way (Base left full, with a small "not checked" label) makes full mean two
   things.
2. **Positions and collectibles.** They come from Zerion and can't be proven this way. Recommended: leave them as
   they are in this build, and say so in CROPS.
3. **The total.** It mixes proven and unproven coins and an unproven price. Recommended: never faded.
4. **On for everyone, or a setting.** Recommended: on for everyone, if step 0 says the node cost is small.

## Estimate

About 3 to 4 days, a guess. Step 0 is the one that can move it.
