# Swap — stage 2 plan

Austin, 2026-10-06: a **Swap** button under the balance (next to Receive) that swaps **any asset on any network to
any other asset on any network**, in our own swap UI. Stage 1 (shipped): the button exists and says "coming soon";
Send moved onto each asset row (green paper airplane).

## What the user sees

1. **Swap** → a sheet: **From** (an asset you hold, chain shown, amount + Max) and **To** (any token on any of our
   chains, searchable, popular ones first: ETH, USDC, USDT, WETH, cbBTC/WBTC, DAI on Base and Ethereum).
2. A live quote under it: "You get ≈ 0.0123 ETH on Ethereum", minimum after slippage, the rate, our network fee,
   the bridge/DEX fee, time ("~20 s" / "~2 min"), price impact (red over 2%). Quote refreshes every ~20 s; a
   stale quote can't be signed.
3. **Swap** (green) → the same signing as Send: Face ID alone inside the daily budget, the owners over it.
4. Progress: "Swapping…" → for cross-chain, "Sent from Base, arriving on Ethereum…" → "Done" + toast; the asset
   list refreshes on both chains.
5. Also reachable from an asset row later (long-press or a ⇄ next to the airplane) with From pre-filled.

## Where quotes come from: two sources, best price wins

Austin, 2026-10-06: quote both and take whichever gives more; Uniswap is also the fallback when LI.FI is down.

1. **LI.FI** (`li.quest/v1/quote`): one API for same-chain DEX aggregation and cross-chain bridges/solvers
   (Relay, Across, Stargate, …), returns a ready `transactionRequest` + `approvalAddress`. Convenient, **not
   decentralized**: a company's API (can rate-limit, geo-block, screen, disappear) and an upgradeable diamond
   contract (exploited July 2024 through a new facet that drained infinite approvals — our exact-amount approvals
   reset to 0 in the same tx are why that can't hit us). Quoted through our own `/api/swap/quote` (key
   server-side, response validated before the browser sees it).
2. **Uniswap, straight on chain** (same-chain only): quote with QuoterV2 via plain RPC calls, from the browser —
   no API, no key, nothing to go down but an RPC. Execute through the Universal Router (recipient = the Safe,
   `amountOutMinimum` from the quote and slippage). Try the common fee tiers (0.05 / 0.3 / 1%) and one hop through
   WETH or USDC.

**Picking:** fetch both in parallel (same-chain); compare what lands in the wallet **after** every fee (DEX/bridge
fees, LI.FI's integrator fee if any, our relay fee — the Uniswap path's batch is smaller, so its gas is cheaper);
show the winner with a small "via Uniswap" / "via LI.FI (Across)" line. If LI.FI times out (~3 s) or errors, the
Uniswap quote is the answer. Cross-chain has no decentralized equivalent of the same quality: when LI.FI is down,
offer the official Base bridge (Ethereum → Base in minutes; Base → Ethereum takes 7 days — said plainly) or
"try again later".

Decide: take an integrator fee through LI.FI (e.g. 0.25%) or not.

## How a swap executes (a Safe batch, through our relay)

One Safe tx via MultiSendCallOnly 1.4.1 (the same path as Send, `lib/safe/send.ts`):

    [ approve(approvalAddress, exact amount) ]   — ERC-20 only
    call LI.FI diamond (transactionRequest.data, value)   — or Uniswap Universal Router
    [ approve(approvalAddress, 0) ]              — no allowance outlives the tx
    fee transfer to the relayer                  — as today (USDC or ETH)

Checks before signing (in the browser) and again in the relay:
- `toAddress` / receiver in the quote = **this Safe's address** (same address on every chain — counterfactual is
  fine: funds land and the Safe deploys there on its first send).
- `to` = the LI.FI diamond for that chain (pinned list), `fromAmount` = what the user typed, `toAmountMin` matches
  the slippage shown.
- The wedgie screen: it decodes MultiSend already; the diamond call shows as "contract call to LI.FI, value X" —
  add a LI.FI selector table to the wedgie decoder later.

**Relay guard** (`lib/safe/relayGuard.ts`) today refuses arbitrary calls. Add one allowed shape: the batch above,
LI.FI diamond / Universal Router addresses pinned per chain, approvals exact and zeroed in the same batch.

## Who can sign a swap (the hard part)

- **Level 1** (burner is the only owner): Face ID, any size. Works with the plan above as-is.
- **Level 2+, over budget**: the owners (Face ID + hot / wedgie), exactly like a big Send. Works as-is.
- **Level 2+, inside the daily budget (Face ID alone through Zodiac Roles)**: the budget today only allows
  `transfer` of USDC and plain ETH sends. A swap through Roles needs a permission on the LI.FI diamond, and Roles
  can't check where a bridge delivers (receiver is deep in the calldata, different per bridge). Options:
  a. Budget swaps only for same-chain swaps through one router whose recipient Roles *can* pin (e.g. Uniswap
     Universal Router / 0x with recipient = avatar), counted against the USDC/ETH allowance.
  b. A tiny audited-pattern guard contract: the budget key may call it; it pulls the input, calls LI.FI, and
     reverts unless the Safe's balance of the output (same chain) rose by `toAmountMin` — cross-chain can't be
     checked this way.
  c. Swaps always need the owners at level 2+ (simplest; a phone-only user at level 2 can't swap without the
     computer).
  Recommendation: ship **c** first, then **a** for same-chain budget swaps. Cross-chain from the budget stays
  owners-only until there's a design that proves where the funds land.

## Build order

1. `/api/swap/quote` (LI.FI, server-side key, validation) + `lib/safe/uniswap.ts` (QuoterV2 quote + Universal
   Router calls, browser-side) + the best-price pick + token list endpoint (LI.FI `/tokens` for our chains,
   cached, merged with what the wallet holds).
2. `components/safe/SafeSwap.tsx`: the sheet, From/To pickers (reuse SafeSend's asset picker + a token search
   sheet), live quote, slippage (0.5% default, tap to change), review.
3. `lib/safe/swap.ts`: quote → batch calls + checks above; sign through the existing `prepareOwners` /
   `finishOwners` (level 1 and owners paths).
4. Relay guard: the swap shape.
5. Cross-chain status: poll LI.FI `/status` until DONE/FAILED; show "arriving" on the destination chain; a
   refund (bridge failed) shows where the funds went back to.
6. Tests: `tools/safe-e2e.mjs` gets a same-chain USDC→ETH swap on the Base fork with a live LI.FI quote; a
   relay-check case for a swap batch with a wrong receiver (refused) and a leftover approval (refused);
   cross-chain checked once for real with a few dollars (Base USDC → Ethereum ETH).
7. Later: same-chain budget swaps through Roles (option a), wedgie selector table, swap from an asset row.

## Open questions for Austin

- Integrator fee: yes/no, how much?
- Any-token "To" list: show everything LI.FI knows (scam tokens included, with warnings) or a curated list +
  paste-an-address?
- Level 2+ phone-only swaps: OK to need the computer at first (option c)?
