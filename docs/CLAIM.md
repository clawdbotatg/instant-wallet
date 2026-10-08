# Claim cards

Built 2026-10-08. Live at https://instant-wallet-b2jn.vercel.app/claim/new.

Money you can hand to someone. It can be a QR on paper, an NFC sticker, or a link. They scan or tap it, make a wallet
with Face ID, tap **Claim it**, and the money is in their own wallet. They need no app, no ETH and no account first.

The old way (Burner Wallet paper wallets) gave someone a private key. This is the same idea, but the money moves from
the card into the person's own passkey wallet, so the card is just cash, not their wallet.

---

## 1. Using it

### Make cards (the giver)

1. Open `/claim/new` on any browser.
2. Tap **New card**. Each tap makes a new random key: one card = one key.
3. Fill it: **Copy address**, then send USDC (or ETH) to that address on Base or Ethereum. Any wallet works, including
   Instant Wallet's own Send. The card shows its balance a few seconds later.
4. Get it to the person, any of these ways:
   - **Print**: prints the QRs, two to a row, no buttons. Cut them out.
   - **Copy link**: send it in a message.
   - **Write NFC tag**: hold a blank tag to the phone (Android Chrome only, see section 4).
5. **Take it back**: opens the card's link in your own browser, which claims it into your own wallet. Use it for cards
   nobody claimed.
6. **Forget**: removes the card from this list. If it still holds money, it asks first. Forgetting doesn't empty the
   card: whoever has the card can still claim it. You just lose your way to take it back.

The keys live in this browser only (localStorage `iw.cards`). Clearing site data, or a different browser, means no
take-back. Make cards on a device you keep.

### Claim a card (the receiver)

1. Scan the QR with the phone camera, tap the NFC tag, or open the link.
2. The page shows **Someone sent you $X** and what it is (for example `5 USDC + 0.001 ETH`).
3. No wallet on this phone yet: the normal welcome shows under it. **Create wallet** (Face ID) or **I already have
   one**. The wallet's address exists right away, before it's on chain, so the money can go straight to it.
4. Tap **Claim it**. A few seconds later: **It's in your wallet $X** (after fees), then **Open my wallet**.
5. Open the same card again later: **Nothing on it: it was claimed already, or it hasn't been filled yet.**

Already have Instant Wallet open? The scan button on the home screen reads claim QRs too: it opens the claim on the
wallet's own site, so the money goes to the wallet you're in.

---

## 2. The link

```
https://instant-wallet-b2jn.vercel.app/pk#0x<64 hex characters: the private key>
```

- **`/pk#0x…`** is Punk Wallet's format, the same one Austin's Burner Wallet paper wallets used. So:
  - a Punk Wallet / Burner Wallet card opens here and claims (if it holds USDC or ETH on Base or Ethereum);
  - our card scanned in Punk Wallet loads there as a wallet.
- **`/claim#<key>`** works too, with or without `0x`.
- **The key is after `#`.** Browsers never send that part to a server (RFC 3986 fragment), so it's not in Vercel's
  logs, analytics, or a proxy's logs.
- **On open, the page takes the key out of the address bar** (`history.replaceState`) and keeps it in this tab's
  sessionStorage (`iw.claim`). A screenshot, a synced tab or the browser history won't carry it. Reloading still works.
  It's deleted after a successful claim.
- Length: about 100 characters. It fits a QR easily and the smallest common NFC tag (NTAG213, 144 bytes).

---

## 3. How the money moves

### USDC: the card needs no gas

A card holds no ETH, so it can't send a normal transaction. USDC has a built-in fix: **EIP-3009
`transferWithAuthorization`**. The owner signs a message saying "move X to Y"; anyone can submit it and pay the gas.

The claim page, in the browser, with the card's key:

1. Asks the relay for a quote (`GET /api/safe/relay?chainId=…&kind=claim`): the fee in USDC and the relay's address.
2. Reads USDC's EIP-712 name and version from the chain (no hard-coded domain).
3. Signs **two** authorizations, each with a random nonce, valid for 1 hour:
   - balance − fee → the receiver's wallet
   - fee → the relay
4. Posts both: `POST /api/safe/relay { chainId, kind: "claim", auths: [toWallet, fee] }`.
5. The relay submits one Multicall3 `aggregate3` call with both transfers, neither allowed to fail, and pays the gas.
6. The page waits for the receipt.

Fee today: **about $0.003 on Base**, more on Ethereum (it follows gas). The quote is 130k gas × gas price × 1.5 (+ a
small L1 data allowance on Base). The relay checks the real cost before sending.

### ETH: the card pays its own gas

ETH has no signed-transfer feature, but the ETH on the card can pay for its own move. The page estimates gas, sends
`balance − gas cost` to the wallet with the card's key, through our RPC proxy. Under 0.00005 ETH is treated as dust:
it costs more to move than it's worth, stays on the card, and the card shows as empty.

### Several networks

The page reads USDC and ETH on every network the app runs on (Base, Ethereum) and claims each one in turn. If one fails
midway, open the card again: what's left is still there.

---

## 4. NFC tags

- **Tag:** any NFC Forum Type 2 tag. NTAG213 (144 bytes) fits the link; NTAG215/216 have more room. Stickers, cards,
  key fobs all work.
- **Write on Android:** Chrome on Android has Web NFC. On `/claim/new`, **Write NFC tag**, hold the tag to the back of
  the phone. It writes one URL record.
- **Write on iPhone:** Safari has no Web NFC, so the button doesn't show. **Copy link**, then write it with an app such
  as NFC Tools (Write → Add a record → URL).
- **Read:** iPhones (XS and later) read URL tags without an app: a notification pops up, tap it, Safari opens the claim.
  Android opens it in the browser.
- **Lock** a tag after writing (NFC Tools: Other → Lock tag) if you don't want someone to overwrite it. Locking is
  permanent.

---

## 5. What keeps it safe

### It's cash

Whoever reads the card first can take the money: the QR, the tag, the link are the key. Treat cards like banknotes.
Don't put more on a card than you'd hand someone in cash. A tag can be read through a bag at a few centimetres.

### What can't go wrong

- **No one can redirect a claim.** The receiver's address is inside the signed message. Someone watching the network
  can submit it early, but the money still goes to the same wallet.
- **Two people with the same card:** the first claim wins; the second sees an empty card.
- **The server never sees the key**, only signed transfers to one wallet and one fee.
- **The relay can't take more than the fee.** It only submits what the card signed.

### What the relay checks (`kind: "claim"` in `web/app/api/safe/relay/route.ts`)

The relay pays gas first, so it refuses anything that could waste it:

- exactly two authorizations, well formed (`validAuth` in `web/lib/claim.ts`);
- both from the same card; the fee one pays **the relay**, the other one does **not**;
- something to claim (value > 0), and two different nonces;
- the transfers run only on that network's USDC contract (the relay picks the address, the client can't);
- it must pass a gas estimate, use ≤ 250k gas, and the fee must cover the real cost;
- each signed claim is sent once (a replay is refused: the authorization is already spent on chain);
- the same rate limits as sends, per IP and per card; a claim that reverts blocks that card and that IP for a day.

`web/tools/claim-e2e.mjs` tries a claim with no fee to the relay and a replay; both are refused.

### The giver's keys

`/claim/new` keeps the card keys in plain localStorage. Anyone with that browser, or a malicious extension in it, could
take them. Make cards on a device you trust, and take back old ones.

---

## 6. Standards (researched 2026-10-08)

Austin's order: **work really well first, follow standards second.**

There is **no ERC for claim links**. What exists:

| what | is it | what we did |
|---|---|---|
| Punk Wallet / Burner Wallet `/pk#0x<key>` | de facto, Austin's own, widely printed | **our link format** |
| Key in the URL fragment (`#`) | RFC 3986 behaviour; every claim-link app does this | **yes** |
| EIP-3009 `transferWithAuthorization` | final standard, built into USDC | **the gasless USDC move** |
| EIP-712 typed signatures | final standard | the signatures above |
| EIP-681 payment requests (`ethereum:…`) | final standard | used by Receive / Request, not by claims |
| Linkdrop (ethereum/EIPs#1683) | draft from 2019, never numbered | not used: needs its own escrow contract |
| Peanut links (`?c=&v=&i=#p=`) | one company's format | not used: needs Peanut's vault contract |

Why a plain key and not an escrow contract: no contract of ours on chain, nothing to audit, and any wallet in the world
can sweep a plain key (import it) if our site is ever gone.

---

## 7. Code

| file | what |
|---|---|
| `web/lib/claim.ts` | link format (`claimUrl`, `claimKey`, `isClaimLink`), EIP-3009 ABI and types, the relay's shape check |
| `web/components/Claim.tsx` | the claim page: read balances, make a wallet, sign, post, wait |
| `web/components/ClaimMaker.tsx` | `/claim/new`: make, list, fund, print, NFC, take back, forget |
| `web/app/pk/page.tsx`, `web/app/claim/page.tsx`, `web/app/claim/new/page.tsx` | the routes |
| `web/app/api/safe/relay/route.ts` | `kind: "claim"` branch |
| `web/lib/safe/fee.ts` | gas: `claim` typical 130k, budget 250k |
| `web/components/safe/SafeSend.tsx` | the in-app scanner hands claim QRs to `/claim` |
| `web/app/globals.css` | print layout (`.claim-maker`, `.claim-card`) |

## 8. Test

`web/tools/claim-e2e.mjs`, on a Base fork with the same setup as `tools/safe-e2e.mjs` (anvil fork + `next dev` on 3100):

```
CHROME=<chromium> node tools/claim-e2e.mjs /tmp/shots
```

It fills a card with 5 USDC + 0.001 ETH, opens `/pk#0x…` on a phone with no wallet, makes one (virtual passkey),
claims, checks the wallet got the USDC minus the fee and the ETH, opens `/claim#…` and sees it empty, then tests the
relay's refusals. **8/8 passed 2026-10-08.** Live check: the Base relay quotes `kind=claim` (fee ≈ $0.003).

Not yet done: a real claim on mainnet with a real phone and a real NFC tag.

---

## 9. Limits and ideas

**Not built**

- Tokens other than USDC and ETH stay on the card (import the key into any wallet to get them).
- USDC under the fee can't be claimed through the relay.
- USB: a phone won't open a link from a USB stick by itself. A wedgie could hold claim keys and hand them over later.
- The card doesn't print its amount or a note.

**Ideas**

- **Fill from my wallet:** one button on `/claim/new` that opens Send with the card's address and an amount.
- **Make many at once:** "10 cards × $5" fills them all in one batch from your wallet.
- **Amount + note on the printed card**, and a nicer card design (logo, cut lines, folded so the QR is hidden).
- **Password cards:** a second secret on a separate channel (like Peanut's), so a stolen card alone isn't enough.
- **Expiry:** auto take-back of unclaimed cards after N days (needs the giver's browser open, or a contract).
- **Claim other tokens** with Permit2 or the card's own ETH.
