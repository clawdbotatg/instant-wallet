# App store: Safe Apps inside Instant Wallet (research, 2026-10-28)

**Answer: yes, it works without asking Safe for anything.** A Safe App is a normal website that talks to its parent
page through `postMessage` (the Safe Apps SDK). Any page that answers those messages is a Safe, as far as the app
knows. Our wallet *is* a real Safe, so we can answer them with real data. Nothing is built yet.

There are two gates, and neither one is Safe's:

1. **The app's own frame headers** (`frame-ancestors`): may our page frame it at all?
2. **The app's connector**: does it accept messages from a parent that isn't app.safe.global?

Safe's app list has an `accessControl` field, but it only hides apps from *Safe's listing* for some hosts. It blocks
nothing in the browser. There is no shared allowlist of host wallets, so there's no one place to PR our domain into.
Getting into a locked app means asking that app's team.

## What we found

**Headers** (all 55 listed apps on Ethereum/Base/Gnosis, full table: `docs/APP-STORE-HEADERS.md`):

| | count | apps |
|---|---|---|
| open to any site | 32 | CoW Swap, Aave, Aerodrome, Balancer, Curve, Lido, Spark, Superfluid, Snapshot, Revoke, Velora, Squid, Rango, DeFi Saver, Summer.fi, LlamaPay, Transaction Builder, CSV Airdrop, Zodiac ×3, Gnosis Bridge… |
| only Safe + named partners | 22 | Uniswap, 1inch, Compound, ENS, Morpho, Pendle, Sushi, Yearn, Sky, Sablier, Hedgey, Jumper, Fluid, KyberSwap, Monerium, Request… |
| blocked everywhere | 0 | |

The locked apps already list other hosts (Hedgey ~20: Den, Optimism's and Linea's Safe forks, Blockscout; Sablier:
impersonator.xyz; Jumper/Arcadia: base.app, Farcaster). So teams do add hosts when asked.

**Connectors** (read from source):

| connector | accepts our page? |
|---|---|
| wagmi `safe()`, RainbowKit `safeWallet`, **Scaffold-ETH 2**, safe-apps-react-sdk | **yes**: no origin filter by default |
| Uniswap | no: hard-coded `app.safe.global` |
| web3-onboard gnosis module | no: Safe + Blockscout + Zodiac Pilot only |
| Reown AppKit | no: only turns the Safe connector on if the parent is app.safe.global |

Any app that copied the SDK README's `allowedDomains: [/app.safe.global$/]` also drops us. Headers can't show that;
we only find out by loading the app. **So every app in our store gets a real connection test, not a header check.**

**Scaffold-ETH 2:** no frame headers, has `manifest.json`, RainbowKit `safeWallet` with no origin filter. So every
SE-2 build should work in our store as-is (read from code, not run yet).

## The protocol (what our host must answer)

The app sends `{ id, method, params, env: { sdkVersion } }` to `window.parent`. We reply
`{ id, success, version, data | error }` to the frame. Rules that silently break it if missed:

- Our page must be the frame's **direct parent**. Check `e.source === frame.contentWindow` and
  `e.origin === new URL(appUrl).origin`; reply with `postMessage(msg, thatOrigin)`.
- Every reply needs `version` "1.x" or later (send "9.1.0"), or the app drops it.
- **wagmi gives `getSafeInfo` 10 ms** to answer. Answer it straight from memory, never after a fetch.

| method | our answer |
|---|---|
| `getSafeInfo` | address, chainId, owners, threshold, nonce, modules, guard, version, `isReadOnly: false`. Fixed per open: the app can't switch networks, so pick the network before opening |
| `getChainInfo`, `getEnvironmentInfo`, `getCurrentTheme` | from config |
| `rpcCall` | pass through to our Alchemy client (a fixed list of read methods) |
| `sendTransactions` `{txs}` | the same card as a WalletConnect batch: owner-signed, relayed, our fee. Reply `{ safeTxHash }` |
| `getTxBySafeTxHash` | `{ txStatus, txHash }` from our own record of what we relayed. The app's provider uses this to find the receipt |
| `signMessage`, `signTypedMessage` | `signForSite` (1271 / 6492), reply `{ messageHash, signature }` |
| `getSafeBalances` | our balances read |
| `requestAddressBook`, `wallet_*Permissions` | empty |

Safe frames with `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms
allow-downloads"`. Copy that.

## How it fits Instant Wallet

It's a third front door to the request card we already have. WalletConnect and the extension both feed
`toPending()` → the queue in `components/WalletConnect.tsx`. The extension uses topic `ext:<rid>`; Safe Apps would
use `app:<id>` the same way (`lib/safeapps.ts`, next to `lib/extension.ts`). Same review, same keys, same relay
rules (never calls into the wallet itself), same `signForSite`. Face ID runs on our page, not in the frame.

Plan, smallest first:

1. **`/apps` page + host.** A curated grid of the open apps on Base/Ethereum, the network picker on top, and "add
   any URL" (needs a valid `manifest.json`, shows "not checked by us"). Tap an app → full-screen frame with our
   header. Every SE-2 build works here for free.
2. **Test each listed app for a real connect + one send** on a fork (a probe like `tools/safe-wc-e2e.mjs`). Only
   list the ones that pass.
3. **Ask the locked apps** for our domain, starting with the ones that already add hosts: Hedgey, Sablier, Jumper,
   1inch. One-line PR or email each. Until then they show as "open with WalletConnect" (already built).
4. Don't apply to Safe's official list: it doesn't unlock anything for us.

**Decide first:** which domain is the store's home (instantwallet.io, xdai.io, or both). Each one is a separate line
on every app's allowlist, and passkeys are bound to the hostname anyway.

**Also worth doing (separate):** our wallet pages send no `frame-ancestors`, so any site can frame the wallet.
Passkeys can't sign in a cross-site frame without `allow=`, but we should send `frame-ancestors 'self'` anyway.

## Other iframe standards (checked, not worth chasing)

Farcaster mini apps (EIP-1193 over postMessage, only works if the app loads their SDK), Ledger Wallet API (apps
must integrate it on purpose), EIP-6963 (the parent can't announce into a cross-origin frame). The Safe Apps SDK is
the one iframe protocol most dapps already ship.

Sources: safe-apps-sdk `communication/index.ts`, `methods.ts`; safe-apps-provider `provider.ts`; safe-wallet-monorepo
`AppCommunicator.ts`, `useAppCommunicator.ts`, `useCustomAppCommunicator.tsx`, `SafeAppIframe.tsx`, `manifest.ts`;
wagmi `connectors/src/safe.ts`; Uniswap `wagmiConfig.ts`; AppKit `CoreHelperUtil.ts`; list API
`safe-client.safe.global/v1/chains/{id}/safe-apps` (needs a browser User-Agent).
