# Instant Wallet

A wallet you make in seconds with Face ID. No seed phrase. Live at https://instantwallet.io
(and at https://xdai.io, the old Burner Wallet's address).

- Your wallet is a Gnosis Safe. Your phone's passkey is its first signer.
- Same address on 14 networks. The list: `docs/NETWORKS.md`.
- Our relay sends your transactions. The fee comes out of the wallet, in USDC or the network's coin.
- Add a wedgie (a small hardware signer, wedgie.dev) or other signers, and pick how many must sign.
- Lost your keys: recovery swaps in new ones after a wait. You can cancel, and you can turn on alerts for it.
- Every transaction is shown in plain words before you sign.
- No contracts of our own: Safe, Safe's passkey signer, Zodiac Roles, Candide recovery.

## Run it

    cd web
    npm install
    npm run dev        # http://localhost:3000

Put `ALCHEMY_API_KEY` in `web/.env.local`. The rest of the env: `web/README.md`.
Push to main deploys (Vercel, root `web/`). Before pushing a UI change: `node web/tools/same-check.mjs`.

## Run it fully local (if instantwallet.io is gone)

Your passkey belongs to instantwallet.io. A page on local.instantwallet.io may use it too, so you run the app on
your own computer under that name. instantwallet.io always stays the real site; nothing here touches it.
Mac, desktop Chrome or Safari. Being tested now. The plan and what doesn't work yet: `docs/LOCAL-MODE.md`.

You need a Mac with Homebrew (brew.sh). In the Terminal app:

    cd ~ && git clone https://github.com/clawdbotatg/instant-wallet.git
    cd instant-wallet && ./run-local.sh

The first time it asks for your Mac password twice (to trust its own certificate, and to point
local.instantwallet.io at this computer) and for a free Alchemy key (dashboard.alchemy.com: sign in, create an app,
copy its API key). If you run your own Ethereum node on port 8545, your own indexer
(github.com/clawdbotatg/iw-indexer) reads your coins and their prices from it, with no setup (Alchemy only searches
your history); Settings → **Balances and prices** shows it and turns it off. Paste the node's URL when it asks, and the
app reads and sends through it too. It copies the transaction words (the EF
clear-signing registry, ours, and what a wedgie shows: about 300 MB) to your computer, and updates them each run. Then it builds and opens
https://local.instantwallet.io. Leave the Terminal window open; Ctrl+C stops it. Next time: `./run-local.sh` again.
To update: stop it (Ctrl+C), `git pull`, `./run-local.sh` (it installs and builds what changed). Kept running with
`--install`: `git pull`, then `./run-local.sh --install` again.

To keep it running without a Terminal window, and start it every time you log in: `./run-local.sh --install`
(`--uninstall` stops that; its log is `~/.instantwallet-local/run.log`).

1. Tap "Select existing passkey" and use your passkey. Your wallet opens.
2. To send, pay the gas one of two ways. With a browser wallet and no relay made, the browser wallet is used by
   itself: Sign executes from it.
   - **Your relay:** Settings, at the bottom, **Your relay** → **Make my relay**. Send it a little ETH on each
     network you use (Base: $1 is plenty, Ethereum: about $5). Each send's fee goes back to it, so you only pay the
     gas. Its key stays in `web/.env.local` on your computer.
   - **Execute from my wallet:** with MetaMask or another browser wallet, the dark gray button under Sign. No fee;
     your browser wallet pays the gas.

### The apps (Earn, Borrow, Stake ETH, ENS, Morpho) on your own computer

`./run-local.sh` gets them too: it clones [instant-wallet-apps](https://github.com/clawdbotatg/instant-wallet-apps)
into `~/.instantwallet-local/instant-wallet-apps`, builds it, and serves it at `https://local.instantwallet.io:4174`.
The wallet's Apps button opens them from there, not from instant-wallet-apps.vercel.app. They read the chain through
the wallet, so through your node. Their log: `~/.instantwallet-local/apps.log`. To update them: stop, `./run-local.sh`
again.

To put USDC into a Morpho vault, all on your computer:

1. Run `./run-local.sh` and sign in with your passkey.
2. Have a way to pay gas: **Your relay** with a little ETH in it, or a browser wallet (step 2 above).
3. Tap **Apps**, then **Morpho**. Pick the network (Ethereum, or Base if you have a node or an Alchemy key for it).
4. Pick a vault, type the dollars, tap **Deposit**. The wallet shows what the transaction does and what it moves,
   from your own simulator. Sign.
5. The vault shows under your positions in the app. **Withdraw** is the same screen.

With Settings → **No external traffic** on, the browser lets the apps talk to nobody but this computer:

| App | Works from your node | Off or shorter |
|---|---|---|
| Morpho | a short saved list of vaults, your positions, deposit, withdraw | the full list and the rates (Morpho's API) |
| Earn | Aave, Compound, Spark, the saved Morpho vaults | Morpho's full list and rates |
| Borrow | Aave, Compound, the pinned Morpho markets | Morpho's rates |
| Stake ETH | Lido, on Ethereum | cbETH and rETH (a swap through LI.FI) |
| ENS | getting a name, setting your primary name | finding names that already point at the wallet (ENS's index) |

If ports 4174 and 4175 are in use, or the apps don't build, the script says so and the wallet uses the hosted
ones (another port: `IW_APPS_PORT=4274 ./run-local.sh`). To keep the hosted ones on purpose: `IW_APPS=hosted ./run-local.sh`.

Your node over Tor: in Settings → **Your node**, paste its `.onion` address (`http://….onion`) and Save. Reads and
your relay's sends then go to it over Tor, from this computer (no gateway), so the node never sees your IP. The
first call starts Tor (up to a minute); after that about a second each. A BuidlGuidl node makes its `.onion` with
`node index.js --tor`. More: `docs/ANON-RPC.md`.

More nodes: add `RPC_URL_<chainId>=<url>` lines to `web/.env.local` (`RPC_URL_8453` for Base) and run it again.

Optional free keys, same file. Settings → **Off on this copy** lists the ones you're missing:

- Deposit with Coinbase: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (portal.cdp.coinbase.com)
- Earn and borrow positions: `ZERION_API_KEY` (developers.zerion.io)
- Shared transactions in Safe{Wallet} too: `SAFE_API_KEY` (developer.safe.global). Without it they still work here.

New names (alice.inst.eth) need instantwallet.io.

If it doesn't work:

- **"This site can't be reached"**: the hosts line is missing (`cat /etc/hosts`), or the script isn't running.
- **"Your connection is not private"**: your Mac doesn't trust the certificate. Run `mkcert -install` in the
  Terminal app (it needs your password, and a box may pop up), then reload. Check it with
  `security verify-cert -c ~/.instantwallet-local/local.instantwallet.io.pem -p ssl -s local.instantwallet.io`:
  a line about "signed certificate timestamps" is fine; "not trusted" is not.
- **"No relay here"** when you sign: make your relay (step 2). **"insufficient funds"**: your relay needs ETH on
  that network.
- **"Port 443 is in use"**: something else serves https on this Mac. Stop it, then run it again.
- **An app's page stays blank**: read `~/.instantwallet-local/apps.log`. The apps are served on port 4174; open
  `https://local.instantwallet.io:4174/morpho` by itself: it should say "Open this inside Instant Wallet".
- **The passkey isn't offered**: use the browser where you made the wallet, or one with the same iCloud or Google
  passwords.

To test it without real money: `cd web && node tools/local-e2e.mjs` (a Base fork: makes a wallet, sends through a
relay and from a browser wallet).

To remove it: `./run-local.sh --remove` takes local.instantwallet.io out of `/etc/hosts`.

mkcert's root certificate can vouch for any site on your computer. Its key never leaves your computer.

## Read

- `EXPECTATIONS.md`: what the wallet must always do. Read it first.
- `docs/FIX-LIST.md`: what's known to be wrong, to fix one at a time.
- `docs/MODES.md`: mountain man (your own computer, as CROPS as possible) and finance bro (our site, smooth).
- `docs/CROPS.md`: the plan from quick sends to full self-custody, against EF's high-CROPS wallet criteria.
- `docs/SAFE-APP.md`: what's built, the relay, the tests.
- `docs/CUSTODY.md`, `docs/MULTI-SIGNER.md`: signers, daily limit, shared transactions.
- `docs/CLAIM.md`, `docs/DROPS.md`, `docs/NFC-SHARE.md`: giving money away by QR, card or code.
- `docs/SWAP.md`, `docs/APP-STORE.md`: Swap and Apps.
- `docs/NAMES.md`: alice.inst.eth, a public name for every wallet.
- `docs/WEDGIE-SAFE.md`, `docs/WEDGIE-PHONE.md`: the wedgie on a computer and on an iPhone.
- `docs/XDAI.md`: xdai.io and sweeping old Burner keys.
- `../clear-descriptors/MAP.md`: clear signing, across all the repos.

## Also here, not live

- `packages/foundry`: the Safe fork tests (`test/safe`) and the post-quantum signer's contracts (`contracts/pq`).
- `design/`: the brand files.
- The first version (our own contract, a Pico signer, its case, its docs) was removed
  11-12; git has it.
- `docs/PLAN.md` and `docs/SAFE.md` are history. `docs/SAFE-APP.md` and `docs/CUSTODY.md` say what's real.

Not audited. MIT.
