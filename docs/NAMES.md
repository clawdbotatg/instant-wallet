# Names: alice.inst.eth

Every wallet can take a public name under `inst.eth`. Free, first come.

## For the person

- Tap the wallet's title (Receive), type a name, Save, Face ID.
- The name shows wherever the address shows, and Send takes it.
- A wallet's own ENS name comes first. The inst.eth name is what shows when it has none.
- A rename keeps the old name: it still pays you and nobody else can take it. 5 names a wallet.
- The QR still holds the address: other wallets can't read a name.
- Paying a name that points somewhere new since you last paid it says so in red.

## How it works

- The names live in our store (Upstash): `lib/namesStore.ts`. The rules (3 to 32 letters, the held-back list):
  `lib/names.ts`.
- Taking one: `POST /api/names`, a Face ID signature from the wallet's own passkey (`lib/passkeyAuth.ts`).
- Inside the wallet, `/api/ens` answers for them straight from the store.
- For everyone else: `inst.eth`'s resolver on Ethereum is ENS's OffchainResolver (`web/tools/names-resolver`,
  their code, unchanged). It sends a wallet to our gateway (`/api/ens/gw`, `lib/nameGateway.ts`) and checks our
  answer was signed by `NAME_SIGNER_KEY` before handing it on.
- The gateway answers the address for Ethereum and every network the wallet is on. Nothing else yet (no Solana).

## Trust

Whoever holds `NAME_SIGNER_KEY`, or our store, decides where a name points. So Send always shows the address and
its blockie, and warns when a name has moved. The key lives only in Vercel. Lost or leaked: make a new one, deploy
the resolver again, point `inst.eth` at it.

## Live

- Resolver on Ethereum: `0x7aC691DBf3c38c067b138b7a28DfDfa0f686Cc7c` (deployed 2026-11-12).
- Its signer: `0x59836772762Ec84974B7cf13D3d5D267C0d32a34`. The key is `NAME_SIGNER_KEY` in Vercel, nowhere else.
- Its gateway: `https://instantwallet.io/api/ens/gw/{sender}/{data}.json`.

## Setting it up (once)

1. A new key in Vercel as `NAME_SIGNER_KEY` (production). Keep its address.
2. `SIGNER=<that address> npx tsx tools/deploy-names-resolver.mts --go` → the resolver's address.
3. `NAME_RESOLVER=<resolver>` in Vercel, so the gateway signs for that resolver only.
4. `inst.eth`'s owner sets the resolver: `setResolver(id, resolver)` on ENS's ETHRegistry
   (`0xf60aba43e1f7f3dab1186ff03b561401c9df85e2`), `id` from its `findTokenId("inst")`. One transaction.

## Tests

- `tools/names-check.mts`: who may take a name, first come, renames.
- `tools/names-e2e.mjs`: the same through the real screens.
- `tools/names-gateway-check.mts`: a stranger's lookup on a fork of Ethereum, through ENS's Universal Resolver.
