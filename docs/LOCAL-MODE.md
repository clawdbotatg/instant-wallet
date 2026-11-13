# Local mode (plan, being tested)

Run the whole Instant Wallet on your own computer at **local.instantwallet.io**, so your passkey keeps working even if
our site, our servers or the domain are gone. Same app, same screens, same wallet.

**instantwallet.io always stays the real site.** Nothing here touches it. local.instantwallet.io is your own copy,
next to it.

## TLDR

- A passkey belongs to a domain (instantwallet.io). A page on a subdomain may use its parent's passkeys, so the app
  drops a leading `local.` from the passkey's domain (`rpId` in `web/lib/passkey.ts`). local.instantwallet.io signs
  with your instantwallet.io passkey.
- Point only local.instantwallet.io at your computer (one hosts line), give it a certificate your computer trusts
  (mkcert), run our open-source app there.
- What's left is everything our server does with our secrets: reads, the relay, the store. Each one gets a local
  version: your own Alchemy key or node, your own relay key, a store on disk.
- Desktop browser first. The phone app is the hard part.

## The first test

The steps are in the README, "Run it fully local". It passes when https://local.instantwallet.io signs a small send
with a passkey made on the real site. If it does, everything below is plumbing.

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
- **Browser extension:** it forwards every request to the open instantwallet.io tab. It needs to also accept a
  local.instantwallet.io tab. Not done.
- **Phone browser:** needs two things a phone doesn't do easily: local.instantwallet.io must point at your computer (a DNS
  override on your router or a small DNS server), and the phone must trust the mkcert root (install it as a profile,
  then turn trust on). Possible, fiddly. Later.
- **iOS app:** it's a web view on instantwallet.io, and its passkey works through a file the domain serves
  (`apple-app-site-association`), fetched by Apple from the live site. If the domain is gone, the app's passkey stops.
  Local mode doesn't fix the app. The fallback for phone-only users stays recovery, or a second key.

## What to build

1. **The script** `tools/local/start.sh`: installs mkcert, makes the certificate, adds the hosts line (asks for your
   password once), asks for an Alchemy key or a node URL, builds, runs on 443. And `tools/local/stop.sh`: stops it.
   The hosts line can stay: it only covers local.instantwallet.io.
2. **`LOCAL=1`**: the server knows it's local. Production refuses to run without Upstash today; local uses a file store
   instead (`lib/kv.ts`: one JSON file, same commands).
3. **A "Local" mark** in the app, so you know it's your copy. `/api/version` says `local: true`.
4. **Hide what can't work locally**: Deposit, alerts, new inst.eth names, drops. Hidden, not broken.
5. **Your own relay**: done. Settings → Your relay (only on a local copy, `components/safe/LocalRelay.tsx`,
   `app/api/local/relay`), or `npm run relay-key`. Makes the key in `.env.local`, shows its address and balances.
6. **Offline words**: bundle the descriptors in the build, so `/api/explain` doesn't need GitHub.
7. **A doc for the day instantwallet.io is gone**: three commands, written for a normal person. Linked from the
   footer and the README.

## Things to watch

- **The mkcert root can vouch for any site** on that computer. Its key stays on that computer. Say so in the doc.
- **Separate browser storage**: local.instantwallet.io doesn't see the real site's saved accounts and settings. Sign
  in with the passkey finds the wallet. Check the test does that.
- **xdai.io** wallets are separate passkeys (`docs/XDAI.md`). Same trick: local.xdai.io (the `local.` strip covers it), its own cert and hosts line.
- **Chrome's secure DNS** still reads the hosts file first. Check it in the test anyway.
- **If the domain is gone for good**, the passkey's domain is still instantwallet.io, so the local copy keeps
  signing. If someone else ever buys the domain, they could ask your passkey to sign too: move funds to a new key
  then.

## Later

- The build on IPFS under an ENS name (`docs/CROPS.md`). It doesn't help the passkey (a different name is a
  different passkey), but it proves which build is real.
- Phone local mode, if anyone asks for it.
