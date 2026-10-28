# Plan: Instant Wallet on xdai.io (sweep old Burner Wallet keys)

Austin, 10-27. Put Instant Wallet at xdai.io with a slightly different look (dark, 🔥 logo). Anyone who still
has a Burner Wallet key saved there gets a sweep screen (like claim) that moves everything into their new
Instant Wallet.

Status: **merged to main 10-27.** How to switch xdai.io over and what the sweep does: `docs/XDAI.md`.

---

## What's there now (checked 10-27)

- **xdai.io** is live: AWS S3 + CloudFront, DNS on Route53 (awsdns). Last deploy 2020-11-17. No `www.xdai.io`.
- It's the old Burner Wallet (CRA build, `github.com/austintgriffith/burner-wallet`).
- **The key:** plain localStorage, `metaPrivateKey` (0x + 64 hex). Also `<address>metaPrivateKey` (cleared on
  burn). Only read when there's no `window.ethereum`.
- **Service worker:** `/service-worker.js` (Workbox 3, precaches the app, serves `/index.html` for every page).
  Returning visitors may get the old app from cache, not the network.
- `index.html` is served with `cache-control: max-age=31536000` (1 year).
- Old RPC `dai.poa.network`, relay `x.xdai.io`. Same key was also used on mainnet (the Exchange screen moved DAI
  between xDai and Ethereum).

## The one hard rule

**localStorage belongs to the origin.** The key can only be read by a page served from `https://xdai.io` itself.
So the new code must run on exactly that origin. A redirect away first loses the key.

---

## Decided (Austin, 10-27): swap the code on xdai.io

Instant Wallet replaces the old Burner code on xdai.io itself. Add `xdai.io` to the Vercel project, point
Route53 at Vercel. The app sees the hostname and switches to the 🔥 dark look. On load it checks for
`metaPrivateKey`; if found, it shows the migration screen: make a passkey Safe, move everything from the old
key into it.

- **Passkeys are tied to the domain** (`rpId = window.location.hostname` in `web/lib/passkey.ts`). A Safe made
  on xdai.io opens only on xdai.io. **Decided (Austin, 10-27): that's fine.** An xdai.io wallet is a separate
  wallet from the main site's. Passkey is for xdai.io. Top left still says "Instant Wallet".

---

## The migration screen

Reuse `web/components/Claim.tsx`. The key comes from localStorage instead of the link. Changes:

1. **Find everything.** Check the old address on every network we run, not just Base/Ethereum. Gnosis first
   (xDAI + tokens), Ethereum second (DAI, ETH). Use Alchemy token balances to find any token.
2. **xDAI (and any native coin)** pays its own gas: send balance − gas, same as the ETH path today.
3. **Tokens with no gas on the key:** USDC uses EIP-3009 (built). Others need gas. On Gnosis gas is nearly free,
   so the relay sends a tiny bit of xDAI to the old key, then the page sweeps the tokens. (Or EIP-7702 + relay;
   pick when building.)
4. **Show it first:** "Your old Burner Wallet has $X: 12.40 xDAI, 3 BUFF…". Worthless dust and spam tokens are
   listed but not moved.
5. **Never delete the key.** After a sweep, move it to `iw.oldBurnerKey`, show "Old Burner key: copy / export"
   in settings. It may hold things we can't see (NFTs, odd chains).
6. Fee: tiny or none. Gnosis gas costs nothing; maybe free sweeps are good marketing.

## The look

A hostname switch (`xdai.io` → theme): dark colors, 🔥 logo, name, favicon, manifest, OG image. Everything else
the same. Keep it to one config object, not forked components.

## Old service worker (must do, or returning users never see the new site)

Ship our own `/service-worker.js` at that exact path: on install `skipWaiting`, on activate delete all caches,
`unregister`, reload open tabs. Browsers fetch the SW script fresh on navigation, so this replaces the old one.
Our real SW (`web/public/sw.js`) stays at its own path.

The 1-year cached `index.html` can't be recalled. A visitor with it cached sees the old app until the SW kill
or the cache expires. Set `no-cache` on S3 now so it doesn't get worse.

---

## Steps

1. **Access:** Austin owns xdai.io in his AWS (account 121420011273). Registered in Route 53, expires
   2027-10-27, auto-renew on. Hosted zone `Z1YYNBSOM7DK7E`. The flip is one record: `xdai.io A` (alias to
   CloudFront `dllztdzvr6cyn`) → Vercel. Austin does it, or gives an AWS CLI login.
2. **Back up** the S3 bucket (the whole old site), so we can roll back by pointing DNS back.
3. (Decided: xdai.io wallets are their own; no cross-domain passkeys.)
4. Build: theme switch, sweep screen, multi-chain balance scan, gas drip on Gnosis, SW kill switch.
5. **Test without touching xdai.io:** a staging domain (e.g. `xdai-test.<ours>`) where a test page writes a
   `metaPrivateKey` holding a little xDAI + a token. Run the whole thing on iPhone Safari and Android Chrome.
6. **Real test:** Austin loads an old key on the live xdai.io (old app), funds it a bit, then we flip DNS and
   he sweeps it on his phone.
7. Flip DNS (Route53 → Vercel). Low TTL first so it can flip back fast.
8. Watch: how many sweeps, how much, any failures.

## Risks

- **Every script on xdai.io can read those keys.** Keep third-party scripts off that origin (no analytics,
  no widgets), strict CSP.
- Old subdomains (`bar`, `fairtags`, `helena`, `min`, `rim`, …) stay on the old code for now (Austin, 10-27).
- Old cards printed as `xdai.io/pk#…` or `xdai.io/<key>` links should keep working: route them to claim.
- People who never re-open xdai.io never sweep. Nothing to do about that.

## Decided

- Name on xdai.io: **Instant Wallet**.
- Only `xdai.io` itself is swapped. Subdomains stay old.
- xdai.io wallets are separate wallets, passkeys for xdai.io only. Top left says "Instant Wallet".

---

## What the old Burner code left behind (review 10-27, checked on chain)

| what | where | on chain now | covered? |
|---|---|---|---|
| key in localStorage `metaPrivateKey`, or a cookie of that name | browser | — | yes |
| `/pk#<key>` hex or 43-char base64url (printed cards), `/<key>`, `/#<key>` | links/QRs | — | yes |
| "seed phrase" box (any text → bip39@2 seed, no word check, m/44'/60'/0'/0/0) | Settings | — | yes (Load old Burner Wallet) |
| xDAI, tokens on Gnosis; DAI, ETH, SAI on Ethereum | the key's address | — | yes (tokens need gas on the key) |
| **Send-with-link** funds: Links `0x5170DA7a3eF514c9F12A3A49EACAF9d026162a1f` (Gnosis) | contract | **98.8 xDAI** unclaimed, 397 sends from 84 senders, 2020-04..2022-06 | **no**. All expired: only the sender's key can take them back (`executeClaim` signed by the sender) |
| **Old Burner Safes**: ProxyFactory `0x3BD7460A7B35D371d621119E2f3c1c5845b874c4`, 52 Safes; the Safe's address is in localStorage `<address>safe` | contracts | **~18 xDAI** over ~19 Safes (largest 7.5, 4.98, 2.5) | **no**. The old key is an owner: it could sign the Safe's own transfer |
| Unclaimed xDai→DAI bridge withdrawals | Ethereum bridge `0x4aa42145…` (pays USDS now) | unknown | no |
| BurnerVendor `0x57Af069C…` | contract | 152 xDAI | not users': only the super admin can `sweep` |
| Badges (NFTs) `0xCF964c89…` | contract | — | not moved |
| old payment links `/<address>;<amount>` | links | — | open Send, but default to Base, not Gnosis |
