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

- `packages/`, `firmware/`, `emu/`, `tools/`, `hardware/`, `design/`: the first version (our own contract, a
  Pico signer; `CONCEPT.md`, `docs/PROTOCOL.md`). `packages/foundry/test/safe` still holds the Safe fork tests.
- `docs/PLAN.md` and the other plan docs are history. `docs/SAFE-APP.md` and `docs/CUSTODY.md` say what's real.

Not audited. MIT. Case v0 by Tomáš Plass (CC BY-NC 4.0), see `hardware/case/`.
