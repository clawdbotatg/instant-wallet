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

### What it does, in words (`components/safe/WhatItDoes.tsx`)

Same as the wedgie: clear signing (ERC-7730) first, then our own reader.

1. `/api/explain` formats each call with Sourcify's library from the EF registry plus ours,
   [clawdbotatg/clear-descriptors](https://github.com/clawdbotatg/clear-descriptors) (the files its `show.json`
   adds, read live, cached an hour: a new descriptor there shows here without a deploy). A call to the Safe itself
   reads as `0x5afe…5afe` (ThisSafe: owners, threshold, modules). USDC is a trusted ERC-20 (sends, approvals).
2. No descriptor, or one the library can't read (ERC-8362: Universal Router, MultiSend): `lib/safe/describe.ts`.
   The daily limit (Zodiac Roles) is only here: a port of the wedgie's `safe_read.py` with its red warnings, which
   a descriptor can't say yet.

A new descriptor of ours: add it in clear-descriptors (its CLAUDE.md), never in this repo.

Home shows "Waiting for signatures" from the merged queue, under the balance, with the same words. Every tx (waiting or sent) gets the Safe{Wallet} button.

## Built (10-28)

- `web/lib/safe/share.ts`: the four places, `shareTx`, `readWaiting`, `checkSigs`, `txLink`.
- `web/app/api/safe/svc/route.ts`: Safe's Transaction Service with `SAFE_API_KEY` (Vercel + `.env.local`).
- `/tx/<chain>/<safe>#<code>` (`components/safe/TxPage.tsx`): what it does, who signed, Sign (Face ID / wedgie /
  browser wallet), Send (relay, or your own wallet), Copy link, Open in Safe{Wallet}.
- Sending, when more than one signature is needed: no choices. Face ID signs, then the tx page opens; the wedgie
  signs or you share it from there (Austin, 10-28: "just gather their signature and take them to the queue";
  `signThenQueue`). A site (WalletConnect) still signs inline: it waits for the answer. Home: "Waiting for signatures" (our queue + this browser only: Safe's quota is shared).

- Invites: Edit signers → Invite someone → a `/join#<id>` link (`components/safe/Join.tsx`, `/api/safe/invite`,
  7 days). The friend uses their passkey (or makes one); its public key comes back; "Add <name>" deploys their
  signer contract and adds it, per network. Named in this browser (`loadSigners`): an invited passkey shows as
  them, not the wedgie, and they sign from the link (`howSigns` → "friend").

## Hard part

A friend signing with a passkey in a fresh browser: a passkey sign-in doesn't give the public key. Sign-in already
works it out from two signatures (`signIn`); the tx page does the same, then checks that signer is an owner.

## Not now

A wallet switcher for friends (Austin: see it and play with it first).

## Open

- A Safe API key for Instant Wallet (wedgie.dev has one: `SAFE_API_KEY`, developer.safe.global).
