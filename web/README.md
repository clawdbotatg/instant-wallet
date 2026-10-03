# Instant Wallet v3 — the website

One page, phone-first: Face ID makes a passkey, the passkey owns an InstantWallet v3 (`packages/foundry`),
same address on Base and Ethereum. Scan or type an address / ENS, pick a token, amount, Face ID, sent.
Gas is paid by your **gas key** (a little ETH; PRF-derived from the passkey where supported). Plan: `docs/V3.md`.

```sh
npm install
npm run dev            # http://localhost:3000
npm run abi            # after `forge build`: refresh lib/abi.ts
```

## Vercel

New project, **Root Directory `web`**, framework Next.js, defaults otherwise. Env:

| var | value |
|---|---|
| `NEXT_PUBLIC_CHAINS` | `8453,1` |
| `NEXT_PUBLIC_FACTORY_ADDRESS` | v3 Factory (same on every chain) |
| `NEXT_PUBLIC_IMPLEMENTATION_ADDRESS` | v3 InstantWallet implementation |
| `ALCHEMY_API_KEY` | server only: RPC, token balances, prices |

Passkeys are bound to the hostname: keys made on a preview URL won't work on instantwallet.io.

## Local end to end

```sh
anvil &
(cd ../packages/foundry && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
# .env.local: NEXT_PUBLIC_CHAINS=31337, the two addresses it printed, NEXT_PUBLIC_LOCAL_TOKENS=<MockUSDC>
npx next dev -p 3100 &
CHROME=<chromium binary> node tools/e2e.mjs /tmp/shots   # virtual passkey: create, fund, send x2, re-login, link
```
