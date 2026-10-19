# Drops

Built 2026-10-18. One pot of money, many codes. Each code pays into a new Instant Wallet. Admin page:
https://instantwallet.io/drops

Claim cards (docs/CLAIM.md) put the money on each card's own key. Drops keep it in one pot on the server, and the server
only pays a passkey wallet, so a code is worth nothing without making a wallet.

## Two kinds

- **Cards:** one use per code. 1 to 500 per drop. Download a PDF (Avery 8371 business-card sheets, 10 a page) or a
  CSV of links for a print shop.
- **Crowd:** one code for a room (a talk). Each wallet claims once. Stops at the cap or when the window closes.
  **Present** shows a full-screen QR, the code to type, and the claim count.

## Make one (you)

1. Open `/drops`. **Log in with Face ID** (an Instant Wallet on this phone) or **Log in with a wallet** (MetaMask,
   Rabby, or a wallet's own browser: sign a one-time message). The wallet must be in `DROP_ADMINS` (atg.eth is).
2. **New drop:** crowd or cards, Base or Ethereum, USDC or ETH, amount per claim, how many / the cap, crowd code
   (or random), window in minutes (blank = no limit).
3. **Fill the pot:** send to the pot's address (QR on the drop). It says "Enough for X of the Y claims left" and how
   much more to send. USDC claims also cost the pot the relay's fee (~$0.003 on Base, more on Ethereum).
4. **Pause / End / Take back.** Take back sends everything left in the pot to your wallet. Nothing moves back on its
   own.

## Claim one (them)

1. Scan the QR (`instantwallet.io/d#CODE`), or go to `instantwallet.io/d` and type the code.
2. "You get $5". No wallet: **Create wallet** (Face ID). Then **Claim $5** (Face ID again: proves the wallet is
   theirs). A few seconds, with a progress bar. Then **Open my wallet**.
3. The code is kept on the phone for a day. If they leave mid-setup, the home screen shows **You have money to claim**.
   The in-app scanner reads drop QRs too. An empty home screen has a **Have a code?** link.

## How it works

- **Pot key:** each drop's key = HKDF(`DROP_SECRET`, drop id). Nothing stores a key. Lose `DROP_SECRET` = lose
  every pot's money: it's in Vercel (production, readable type) — keep a copy.
- **USDC:** the pot signs two EIP-3009 transfers (amount → wallet, fee → relay); the relay submits them. The pot needs
  no ETH.
- **ETH:** the pot sends it and pays its own gas. One send at a time per pot.
- **Claim checks:** code is live → the wallet's passkey signed `claim <CODE>` (same check as recovery alerts) →
  reserve (card used / this wallet's crowd claim / a place under the cap) → send → wait for it to land. A failed send
  gives the reservation back. 300 claims per IP per hour.
- **Farming:** one person can make many passkey wallets and claim a crowd code many times. The cap and the window
  bound the loss. Cards can't be farmed.
- **Storage:** Upstash Redis (`RELAY_KV_*`), keys `iws:drop:`. Layout in `web/lib/drops.ts`.

## Env

| var | what |
|---|---|
| `DROP_SECRET` | derives every pot key. Set in Vercel production. |
| `DROP_ADMINS` | wallet addresses that can use `/drops`, comma-separated. Unset in production = nobody. Set: atg.eth `0x34aA3F359A9D614239015126635CE7732c18fDF3`. |

## Code

| file | what |
|---|---|
| `web/lib/drops.ts` | pots, codes, claim, send USDC / ETH, take back, admin sessions |
| `web/lib/dropClient.ts` | link format, the stashed code, the passkey signature |
| `web/app/api/drop/route.ts` | GET a code's info, POST a claim |
| `web/app/api/drop/admin/route.ts` | login, list, get, create, set, takeback |
| `web/components/Drop.tsx` | `/d`: the claim page |
| `web/components/DropAdmin.tsx` | `/drops`: the admin page, Present |
| `web/lib/kv.ts` | Redis, with an in-memory store for local tests |
| `web/lib/safe/relayCore.ts` | the relay's key, clients and quote (shared with `/api/safe/relay`) |

## Test

Base fork (anvil + `next dev -p 3100`, see the top of each file):

- `npx tsx tools/drop-check.mts`: API. Cards, crowd, cap, used card, second claim, wrong passkey, paused, ended, empty
  pot, 20 USDC claims at once, 20 ETH claims at once, take back. **30/30 passed 2026-10-18.**
- `CHROME=<chromium> node tools/drop-e2e.mjs /tmp/shots`: browser with virtual passkeys. Admin logs in, makes a drop,
  a new phone claims, a phone claims from the home banner, typed code, wrong code, Present, PDF. **17/17 passed
  2026-10-18.**

Not done yet: a real claim on Base and Ethereum with a real phone.
