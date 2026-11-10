# Fix list

From the full read-through on 2026-11-09 (commit `e21311d` fixed the first batch). One at a time: pick a number,
fix it, check it off here in the same commit.

Each item was found by reading the code. None was reproduced on the live site unless it says so. Line numbers are
from `e21311d` and drift. Paths are under `web/` unless they start with another folder.

Suggested first: 1, 3, 5, 12, 20.

## Money and safety

- [x] **1. A recovery alert that fails to send is marked sent.**
  `app/api/alerts/check/route.ts:22-27`. `once("sent:<id>")` is set before `notify()`. `notify` collects errors, the
  route answers 200, and the GitHub cron (`curl --fail`) stays green. A Gmail or Telegram failure loses the alert.
  Fix: take the `sent:` / `soon:` key back when nobody was reached; answer 500 so the workflow goes red.
  Watch out: a channel that always fails must not make the working ones repeat every 5 minutes.

- [x] **2. Anyone can delete any wallet's parked wedgie tx.** (Fixed by removing the park path: nothing parked
  since 10-30 and a parked tx lived 7 days.)
  `app/api/safe/pending/route.ts:106-118`. DELETE needs only chain, safe and hash, and the open GET gives the hash.
  The queue's DELETE needs an owner's signature. Fix: the same signature, or remove the park path (item 26b).

- [x] **3. The relay marks a tx "already sent" before sending it.**
  `app/api/safe/relay/route.ts:185-194`. `once("tx:…", 3600)` then `withChainLock(sendTransaction)`. If the lock is
  busy (503) or the node says no, the key stays and the retry gets 409 "Already sent." for an hour.
  Fix: take the key back when it surely didn't go out (lock busy, or the node answered with an RPC error). Keep it
  on a timeout or dropped connection: that one may have gone out.

- [x] **4. The relay's chain lock.**
  `lib/safe/relayGuard.ts` `withLock`: each holder puts its own mark on the lock and deletes it only if it's still
  its own, so a send slower than the lock's 20 s can't delete the next holder's lock. `bump()` (there and in
  `lib/drops.ts`) sets the counter's life first, then counts, so a counter can't be left without a life.
  Checked in memory mode only (no Upstash keys on this machine): one holder at a time, released after.

- [ ] **4b. The relay keeps no memory of its last nonce.** Drops do (`lib/drops.ts` `sendEth`: never below last + 1,
  for an RPC that lags our own last send). Not copied to the relay on purpose: if a sent tx is ever dropped by the
  network, last + 1 leaves a gap and every later relay send on that chain sticks until the memory expires (1 h).
  Today a lagging RPC gives the user an error and they retry. Decide which is worse.

- [x] **5. The shared tx queue loses a signature when two owners sign at once.**
  `app/api/safe/queue/route.ts` (POST, DELETE) and `app/api/safe/invite/route.ts` (PUT): read, edit, write on one
  JSON blob. Now each inside `withLock`.

- [x] **5b. The same read-edit-write, still open.** `lib/drops.ts:168-178` (`updateDrop`: two admin changes at
  once), alert contacts (`app/api/alerts/route.ts:30,74`, `app/api/alerts/telegram/route.ts:30-33`,
  `lib/alerts.ts:191`: an email change and a push change at once, one is lost). The alert ones send messages
  between the read and the write, so the lock (20 s) has to wrap only the read and write.

- [x] **6. Drop claims.** (b and c; a is 6a below)
  b. If the kv write of the nonce failed after an ETH claim went out, `claim()` released the code and it could be
     claimed again. Done: that write is best-effort.
  c. Dozens of claims at once got "The relay is busy" after 10 s. Done: a claim waits 25 s for its turn, and the
     drop routes run 120 s, so a claim isn't killed mid-way. Not fixed: claims and normal sends still share one
     lock per chain (the relay's nonce), so a big drop still slows sends on that chain.

- [ ] **6a. A claim killed mid-way holds its code for good.** `lib/drops.ts` `claim`: the hold is
  `SET "pending" NX` with no life and no log row. Much rarer now (routes run 120 s). A plain life on "pending"
  risks a double pay. A safe way, to decide: USDC signs a nonce made from the code (a second pay reverts on
  chain; `authorizationState` says if the first landed); ETH saves the pot nonce in the hold before sending and a
  retry reuses it.

- [x] **7. `authorize` lets a replaced passkey back in when the RPC errors.**
  `lib/alerts.ts` `authorize`. A failed `getCode` reads as "not deployed"; if every chain the wallet lives on
  errors, the counterfactual check passes a passkey that a recovery replaced. Fix: answer "Couldn't check the
  wallet. Try again." when any chain's read fails.

- [x] **8. Push alerts POST to any https URL a user gives.**
  `app/api/alerts/route.ts:59-63`, sent by `lib/alerts.ts:168-177`. The gate is a passkey signature for any wallet,
  and an undeployed one passes, so it's free. `sendNotification` has no timeout, so a slow URL stalls the cron.
  Fix: allow only push hosts (`fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com`,
  `*.notify.windows.com`) and pass a timeout.

- [x] **8b. A dead new device wipes the wallet's other contacts.**
  `app/api/alerts/route.ts:77-80` calls `notify` with only the new contact; `lib/alerts.ts` notify then saves
  `{ ...c, push: alive }` over the whole record. If that first push says 404/410, email and telegram are gone.
  Fix: notify re-reads the saved contacts and only removes the dead endpoints.

- [x] **9. A failed `getCode` turns a wedgie into a browser wallet.**
  `lib/safe/state.ts:241`. `.catch(() => "0x00")` makes `isPasskey` false, so `hasWedgie`, the level and the fee
  kind are wrong for that refresh ("fee too low"). Fix: throw so that chain is skipped this tick, or keep the last
  answer.

- [x] **10. No sign-in or limits.** Done 11-10: one limit per IP (`lib/limit.ts` `tooMany`) on the routes that
  cost money or storage: `/api/positions` (120 paid Zerion calls an hour; `fresh=1` no longer skips a cache under
  5 s old), `/api/safe/svc` (40 uncached reads a day, 60 writes an hour), `/api/name` PUT (30 an hour),
  `/api/safe/invite` POST (30 an hour), `/api/safe/queue` POST (120 an hour, before any chain read),
  `/api/safe/relay` POST (240 an hour, before its chain reads).

- [ ] **10b. Left from 10.**
  - `app/api/drop/admin/route.ts:61-93`: any admin can change or take back any drop (`d.admin` is never checked).
  - `app/api/alerts/route.ts:15-19`: an open GET shows the first 2 letters and the domain of a wallet's alert email.

- [x] **11. Public RPC when the Alchemy key is missing.**
  These pass `http(upstreamRpc(id))` unchecked, so viem falls back to the chain's public RPC: `app/api/ens`,
  `uni`, `onramp`, `portfolio:63`, `bundler:59,77`, `lib/drops.ts:254,426`. Others throw "chain not enabled".
  Fix: one helper that throws. Also `web/tools/aa-live.mjs:20`, `wc-e2e.mjs:63`, `relay-tip-demo.mjs:15` and
  `packages/foundry/foundry.toml` name public RPCs.

- [ ] **11b. Smaller, same area.**
  - `lib/safe/describe.ts:33` hard-codes the relayer's address; the fee goes to the address from
    `RELAYER_PRIVATE_KEY`. Nothing checks they match. If they ever differ, the fee line reads as a plain send.
  - `lib/safe/share.ts:108-109`: a confirmation posted to Safe's service is never checked (`r.ok`).
  - `lib/parse.ts:48-54`: an EIP-681 request with no recipient comes back as a payment to "".
  - `app/api/onramp/route.ts:43-49,107-115`: bad input gives a 500, not a 400.
  - `app/api/uni/route.ts:22-23`: a case-sensitive sort against a lowercased address may pick the wrong chunk (a
    false "nothing to claim"). Not checked against Uniswap's data.
  - `app/api/ens/route.ts:19`: name → address can be served up to 7 days old.
  - `app/api/price/route.ts:11-12` and `lib/price.ts:15-16`: a failed price (0) is cached.
  - `lib/safe/relayGuard.ts:109,121`, `lib/drops.ts:212`: 60 sends an hour per IP and a 1-day ban after one revert.
    A crowd on one Wi-Fi shares an IP.
  - Two passkey checks: `app/api/onramp` checks origin, rpId and the UV flag; `lib/alerts.ts` `authorize` checks
    none of them.
  - Three ETH prices: Coinbase from the browser (`lib/price.ts`), Coinbase on the server (`relayCore.ts:45`), and a
    Uniswap pool's spot price that sets what an ETH drop pays (`lib/drops.ts:252`).

## What people see

- [x] **12. "What it does" is asked once and kept for the page's life, failures too.**
  `components/safe/WhatItDoes.tsx:31-48,96-127`. A waiting tx that showed "Would fail now" still says so after the
  wallet is funded; a simulator blip leaves a card with no coins until reload. This is expectation #1.
  Fix: never keep a failed ask; keep the coins ~30 s and ask again while the card is on screen.

- [ ] **13. Waits of 5 s+ with no progress bar.**
  `SendAll.tsx:214-230` · `Waiting.tsx:143-145` (reject) · `SafeApp.tsx` (budget turn-off) ·
  `RecoveryAlert.tsx:80-82` (Cancelling…) · `Claim.tsx:468-471` (the normal claim; the xdai branch has one) ·
  `SafeSwap.tsx:352-358` ("On its way…") · `SimSetting.tsx:14`.

- [ ] **14. Bare `short(…)` addresses where the rule says `<Who>` / `<Words>`.**
  `RecoveryAlert.tsx:75` (who is taking the wallet: the one that matters) · `Activity.tsx:196-199` (Received from) ·
  `SafeSend.tsx:280` (done screen) · `SafeConnect.tsx:234` · `Join.tsx:66-68` · `ClaimMaker.tsx:224,255` ·
  `RecoverTool.tsx:90,111` · `SafeWelcome.tsx:155-158` (raw hex).

- [ ] **15. Words and colors against EXPECTATIONS #2. Decide: change, or write the exception down.**
  - `Activity.tsx:114`: "Sending… / Sent" (rule: Executing / Executed). Added on purpose in `6bc331a`.
  - `Apps.tsx:87-89`: a red "✕ Close". A comment says Austin asked for it on 10-31.
  - `TxPage.tsx:360`: the passkey row's button says "Face ID"; the other rows say "Sign".
  - A button that changes color: `DropAdmin.tsx:162`, `Waiting.tsx:149`, `WedgieButton.tsx:353,369`.
  - Hand-written money: `WhatItDoes.tsx:164-166` ("− SYMBOL (amount not known)"), `Drop.tsx:118`, `Claim.tsx:385`.
  - The stage words ("Signing…", "Executing…") are written four times and differ: `SafeSend.tsx:291`,
    `SafeSwap.tsx:370`, `SafeConnect.tsx:172`, `Share.tsx:214`, `SendAll.tsx:225`. One `stageLabel` in `bits.tsx`.

- [ ] **16. USDC dust on one network stops the whole claim.**
  `components/Claim.tsx:311-314`. `claimUsdc` throws inside the loop over networks, so later networks are never
  claimed. `claimEth` returns 0 for the same case. Fix: skip that network and say so.

- [x] **17. Pulling the WalletConnect sheet down mid-sign tells the site "rejected" while the tx still runs.**
  `components/WalletConnect.tsx:234-238`. Fix: the sheet's close does nothing while busy.

- [ ] **18. Dead ends.**
  - `Alerts.tsx:50-53,98`: "Loading…" forever if `/api/alerts` fails. `:138`: Telegram is checked once, 8 s later.
  - `SafeConnect.tsx:102-114`: a failed fee quote leaves a disabled "Getting the fee…".
  - `TxPage.tsx:247-260`: "Removed" and "Transaction not found" have no way back on the standalone page.
  - `ClaimMaker.tsx:110-114`, `DropAdmin.tsx:340-344`: a PDF that fails does so silently.
  - `RecoverTool.tsx:143-149`: the copy button says nothing. `:75-88`: Start / Finish / Deploy stay live mid-run.
  - `Keys.tsx:179-181`, `Limits.tsx:96-98`: after a failed Sign, the retry uses a closed wedgie port.
  - `Welcome.tsx:115`: `friendly()` still says "Your gas key needs a little more ETH" (a v3 thing) in the live app.
  - Only `SafeConnect.tsx:122` checks the fee quote went stale before signing. Check it once in `finishOwners`.
  - `SafeApp.tsx:146-150`: `loadStates` has no order guard; an old read landing late overwrites a newer one.
  - `lib/claimBatch.ts:53`: a card's `eth` total adds different coins together (POL + xDAI + ETH).

- [ ] **19. The "Slow internet…" pill fires on calls that are slow by design.**
  `components/NetBar.tsx:22-32`: any fetch over 5 s. LI.FI quotes take 6-15 s, the relay up to 60 s.

## Speed

- [x] **20. Browser reads go out one request each.**
  `lib/chains.ts` `publicClient`: now `http(url, { batch: { batchSize: 50, wait: 0 } })`, so reads asked in the same
  tick are one request to `/api/rpc`. Checked against the live proxy on Base, Gnosis and Arc: 65 reads in 1
  request, and one bad call doesn't fail the rest. Not checked in a browser.

- [x] **20b. The read count itself.** The proxy's limit (600 a minute per IP) counts calls, not requests. Contract
  code that's there is now asked once per page (`codeOnce` in `lib/chains.ts`): the Safe, the 60-day module, Roles,
  the other owners' signers, the burner's signer. By count, not measured: a wallet on 5 of 14 chains goes from
  ~118 calls every 12 s to ~89.

- [x] **20c. One multicall per chain.** `readChain` (`lib/safe/state.ts`) reads owners, threshold, nonce, modules,
  the 3 recovery modules, Roles' members and the 3 allowances in one Multicall3 call. Checked against the old
  code on the live wallet (Base, Ethereum, Arbitrum, Gnosis, Optimism, each owner as "this phone"): the same
  answer every time, 14-18 calls down to 2-3 per chain. Not checked in a browser.

- [ ] **20d. Chains the wallet isn't on** are still read every 12 s (1 call each). Once a minute would do.

- [x] **21. Keys and Limits re-read the whole Activity history every 2 s while they wait.**
  `Keys.tsx:135-138`, `Limits.tsx:46` call `onRefresh`, which bumps Activity past its cache on every chain.
  Fix: a states-only refresh.

- [x] **22. Home re-renders every 3 s with nothing changed.**
  `SafeApp.tsx:133-144`: `keepLate` returns a new object each poll. Each render redoes `rolesAddress` + `dangers`
  per waiting card (`WhatItDoes.tsx:136`) and `howSigns` / `loadSigners` per owner (`Keys.tsx:479-485`).
  Fix: skip `setPortfolio` when nothing changed; memo those.

- [ ] **23. Polling that never stops or does too much.**
  - Drop admin: one KV read per card (up to 500) every 8 s per open tab (`app/api/drop/admin/route.ts:76-82`).
    Making a cards drop: up to 500 KV writes one by one (`lib/drops.ts:157-160`).
  - `Claim.tsx:227-245`: all 14 chains + portfolio every 5 s, also during the sweep and after Done.
  - `ClaimMaker.tsx:55-73`: every card on every chain every 6 s, claimed ones too.
  - `Activity.tsx:155-160`: token names fetched again on every refresh.
  - `SafeSwap.tsx:191-200`: the 20 s re-quote blanks the card and disables Swap each time.
  - `SafeApp.tsx:225-233`: two ENS reads for the same address.
  - `app/api/uni/route.ts:25`: a static file downloaded again on every call.
  - `lib/safe/relayCore.ts:42-54`: no old price to fall back on; a Coinbase blip fails every quote.

- [ ] **24. No timeouts, no size caps.**
  No timeout on: `lib/rpcServer.ts:19`, `relayCore.ts:45,49`, `lib/kv.ts:58`, `lib/alerts.ts:47,159`,
  `relayGuard.ts:50`, `app/api/rpc`, `bundler`, `nfts:42`, `portfolio:177,191,248`, `uni:22,25`.
  Caches that only grow: `nfts:10`, `positions:27`, `portfolio:45,115,156,232`. (`safe/svc:44` caps its own.)

- [ ] **25. Three copies of the Upstash client.**
  `lib/kv.ts`, `lib/alerts.ts:22-56`, `lib/safe/relayGuard.ts:19-59`, each with its own memory fallback, and they
  differ. Fix: the other two import `lib/kv.ts`.

## Delete?

- [x] **26. The v3 wallet.** Removed 11-10 (3 wallets on Base held $0.85 in all; git has the code). Nothing links to `/v3`, `/wedgie`, `/guardian`; `/api/bundler` serves only them.
  Goes with it: `components/App.tsx`, `Send.tsx`, `Settings.tsx`, `Safety.tsx`, `Welcome.tsx` (move `friendly()`
  out first: ~20 live files import it), `lib/wallet.ts`, `userop.ts`, `cold.ts`, `abi.ts`, the v3 parts of
  `walletconnect.ts` / `WalletConnect.tsx`, tools `e2e.mjs`, `wc-e2e.mjs`, `cold-e2e.mjs`, `aa-live.mjs`,
  `relay-tip-demo.mjs`, `abi.mjs`, the 4337 methods in `app/api/rpc`. Those three e2e tools open `/` and are
  broken today (v3 moved to `/v3`). `docs/V3.md`, `docs/GAS.md`.
  **26b. The park-for-the-wedgie path**: removed (item 2).

- [ ] **27. The first version.** `packages/nextjs`, `packages/mobile`, `firmware/`, `emu/`, `tools/`, `.cursor/`
  (its rule says never push without `/push`), root `package.json` / `yarn.lock` / `.yarn/` / `.yarnrc.yml`,
  `design/mockups`, `hardware/` (16 MB of STLs; move to wedgie-dev?). Keep `packages/foundry` contracts and
  `test/safe` (drop its SE-2 wrapper: `scripts-js`, `Makefile`, `DeployYourContract.s.sol`); keep `.gitmodules`.
  `design/brand/make.py:7` still writes to `packages/nextjs/public/`.

- [ ] **28. `firmware/p256.py`.** `1e0d03f` (11-06) put constant-time signing into this old copy. wedgie-dev removed
  `sign()` the same day. Decide which is right; stop patching this one.

- [ ] **29. Exports nobody uses.**
  `core.prevOwner` (Keys.tsx:323 hand-writes it instead), `core.setGuardianCalls`, `state.hotOf`,
  `state.oldLayout`, `fee.ZERO`, `pq/hybrid.pqCommit`, `pq/sphincs.C13`, `webauthn.encodeRawSignature`,
  `address.KIND_RAW`. Props nobody passes: `SafeSwap` `start`, `Receive` `toast`, `Keys` `Step.done`,
  `WhatItDoes` `Said.n`. `WedgieButton.tsx:220` `const open = true`. `Receive.tsx` `ShareApp` (`APP_LINK = ""`).
  CSS: `.fab-wedgie`, `.step.current`. `public/wordmark.png`. `@adraffy/ens-normalize` in `package.json`.
  About 20 more only need `export` dropped. Comments that name missing files: `describe.ts:81` (`urWords.ts`),
  `wedgie.ts:20` (`clear.ts`), `pq/sphincs.ts:6` (`pq-check.mts`).

- [ ] **30. Docs that say things that aren't so.**
  - `docs/SAFE-APP.md`: `:5` the b2jn URL (it's instantwallet.io), `:14` "two owners, threshold 3" (now one
    signer, 1 of 2), `:3` "Base and Ethereum" (14 networks), `:54` `web/app/safe/` (no such folder), `:78`.
    `:15` vs `docs/CUSTODY.md:48`: can you still set your own recovery address? One of them is wrong.
  - `docs/CLAIM.md:3,70,115,244` · `docs/CUSTODY.md:30` and `PLAN-recovery-delay.md` ("15 chains") ·
    `docs/OWN-NODE.md:17` · `docs/XDAI.md:18` (written before the switch) · `docs/APP-STORE.md:36` ·
    `docs/SWAP.md:3,12` · `docs/MULTI-SIGNER.md:72` · `docs/PLATFORMS.md:24-45` · `emu/README.md:36`,
    `emu/SKILL.md:52,63`, `hardware/case/README.md` (scripts that are gone).
  - `EXPECTATIONS.md:29` says every shared part is in `bits.tsx`; `SrcTag` is in `WhatItDoes.tsx`, `bio()` in
    `lib/passkey.ts`, `shownAs` / `wedgieHome` in `lib/safe/state.ts`.
  - Shipped or dropped, could go: `PLAN-drops.md`, `PLAN-recovery-delay.md`, `PLAN-xdai.md` (keep its table of
    what the old Burner left behind, in `docs/XDAI.md`), `docs/PLAN-REVIEW-2026-10-05*.md`,
    `docs/HANDOFF-2026-10-08-wedgie.md`, `docs/WEDGIE-PHONE-DEBUG.md`.
  - Mark as history: `docs/PLAN.md`, `CONCEPT.md`, `docs/PROTOCOL.md`, `docs/PLATFORMS.md`, `docs/V3.md`,
    `docs/GAS.md`, `docs/COLD-STORAGE.md`, `docs/ROLES.md`, `docs/SAFE.md`, `docs/LEVELS.md`.
  - No `.env.example`. `web/README.md` now lists the names.

- [ ] **31. Checks that miss things.**
  - `tools/same-check.mjs` walks only `components/`, never `app/` (19 `.tsx` files).
  - `.github/workflows/expect.yaml` runs on docs-only pushes and starts with a blind `sleep 240`; it could wait
    for `/api/version` to show the commit.
  - Ten `.mts` tools say `npx tsx`, and `tsx` isn't a dependency.
  - `tools/wedgie/serve.py` was fixed by reading in `e21311d` and never run (needs `micropython`).
  - Recovery watcher (`lib/alerts.ts` `running`) passes no `multicallAddress`, so it can't run on a local anvil.
