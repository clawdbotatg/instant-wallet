# One codebase, four surfaces

| surface | what ships | how the user gets it | status |
|---|---|---|---|
| **Phone, today** | `packages/nextjs` as an installable PWA | open the URL in Safari/Chrome, *Add to Home Screen* | built; passkeys, camera QR, standalone mode |
| **App Store** | the same site inside a Capacitor shell (`packages/mobile`) | App Store / TestFlight | scaffolded; needs Xcode + an Apple team, and the native passkey plugin |
| **Desktop wallet** | the same app at ≥1024px (sidebar + send rail, see `design/mockups/Desktop.png`) | the URL, or a Tauri/Electron shell around it later | built (web); shell not started |
| **Website** | the same deployment | the URL | same build |

The rule that keeps this honest: **there is one UI codebase.** The phone, the desktop wallet and
the website are the same Next.js app rendered at different widths. The App Store app is that app
in a native window. Components are shared because there is nothing to share them between.

## Why not React Native / Expo

Passkeys, the camera, and the device queue are all browser APIs that work in Safari and in a
WKWebView (via a small native bridge for passkeys). A native rewrite would give us a second UI
to keep in sync with the mockups and two places for every bug in the signing flow. If a native
surface is ever needed (widgets, NFC, background pairing), Capacitor plugins get there without
leaving this codebase.

## Deployment

- **Host:** Vercel project `instant-wallet` (team buidlguidldao), root directory `packages/nextjs`.
  Production domain `instantwallet.io` is on that project and still serves an older deployment;
  it is not replaced until someone pushes to the linked `main` on purpose.
- **Preview / beta URL:** https://instant-wallet-beta.vercel.app — CLI deployments aliased to that
  hostname. Passkeys are bound to the hostname, so the beta alias must stay stable.
  Ship a new build with, from the repo root:
  ```sh
  vercel pull --yes --environment=preview   # env + settings into .vercel/ (gitignored)
  vercel build                              # runs the Vercel builder locally
  vercel deploy --prebuilt                  # uploads .vercel/output
  vercel alias set <deployment-url> instant-wallet-beta.vercel.app
  ```
  Building on Vercel's own builders currently dies with `RangeError: Invalid array length` inside
  `next build` (Next 15.2 and 15.5, Node 22 and 24, cache on or off) while the identical
  `vercel build` succeeds on this Mac. Unresolved as of 2026-09-13; until it is, deploy prebuilt
  and do not rely on GitHub-push builds for this project.
- **State:** the device queue lives in Upstash Redis on Vercel (`UPSTASH_REDIS_REST_URL/TOKEN`,
  keys prefixed `iw:<chainId>:`); locally it is a JSON file.
- **Chain:** `NEXT_PUBLIC_TARGET_NETWORK=base` (Base mainnet). `mainnet` (Ethereum) is a second deployment of the same
  app; the contracts sit at the same addresses on both, so a wallet address is the same on both. No testnets.
- **Contracts per chain:** `packages/foundry/deployments/<chainId>.json` → `yarn generate-abis`
  regenerates `packages/nextjs/contracts/deployedContracts.ts`. Or set `NEXT_PUBLIC_FACTORY_ADDRESS`.

## Passkeys across surfaces

A passkey is bound to the rpId (hostname). Safari, the home-screen PWA and the Capacitor shell
share the passkey only when the shell is associated with the domain (`webcredentials:` in the app,
`/.well-known/apple-app-site-association` on the site). Until then each surface has its own key,
and each can be a signer of the same wallet: adding "my laptop" or "the app" is one owner-signed
`AddSigner`, exactly like adding the hardware device.
