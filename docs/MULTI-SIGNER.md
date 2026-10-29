# Multi-signer transactions (plan)

Austin, 2026-10-28. First version built (below: what's in).

An Instant Wallet can have signers who are different people. A transaction then needs a link anyone can open,
see, and sign.

## Where signatures live (same as wedgie.dev/safe)

Four places, merged by safeTxHash. One working is enough.

1. Safe's Transaction Service (through a proxy with our key, cached). Safe{Wallet} sees it too.
2. Instant Wallet's queue, `/api/safe/queue` (already built; checks each signature on chain).
3. This browser.
4. The link: the tx and its signatures after the `#`. No server needed. Each signature is checked on chain
   (`checkNSignatures`) when the link opens.

Port from wedgie-dev `src/pages/safe.ts`: `readQueue`, `share`, `txLink`, `takeLink`. Proxy: wedgie-dev `api/safe.ts`.

## The transaction page

`/tx/<chain>/<safe>#<code>`:
- what it does, in words (the same decoding the wedgie uses)
- who signed, "2 of 3"
- Sign: Face ID (their own passkey), a wedgie, or a browser wallet (`howSigns`)
- the last signer sends it (relay, fee in USDC from the Safe; or their own gas)
- Share link, and **Open in Safe{Wallet}**:
  `https://app.safe.global/transactions/tx?safe=<chainKey>:<safe>&id=multisig_<safe>_<safeTxHash>`

Home shows "Waiting for signatures" from the merged queue. Every tx (waiting or sent) gets the Safe{Wallet} button.

## Built (10-28)

- `web/lib/safe/share.ts`: the four places, `shareTx`, `readWaiting`, `checkSigs`, `txLink`.
- `web/app/api/safe/svc/route.ts`: Safe's Transaction Service with `SAFE_API_KEY` (Vercel + `.env.local`).
- `/tx/<chain>/<safe>#<code>` (`components/safe/TxPage.tsx`): what it does, who signed, Sign (Face ID / wedgie /
  browser wallet), Send (relay, or your own wallet), Copy link, Open in Safe{Wallet}.
- Sending: a "Face ID, then share" choice whenever more than one signature is needed. It signs, shares, and shows
  the link (`SharedDone`). Home: "Waiting for signatures" (our queue + this browser only: Safe's quota is shared).

## Hard part

A friend signing with a passkey in a fresh browser: a passkey sign-in doesn't give the public key. Sign-in already
works it out from two signatures (`signIn`); the tx page does the same, then checks that signer is an owner.

## Not now

A wallet switcher for friends (Austin: see it and play with it first).

## Open

- A Safe API key for Instant Wallet (wedgie.dev has one: `SAFE_API_KEY`, developer.safe.global).
