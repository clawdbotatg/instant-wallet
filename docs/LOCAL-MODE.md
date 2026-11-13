# Local mode (plan, not built)

Run the whole Instant Wallet on your own computer, under the name instantwallet.io, so your passkey keeps working
even if our site, our servers or the domain are gone. Same app, same screens, same wallet.

## TLDR

- **Use local.instantwallet.io, not instantwallet.io.** A page may use its parent domain as the passkey's domain,
  so the app strips `local.` (`web/lib/passkey.ts`) and signs with the instantwallet.io passkey. The real site
  stays reachable. The steps: README, "Run it fully local". The hosts-line-on-instantwallet.io idea below is the
  fallback.

- A passkey only signs on the domain it was made for. The app uses the page's own hostname as the passkey's domain
  (`rpId = window.location.hostname`, `web/lib/passkey.ts:69`).
- So: point instantwallet.io at your own computer (one line in the hosts file), give it a certificate your computer
  trusts (mkcert), and run our open-source app there. The browser sees instantwallet.io and your passkey signs. No
  code change for that part.
- What's left is everything our server does with our secrets: reads, the relay, the store. Each one gets a local
  version: your own Alchemy key or node, your own relay key, a store on disk.
- Desktop browser first. The browser extension should work unchanged. The phone app is the hard part.

## The first test (do this before building anything)

Prove the passkey trick works with our app, by hand, on one Mac:

1. `brew install mkcert && mkcert -install` (adds a local root certificate to the Mac and to Firefox).
2. `mkcert instantwallet.io` in a scratch folder: makes `instantwallet.io.pem` and `instantwallet.io-key.pem`.
3. Add `127.0.0.1 instantwallet.io` to `/etc/hosts` (needs your password). Then `dscacheutil -flushcache`.
4. In `web/`: `.env.local` with `ALCHEMY_API_KEY`, then `npm run build && npx next start -p 3000`, and a small TLS
   proxy on 443 in front of it with the certificate from step 2 (`npx local-ssl-proxy --source 443 --target 3000
   --cert instantwallet.io.pem --key instantwallet.io-key.pem`). macOS lets a normal user use port 443.
5. Open https://instantwallet.io in Chrome and Safari. Check: no certificate warning, `/api/version` says the local
   build, and "Sign in" with your existing passkey opens your real wallet. Then sign a small send.
6. Remove the hosts line. You're back on the real site.

The test passes if step 5 signs with a passkey made on the real site. If it does, everything below is plumbing.

## What our server does today, and the local version

| Today (our server, our secrets) | Local |
|---|---|
| Reads: `/api/rpc`, portfolio, prices, NFTs via Alchemy (`ALCHEMY_API_KEY`) | Your own free Alchemy key, or your own node (Settings → Your node already exists, `docs/OWN-NODE.md`) |
| The relay pays gas (`RELAYER_PRIVATE_KEY`) and takes a fee in the same tx | Your own relay key, funded by you. The fee goes to the relay's own address (`relayCore.ts`), so you pay yourself back: you only pay gas. Or skip it: "Execute from my wallet (I pay gas)" |
| The store: Upstash (`RELAY_KV_*`): tx queue, names, rate limits | A file on disk. Today it falls back to memory (`lib/kv.ts`), which is lost on restart |
| The simulator, sim.wedgie.dev | clear-sim on your computer (open source), set in Settings → Simulator. Or the light client on Ethereum and Gnosis |
| Words for a tx: `/api/explain` (EF registry + clear-descriptors from GitHub) | Same route, runs locally. Bundle a copy of the descriptors so it works offline |
| Swaps: Uniswap on chain + LI.FI (`LIFI_API_KEY`) | Uniswap works with any node. LI.FI works without our key, with lower limits |
| DeFi positions: Zerion (`ZERION_API_KEY`) | Your own key, or hidden |
| Safe Transaction Service (other signers' signatures) | Public, works as is. `SAFE_API_KEY` optional |
| WalletConnect | Public relay. Needs a WalletConnect project id (free) |
| Names: `alice.inst.eth` (`NAME_SIGNER_KEY`, our gateway) | Reading names works through ENS. Giving out new names needs us: off locally |
| Alerts (email, Telegram, push) and drops | Off locally |
| Deposit (Coinbase Onramp, `CDP_API_KEY_*`) | Off locally |

## Phone, app, extension

- **Desktop browser (Chrome, Safari, Firefox):** works with the test above. Passkeys synced by iCloud or Google
  are the same passkeys, so a wallet made on the phone signs on the Mac.
- **Browser extension:** it forwards every request to the open instantwallet.io tab. With the hosts line, that tab is
  your local one. Should work as is. Test it.
- **Phone browser:** needs two things a phone doesn't do easily: instantwallet.io must point at your computer (a DNS
  override on your router or a small DNS server), and the phone must trust the mkcert root (install it as a profile,
  then turn trust on). Possible, fiddly. Later.
- **iOS app:** it's a web view on instantwallet.io, and its passkey works through a file the domain serves
  (`apple-app-site-association`), fetched by Apple from the live site. If the domain is gone, the app's passkey stops.
  Local mode doesn't fix the app. The fallback for phone-only users stays recovery, or a second key.

## What to build

1. **The script** `tools/local/start.sh`: installs mkcert, makes the certificate, adds the hosts line (asks for your
   password once), asks for an Alchemy key or a node URL, builds, runs on 443. And `tools/local/stop.sh`: removes the
   hosts line.
2. **`LOCAL=1`**: the server knows it's local. Production refuses to run without Upstash today; local uses a file store
   instead (`lib/kv.ts`: one JSON file, same commands).
3. **A "Local" mark** in the app, always on screen. The address bar says instantwallet.io either way, so you must be
   able to tell which one you're on. `/api/version` says `local: true`.
4. **Hide what can't work locally**: Deposit, alerts, new inst.eth names, drops. Hidden, not broken.
5. **Your own relay**: a local relay key in `.env.local`, with a "Fund your relay" line showing its balance per network.
6. **Offline words**: bundle the descriptors in the build, so `/api/explain` doesn't need GitHub.
7. **A doc for the day instantwallet.io is gone**: three commands, written for a normal person. Linked from the
   footer and the README.

## Things to watch

- **Forgetting the hosts line** means the real site is unreachable, and you get no updates. The "Local" mark helps;
  `stop.sh` undoes it.
- **The mkcert root can vouch for any site** on that computer. Its key stays on that computer. Say so in the doc.
- **Same name, two copies**: browser storage (accounts, settings) is per name, so local and real share it on that
  computer. Good for "same wallet", but a local build that's older than the real one must not break newer storage.
- **xdai.io** wallets are separate passkeys (`docs/XDAI.md`). The same trick works with a second hosts line.
- **Chrome's secure DNS** still reads the hosts file first. Check it in the test anyway.
- **HSTS** is fine: the mkcert certificate is trusted, so the browser accepts it.

## Later

- The build on IPFS under an ENS name (`docs/CROPS.md`). It doesn't help the passkey (a different name is a
  different passkey), but it proves which build is real.
- Phone local mode, if anyone asks for it.
