# Fully local: your node, nothing else

The plan for a copy of Instant Wallet that talks only to your own Ethereum node, with the same screens.
`docs/LOCAL-MODE.md` is step one (the local copy itself, done). This is everything after it. Plan only.

## The goal

Run `./run-local.sh`, point it at your node, and the wallet works the same as instantwallet.io: balances,
Activity, prices, send, swap, Earn, positions. No Alchemy, no Zerion, no Vercel. A test proves it: the browser
and the server may only reach your node (and localhost).

## What still calls out today

| Part | Today | Replaced by |
|---|---|---|
| Chain reads, sends | Alchemy, or your node (`RPC_URL_<chainId>`) | your node (done) |
| Which coins you hold (`/api/portfolio`) | `alchemy_getTokenBalances`, metadata | **indexer** |
| Activity | `alchemy_getAssetTransfers` + Safe logs (kit `chainHistory`) | **indexer** |
| NFTs (`/api/nfts`) | Alchemy NFT API | **indexer** |
| Prices | Alchemy prices, Coinbase, DexScreener, DefiLlama | **indexer** (from the chain) |
| Positions (`/api/positions`) | Zerion | **positions service** |
| Coin names, decimals | `alchemy_getTokenMetadata` | `eth_call` on the coin (already the fallback in `/api/explain`) |
| Simulation (coins in and out) | clear-sim | your node: `eth_simulateV1` / `debug_traceCall` |
| Swap quotes | Uniswap API, LI.FI | Uniswap's Quoter contract on your node; cross-chain stays LI.FI (off when local) |
| Earn, Borrow, Stake, ENS, Morpho apps | instant-wallet-apps.vercel.app | your own copy at `https://local.instantwallet.io:4174` (run-local.sh, built 11-25). Still outside, and blocked when No external traffic is on: Morpho's API, LI.FI (cbETH, rETH), ENS's index |
| Apps icons, coin logos | debank, GitHub raw, coingecko... | packed into the repo, fetched once by run-local.sh |
| Balance proofs | Colibri | not needed: it's your node |
| Tx words, wedgie words, shared queue | | done (local clones, local store) |

Never local: Deposit (Coinbase), new names (signed by instantwallet.io), WalletConnect (Reown's relay: the
extension connects sites without it).

## Each service is its own repo

Open source, MIT, one job each, the same JSON the app's routes give today. Anyone can run them; we run our own too,
and instantwallet.io moves onto them (in place of Alchemy and Zerion) once they're good. The app only knows URLs:
`INDEXER_URL`, `POSITIONS_URL`, `QUOTES_URL`. Without one, it works as now.

| Repo | Replaces |
|---|---|
| `iw-indexer` | Alchemy balances, transfers, NFTs, prices |
| `iw-positions` | Zerion |
| `iw-quotes` | Uniswap API (same-chain quotes from the Quoter contracts) |
| clear-sim (exists) | pointed at your node |
| instant-wallet-apps (exists) | run beside the wallet: run-local.sh clones, builds and serves it (its `tools/serve.mjs`) |

## New repo 1: the indexer (`clawdbotatg/iw-indexer`): 0.1 built 11-14

Built: /portfolio (well-known + seen tokens, live balances, Uniswap v3 prices), /transfers, /status; the wallet
uses it per network (`INDEXER_URL`), run-local.sh starts it when you give a node. Same 54 coins and balances as
Alchemy on a test wallet.

Test suite first (iw-indexer `test/wallets.json`: 92 wallets, well-known people + active traders on Ethereum, Base,
Arbitrum, Optimism; `test/suite.ts` compares each with Alchemy). Every new piece is checked on all of them. Then, in
order: **Activity**, **NFTs**, **prices on networks without Uniswap v3** (Gnosis, Sonic, HyperEVM, Plasma,
Robinhood), then v4 pools and Chainlink. The positions service gets the same suite (vs Zerion).

One process, one SQLite file, reads only your node. It watches the wallets you open (the app tells it, the same
way the app tells the relay today), per chain.

- **Backfill**, from the Safe's first block: `eth_getLogs` for ERC-20 / ERC-721 / ERC-1155 `Transfer` to or from the
  wallet, and the Safe's own events (`SafeReceived` = coin in, `ExecutionSuccess`, module calls). Then follow new
  blocks. Handles reorgs (keep the last 64 blocks' hashes, redo on a change).
- **Balances**: every token it has seen move, read with `balanceOf` (logs miss rebasing coins like stETH; the read
  doesn't). Native coin: `eth_getBalance`.
- **Activity**: the same rows the app shows now (kit `moves` / `moved`), from the stored logs.
- **Prices**, from the chain: Chainlink feeds for the big ones (ETH, BTC, stables); else the deepest Uniswap v3/v4
  pool against USDC or WETH (`slot0`, checked against a short TWAP so one block can't fake it). No pool with real
  liquidity: no price, and the coin counts as spam (same rule as today: no price, hidden under "more").
- **Metadata**: name, symbol, decimals by `eth_call`, kept forever.
- **API**: the same JSON as the app's routes today (`/portfolio`, `/activity`, `/nfts`, `/price`), so the app only
  swaps a URL: `INDEXER_URL`. Without it, the app works as now.

Size: a wallet's history is small (thousands of logs), so backfill is minutes, not days. `eth_getLogs` over big
ranges needs a node that allows it (reth, erigon, geth with a raised limit); the indexer pages by block range.

## New repo 2: positions (`clawdbotatg/iw-positions`)

Zerion's job, for the protocols our apps use. Its own repo: other wallets can use it too. One adapter per protocol, each a few `eth_call`s:

- Aave v3: `getUserAccountData` + the aToken and debt-token balances.
- Compound v3 (Comet): `balanceOf`, `borrowBalanceOf`, `collateralBalanceOf`.
- Morpho: vaults (ERC-4626 `balanceOf` → `convertToAssets`), and Morpho Blue market positions.
- Spark: Aave v3's adapter, its addresses.
- Lido (stETH, wstETH), Coinbase cbETH, Rocket Pool rETH: a balance and the rate.
- Uniswap v3 / v4 LP NFTs: the position's range and amounts.
- Later: Balancer, Aerodrome, Venus.

Which contracts to ask: the indexer's token list (aTokens, vault shares and LP NFTs show up as tokens the wallet
holds), so nothing is scanned blind. Same JSON as `/api/positions` today: `POSITIONS_URL`.

## New repo 3: quotes (`clawdbotatg/iw-quotes`)

Same-chain swap prices from the chain: Uniswap v3 / v4 Quoter contracts (and Aerodrome on Base), best route over a
few pools, built into the same Universal Router call the Swap sheet signs today. Cross-chain stays LI.FI (off when
local).

## In this repo

1. **Only-your-node mode**: `LOCAL_ONLY=1` (set by run-local.sh when you give a node and no Alchemy key). Every
   route that calls a service checks it and uses the local source or says "off on this copy".
2. **The test**: `tools/local-e2e.mjs` with `LOCAL_ONLY=1` blocks every request that isn't localhost or the node
   (browser: Playwright route; server: a fetch guard) and fails on any. Then: balances, Activity, a price, a send,
   a swap, an Earn deposit and its position, all on a fork.
3. **Simulation on your node** (clear-sim with your node's URL), icons packed, instant-wallet-apps started by run-local.sh.
4. **run-local.sh** clones and starts each service repo, like it does the descriptor repos.

## Order

1. Only-your-node mode + the test (it lists what's left, and keeps it from coming back).
2. Indexer: balances and Activity.
3. Indexer: prices.
4. Quotes repo, simulation, icons, the apps site: the rest of the same screens.
5. Positions service: Aave, Morpho, Compound, staking first (what Earn, Borrow and Stake ETH make).
6. NFTs.

## The node

You bring it: one per chain you use (Ethereum ~2 TB with reth; Base about the same). run-local.sh finds it on
:8545 and asks for others. A node box on your network works too. Running the nodes is not this project's job.

## Open questions

- One indexer for many people (a family's box), or always one per person? Start with one per computer; ours on the
  server serves everyone.
