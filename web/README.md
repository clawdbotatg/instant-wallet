# Instant Wallet v3 — the website

One page, phone-first: Face ID makes a passkey, the passkey owns an InstantWallet v3.1 (`packages/foundry`),
same address on Base and Ethereum. Scan or type an address / ENS, pick a token (or Everything), amount, Face ID,
sent. Every send is one ERC-4337 op through `/api/bundler/<chain>` (Pimlico's public bundler by default); the
network fee is paid in **USDC** by Circle Paymaster, so the wallet never needs ETH. Sending is Base-only until the
contracts are deployed on Ethereum (`SENDABLE` in `lib/chains.ts`). Plan: `docs/V3.md`.

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
| `ALCHEMY_API_KEY` | server only: RPC, token balances, prices |
| `BUNDLER_URL_8453` | optional: a keyed bundler URL, or `self` (+ `BUNDLER_PRIVATE_KEY` with a little ETH) to bundle ourselves |

Contract addresses are constants in `lib/chains.ts` (CREATE2, the same on every chain).

Passkeys are bound to the hostname: keys made on a preview URL won't work on instantwallet.io.

## Local end to end

On a fork of Base (real EntryPoint, Circle Paymaster, USDC; `--network optimism` = the P-256 precompile), with
this route bundling itself:

```sh
anvil --fork-url <base rpc> --network optimism &
NEXT_PUBLIC_CHAINS=8453 BASE_RPC_URL=http://127.0.0.1:8545 BUNDLER_URL_8453=self \
  BUNDLER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  LOCAL_TOKENS_ONLY=1 LOCAL_TOKENS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 npx next dev -p 3100 &
CHROME=<chromium binary> node tools/e2e.mjs /tmp/shots   # virtual passkey: create, send USDC / ETH / everything, re-login, link
```

`tools/aa-live.mjs` does one real send on Base through Pimlico with a raw P-256 test key.
