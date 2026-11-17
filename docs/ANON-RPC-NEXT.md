# Tor: next steps

What's built is in `docs/ANON-RPC.md`. In this order:

## 1. Test a real send over Tor (Austin)

Only the relay's quote has been tested over the .onion, not a send.

1. On the local copy: `git pull`, `./run-local.sh` (or `--install` again).
2. Settings → Your node → Ethereum → paste the bgnodetest3 `.onion` → Save.
3. Settings → Your relay: needs about $5 of ETH on Ethereum.
4. Send a little ETH. Expect it to land, with `POST /api/local/tor` and `/api/safe/relay` in the log, and no
   `alchemy.com` call for the send.

## 2. Pin the Tor code's hash

**Why:** the harness runs whatever code the tor-js contract (`0x700dA319…659e`) points at. One EF key can change it,
and every wallet runs the new code the next time it loads.

**Plan:** in `web/lib/tor.ts`, the `rpcProvider` passed to the harness checks the answer to `workerHash()`
(`eth_call` to the contract, data `0x3898587d`) against our own constant. A different hash throws: Tor doesn't start
and reads fail, with no fallback to our proxy.

- Today's hash (tor-js 0.4.4, read 2026-11-17): `0x5b62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b`
- When the EF ships a new tor-js: read its changelog, update the constant, push.
- Also ask the EF for a timelock or multisig on the contract.
- Local copies don't need it: their server runs tor-js from npm, pinned in `package.json`.

Size: one function, a few lines. Test: change one digit in the constant, and Tor must refuse to start.

## 3. Run our own gateway

**Why:** on instantwallet.io, the browser reaches Tor through the EF's demo gateway (`152.236.3.22`). It says it may
go away at any time, and it has little capacity. Local copies don't use a gateway.

**Plan:** one Linux box with a fixed public IP and one open UDP port (12298). Steps: `~/anonrpc/GATEWAY-RUNBOOK.md`
(`cargo install`, `tor-js-gateway init`, `install` as a service). It sees only encrypted Tor traffic and isn't an
exit node. Then put its address first in `GATEWAY` in `web/lib/tor.ts`, keeping the EF's as the second.

Cost: a small VPS. Better later: BG node operators run gateways too, and the wallet lists several.

## 4. Stop Alchemy seeing who you are

**Why:** with a .onion set, these still go to Alchemy (with your IP on a local copy, through our server on ours):
tokens you hold, Activity (`alchemy_getTokenBalances`, `alchemy_getAssetTransfers`, `alchemy_getTokenMetadata`),
prices, NFTs.

**Plan:**
- Local copy: the indexer (Settings → Balances and prices, iw-indexer) already reads coins and prices from your
  node. Point it at the .onion too (it needs Tor: reuse `lib/torServer.ts`'s approach), and move Activity to it.
- Our site: the log scan in `docs/OWN-NODE.md`: `eth_getLogs` for transfers to and from the wallet, over Tor.
  Tested on the onion (2000 blocks a call). Slow for an old wallet, so start from the wallet's first block.
- Prices: ask for all coins at once, never one address's list.

## 5. More nodes

**Why:** there is one node (bgnodetest3, on Austin's network). If it's down, Ethereum reads fail.

**Plan:**
1. Merge `--tor` into the BG client ([PR #70](https://github.com/BuidlGuidl/buidlguidl-client/pull/70)).
2. A list of node `.onion` addresses, signed by BG (or on chain). The list can't change answers, only point to
   nodes.
3. Settings → Your node: a "BuidlGuidl nodes over Tor" choice that picks from the list and moves to the next one if
   a node doesn't answer (only to other .onion nodes, never to our proxy).
4. Base and Gnosis: nodes for those chains with their own `.onion`.
