# xdai.io

Instant Wallet also runs at xdai.io, the old Burner Wallet's domain. It's the same code and the same Vercel project.
Only the look changes, picked by hostname: dark, with the burning-wallet logo. People who still have a Burner key there
get one screen, "Burner Wallet has become Instant Wallet", and one button that sweeps everything into a new passkey
wallet.

Why the domain matters: the old key is in xdai.io's localStorage, and only a page served from `https://xdai.io` can
read it. Passkeys are tied to the domain too, so a wallet made on xdai.io opens only on xdai.io. It's a separate
wallet from instantwallet.io (decided 10-27).

How it was planned and what was found in the old code: `PLAN-xdai.md`.

---

## Switching xdai.io over

Today (10-27) xdai.io is the 2020 Burner build: S3 behind CloudFront `dllztdzvr6cyn.cloudfront.net`. DNS and the
domain are in Austin's AWS (account 121420011273), Route 53 hosted zone `Z1YYNBSOM7DK7E`. Everything that build
calls is dead (its RPC `dai.poa.network` no longer exists), so nothing works there now.

1. **Back up the old site.** In S3, find the bucket behind that CloudFront distribution and copy it somewhere (or
   leave it untouched: the rollback below only needs CloudFront to keep serving it).
2. **Add the domain in Vercel.** Project `instant-wallet-b2jn` (team buidlguidldao) → Settings → Domains → add
   `xdai.io`, production. Vercel shows the record it wants: for the bare domain an **A record `76.76.21.21`**. Use
   whatever it shows if it differs.
3. **Point DNS at Vercel.** Route 53 → `xdai.io` zone → edit the `xdai.io  A` record. Today it's an alias to
   CloudFront. Make it a plain A record, value from step 2, TTL 300. Don't touch the subdomains (`bar`, `fairtags`,
   `helena`, `min`, `rim`… stay on the old code) or the `_…acm-validations` CNAMEs.
4. **Wait for the certificate.** Vercel issues it once DNS reaches it, usually a few minutes. Until then
   `https://xdai.io` shows a certificate error.
5. **Check:**
   - `https://xdai.io` is the dark wallet with the burning-wallet logo.
   - `https://xdai.io/service-worker.js` is ours (it says "unregister"). This file removes the old site's cached
     app, so returning visitors get the new site.
   - On a phone that used the old Burner (or after scanning an old card): "Burner Wallet has become Instant Wallet"
     → **Sweep to Instant Wallet** → the money is in the new wallet.
6. **Rollback:** set the `xdai.io  A` record back to an alias to `dllztdzvr6cyn.cloudfront.net`. Old keys are never
   deleted by the new site, so going back loses nothing.

Nothing else changes: no new env vars, no code changes. The hostname check is in `web/lib/brand.ts` (`XDAI_HOSTS`).

---

## What the sweep moves

From the old key's address, on every network the app runs:

- native coins (xDAI, ETH…): each pays its own gas;
- USDC: gasless (EIP-3009);
- other tokens worth 1¢ or more (DAI, sDAI, SAI…), and NFTs (Nifty.Ink…): the key pays gas in that network's coin;
- the old Burner's optional Safes on Gnosis (41 exist, `web/lib/oldSafes.ts`): the key, as owner, sends the Safe's
  xDAI out;
- an unclaimed 2020 UNI airdrop (`/api/uni`): claimed, then swept (needs ETH on the key).

If the key has no coin for gas on a network, the screen lists what's stuck there and how much to send in first.

Where the key comes from:

- the old site's localStorage `metaPrivateKey` (or its cookie fallback): the sweep screen opens by itself;
- old cards and links: `/pk#<key>` (hex or the 43-character base64 printed cards use), `/<key>`, `/#<key>`;
- Settings → **Load old Burner Wallet**: paste a private key, or type the old "seed phrase" (any text, exactly as
  typed before).

After a sweep the key moves to `iw.oldBurnerKey`. Settings → **Copy old Burner private key** still gives it back.

## Not covered

- "Send with link" money in the old Links contract (98.8 xDAI, all expired; only the sender's key can take it back).
- Tokens inside old Safes (only their xDAI moves).
- Unclaimed xDai→DAI bridge withdrawals.
- Recovery alert links and Receive QR links still say instantwallet.io.

## Testing

- `web/tools/xdai-probe.mjs`: headless, no chain: the look, the sweep screen, stuck coins, old links, the service
  worker file.
- On a preview, `?brand=xdai` turns the look on, and `?burner=new` plants a fake old key to fund and sweep (off in
  production).
