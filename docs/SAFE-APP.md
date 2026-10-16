# Instant Wallet on a Safe — what's built (2026-10-06)

The first version of `docs/PLAN.md`: phases 0–2 plus recovery, live on **Base and Ethereum**.

**Use it:** https://instant-wallet-b2jn.vercel.app (the old v3 wallet moved to `/v3`).
Passkeys are bound to that hostname: a wallet made there won't open on instantwallet.io later (it can be recovered
onto a new key there, like a lost phone).

## What you can do

| level | how | what it does on chain |
|---|---|---|
| 1 Instant wallet | Create wallet (Face ID) | Address exists at once on every chain (counterfactual). First send on a chain deploys the passkey signer + the Safe and runs the send, one relayer tx, fee paid in USDC or ETH inside your own batch. DAO (dao.buidlguidl.eth) is the 7-day recovery from the first setup. |
| 2 Wedgie | Keys → Connect and add the wedgie (Chrome on a computer, or the iPhone drive) | One batch: deploys Zodiac Roles, gives the burner a daily budget (100 USDC + 0.04 ETH, refills daily), the wedgie becomes two owners (same key, two verifier settings), threshold 3, and recovery moves from Candide's 7-day module to its 14-day one (same guardians). Big moves and settings need Face ID + the wedgie. A wallet paired before 10-15 gets a "Make it 14 days" button. |
| 3 Own recovery | Keys → Recovery: any address you control (MetaMask, Ledger, ENS, a paper seed) | Replaces the DAO as the recovery address. It can only replace lost keys, after 7 days, and you can cancel. Seed cards: `/paper` (OPSEK layout, any 2 of 3). |

**No hot wallet (Austin 10-14).** Three things only: the passkey, the wedgie, the recovery address. The app no longer
offers to add a hot wallet. Wallets that added one before still have it as an owner: Keys shows it, and it can
still sign (`hotOf`, the `"hot"` signer in `lib/safe/send.ts`).

- **Send:** within the budget = Face ID alone (a signed Zodiac Roles call). Over it = the owners (Face ID + the wedgie). The review screen says which keys and the fee.
- **Recovery:** a running recovery shows a red alert with Cancel (it needs your owners' signatures: at level 2+ that's a
  computer with MetaMask). Lost phone: "Lost my phone: recover a wallet" on a
  new device makes a new key; the recovery address runs `/recover` (deploy-if-needed, start, finish after 7 days;
  for the DAO it copies the calldata for Safe{Wallet}). Afterwards the app offers to turn off the old phone's budget.
- **Recovery alerts** (10-14): Keys → Recovery alerts: an email, Telegram, notifications on this device (not iPhone
  Safari: it only allows them for a home-screen app). A job reads every listed wallet's recovery on every chain every
  5 min (`.github/workflows/alerts.yaml` → `/api/alerts/check`) and sends once, then once more in the last day.
  Changing them takes Face ID (P-256 checked on the server, the key must own the wallet), and the old contacts are
  told. `web/lib/alerts.ts`; test `web/tools/alerts-check.mts`. Env: `ALERT_MAIL_USER` + `ALERT_MAIL_PASS` (wedgie@buidlguidl.com, Gmail app password, same as wedgie.dev),
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_BOT_NAME` + `TELEGRAM_WEBHOOK_SECRET` (setWebhook: see the route),
  `NEXT_PUBLIC_VAPID_KEY` + `VAPID_PRIVATE_KEY`. A channel without its env is hidden.
- **Each chain is its own Safe** (same address): level up per chain (Keys has a chain picker).

- **Claim cards:** money on a QR / NFC tag / link; scan, make a wallet, claim. `/claim/new` makes them. `docs/CLAIM.md`.
- **WalletConnect:** the scan button also reads a site's `wc:` QR and connects at once, no question (the scan was the yes; a site WalletConnect flags as a scam or impostor still asks) (Settings → Connected sites to paste a link or
  disconnect). A site's calls are one owner-signed batch + the relay's fee (the same keys as a big send, never the
  budget path); messages (`personal_sign`, typed data) are ERC-1271 SafeMessage signatures, ERC-6492-wrapped until
  the Safe and this phone's signer exist on that chain. The wedgie can't sign a site's message, and a wedgie
  transaction can't park from a phone (the site waits). Calls into the wallet itself are refused.
  `web/lib/safe/connect.ts`, `web/components/safe/SafeConnect.tsx` (the connection is shared with v3).

## How it's built

- Contracts: all deployed and audited, nothing of ours on chain. Safe 1.5 (SafeL2), Safe passkey signer 0.2.1,
  Candide SocialRecoveryModule (7 d), Zodiac Roles 2.1.1 + MultiSendUnwrapper, MultiSendCallOnly 1.5 (first setup
  only) and 1.4.1 (every other batch: the wedgie's Safe app decodes it), Multicall3. Addresses: `web/lib/safe/config.ts`.
- App: `web/lib/safe/` (core = addresses, batches, hashes, signatures; send = paths; state = per-chain reads),
  `web/components/safe/`, `web/app/safe/`.
- Relay: `web/app/api/safe/relay/route.ts`, key `RELAYER_PRIVATE_KEY` (the facilitator 0x4cFa…8A2f). It only relays
  Instant Wallet shapes (ERC-20 transfers; ETH to accounts, 7702 accounts and real Safes; the wallet's own owner/module
  changes, Roles, Candide, createSigner, deployModule of Roles; and in an owner-signed batch, a site's arbitrary
  calls, never into the wallet itself, whose reverts count like a swap's), Roles calls only with shouldRevert, one submission per
  signed tx, estimates at the real fee with a gas cap per kind of send, rate limits, refuses the wallet and the IP for a
  day after a revert (Upstash, `RELAY_KV_*`; fails closed without it in production), waits for the receipt. Two
  independent reviews' findings are fixed. Fees today: first send ≈ $0.04 on Base, ≈ $0.55 on Ethereum.

## Tests

| what | command | result |
|---|---|---|
| Solidity, Base fork (levels 1/2/4, recovery, groups) | `cd packages/foundry && BASE_RPC_URL=… forge test --match-path 'test/safe/*'` | 38/38 |
| TS address math = chain | `cd web && npx tsx tools/safe-check.mts <base rpc>` | ok |
| Full UI journey, fork (virtual passkey, fake MetaMask, fake wedgie) | `tools/safe-e2e.mjs` (setup in its header) | 27/27 on Base and on Ethereum forks |
| Relay defences, fork | `tools/safe-relay-check.mts` | 10/10 on both forks and against the live relay (Base) |
| WalletConnect, fork (scan a site's QR, 6492/1271 signatures, a 2-call batch, a call into the wallet refused) | `tools/safe-wc-e2e.mjs` | 12/12 on Base |
| Live first send through the live relay (raw P-256 key) | `tools/safe-live.mts` | passed on Base and Ethereum mainnet |

## Not built yet (PLAN.md phases)

- Phase 4 contract (24 h wait on wedgie + one, any-two cancel, travel lock, one-key protect). Until then wedgie + one
  is instant, as PLAN.md says.
- 6-month death switch + EAS heir; group wallets UI; AI / skill.md; more chains; the indexer; alerts (push/email);
  changing the daily budget from the app; per-token budgets other than USDC/ETH.
- Big moves need a computer (MetaMask + the wedgie over Web Serial). The phone does budget sends.
- Relayer balances are small (Base ~0.005 ETH, Ethereum ~0.0015 ETH): top up 0x4cFaB32186e65E2A39EC0e882e11380cbf2f8A2f.
