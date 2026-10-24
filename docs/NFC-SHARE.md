# Plan: Share to an NFC card (from the iPhone app)

Status: built 2026-10-24 (`components/safe/Share.tsx`, app `InstantWallet/Nfc.swift`). Not yet tested on a phone.

Decided (Austin, 10-24): order is check money + budget, keep the key, write the card, THEN fund it. Within the daily budget only (one Face ID, no wedgie). The claimer pays the relay fee
from the card. No shared-cards list: just share.

## What Austin wants

In the iPhone app: Settings → **Share** → pick an amount → tap a card. The app makes a new key, sends the money to it
from your wallet, and writes the claim link to the card's NFC chip. Whoever taps the card makes a wallet (or uses
theirs) and the money moves to it.

The cards: wedgie NFC cards with an NTAG215 sticker inside (clawdbotatg/wedgie-nfc-cards). NTAG215 holds 504 bytes.
The link is about 100.

## Already built (don't rebuild)

- **Claim side:** `/pk#0x<key>` and `/claim#<key>` → `components/Claim.tsx`. It shows the money, makes or picks the
  wallet, and sweeps it in. See `docs/CLAIM.md`.
- **Making keys and links:** `generatePrivateKey()` (viem) and `claimUrl(origin, key)` in `lib/claim.ts`.
- **Keeping keys for take-back:** `iw.cards` in localStorage, in `components/ClaimMaker.tsx`.
- **Sending from the wallet:** `plan` + `budgetSend` / `ownersSend` in `lib/safe/send.ts` (what `SafeSend.tsx` uses).
  The live site is the Safe wallet (`SafeApp`); `Settings.tsx` / `lib/wallet.ts` are the old `/v3` wallet.
- **Applinks:** a tapped `instantwallet.io` link opens the app if it's installed, Safari if not. Both work.

## To build

### 1. iOS app: write NFC (instant-wallet-app repo)

Copy how `window.wedgieDrive` works in `InstantWallet/WebView.swift`.

- New `InstantWallet/Nfc.swift`: an `NFCNDEFReaderSession` that connects to the tag, checks it's writable, writes one
  URI record (`NFCNDEFPayload.wellKnownTypeURIPayload(url:)`), and returns `"ok"` or an error string.
  Set `alertMessage` to "Hold the card to the top of your phone".
- Add `window.wedgieNfc` in `bridgeJS` (same host check):
  - `available()` → `NFCNDEFReaderSession.readingAvailable`
  - `write(url)` → resolves when written, rejects with the error
- Register it with `addScriptMessageHandler(..., name: "wedgieNfc")`, like `DriveBridge`.
- `project.yml`:
  - Info: `NFCReaderUsageDescription: Instant Wallet writes claim links to NFC cards.`
  - Entitlements file: `com.apple.developer.nfc.readersession.formats` = `[NDEF]`.
- Apple developer portal: turn on **NFC Tag Reading** for `io.instantwallet` (team XX7QP5899Z). Austin may need to do
  this by hand. Without it the build fails to sign.
- Update the comment block at the top of `WebView.swift` and the README.
- Never lock the tag. Locking is permanent.

### 2. Site: the Share screen (instant-wallet repo, web/)

- In `components/safe/Keys.tsx` (the settings button), a **Share to a card** button. Show it only when `window.wedgieNfc` exists (the app).
- Share screen:
  1. Amount in USDC (preset chips like $5 / $10 / $20, plus a box). Network: Base.
  2. **Write card** does, in order:
     - make the key, save it to `iw.cards` **first** (so a failure later never loses money)
     - send the USDC from the wallet to the key's address (`budgetSend`), wait for it to land
     - `wedgieNfc.write(claimUrl(origin, key))`
     - "Done. $5 on the card."
  3. If the write fails or is cancelled: keep the key, show **Try again**. The money sits on the key, and **Take back**
     on `/claim/new` gets it back.
- Order matters: save the key, then fund, then write. Never write an unfunded card that you then forget.
- Use the production origin (`https://instantwallet.io`) in the link, not `window.location.origin`, if those can
  differ in the app.

### 3. Claim side: check it, probably no change

- Test that a tap on the card opens the app (applinks) and that `Claim.tsx` works inside the app as well as in Safari.
- Two wallet types exist: `Claim.tsx` uses `lib/safe/state` (SafeAccount) and Settings gets an `Account`. Check that a
  person who already has the app wallet gets the money in **that** wallet, not a new one.
- If the claim misses ETH-only cards or another chain, that's fine for v1: Share only puts USDC on Base.

## Test

1. Build the app to Austin's iPhone (`xcodegen generate`, Xcode, Run).
2. Settings → Share → $1 → write a wedgie card.
3. Another phone without the app: tap the card → Safari → make a wallet → claim → $1 (minus fee) lands.
4. Same with the app installed and an existing wallet: the money goes to that wallet.
5. Tap the card again: "Nothing on it".
6. Cancel mid-write: the key is still in the list, and Take back works.

## Not in v1

- Locking tags.
- Reading a card in the app (iOS already opens the link on a tap).
- Rewriting an old card. NFC Tools can do it for now.
