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

Run these in the Terminal app: steps 1 and 3 ask for your Mac password.

1. Install mkcert and trust its certificate:

       brew install mkcert
       mkcert -install

2. Make a certificate for local.instantwallet.io:

       mkdir -p ~/.instantwallet-local && cd ~/.instantwallet-local
       mkcert local.instantwallet.io

3. Point local.instantwallet.io at your computer. This only touches the local name:

       echo "127.0.0.1 local.instantwallet.io" | sudo tee -a /etc/hosts
       sudo dscacheutil -flushcache

4. Build and run the app. Put your own free Alchemy key (dashboard.alchemy.com) in `web/.env.local` as
   `ALCHEMY_API_KEY=...` first.

       cd web
       npm install
       npm run build
       npx next start -p 3000

5. In a second terminal, serve it on https:

       cd ~/.instantwallet-local
       npx local-ssl-proxy --source 443 --target 3000 --cert local.instantwallet.io.pem --key local.instantwallet.io-key.pem

6. Open https://local.instantwallet.io and sign in with your passkey.

To remove it: delete the line from `/etc/hosts` (`sudo sed -i '' '/local.instantwallet.io/d' /etc/hosts`).

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
