# Networks

Added 2026-10-08. The wallet runs on 14 networks, same address on all of them:

Base, Ethereum, Arbitrum, Optimism, Robinhood, Polygon, Avalanche, BNB Chain, Gnosis, Celo, Sonic, HyperEVM,
Plasma, Arc.

The list lives in `web/lib/chains.ts`. Vercel's `NEXT_PUBLIC_CHAINS` picks which are on (now all 14).

## How a network gets on the list

It must have all three:

1. **The Safe contracts at their usual addresses**: Safe 1.5.0, the passkey signer, Candide recovery, Zodiac Roles
   (every address in `web/lib/safe/config.ts`). Same contracts at the same addresses = same wallet address.
2. **Alchemy**: the Alchemy app "instantwallet" (BuidlGuidl team) has it turned on. Key `ALCHEMY_API_KEY` in
   Vercel and `web/.env.local`. Alchemy has 33 Safe networks on; only the 14 below have every contract.
3. **LI.FI**: so swaps and bridges work there.

Not added yet (Safe is there, but some passkey/recovery/Roles contracts aren't; deploy them once to add):
World Chain, Berachain, Linea, Unichain, Monad, Scroll, Mantle, MegaETH, Tempo, Ink, X Layer, Sei, opBNB, Stable,
Katana, Kaia, Pharos. Rise and ADI are on Alchemy but not LI.FI. zkSync, Abstract, Sophon, Lens can never match
the address.

## Per network

| | fee + daily limit coin | USDC |
|---|---|---|
| Base, Ethereum, Arbitrum, Optimism | ETH | yes |
| Robinhood | ETH | none (fees in ETH) |
| Polygon, Avalanche, Gnosis, Celo, Sonic, HyperEVM | POL, AVAX, xDAI, CELO, S, HYPE | yes |
| BNB Chain, Plasma | BNB, XPL | none (BNB's USDC has 18 decimals) |
| Arc | USDC is the gas coin; the native balance is hidden (it's the USDC token again) | yes |

Swap's default "To" list on each network: its coin, USDC, and its most traded tokens (`MORE` in
`web/lib/safe/swap.ts`, picked by pool size and checked on chain 2026-10-08). Search finds anything else.

The burner's native daily limit is about $100 of the coin (`nativeBudget` in `chains.ts`).

Not set up yet: the DAO recovery wallet (dao.buidlguidl.eth) only exists on Base, Ethereum, Arbitrum, Optimism,
Polygon, Gnosis. On the other 8 networks recovery won't work until that Safe is deployed there.

## Relay gas

The relay (`0x4cFaB32186e65E2A39EC0e882e11380cbf2f8A2f`) pays gas on every network, so it needs a little of each
native coin. It gets paid back in each send's fee.

Top it up with `web/tools/fund-relay.mts`:

```sh
cd web
npx tsx tools/fund-relay.mts          # dry run: the relay's balance on every network, what it would send
npx tsx tools/fund-relay.mts --go     # send
TARGET_USD=10 npx tsx tools/fund-relay.mts --go   # a bigger target (default $5 per network)
```

- It sends from a funder wallet on Base: `0x6F608b04253eDA56Ce0C123bFE3814D21f5df1bd`. Fund it with ETH on Base.
  Its key is `~/.instant-wallet-funder.key` on Austin's machine (outside the repo, never commit it).
- Base gets ETH directly. Every other network gets its native coin through LI.FI (bridge + swap), paid straight to
  the relay. Only networks under the target get sent anything.
- A network sent to in the last 30 min is skipped (log: `~/.instant-wallet-funder.key.sent.json`). Arc's bridge
  takes ~20 min; running twice before the log existed sent Arc $5 twice.
- Celo's native coin is named by its token contract on LI.FI (`NATIVE_TOKEN` in the script). Squid adds ~1% fee on
  top of the amount; the script allows up to 5%.

First run, 2026-10-08: $5 to each of the 12 new networks from 0.027 ETH.
