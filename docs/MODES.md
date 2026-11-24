# Two modes: mountain man and finance bro

Austin, 2026-11-24. One wallet, two ways to run it. Read this before any CROPS, privacy, proving or rate-limit work.

| | Mountain man | Finance bro |
|---|---|---|
| Where | a copy on your own computer (`./run-local.sh`, local.instantwallet.io) | instantwallet.io, the iPhone app |
| Goal | as CROPS as possible | very smooth |
| Checking and privacy | all of it, the hard way | what's free or nearly free |
| Cost of that | yours: more calls to your own node, slower, red when a proof can't be had | must not show: no slower screen, no hitting our rate limits |

CROPS = Censorship Resistance, Open source, Privacy, Security. The plan against EF's criteria: `docs/CROPS.md`.

## The rules

1. **The local copy is where we score CROPS.** Anything that makes the wallet check more, trust less or leak less
   goes there first, on by default, even when it's slow or costs 600 node calls an hour. Those calls go to the
   person's own node, which is what they want.
2. **The site stays smooth.** A change there may not add a wait, a red screen that depends on someone else's server
   being up, or node calls that eat our limits (Alchemy bill, `/api/rpc` per-IP limits: `EXPECTATIONS.md` #6). It
   still does every cypherpunk thing that costs nothing: clear signing, the raw bytes, no tracking of what you do,
   fail closed.
3. **A mode only picks defaults.** Every switch it sets can be flipped by hand, in either mode, and a switch someone
   flipped stays as they left it. Nothing is locked to a mode unless it can't work there (see the second table).
4. **Either mode can be picked anywhere.** Settings → Mode → "Mountain man mode". On by default on a local copy, off
   on the site. Flipping it reloads the page.
5. **No new UI for it** beyond that one switch. No badge, no banner (`EXPECTATIONS.md`, and "A Local mark: none").

## In the code

- `web/lib/mode.ts`: `mode()`, `mountain()`, `setMode()`, `proveByDefault()`. Kept in this browser (`iws.mode`), only
  when it differs from the place's default.
- **A new setting that trades smooth for checked reads its default from `lib/mode.ts`, never from `isLocal()`.**
  `isLocal()` is for things that need the local server (the second table).
- `npx tsx web/tools/mode-check.mts`: what each mode turns on, and that a hand-set switch wins.
- Add every new mode-driven setting to the first table below, and to that check.

## What the mode sets (defaults, each can be flipped)

| Setting | Mountain man | Finance bro | Why bro is off |
|---|---|---|---|
| Prove balances (Settings → Your node; Ethereum, Gnosis) | on | off | about a node call per coin per round, ≈600 an hour on our Alchemy key |
| Run a light client for the signing preview (same place) | on | off | if the prover is down, every signing there is red with no coins; not timed on a phone |

With **No external traffic** on, both stay off unless turned on by hand: a proof needs a prover and Colibri's is
outside. Set your own prover and turn them on.

## What only a local copy can do (needs its own server, not a mode switch)

| Thing | Local copy | Site |
|---|---|---|
| Relay | your own (Settings → Your relay), or your browser wallet executes | ours |
| Coins, prices, Activity, NFTs | your own indexer on your node | Alchemy through our server |
| Simulator | the one on your computer first | sim.instantwallet.io |
| Swaps | Uniswap from your node; LI.FI only when it must, marked "sees your wallet" | Uniswap + LI.FI |
| No external traffic | a setting | not there |
| Your node over Tor | from your computer, no gateway | from the browser, through a gateway |
| Page-visit counts (Plausible) | never loaded | on for now (to be removed) |
| Drops, new names, alerts, Deposit | off | on |

## To do (not built)

- Move more into the first table as it's built: logos packed in the app, staggered reads per network, a relay URL.
- Bro mode proving "within sane limits": prove only the few biggest coins, or only before a send, once proofs can
  come from BuidlGuidl nodes and not our Alchemy key.
- The sheet's "a protection is off" mark. If it goes on Home, it goes at the very bottom.
