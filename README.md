# Instant Wallet

**Your money, instantly.** A passkey smart-contract wallet (Face ID / Touch ID, no seed phrase,
no gas) that you can harden with a $35 hardware signer you build yourself from three off-the-shelf
parts. One account, many P-256 keys, tiered by trust. Optional AI on top, bring your own model.

It is the child of two projects:
[progressive-self-custody](https://github.com/austintgriffith/progressive-self-custody)
(passkeys + facilitator-paid gas) and
[picowallet](https://github.com/austintgriffith/picowallet) (a Pico 2 W + ATECC608 hardware wallet
with a green SIGN button). Both signers speak P-256, so one contract verifies both.

```
 phone / laptop passkey ──WebAuthn sig──┐
                                        ├──▶  InstantWallet.sol  ◀── relay pays gas, takes a USDC fee
 the device (ATECC608)  ──raw P-256 sig─┘     spender: per-asset daily limits · owner: anything
```

- **Day 1**: Face ID makes a key. The address exists before any deposit. Send with a face scan.
- **Later**: build the device, scan its screen, done. It becomes the owner; Face ID keeps a daily
  allowance. Anything bigger lights the green button. Both screens show the same 3-word
  **match code** so a swapped request is visible by eye.
- **Lost phone**: the device adds a new one. **Lost both**: the recovery address adds a key after a delay.
- **AI**: "send $20 to atg.eth", "what did I spend this week" — turns into the same proposal card
  you confirm with a key. Off by default. Anthropic, or any OpenAI-compatible endpoint you bring.

## Layout

| path | what |
|---|---|
| `docs/PROTOCOL.md` | **read this first** — digests, signature encodings, device queue, match code. Contract, app and firmware all follow it |
| `CONCEPT.md` | the idea, the ladder, open questions |
| `packages/foundry/` | `InstantWallet.sol`, `Factory.sol`, `MockUSDC.sol`, tests (`forge test`) |
| `packages/nextjs/` | the app: passkeys, facilitator, device queue, talk-to-your-wallet, BYOAI |
| `firmware/` | MicroPython for the device; `hardware/` build guide + case |
| `emu/`, `tools/` | the virtual device (MicroPython in WebAssembly) and CLI helpers |
| `design/` | mockups and the generator |

## Run it locally

```sh
yarn install
yarn chain                       # anvil
yarn deploy                      # MockUSDC + InstantWallet + Factory on 31337
cp packages/nextjs/.env.local.example packages/nextjs/.env.local
yarn start                       # http://localhost:3000
```

Create an account with a passkey, mint yourself play USDC, send some. To try the device without
hardware: `tools/emu` opens the virtual wallet; point its `secrets.py` `APP_URL` at your laptop.

Tests: `cd packages/foundry && forge test` · `yarn workspace @se-2/nextjs check:digests` ·
`yarn workspace @se-2/nextjs e2e:device` · `python3 firmware/test_digests.py`.

## Status

Proof of concept. Nothing here is audited. See `docs/PROTOCOL.md` §1 for the trust model.

## License

MIT. Case v0 by Tomáš Plass (CC BY-NC 4.0), see `hardware/case/`.
