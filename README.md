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
copy its API key). If you run your own Ethereum node, paste its URL when it asks (it finds one on port 8545 by
itself); the app then reads and sends through your node instead of Alchemy. Then it builds and opens
https://local.instantwallet.io. Leave the Terminal window open; Ctrl+C stops it. Next time: `./run-local.sh` again.

1. Tap "I already have one" and use your passkey. Your wallet opens.
2. To send, pay the gas one of two ways:
   - **Your relay:** Settings, at the bottom, **Your relay** → **Make my relay**. Send it a little ETH on each
     network you use (Base: $1 is plenty, Ethereum: about $5). Each send's fee goes back to it, so you only pay the
     gas. Its key stays in `web/.env.local` on your computer.
   - **Execute from my wallet:** with MetaMask or another browser wallet, the dark gray button under Sign. No fee;
     your browser wallet pays the gas.

More nodes: add `RPC_URL_<chainId>=<url>` lines to `web/.env.local` (`RPC_URL_8453` for Base) and run it again.

If it doesn't work:

- **"This site can't be reached"**: the hosts line is missing (`cat /etc/hosts`), or the script isn't running.
- **"Your connection is not private"**: your Mac doesn't trust the certificate. Run `mkcert -install` in the
  Terminal app (it needs your password, and a box may pop up), then reload. Check it with
  `security verify-cert -c ~/.instantwallet-local/local.instantwallet.io.pem -p ssl -s local.instantwallet.io`:
  a line about "signed certificate timestamps" is fine; "not trusted" is not.
- **"No relay here"** when you sign: make your relay (step 2). **"insufficient funds"**: your relay needs ETH on
  that network.
- **"Port 443 is in use"**: something else serves https on this Mac. Stop it, then run it again.
- **The passkey isn't offered**: use the browser where you made the wallet, or one with the same iCloud or Google
  passwords.

To remove it: `./run-local.sh --remove` takes local.instantwallet.io out of `/etc/hosts`.

mkcert's root certificate can vouch for any site on your computer. Its key never leaves your computer.

## Read

- `EXPECTATIONS.md`: what the wallet must always do. Read it first.
- `docs/FIX-LIST.md`: what's known to be wrong, to fix one at a time.
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
