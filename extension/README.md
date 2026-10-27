# Instant Wallet browser extension

Use Instant Wallet on any site, like MetaMask. The extension holds no keys. A site asks, the request shows up in
your Instant Wallet tab, you approve there (Face ID, the wedgie), the answer goes back to the site.

## Install (until it's in the Chrome Web Store)

1. `chrome://extensions` → Developer mode on → **Load unpacked** → pick this `extension/` folder.
2. Open instantwallet.io once with your wallet open. The extension learns your address.
3. On a site: Connect wallet → **Instant Wallet**.

## How it works

| file | runs | does |
|---|---|---|
| `inpage.js` | in the site's page | the provider. Always in the site's wallet list as "Instant Wallet" (EIP-6963). "Act as MetaMask" on: also `window.ethereum`, `isMetaMask`, no lock (how Impersonator and WalletChan do it) |
| `site.js` | on every site | answers what needs no key: address, network, switching, reads (through `/api/rpc`). Sends the rest on |
| `background.js` | the extension | finds or opens the Instant Wallet tab, hands it the request, sends the answer back, brings the site's tab forward |
| `wallet.js` | on instantwallet.io | passes requests to the page (`web/lib/extension.ts`), which shows the same card as a WalletConnect request |
| `popup.*` | the toolbar button | your address, the "Act as MetaMask" switch, connected sites |

- Connecting a site doesn't open the wallet once the address is known: clicking Connect on the site was the yes.
- Sends answer with the tx hash as soon as the relay has it.
- The site's address the wallet shows comes from Chrome, not from the site.
- Refused: `eth_sign`, `eth_signTransaction`, `eth_sendRawTransaction`.
- Wallet sites: `instantwallet.io` and `instant-wallet-b2jn.vercel.app` (in `manifest.json` and `background.js`).
  To try a local `web/`, add `http://localhost:3000/*` to both (not by default: localhost:3000 is also where most
  dapps run in dev).
