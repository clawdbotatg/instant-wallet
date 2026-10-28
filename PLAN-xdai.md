# Plan: Instant Wallet on xdai.io (sweep old Burner Wallet keys)

Austin, 10-27. Put Instant Wallet at xdai.io with a slightly different look (dark, 🔥 logo). Anyone who still
has a Burner Wallet key saved there gets a sweep screen (like claim) that moves everything into their new
Instant Wallet.

Status: **planning.** Nothing built.

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

## Two ways to do it

### A. Instant Wallet runs on xdai.io (what Austin asked for)

Add `xdai.io` to the Vercel project, point Route53 at Vercel. The app sees the hostname and switches to the
🔥 dark look. On load it checks for `metaPrivateKey`; if there's money on it, it shows the sweep screen.

- Catch: **passkeys are tied to the domain** (`rpId = window.location.hostname` in `web/lib/passkey.ts`).
  A wallet made on xdai.io is a different wallet from one made on the main site, and can only be opened on
  xdai.io. Fix if we want one wallet everywhere: WebAuthn Related Origin Requests (`/.well-known/webauthn` on
  the main domain listing xdai.io), so xdai.io makes passkeys for the main domain. Needs a real main domain
  (not `*.vercel.app`) and a check that iOS Safari + Chrome Android both do it.

### B. Tiny bridge page on xdai.io, wallet stays on the main site

Keep it static. xdai.io serves one small page: reads `metaPrivateKey`, sends you to
`<main site>/claim#<key>` (fragment, never hits a server). The existing claim page does the rest.

- No passkey split, little new code, nothing else of ours on that origin.
- But no 🔥 version of the wallet; xdai.io is just a door.

**Leaning A** (it's the ask), with Related Origin Requests if it works on iPhone. B is the fallback, and also
a fine first step: it can ship in a day.

---

## The sweep screen

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

1. **Access:** find which AWS account has the xdai.io Route53 zone + S3 bucket + CloudFront. Need login.
2. **Back up** the S3 bucket (the whole old site), so we can roll back by pointing DNS back.
3. **Decide A or B** (and test Related Origin Requests on iPhone if A).
4. Build: theme switch, sweep screen, multi-chain balance scan, gas drip on Gnosis, SW kill switch.
5. **Test without touching xdai.io:** a staging domain (e.g. `xdai-test.<ours>`) where a test page writes a
   `metaPrivateKey` holding a little xDAI + a token. Run the whole thing on iPhone Safari and Android Chrome.
6. **Real test:** Austin loads an old key on the live xdai.io (old app), funds it a bit, then we flip DNS and
   he sweeps it on his phone.
7. Flip DNS (Route53 → Vercel). Low TTL first so it can flip back fast.
8. Watch: how many sweeps, how much, any failures.

## Risks

- **Every script on xdai.io can read those keys.** Keep third-party scripts off that origin (no analytics,
  no widgets). That's a point for B, or for a strict CSP on A.
- Other burner hosts (`s.xdai.io`, buffidai, event subdomains) are separate origins. Each needs the same
  treatment or its keys stay put. List them from the old deploy scripts (`deploy*.sh`) and decide which matter.
- Old cards printed as `xdai.io/pk#…` or `xdai.io/<key>` links should keep working: route them to claim.
- People who never re-open xdai.io never sweep. Nothing to do about that.

## Open questions for Austin

1. Who has the AWS login for xdai.io?
2. A or B? If A: one passkey wallet across both domains, or a separate xdai.io wallet is fine?
3. What's the main domain going to be? (Related Origin Requests need a real one.)
4. Name on xdai.io: "Instant Wallet", "Burner Wallet", something else?
5. Which old subdomains matter?
