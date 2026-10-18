# Plan: drops (a pot of money, many codes)

Austin, 10-18. Put $200 in one place. Hand out codes. Each code gets someone $5 into a new Instant Wallet.
The point: get people to make a wallet (passkey) and have a little money on Base on their phone.

Status: **plan, not built.** Open questions at the bottom.

---

## How it differs from claim cards (docs/CLAIM.md)

| | claim cards (built) | drops (this plan) |
|---|---|---|
| where the money is | on each card's own key | in one pot, on the server's key |
| the QR holds | the private key | a short code |
| who checks the code | nobody: whoever has the key has the money | the server |
| one QR for a crowd | no | yes |
| needs a wallet first | no (anyone can sweep the key) | **yes: the server only pays a passkey wallet** |
| giver's keys | in the giver's browser | derived on the server, never in a browser |

Cards stay as they are. Drops are a second thing next to them.

---

## Two kinds of code

1. **Card code** (one use). Printed on a card, one per person. First wallet to claim it wins, then it's dead.
   Made in batches (10 to 500), printed as a PDF with the same Avery 8371 layout the cards use.
2. **Crowd code** (many uses). One QR on a slide. Everyone who scans gets $5, once per wallet, until the pot or the
   claim cap runs out, or the time window closes.

Both live inside a **drop**: one pot, one token, one amount per claim.

```
drop "ETHDenver talk"
  pot:      0xAb…12 on Base, 200 USDC
  amount:   5 USDC per claim
  cap:      40 claims
  window:   until 10-20 18:00
  codes:    1 crowd code "GWEI"   (or 40 card codes)
```

---

## What the person scanning sees

1. Scans the QR: `instantwallet.io/d#GWEI` (code after `#`, so it's never in server logs; same trick as cards).
2. Page: **"You get $5 USDC on Base"**, and checks the code is live (not used, pot not empty, window open).
3. No wallet on this phone: the normal welcome, **Create wallet** (Face ID). Has one: skip to 4.
4. **Claim $5**: Face ID once more (signs "claim GWEI to 0xMyWallet"). The server sends the $5.
5. **"It's in your wallet"** → **Open my wallet**.

**The code follows them.** On landing, the code goes into localStorage (`iw.drop`, kept 24 h). If they wander off
mid-setup (back up a key, add to home screen, close the tab), the home screen shows a banner: **"You have $5 to
claim → Claim"**. It's cleared once claimed or dead.

Known catch (same as cards): an iPhone home-screen app has its own storage, apart from Safari. If they add it to the
home screen before claiming, the banner won't be there. Fix: the code is also short enough to type: a **"Have a code?"**
box on the home screen. For a talk, Austin can just say "type GWEI".

---

## How the money moves

### The pot

Each drop gets its own address. Its key is **derived on the server** from one secret:
`key = HKDF(DROP_SECRET, dropId)`. `DROP_SECRET` is a new Vercel env var. Nothing in Redis or a browser holds a key,
and one leaked drop key can't touch other drops.

Austin fills the pot by sending to its address (a QR on the drop's admin page, same as a card's step 1).

### USDC: the pot needs no gas

Same path as a card claim: the server signs two EIP-3009 authorizations with the pot's key (amount → wallet, fee →
relay) and hands them to the existing relay `kind: "claim"` code. The relay pays the gas and takes ~$0.003 on Base.
EIP-3009 uses random nonces, so 50 claims at once don't fight over a nonce.

The claimer gets exactly $5; the fee comes from the pot on top. Austin funds "$5 × N + a little".

### ETH: the pot pays its own gas

The server sends ETH from the pot's key directly. Claims on one pot go one at a time (the existing `withChainLock`,
keyed by the pot) so nonces don't collide. On Base each takes ~2 s; 50 people at once clear in under 2 minutes.

### Other tokens

v1: USDC and ETH on Base and Ethereum. Other stablecoins (USDT, DAI) don't have EIP-3009, so the pot would need ETH
for gas: doable later with the same ETH path.

### Mainnet

Works the same. A USDC claim on Ethereum costs roughly $0.30–2 in gas today (comes out of the pot). The admin page
shows the current cost per claim before Austin picks Ethereum.

---

## Keeping it from being farmed

The server checks, in this order, before sending anything:

1. **Code is real and live**: drop exists, window open, pot has enough, claims < cap.
2. **The wallet is a real Instant Wallet and the claimer holds it**: a passkey signature over
   `(code, wallet, time)`, checked with the existing `authorize()` from alerts (P-256, counterfactual address or
   on-chain owner). So the money only goes to a passkey wallet, and nobody can claim to someone else's address.
3. **Once**: card code → `SET NX code:used`. Crowd code → `SET NX drop:<id>:wallet:<addr>` (one claim per wallet
   per drop) **and** an atomic counter for the cap.
4. **Rate limits**: per IP (loose: a whole conference shares wifi), per drop per minute.

What we can't stop: one person making 10 passkey wallets and claiming a crowd code 10 times. Passkeys are free. The
limits that bound the loss:
- **the cap** (40 claims max, whatever happens);
- **the window** (open only during the talk, e.g. 30 min);
- **a rotating QR** (optional): the slide shows a QR that changes every 30 s (`GWEI-<time code>`), so a photo of it
  posted online dies in a minute. People in the room still scan it fine.
- **one per device** (soft): a flag in localStorage. Stops casual double-dips, not a determined person.

Card codes don't have this problem: one card, one claim.

---

## The admin page: `/drop/new` (Austin)

Gated by Austin's own Instant Wallet passkey (wallet address in `DROP_ADMINS` env). Every change is a signed request,
checked with `authorize()`. No passwords.

- **New drop**: name, network, token, amount per claim, kind (cards / crowd), how many (cap), window (optional).
- **Fill**: shows the pot's address + QR, live balance, "enough for 37 of 40 claims".
- **Cards**: **Download PDF** (Avery 8371, reusing `claimBatch.ts`'s layout), **Copy all links** (CSV for a card
  printer service), per-card status (ready / claimed by 0x…, when).
- **Crowd**: a **Present** button: full-screen QR + big code text + a live "23 claimed · $85 left" counter. Rotates
  if rotating is on.
- **Pause / resume**, **End** (kills all codes).
- **Take back**: sweep what's left in the pot to Austin's wallet (USDC via the relay, ETH directly).
- A list of claims: wallet, time, tx link.

---

## Data (Upstash Redis, the one alerts already use; prefix `iws:drop:`)

```
drop:<id>          { name, chainId, token, amount, kind, cap, opensAt, closesAt, paused, admin, createdAt }
drop:<id>:count    claims so far (INCR)
drop:<id>:claims   list of { wallet, code, tx, at }
drop:<id>:w:<addr> 1   (crowd: one per wallet)
code:<code>        <dropId>   (card codes and crowd codes both)
code:<code>:used   { wallet, tx, at }   (card codes)
drops              set of drop ids
```

Codes: card codes are 10 characters from a no-confusion alphabet (no 0/O, 1/I/L): ~50 bits, can't be guessed under
the rate limit. Crowd codes can be a word Austin picks ("GWEI") since anyone in the room has it anyway.

Order of a claim on the server, so a failure never pays twice or burns a code for nothing:
1. checks → 2. reserve (`SET NX` + `INCR`) → 3. send → 4. on a failed send, release the reservation.

---

## Files

| file | what |
|---|---|
| `web/lib/drops.ts` | Redis model, key derivation, code generation, the claim checks |
| `web/app/api/drop/route.ts` | `GET ?code=` (what's it worth, is it live), `POST` claim |
| `web/app/api/drop/admin/route.ts` | create, list, pause, end, take back (signed by an admin passkey) |
| `web/components/Drop.tsx` | the claim page (reuses the welcome / wallet creation from `Claim.tsx`) |
| `web/components/DropAdmin.tsx` | `/drop/new`: drops, fill, PDF, Present |
| `web/app/d/page.tsx`, `web/app/drop/new/page.tsx` | routes |
| home screen | "You have $X to claim" banner + "Have a code?" box; the in-app scanner reads drop QRs |
| `web/lib/claimBatch.ts` | PDF: take a list of links + a label, not only card keys |
| `web/tools/drop-e2e.mjs` | Base fork test (below) |
| `docs/DROPS.md` | how to use it, after it's built |

---

## Test (Base fork, same setup as `claim-e2e.mjs`)

1. Admin makes a card drop (3 × 5 USDC), fills it, downloads the PDF.
2. Phone with no wallet opens a card code → makes a wallet → claims → wallet has 5 USDC, pot down by 5 + fee.
3. Same card again → "already claimed". Second phone → same.
4. Crowd drop, cap 2: three phones; two get paid, the third sees "all gone".
5. Same wallet twice on a crowd code → refused.
6. Claim to a wallet whose passkey you don't hold → refused.
7. Expired window, paused drop, empty pot → refused, nothing sent.
8. The code follows: land, close the tab before claiming, open the home screen → banner → claim works.
9. 20 crowd claims at once → all 20 land, no nonce errors (USDC and ETH).
10. Take back → pot empty, Austin's wallet has the rest.

Then one real claim on Base with a real phone.

---

## Build order

1. Server: `drops.ts`, claim API, USDC on Base only. Test steps 2–7.
2. Claim page + "code follows them" + home banner + "Have a code?".
3. Admin page: create, fill, take back, card PDF.
4. Present mode for crowd codes (+ rotating QR if wanted).
5. ETH, then Ethereum mainnet.
6. Docs, e2e, ship.

Roughly a day of work for 1–3, half a day for 4–6.

---

## Open questions

1. **Crowd farming:** cap + window enough, or also the rotating QR?
2. **Admin:** OK to gate `/drop/new` with your Instant Wallet passkey (`DROP_ADMINS` = your wallet address)?
3. **v1 tokens/chains:** Base USDC first, then Base ETH and mainnet? Or do you need mainnet ETH on day one?
4. **Leftovers:** when a drop ends, sweep the rest back to your wallet automatically, or leave it until you tap Take back?
5. **Domain on the QR:** `instantwallet.io` (short, permanent) or the Vercel URL?
6. **Gas for new wallets:** should a claim also include a few cents of ETH so the wallet can do things right away,
   or is USDC enough (the relay already takes fees in USDC)?
