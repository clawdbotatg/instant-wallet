# Instant Wallet on a Safe — what's built (2026-10-06)

The first version of `docs/PLAN.md`: phases 0–2 plus recovery, live on **Base and Ethereum**.

**Use it:** https://instant-wallet-b2jn.vercel.app/safe (the v3 wallet stays at `/`).
Passkeys are bound to that hostname: a wallet made there won't open on instantwallet.io later (it can be recovered
onto a new key there, like a lost phone).

## What you can do

| level | how | what it does on chain |
|---|---|---|
| 1 Burner | Create wallet (Face ID) | Address exists at once on every chain (counterfactual). First send on a chain deploys the passkey signer + the Safe and runs the send, one relayer tx, fee paid in USDC or ETH inside your own batch. DAO (dao.buidlguidl.eth) is the 7-day recovery from the first setup. |
| 2 Hot wallet | Keys → Connect and add (a browser with MetaMask) | One batch signed by Face ID: deploys Zodiac Roles, gives the burner a daily budget (100 USDC + 0.04 ETH, refills daily), adds MetaMask, threshold 2. |
| 3 Paper | Keys → paste the paper seed's address | Your seed's address replaces the DAO as the recovery address. Cards: `/safe/paper` (OPSEK layout). |
| 4 Wedgie | Keys → Connect and add the wedgie (Chrome on a computer, wedgie running its Safe signer app) | The wedgie becomes two owners (same key, two verifier settings), threshold 3. Big moves need wedgie + one. |
| 5 | wedgie + your own recovery | no DAO anywhere (the 6-month death switch isn't built yet) |

- **Send:** within the budget = Face ID alone (a signed Zodiac Roles call). Over it = the owners (Face ID + MetaMask,
  or the wedgie + one). The review screen says which keys and the fee.
- **Recovery:** a running recovery shows a red alert with Cancel. Lost phone: "Lost my phone: recover a wallet" on a
  new device makes a new key; the recovery address runs `/safe/recover` (deploy-if-needed, start, finish after 7 days;
  for the DAO it copies the calldata for Safe{Wallet}). Afterwards the app offers to turn off the old phone's budget.
- **Each chain is its own Safe** (same address): level up per chain (Keys has a chain picker).

## How it's built

- Contracts: all deployed and audited, nothing of ours on chain. Safe 1.5 (SafeL2), Safe passkey signer 0.2.1,
  Candide SocialRecoveryModule (7 d), Zodiac Roles 2.1.1 + MultiSendUnwrapper, MultiSendCallOnly 1.5 (first setup
  only) and 1.4.1 (every other batch: the wedgie's Safe app decodes it), Multicall3. Addresses: `web/lib/safe/config.ts`.
- App: `web/lib/safe/` (core = addresses, batches, hashes, signatures; send = paths; state = per-chain reads),
  `web/components/safe/`, `web/app/safe/`.
- Relay: `web/app/api/safe/relay/route.ts`, key `RELAYER_PRIVATE_KEY` (the facilitator 0x4cFa…8A2f). It only relays
  Instant Wallet shapes (token transfers, ETH sends, the wallet's own changes), one submission per signed tx, rate
  limits, refuses a wallet for a day after a revert, pauses after 10 reverts an hour (Upstash, `RELAY_KV_*`), checks the
  fee covers the real gas, waits for the receipt. Fees today: first send ≈ $0.04 on Base, ≈ $0.55 on Ethereum.

## Tests

| what | command | result |
|---|---|---|
| Solidity, Base fork (levels 1/2/4, recovery, groups) | `cd packages/foundry && BASE_RPC_URL=… forge test --match-path 'test/safe/*'` | 38/38 |
| TS address math = chain | `cd web && npx tsx tools/safe-check.mts <base rpc>` | ok |
| Full UI journey, fork (virtual passkey, fake MetaMask, fake wedgie) | `tools/safe-e2e.mjs` (setup in its header) | 24/24 on Base and on Ethereum forks |
| Relay defences, fork | `tools/safe-relay-check.mts` | 10/10 |
| Live first send through the live relay (raw P-256 key) | `tools/safe-live.mts` | passed on Base and Ethereum mainnet |

## Not built yet (PLAN.md phases)

- Phase 4 contract (24 h wait on wedgie + one, any-two cancel, travel lock, one-key protect). Until then wedgie + one
  is instant, as PLAN.md says.
- 6-month death switch + EAS heir; group wallets UI; AI / skill.md; more chains; the indexer; alerts (push/email);
  changing the daily budget from the app; per-token budgets other than USDC/ETH.
- Big moves need a computer (MetaMask + the wedgie over Web Serial). The phone does budget sends.
- Relayer balances are small (Base ~0.005 ETH, Ethereum ~0.0015 ETH): top up 0x4cFaB32186e65E2A39EC0e882e11380cbf2f8A2f.
