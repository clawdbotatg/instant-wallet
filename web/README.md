# Instant Wallet — the website

The live app: a passkey wallet on a Gnosis Safe, same address on 14 networks. What's built: `../docs/SAFE-APP.md`.

```sh
npm install
npm run dev            # http://localhost:3000
npx tsc --noEmit       # types (CI runs this on every push)
node tools/same-check.mjs   # EXPECTATIONS.md #2, before pushing a UI change
```

## Vercel

Root Directory `web`, framework Next.js. Push to main deploys. Passkeys are bound to the hostname: a key made on a
preview URL won't work on instantwallet.io.

## Env

Names only. Values live in Vercel and in `web/.env.local` (gitignored).

| var | for |
|---|---|
| `ALCHEMY_API_KEY` | every chain read, balances, prices. Server only; browsers go through `/api/rpc/<chain>` |
| `RELAYER_PRIVATE_KEY` | the relay's key (pays gas, gets the fee) |
| `RELAY_KV_URL`, `RELAY_KV_TOKEN` | Upstash: relay limits, alerts, drops, the shared tx queue |
| `NEXT_PUBLIC_CHAINS` | optional. All 14 by default; `8453,1` for a few; `31337` for a local anvil |
| `BASE_RPC_URL`, `MAINNET_RPC_URL`, `LOCAL_RPC_URL` | optional: another RPC for that chain (a fork, in tests) |
| `SAFE_API_KEY` | Safe's transaction service (shared transactions) |
| `LIFI_API_KEY` | Swap quotes |
| `ZERION_API_KEY` | positions |
| `NEXT_PUBLIC_WC_PROJECT_ID` | WalletConnect |
| `NEXT_PUBLIC_APPS_URL` | optional: where the Apps list comes from |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Deposit with Coinbase |
| `ALERT_MAIL_USER`, `ALERT_MAIL_PASS`, `ALERT_SITE` | recovery alerts by email |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NAME`, `TELEGRAM_WEBHOOK_SECRET` | recovery alerts by Telegram |
| `NEXT_PUBLIC_VAPID_KEY`, `VAPID_PRIVATE_KEY` | recovery alerts by push |
| `DROP_SECRET`, `DROP_ADMINS` | drops (`../docs/DROPS.md`) |
| `LOCAL_TOKENS`, `LOCAL_TOKENS_ONLY`, `NEXT_PUBLIC_LOCAL_TOKENS`, `NEXT_PUBLIC_TEST_FEE_ALLOWANCE` | tests on a fork only |

## Tests

The table in `../docs/SAFE-APP.md` ("Tests"). Each tool's header says how to set it up. The tools that say
`npx tsx` need nothing installed.
