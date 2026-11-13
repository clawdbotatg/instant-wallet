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

- [x] **4b. The relay keeps no memory of its last nonce.** It does now, for 10 s (`lib/safe/relayGuard.ts`
  `relaySend`, used by the relay and by USDC drop claims; an ETH pot's memory went from 1 h to the same 10 s).
  A lagging RPC is a block or two behind, so 10 s covers it. A tx the network dropped leaves a gap for 10 s at most:
  the next send after that takes the node's count and fills it. Without the memory a lagging RPC gave an error, or
  (fees up 10%) the new tx took the place of the one before. Checked with a fake node only
  (`tools/relay-nonce-check.mts`), not with a real send.

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

- [x] **10b. Left from 10.**
  - Done 11-13: only the wallet that made a drop can change it or take it back. Other admins see it, with no buttons.
  - Done 11-12: the open GET says the email is "On", not its first letters and domain. A signed change still
    answers with the masked address.

- [x] **11. Public RPC when the Alchemy key is missing.**
  These pass `http(upstreamRpc(id))` unchecked, so viem falls back to the chain's public RPC: `app/api/ens`,
  `uni`, `onramp`, `portfolio:63`, `bundler:59,77`, `lib/drops.ts:254,426`. Others throw "chain not enabled".
  Fix: one helper that throws. Also `web/tools/aa-live.mjs:20`, `wc-e2e.mjs:63`, `relay-tip-demo.mjs:15` and
  `packages/foundry/foundry.toml` name public RPCs.

- [x] **11b. Smaller, same area.**
  - Done 11-12: in production the relay refuses to start with a key that isn't `RELAY` (`relayCore.ts`
    `relayer`). Live they match.
  - Done 11-12: a confirmation Safe's service doesn't take throws (`lib/safe/share.ts`).
  - Done 11-12: an EIP-681 transfer with no recipient is "unknown", not a payment to "" (`lib/parse.ts`).
  - Checked 11-12, nothing to fix: `app/api/onramp` answers bad input with a 401 (seen live); Uniswap's
    `mapping.json` keys are all lowercase and sorted, so the chunk pick is right.
  - Done 11-12: name → address is kept 5 minutes (was a day, and up to a week stale).
  - Done 11-12: a price of 0 isn't cached (`app/api/price`, `lib/price.ts` `nativeUsd`).
  - Done 11-10 for the relay: a revert refuses that wallet for a day and the IP only at its third revert in a day;
    the IP's send cap is the route's 240 an hour, not 60 (`tools/relay-ban-check.mts`). Still as it was for drops
    (`lib/drops.ts:212`): a crowd on one Wi-Fi shares an IP.
  - Done 11-10: `lib/alerts.ts` `authorize` checks origin, rpId and the UV flag, as `app/api/onramp` does
    (`tools/passkey-site-check.mts`).
  - Left (drops, low): a Uniswap pool's spot price sets what an ETH drop pays (`lib/drops.ts:252`); the wallet
    itself now has one ETH price (the server's). Drops still share an IP ban (`lib/drops.ts:212`).

## What people see

- [x] **12. "What it does" is asked once and kept for the page's life, failures too.**
  `components/safe/WhatItDoes.tsx:31-48,96-127`. A waiting tx that showed "Would fail now" still says so after the
  wallet is funded; a simulator blip leaves a card with no coins until reload. This is expectation #1.
  Fix: never keep a failed ask; keep the coins ~30 s and ask again while the card is on screen.

- [x] **13. Waits of 5 s+ with no progress bar.**
  Done 11-10: a cross-chain swap ("On its way…": `TimeBar`, sized to the route's usual time) and Send everything
  (the send bar under each network's button).
  Done 11-11: Reject (`Waiting.tsx`), the old phone's budget turn-off (`SafeApp.tsx`), cancelling a recovery
  (`RecoveryAlert.tsx`), funding a share (`Share.tsx`), checking your simulator (`SimSetting.tsx`). `useSendProgress`
  in `Progress.tsx`. `same-check.mjs` fails on a file that sends a tx and draws no bar.
  Left: `Claim.tsx` (the normal claim; the xdai branch has one): drops, low.

- [x] **14. Bare `short(…)` addresses where the rule says `<Who>` / `<Words>`.** Done 11-10: the recovery alert
  (who is taking the wallet), the recovery tool's pending line, Activity's "Received from", Send's done screen, a
  site's request ("from"), Join, and the welcome screen's raw hex. `same-check.mjs` now fails on `.map(short)` and a
  mono `short(…)` span. Left: `ClaimMaker.tsx:224,255` (drops), and the recovery addresses listed as text in
  `RecoverTool.tsx:90` and `SafeWelcome.tsx:160`.

- [x] **15. Words and colors against EXPECTATIONS #2. Decide: change, or write the exception down.**
  - Done 11-11 (Austin: Executing / Executed): Activity's row on its way says "Executing…"; so does the drop
    take-back. `same-check.mjs` fails on "Sending…" for a tx.
  - Done 11-12 (Austin: yes): the app frame's Close is white (was a red "✕ Close"); Swap's wait says "Executing…"
    (was "Swapping…"). `same-check.mjs` fails on both.
  - Done 11-12 (Austin: fine): the tx page's passkey row says "Sign". An amount we can't read is `<Money unknown>`.
    The stage words are one `stageLabel` in `bits.tsx` (a site's request said "Face ID…" where the rest said
    "Signing…"); `same-check.mjs` fails on a copy. EXPECTATIONS #4 now says green follows what's next, and a
    button doesn't change color while it works, so the waiting tx's button and the wedgie's are right as they are.
  - Left: `Drop.tsx:118`, `Claim.tsx:385` (hand-written money) and `DropAdmin.tsx:162`: drops, low.

- [x] **16. USDC dust on one network stops the whole claim.** Done 11-13: skipped; the done screen says what stayed.
  `components/Claim.tsx:311-314`. `claimUsdc` throws inside the loop over networks, so later networks are never
  claimed. `claimEth` returns 0 for the same case. Fix: skip that network and say so.

- [x] **17. Pulling the WalletConnect sheet down mid-sign tells the site "rejected" while the tx still runs.**
  `components/WalletConnect.tsx:234-238`. Fix: the sheet's close does nothing while busy.

- [x] **18. Dead ends.** Done 11-10: Alerts keeps trying to load and watches for the Telegram chat to link; a
  failed fee quote for a site's request is asked again every 5 s; "Removed" and "Transaction not found" link home
  on the standalone page; a failed Sign in Keys or Limits clears the prepared change (its wedgie port is closed);
  an old keys read landing late no longer overwrites a newer one; `friendly()` lost the v3 "gas key" line (26).

- [x] **18b. Left from 18 (small).** Done 11-13: a failed PDF shows an error; Copy says Copied; Start / Finish /
  Deploy are off while one runs; a card's coins are totalled one coin at a time.
  - `ClaimMaker.tsx:110-114`, `DropAdmin.tsx:340-344`: a PDF that fails does so silently.
  - `RecoverTool.tsx:143-149`: the copy button says nothing. `:75-88`: Start / Finish / Deploy stay live mid-run.
  - Done 11-12: `finishOwners` refuses a fee quote past its time, before anything is signed. The recovery alert and
    the budget turn-off drop what they prepared when a sign fails, so the next tap starts fresh.
  - `lib/claimBatch.ts:53`: a card's `eth` total adds different coins together (POL + xDAI + ETH).

- [x] **19. The "Slow internet…" pill fires on calls that are slow by design.**
  `components/NetBar.tsx:22-32`: any fetch over 5 s. LI.FI quotes take 6-15 s, the relay up to 60 s.
  Done 11-11: `slowAfter` in `NetBar.tsx`. A swap quote counts after 30 s; a relayed send, a drop claim and a drop
  take-back after 75 s. Everything else still 5 s.

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

- [x] **20d. Chains the wallet isn't on** were read every 12 s (1 call each). Done 11-12: the 12 s poll asks them
  every fifth time (once a minute). A refresh, coming back to the tab, and Keys/Limits waiting still ask every chain.

- [x] **21. Keys and Limits re-read the whole Activity history every 2 s while they wait.**
  `Keys.tsx:135-138`, `Limits.tsx:46` call `onRefresh`, which bumps Activity past its cache on every chain.
  Fix: a states-only refresh.

- [x] **22. Home re-renders every 3 s with nothing changed.**
  `SafeApp.tsx:133-144`: `keepLate` returns a new object each poll. Each render redoes `rolesAddress` + `dangers`
  per waiting card (`WhatItDoes.tsx:136`) and `howSigns` / `loadSigners` per owner (`Keys.tsx:479-485`).
  Fix: skip `setPortfolio` when nothing changed; memo those.

- [x] **23. Polling that never stops or does too much.** Done 11-13 (drops): the admin reads all cards in one KV
  call; codes are saved 100 a write; the claim page stops polling while it moves and after Done; the card maker
  reads a claimed card once.
  - Drop admin: one KV read per card (up to 500) every 8 s per open tab (`app/api/drop/admin/route.ts:76-82`).
    Making a cards drop: up to 500 KV writes one by one (`lib/drops.ts:157-160`).
  - `Claim.tsx:227-245`: all 14 chains + portfolio every 5 s, also during the sweep and after Done.
  - `ClaimMaker.tsx:55-73`: every card on every chain every 6 s, claimed ones too.
  - Done 11-12: Activity asks for a token's name once per page, not on every refresh.
  - Done 11-12: Swap's 20 s re-quote is quiet. The card and the button stay until the new price is in.
  - Done 11-12: Home reads the wallet's ENS name once (it shares `named` with the pill).
  - Done 11-12: `app/api/uni` keeps the claim files it has downloaded (8 at most).
  - Done 11-10: `lib/safe/relayCore.ts` uses its last price (up to 10 min old) when the feed fails.

- [x] **24. No timeouts, no size caps.**
  Done 11-10, timeouts on: all three KV clients (5 s), `lib/rpcServer.ts` (10 s), `app/api/rpc` (15 s, then a 504),
  the relay's prices (4 s), Telegram (8 s), `nfts`, `uni`.
  Done 11-11: `app/api/portfolio` (Alchemy prices, DexScreener: 4 s each; a late one means no price this round,
  nothing cached). The caches in `nfts`, `positions` and `portfolio` are `Capped` (`lib/capped.ts`): the oldest
  goes when it's full.

- [x] **25. Three copies of the Upstash client.**
  `lib/kv.ts`, `lib/alerts.ts:22-56`, `lib/safe/relayGuard.ts:19-59`, each with its own memory fallback, and they
  differ. Done 11-12: the other two import `lib/kv.ts` (it gained SREM; a script throws in memory, so the lock's
  plain fallback runs).

## Delete?

- [x] **26. The v3 wallet.** Removed 11-10 (3 wallets on Base held $0.85 in all; git has the code). Nothing links to `/v3`, `/wedgie`, `/guardian`; `/api/bundler` serves only them.
  Goes with it: `components/App.tsx`, `Send.tsx`, `Settings.tsx`, `Safety.tsx`, `Welcome.tsx` (move `friendly()`
  out first: ~20 live files import it), `lib/wallet.ts`, `userop.ts`, `cold.ts`, `abi.ts`, the v3 parts of
  `walletconnect.ts` / `WalletConnect.tsx`, tools `e2e.mjs`, `wc-e2e.mjs`, `cold-e2e.mjs`, `aa-live.mjs`,
  `relay-tip-demo.mjs`, `abi.mjs`, the 4337 methods in `app/api/rpc`. Those three e2e tools open `/` and are
  broken today (v3 moved to `/v3`). `docs/V3.md`, `docs/GAS.md`.
  **26b. The park-for-the-wedgie path**: removed (item 2).

- [x] **27. The first version.** Removed 11-12 (Austin: yes; git has it): `packages/nextjs`, `packages/mobile`,
  `firmware/`, `emu/`, root `tools/`, `.cursor/`, `design/mockups`.
  Then (Austin: sure): `hardware/` (the first device's case and build guide; wedgie-dev has its own case tool),
  the first version's contracts (`InstantWallet`, `Factory`, `RelayTip`, `MockUSDC`), their tests, deploy scripts
  and records, the SE-2 wrapper (`scripts-js`, `Makefile`, `package.json`) and the root yarn files.
  Kept: `packages/foundry/test/safe`, `contracts/pq`, `script/PQHybridLive.s.sol` and its record, `lib/` (the
  names resolver builds against it), `.gitmodules`. `forge test --ffi --match-path 'test/safe/*'`: 46 of 46 after.
  Now pointing at a folder that's gone: `design/brand/make.py:7` and `design/gen.py:7` (`packages/nextjs/public/`).

- [x] **28. `firmware/p256.py`.** Gone with `firmware/` (27). wedgie-dev's copy is the one.

- [x] **29. Exports nobody uses.**
  Removed 11-12: `core.prevOwner`, `core.setGuardianCalls`, `state.hotOf`, `state.oldLayout`, `fee.ZERO`,
  `pq/hybrid.pqCommit`, `webauthn.encodeRawSignature`, `address.KIND_RAW`, `Receive.tsx` `ShareApp`,
  `WedgieButton.tsx` `const open = true`, `.step.current`, `public/wordmark.png`.
  Left on purpose: `pq/sphincs.C13` (the comment beside it explains C11 against it). Not done: the props nobody
  passes, `.fab-wedgie` (it's inside a live xdai selector), `@adraffy/ens-normalize` in `package.json`, the ~20
  that only need `export` dropped, the three comments that name missing files.

- [x] **30. Docs that say things that aren't so.** Done 11-12.
  - Fixed: `docs/SAFE-APP.md` (instantwallet.io, 14 networks, the wedgie is one signer, recovery is the DAO only as
    `docs/CUSTODY.md` says, no `web/app/safe/`), `docs/CLAIM.md` and two tools (the old b2jn address), `docs/CUSTODY.md`
    (14 networks), `docs/OWN-NODE.md` (the preview exists), `docs/XDAI.md` (the switch is done), `docs/APP-STORE.md`,
    `docs/SWAP.md` (Swap is in Apps), `docs/MULTI-SIGNER.md` (the Safe key is set).
  - Removed: `CONCEPT.md`, `docs/PROTOCOL.md`, `docs/PLATFORMS.md`, `docs/COLD-STORAGE.md`, `docs/ROLES.md`,
    `docs/LEVELS.md`, and earlier the plan docs and `PLAN-xdai.md` (its table is at the end of `docs/XDAI.md`;
    `web/public/service-worker.js` still names it: changing that file's bytes makes old browsers fetch it again).
  - Marked as history: `docs/PLAN.md` (code comments point at it for why the first setup is what it is), `docs/SAFE.md`.
  - Not checked: `docs/SWAP.md:12` "the wedgie's LI.FI decoding" not built.
  - No `.env.example`. `web/README.md` lists the names.

- [x] **31. Checks that miss things.** Done 11-12.
  - `tools/same-check.mjs` walks `app/` too.
  - `.github/workflows/expect.yaml` skips docs-only pushes and waits for `/api/version` to show the commit (8 min at most).
  - `tsx` is a dev dependency.
  - `tools/wedgie-app-check.mts` was run (micropython) and was broken: `tools/wedgie/serve.py` had no storage, no raw
    bytes, no key state, no p256. Fixed; it needs `WEDGIE_DEV` too. 2/2 against safe-59.
  - The recovery watcher names its multicall address, so it runs on a local fork.

## Who sees what (from the lab, 2026-11-12)

Unlike the rest of this list, these were seen on the live site: CROPS Lab (`~/ef/crops-lab`) ran instantwallet.io in
a clean macOS VM with a virtual passkey and recorded every request. Runs: `20261111-123340-home-instant` (idle),
`20261111-185710-send-eth-instant`, `20261111-191032-swap-instant`, `20261112-093301-send-token-instant` (all real,
Ethereum). Maps: ethereumtransitauthority.com `#/iw`, `#/iws`, `#/iwt`. Desktop Chromium at phone size; the phone
(Safari, Face ID, passkey sync) and the wedgie were not captured. This answers `docs/CROPS.md` section 3's "check"s.

- [x] **32. WalletConnect telemetry on every page load, with an id that lasts.**
  `POST pulse.walletconnect.org/batch`, event `INIT`, with the site, the SDK version and a `client_id`
  (`did:key:…`). The same id was sent in every run, across browser restarts. No dapp was connected.
  `lib/walletconnect.ts:62` (`WalletKit.init`, `new Core({ projectId })`).
  Fix: don't start WalletConnect until someone opens Connect; turn its telemetry off (`telemetryEnabled: false` on
  `Core`: not tried). Then add the host to `same-check.mjs` so it can't come back.
  `docs/CROPS.md` "Data collection: likely passes today" is wrong until this is fixed.
  Done 11-12: WalletConnect starts only when a site is connected, Connect is open or a wc: link comes in
  (`wcWanted` / `wcKeep`), and `telemetryEnabled: false`. Not added to `same-check.mjs`.

- [x] **33. A picture host learns who you pay.**
  The browser loads `euc.li/<name>` for the recipient's ENS avatar on the send form, before anything is signed, and
  for names in the wallet's history on Home. euc.li gets your IP and the name. The URL comes from `/api/ens`
  (`avatarUrl` in clear-signing-safe-kit).
  Fix: serve avatars through our server (or cache them there), or show a blockie until the send is done.
  Done 11-12: `/api/avatar?name=` fetches the picture and serves it (a name in, never a URL; https hosts only;
  3 MB; images only; an SVG can't run anything). `/api/ens` hands out that path, and `useName` rewrites an answer
  kept from before. The avatar's host now sees our server, not you.

- [x] **34. Coinbase sees every review screen.**
  `lib/price.ts:7` fetches `api.coinbase.com/v2/prices/ETH-USD/spot` from the browser on the swap and token-send
  review. IP only, no address. The server already fetches the same price (`lib/safe/relayCore.ts:48`).
  Fix: take it from `/api/price` or the relay quote.
  Done 11-12: `lib/price.ts` `ethUsd` reads `/api/price?chain=1`.

- [x] **35. Idle polling.**
  60 s on Home with nothing happening: 125 requests. `/api/portfolio` 23 times; `eth_getCode` of the wallet on all
  14 networks every 12 s (`SafeApp.tsx:198-199`); `alchemy_getAssetTransfers` on 11 networks. Every one carries the
  address and the IP to our server, and the address on to Alchemy.
  Fix: `getCode` once per network then only after a send; slow the balance timer when nothing is pending; one
  multicall for the networks that have it.
  Part done 11-12: left alone on Home for a minute, the balance is read every 10 s (was 3) and the keys once a
  minute (was 12 s); the first touch reads both at once. Receive, an open sheet or a send on its way stay quick.
  Done 11-12: `getCode` is asked once per network (`codeOnce`); a network with no wallet yet is read 1 poll in 5;
  the guard's slot is in the one multicall (Safe's `getStorageAt`), so a network is one request per poll.

- [x] **36. The fee on a small USDC send on Ethereum is bigger than the send.**
  $0.40 of USDC cost about 0.51 USDC in fee (tx `0xf919d405…2ef8`). $0.50 with 1.03 USDC in the wallet showed
  "Would fail now". The ETH send's fee was $0.43 (it also deployed the wallet); the swap's was $0.20.
  Fix: decide. Warn when the fee is more than the amount, or point small sends at Base.
  Dropped 11-12: Austin doesn't care about this one.

- [x] **37. Opening Apps calls two more hosts.**
  5 icons from `instant-wallet-apps.vercel.app` and 5 from `safe-transaction-assets.safe.global` load as soon as
  Apps opens (and Swap is behind Apps). IP only. Fix: ship the icons in the app.
  Done 11-12: the ten icons are in `public/apps/`.

- [x] **38. `/api/explain` ran after the relay POST on the ETH send.**
  In `20261111-185710-send-eth-instant` the first `/api/explain` is 0.2 s after `POST /api/safe/relay`. On the swap
  and the USDC send it ran before signing. Check whether a plain ETH send skips the check on the review card.
  Checked 11-12, by design: that send was the wallet's first on Ethereum (it also deployed it), and a wallet not
  yet on a network can't be run (`SafeSend.tsx` `ran`). The review still says the amount, the coin and who. The
  `/api/explain` seen after the POST is Activity's row. A send from a wallet already on the network runs first.

- [x] **39. LI.FI gets the wallet address on every swap quote, even when Uniswap wins.**
  `app/api/swap/quote/route.ts:26-41` sends `fromAddress` and `toAddress` = the Safe. Read from code, not seen on the
  wire (it's server to server). Fix: quote with a fixed placeholder address, and ask again with the real one only
  if LI.FI wins.
  Done 11-12: on one network the first ask has no address (`/api/swap/quote` with no `safe` asks for
  `0x1111…1111` and returns a price that can't be signed). Only when LI.FI wins, or Uniswap has nothing, is it asked
  again with the wallet. Across networks LI.FI is the only route, so it still gets the address.

Not a bug, but the shape of the wallet: the browser talks to our server for almost everything, so we see IP +
address + every read, and Alchemy, Zerion and LI.FI see the address behind us. `docs/CROPS.md` levels 4 and 5 are
the fix.
