# CROPS plan: from quick sends to mountain man

2026-11-11. A plan, not built. Measured against EF's "High CROPS Wallet criteria" sheet
(https://docs.google.com/spreadsheets/d/1od9xzZg1kzmq4TktXLd2vaQTuMJH7AJySzD6ji49XoI, tab gid 1434986281).
"Now" is from reading this repo's docs and code, not from running tests. Lines marked **check** were not verified.

CROPS = Censorship Resistance, Open source, Privacy, Security.

## The idea

One wallet, one address, six levels. Level 1 is easy and trusts us. Level 6 trusts nobody. The app shows your
level and the one next step. More money = a nudge up. Nothing is forced.

| level | you do | you stop trusting |
|---|---|---|
| 1 Pocket money | Face ID | nothing yet (us, Alchemy, Apple) |
| 2 Savings | add a wedgie + a backup key, 2 of 3 | a stolen or hacked phone |
| 3 Check it yourself | turn on the light client | what our node tells you |
| 4 Your own pipes | your node, your simulator, no relay, app from IPFS | our servers being up or honest |
| 5 Private | hide your IP, split accounts, private transfers | anyone watching |
| 6 Mountain man | own recovery, DAO removed, exit drill passed | everyone |

Levels 3+ work on Ethereum and Gnosis only: no other network of ours has a light client. Base stays levels 1–2.

Each part below: **Why** it's CROPS, what we do **Now**, what we **Should** do, **How**. The level it belongs to is
in the heading.

---

## 1. Works when we're down or hostile (Censorship Resistance)

The sheet's test: block our domains, make the RPC and relay refuse your address, and you can still do all of this.

### Read (level 4)
- **Why:** you can't leave if you can't see what you have.
- **Now:** Settings → Your node sends reads to your node, never back to ours. But the token list, names, logos and
  prices still come from Alchemy through our server (`alchemy_*` calls are split off in `lib/chains.ts`,
  `app/api/portfolio`). No record of approvals you signed.
- **Should:** with your node set, nothing asks our server. Keep a list in the browser of every approval, permit and
  token this wallet has seen.
- **How:** `docs/OWN-NODE.md` step 3: scan `Transfer` logs from the wallet's first block, then `balanceOf`; names
  from `symbol()`/`decimals()`; prices from Uniswap pools. Save approvals and permits to browser storage as
  they're signed (Send, Swap, WalletConnect).

### Exit (level 4)
- **Why:** the money is only yours if you can move it without asking us.
- **Now:** every phone send goes through our relay (`/api/safe/relay`). A passkey can't pay gas. A browser wallet
  can run a signed tx itself (`sendSelf` in `TxPage.tsx`), and any Safe tool opens the wallet. Send everything
  exists (`SendAll.tsx`).
- **Should:** a send that touches no server of ours, from the phone. One "Exit" button: everything, every network,
  to one address.
- **How:** options, easiest first:
  1. **Gas key:** a throwaway key in the browser that holds a little ETH and only pays gas. Not an owner, can't
     move wallet money. It submits `execTransaction` to your node.
  2. **Any relay:** Settings → Relay URL. The relay code is here and MIT, so anyone can run one.
  3. **Signed tx as a file or QR:** anyone with gas can submit it.
  4. **4337 public bundlers** (ERC-4337). Owners only, costs more.
  Check the daily-limit (Roles) path can also be submitted by anyone, not just our relay. **check**

### Revoke (level 2)
- **Why:** an old approval is a standing permission to take your coins.
- **Now:** you can Reject a waiting tx. No screen for token approvals or permits.
- **Should:** one list of everything still allowed to move your money, each with a red ✕, and "Revoke all".
- **How:** list = the browser record (above) plus `Approval` logs from your node. Revoke = one batch of
  `approve(spender, 0)`; Permit2 `lockdown`; a signed-but-unsent tx dies by using its nonce (Reject does this).
  Roles members and modules are already removable in Keys and Limits.

### Rotate (level 2)
- **Why:** you can swap a bad key without anyone's help, and a thief can't swap yours quietly.
- **Now:** owners swap keys at once (M of N). No delay, so nothing to cancel. The delay contract (PLAN phase 4)
  was never built.
- **Should:** changing keys takes two of your keys **and** a wait you set, which your current key can cancel.
  Rule: weakening is slow, protecting is instant.
- **How:** Zodiac Delay modifier (audited, not ours) in front of owner changes. Reuse the recovery alert and its
  Cancel button for a pending key change.

### Recover (level 6)
- **Why:** if one outside party can take over or block recovery, it isn't your wallet.
- **Now:** Candide recovery, the BuidlGuidl DAO after 7 or 60 days, you can cancel, alerts by email/Telegram/push.
  Own recovery addresses can't be added any more (removed 10-28, `docs/CUSTODY.md`).
- **Should:** bring back your own recovery: a paper key, a second wedgie, or 2 of 3 friends. At level 6 the DAO
  is removed.
- **How:** Candide already takes several guardians with a threshold. Add the screen back; `/paper` already prints
  seed cards. Alerts: say how to run your own watcher (`/api/alerts/check` is one job).

### Prove (level 5)
- Only matters once a privacy protocol is in (section 3): the proof to withdraw is made in the browser.

---

## 2. Baseline security

- **Why:** "trust me" isn't security. Someone else has to have checked it.
- **Now:** nothing of ours on chain: Safe, Safe passkey signer, Zodiac Roles, Candide, all audited. The relay had
  two reviews. The app, clear-signing-safe-kit and the wedgie firmware are **not audited**. No bug bounty.
  Every push to main deploys; no tags, no way to stay on an old version.
- **Should / How:**
  - **Formal verification:** list which of the four contracts have it and link the reports. **check**
  - **Audit:** the parts that are ours: key handling, signing, building and decoding a tx (`web/lib/safe`, the
    kit, the wedgie's Safe app). List the crypto libraries (`@noble/*`, Colibri) with their own audits.
  - **Bug bounty:** a page with scope, payout and how to report. Small is fine.
  - **Update integrity (nice):** tag every release; publish the build's hash; the same build on IPFS so you can
    stay on one version (also section 6, Frontends).

---

## 3. Privacy

The sheet's Must is "privacy possible", not "on by default". Test: record every request the wallet makes with a
fake portfolio and see who learns what. **We have the rig for this: `~/ef/crops-lab`. Run it first** and replace
the guesses below with what it finds.

### Origin: who's asking (level 5)
- **Why:** IP + address = a name on a balance.
- **Now:** every read goes through our server (it hides you from Alchemy, not from us). The relay keeps address
  and IP for a few days to stop abuse (`app/privacy`). Your own node fixes this for you alone.
- **Should:** a way to use the wallet where no server sees your IP with your address.
- **How:** own node on your own network (done). Then one of: BuidlGuidl RPC over anon-RPC, an OHTTP relay in
  front of `/api/rpc`, or a Tor address for the app. A web page can't use Tor by itself, so this may need the
  extension or the native app.

### Content: what you ask (level 5)
- **Why:** a server that sees your queries knows your holdings and what you're about to do.
- **Now:** our server and Alchemy see every address and call. The simulator (sim.wedgie.dev) sees every tx before
  you sign, unless you run your own or use the light client. Token logos load straight from debank, coingecko and
  others, so they see your IP and which tokens you hold.
- **Should:** with privacy on, no outside server gets your address, tokens or unsigned tx in the clear.
- **How:** own node + light-client simulation (built). Ship logos inside the app. Prices: ask for the same fixed
  list for everyone, or read Uniswap pools on chain. Later: private reads (PIR) when a provider exists.

### Linkability (level 5)
- **Why:** two accounts asked for in one request are one person.
- **Now:** one address on 14 networks, loaded together. Spending and Savings wallets come from the same browser
  and server. Alerts store your wallets next to your email or Telegram.
- **Should:** each wallet on its own connection, at its own time. Alerts you can run yourself.
- **How:** never put two wallets in one request; stagger refreshes. A fresh address per site is a "nice" and
  costly with Safes: skip for now.

### Identifiers (level 5)
- **Why:** an ID that survives a restart tracks you without your address.
- **Now:** unknown. WalletConnect and push sign-ups are the likely ones. **check**
- **How:** crops-lab test: two fresh installs, restart both, diff every request.

### Data collection (level 1)
- **Now:** no analytics, crash reports or tracking code found. This one likely passes today.
- **How:** add a check to `same-check.mjs` that fails if an analytics package or host appears.

### Privacy protocol (level 5)
- **Why:** on a public chain, hiding your IP still leaves every payment readable.
- **Now:** none.
- **Should:** shield, send privately and withdraw from inside the wallet.
- **How:** the Kohaku SDK (the sheet names it). A Safe app in Apps first, then built in. Proofs in the browser.
  Ask the Kohaku team which protocol counts.

---

## 4. Hardware key (level 2)

- **Why:** a key that can't be copied, on a screen the computer can't fake, is the only real check on what you sign.
- **Now:** this is our strongest part. The wedgie's key lives in its secure chip, needs a button press, works out
  the hash itself and shows the tx in words. The app shows the same words and coins. A delegatecall, module or
  guard shows red. The wallet survives without our app (Safe{Wallet}, recovery).
- **Gaps:**
  - **Face ID is a synced passkey** (iCloud). The sheet says no synced passkeys. So Face ID is the level-1 key,
    never the high-CROPS one. The wedgie is.
  - No proof to the wallet that a key really lives in hardware (attestation). **check** what the Trust M can give.
  - The wedgie won't sign typed data (permits), so those fall back to keys that can't show them.
  - Open question on undisclosed Trust M flaws (`~/ef/hardware-wallet-signing.md`). Get the answer before
    calling it secure.
- **How:** say plainly in Keys which key is which. Read the Trust M's Infineon certificate at pairing and show
  "hardware key: yes". Typed-data descriptors for the wedgie (clear-descriptors). Nice: show the ERC-8213 hash on
  the wedgie; a second wedgie from different parts as the backup.

---

## 5. Open source (level 4)

- **Why:** you can't check or fork what you can't read.
- **Now:** MIT, all of it, and a fork runs. Node and simulator can be swapped. The relay can't be swapped in the
  app. Swap quotes (LI.FI), onramps (Coinbase, MoonPay) and Alchemy are closed services, but not core.
- **Should:** every server we run can be replaced in Settings. Each release has a tag that builds.
- **How:** Settings → Relay URL (same as Exit). Tag releases. A CI job: licence check on every dependency, no
  binaries without source.

---

## 6. Verifies its data (level 3)

- **Why:** a lying node can show you a fake balance or a fake preview and you'd sign.
- **Now:** on Ethereum and Gnosis the browser can run the tx itself on proven state (Colibri, `lib/safe/light.ts`).
  A failed proof shows red, never the unchecked answer. It's off by default.
  Home's coin balances there can be proven too (Settings → Your node, off by default, `lib/safe/proven.ts`): faded
  until proven, red with the chain's number when our server's is wrong. Other networks stay faded. The token list,
  prices, positions and history are taken on trust. Header proofs come from one prover (Colibri's).
- **Should:** balances and allowances proven too. On by default where it works. A clear mark on every network
  that can't be checked.
- **How:**
  - **Read:** send `eth_getBalance` and `eth_call` through the same Colibri client the preview uses.
  - **Indexing:** the indexer only suggests tokens; each balance shown is a proven `balanceOf`. A missing token is
    allowed, a fake one isn't.
  - **Unverified mode:** a setting, with a mark on Home while it's on. Base and the rest wear that mark.
  - **More than one prover**, or your own (the setting exists).
  - **Frontends (nice):** enrol instantwallet.io in WEBCAT; publish the build to IPFS under an ENS name.
  - Test: a lying RPC and a lying indexer in `web/tools`, like `relay-ban-check.mts`.

---

## 7. Enforced limits (level 2)

- **Why:** a preview is a promise. A limit on chain is a guarantee, even if the app is hacked.
- **Now:** Face ID's daily limit is enforced on chain by Zodiac Roles: ETH and USDC sends only. Big moves have no
  enforced limit; the preview is only shown.
- **Should:** you can put a rule on any tx ("no more than X leaves", "no new approvals") and it fails if broken.
  The rule can never block Exit.
- **How:** wider Roles rules first (swaps, LP: `docs/CUSTODY.md`, `docs/SWAP.md`). For big moves: a last step in
  the batch that checks balances after, using someone else's audited checker (ask Philip and Rahul: transaction
  assertions, Phylax). No contract of ours.

---

## 8. Fees in the open (nice, level 1)

- **Why:** hidden fees are how wallets farm users.
- **Now:** the relay fee is a line in the batch you sign. Swap fees through LI.FI: **check** they're shown.
- **How:** every fee is a `<Money>` line on the review card. A test that the fee shown equals the fee paid on chain.

## 9. Who can act on your wallet (nice, level 2)

- **Why:** every key, module and guardian is a way in. You should see them all in one place.
- **Now:** Keys shows owners, Limits shows the budget, Recovery shows the DAO. No single list. The DAO is ours,
  behind a 7 to 60 day wait.
- **How:** one "Who can move this wallet" list: owners, modules, guards, recovery, each with what it can do and a ✕.
  Level 6 removes the DAO.

---

## Order

1. **Run crops-lab on Instant Wallet.** Real numbers for section 3, and it tests the rig.
2. **Send without our relay + the exit drill** (gas key, relay URL). The biggest Must we miss.
3. **Light client on by default, balances proven, unverified mark.**
4. **Revoke screen** and the browser record of approvals.
5. **Own recovery back; delay on key changes.**
6. **The level ladder in the app**: where you are, your next step.
7. **Tokens and prices from your own node; logos shipped in the app.**
8. **Privacy protocol** (Kohaku), then hiding the IP.
9. **Audit, bug bounty, tagged releases, IPFS build.**

The exit drill is the level-6 test: block instantwallet.io, wedgie.dev and Alchemy, then read, send everything,
revoke, rotate and recover. Pass = mountain man.

## Who else at EF

Hester called this the same project as the Mountain Man kit. Before building: Tim Clancy (User Layer, the kit),
the Kohaku team (privacy), Philip and Rahul (transaction assertions, WEBCAT), the sheet's authors. No yes / no /
adapt proposal exists yet.
