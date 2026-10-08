# Claim cards (built 2026-10-08)

Money on a QR, an NFC tag or a link. Someone scans or taps it, makes a wallet (Face ID), taps **Claim it**, the money is in.

- **Make:** `/claim/new`. New card = a fresh key, kept in this browser (so you can take back what nobody claims).
  Fill it by sending USDC or ETH to its address. Print the QRs, copy the link, or **Write NFC tag** (Android Chrome;
  on an iPhone write the link with an NFC app, e.g. NFC Tools; an NTAG213+ fits it).
- **Link:** `<origin>/pk#0x<key>`: punk wallet's and the Burner Wallet paper wallets' format, so their cards claim here
  and ours load there. `/claim#<key>` works too. The key is after `#`: never sent to a server or its logs. The page
  moves it to sessionStorage and strips it from the address bar.
- **Claim:** the card's key needs no gas. For USDC it signs two EIP-3009 `transferWithAuthorization` (everything to the
  wallet, the fee to the relay); the relay submits both in one Multicall3 call (`kind: "claim"` in
  `web/app/api/safe/relay/route.ts`, fee checked like any send). ETH pays its own gas; under 0.00005 ETH stays as dust.
  The wallet doesn't need deploying: its address exists already.
- **In the app:** scanning a claim QR with the wallet's scanner opens the claim on this wallet's host.
- **Standards (researched 2026-10-08):** no ERC covers claim links. Closest: Linkdrop's unnumbered draft
  (ethereum/EIPs#1683, a transit key in the link signs the receiver's address for an escrow contract) and Peanut
  (`?c=&v=&i=#p=`, its own vault). Both need their own contract; a plain key needs none and any wallet can sweep it.
  We follow: the `/pk#0x` link (de facto), the key in the fragment (RFC 3986, every claim-link app does this),
  EIP-3009 for the gasless USDC move, EIP-681 for payment requests elsewhere in the app.
- **Risk:** it's cash. Whoever reads the card first takes it.
- **Not built:** other tokens; USB (a phone won't open a URL from a USB stick by itself; a wedgie could serve it later).

Code: `web/lib/claim.ts`, `web/components/Claim.tsx`, `web/components/ClaimMaker.tsx`.
Test: `web/tools/claim-e2e.mjs` (Base fork, setup as safe-e2e.mjs): 8/8.
