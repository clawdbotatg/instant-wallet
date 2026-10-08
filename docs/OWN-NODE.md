# Own node (idea, not built)

One setting for people who don't want to depend on us or Alchemy: **"My node: <URL>"** per network. Point it at a
node you run, and the app reads everything from it directly: balances, tokens, previews, prices. Alchemy through
our server stays the default.

## What we use today

| Need | Today | Where |
|---|---|---|
| Chain reads (owners, threshold, nonce, roles) | Alchemy via `/api/rpc/[chain]` | `lib/rpcServer.ts`, `lib/safe/state.ts` |
| Which tokens you hold | `alchemy_getTokenBalances` | `app/api/portfolio/route.ts` |
| Token name, symbol, logo | `alchemy_getTokenMetadata`, DexScreener for logos | same |
| Prices | Alchemy Prices API, DexScreener for the long tail | same |
| Swap quotes | Uniswap quoter on chain, LI.FI | `app/api/swap` |
| Send a transaction | our relay (`/api/safe/relay`) pays gas | `app/api/safe` |
| Preview before signing | none | — |

## With your own node

All of it comes from standard JSON-RPC, called from the browser straight to your node (no server of ours in
between):

- **Chain reads:** the same calls, different URL. Easy.
- **Tokens you hold:** no indexer needed. `eth_getLogs` for `Transfer(_, you)` across all token contracts from the
  wallet's creation block, then `balanceOf` on each token found. Cache what's been scanned (last block per network)
  in the browser, so later loads only scan new blocks. Fast on your own node; too slow on public RPCs (block range
  limits), which is why it's an own-node feature.
  - Erigon also keeps an address index (`ots_searchTransactionsBefore`, the Otterscan API), which can be faster
    than a log scan. Use it when the node has it.
- **Name, symbol, decimals:** `symbol()`, `name()`, `decimals()` on the token. Logos: a token list (Uniswap's,
  hosted anywhere or bundled), else the first letter.
- **Prices:** Uniswap pool reads on chain (USDC / WETH pairs), as Swap already does. No price for tokens without
  a pool.
- **Preview (simulation):** `eth_simulateV1` (geth, reth, Nethermind) runs the Safe transaction against the
  latest state and returns logs and balance changes. Show "you send X, they get Y, your balance after: Z" before
  you sign. Fallback: `debug_traceCall`, or a local anvil fork of your node.
- **Sending:** could submit straight to your node with your own gas (a hot wallet pays), skipping the relay. Or
  keep the relay. Both are options in the setting.

## Settings screen

Under the keys, a short "Advanced" section:

- **Node (Base)** / **Node (Ethereum):** URL, plus a check button (chain id matches, `eth_simulateV1` supported,
  how far back logs go).
- What it turned on: ✓ balances ✓ tokens ✓ preview ✓ prices.
- Stored in the browser only. Nothing goes to our server.

## Open questions

- A browser calling a local node needs CORS (geth `--http.corsdomain`). The check button should say so.
- The first token scan on a wallet with a long history can take a while: show progress, and start from the
  wallet's creation block.
- Should the preview also work on the default setup? Alchemy supports `eth_simulateV1` too, so likely yes:
  build the preview first, for everyone, then the node URL.

## Order

1. Preview before signing (works on Alchemy too).
2. Node URL setting for chain reads.
3. Token scan + on-chain prices from your node.
4. Send without the relay.
