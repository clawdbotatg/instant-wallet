# Instant Wallet — the plan

2026-10-05. **This is the master doc.** It replaces the rules in `ROLES.md` and `COLD-STORAGE.md` (no more
"one key waits 48 h"). Details: `SAFE.md` (research), `WEDGIE-SAFE.md` (wedgie as owner, tested),
`LEVELS.md` (dials), `GAS.md` (fees). Our own `InstantWallet` 3.2 contract is shelved, never deployed.

## In one paragraph

**It all starts with a delightful burner wallet at instantwallet.io, and you go down the rabbit hole.**

You open instantwallet.io, Face ID, and you have a wallet: a **Gnosis Safe** controlled by a passkey on your
phone. Later you add MetaMask, a 24-word seed sharded on paper (your recovery), then a wedgie. Each step makes it
harder to steal. Big moves need two keys and wait 24 h (all three: instant); the phone keeps a daily limit. If you lose keys, your recovery address gives you new ones
after 7 days. If you die, a death switch hands it to your heir after 6 months. Almost every contract is audited
code that already exists; one contract is ours (24 h wait with cancel, travel lock), audited before
real money. The same wallet works on many chains at one address, can co-own group Safes with
friends, and you can talk to it through any AI. Built in phases (bottom of this doc); planned in full here.

## The pieces (audited and already deployed on Base, except ours)

| piece | job | audited by |
|---|---|---|
| Safe 1.5 | the wallet: holds the money, list of owners, how many must sign | Safe (many). The wedgie was tested on 1.4.1; Roles, Candide and the passkey signer still need testing on 1.5 |
| Safe passkey signer v0.2.1 | lets a passkey or a wedgie be a Safe owner | Certora, Nethermind, Hats |
| Zodiac Roles v2.1 | gives a key limited powers without making it an owner (daily budgets) | G0, Omniscia |
| Candide Social Recovery (×2) | recovery (7 days) and death switch (6 months) | Ackee, Nethermind, Certora |
| Safe4337Module | optional: send through public 4337 bundlers | Ackee, Certora, Nethermind |
| ours (phase 4) | wedgie + one waits 24 h, cancels, travel lock (Safe 1.5 module + guard + fallback handler) | needs a full audit: it checks signatures and executes as the Safe, so it has full power over every wallet |

The death switch needs our own deployment of Candide's audited code with a 6-month delay (theirs ship
3/7/14 days). Same code, different number.

What is ours (not contracts, still must be reviewed): the app, the relay, the alert watcher, and the wedgie
`safe` app (firmware).

## The keys

| key | what it is | how it signs |
|---|---|---|
| **Burner** | passkey made on your phone by Face ID | WebAuthn, through Safe's passkey signer |
| **Hot** | MetaMask / Rainbow / any wallet you already have, usually by ENS | normal Ethereum signature |
| **Cold** | wedgie. Trust M chip makes the key; it never leaves the chip | press A; firmware wraps it as a passkey signature (tested on Base) |
| **Recovery** | an address that can replace your keys after 7 days | starts as dao.buidlguidl.eth (4 of 8), you swap in your own |
| **Death switch** | an address that can hand the wallet to your heir after 6 months | dao.buidlguidl.eth; optional |

## Levels: progressive decentralization (how the Safe is set up at each one)

Get a burner wallet right now; decentralize step by step, learning as you go. Your address never changes. Each
step is one transaction signed by the current owners.

| level | who can do anything | burner alone | recovery | death switch |
|---|---|---|---|---|
| 1 Burner | burner | everything (it's the only key) | DAO, 7 d | DAO, 6 mo |
| 2 Hot | burner + hot | its daily limit | DAO, 7 d | DAO, 6 mo |
| 3 Paper | burner + hot | its daily limit | **your 24-word seed, sharded on paper**, 7 d | DAO, 6 mo |
| 4 Cold | all three: instant. Wedgie + burner or hot: after 24 h | its daily limit | yours, 7 d | DAO, 6 mo |
| 5 Full self-custody | same as 4 | its daily limit | yours | none, or your own heir address |

**The general rule (Austin 10-05): all your keys = instant; all but one = after the 24 h wait.** Never fewer
than two for anything beyond the burner's limit, and once you have a wedgie it must be one of them. So:
level 1, burner alone (only key); levels 2–3, burner + hot, instant (no one-key-with-a-wait path: a single
stolen key could then drain after 24 h); level 4+, all three instant, wedgie + one after 24 h.

The app nudges you up by balance ("$500 in here, add MetaMask", "$1,000: add a wedgie") and shows a level meter.
Level 1 is only for spending money. The burner's default daily limit is 100 USDC + 0.04 ETH; the user can change it.

### Level 3: the paper seed (Austin 10-05)

You make a new 24-word seed phrase and learn to keep it safe. It becomes **your recovery address**, replacing
the DAO's 7-day recovery. The DAO keeps its death switch (it can still replace your keys after a 6-month wait,
with an alert) until you remove it at level 5. It's a good fit: recovery is rarely used and should be offline.
- Made on the wedgie (hardware random numbers) or with dice, never by the web app: a hacked site could hand
  out a seed it already knows. Shown once, never stored.
- **Sharded:** split into 3 shares on special paper, any 2 rebuild it. Keep them in 3 places; one share
  alone reveals nothing **with SLIP-39** (proper Shamir; needs software to rebuild; recommended).
  Alternative: overlapping word cards (each has 16 of the 24 words, any two cover all; no software). But one
  card leaks 16 words, leaving ~88 bits: a stolen card is a real, if small, risk.
- The app walks you through a practice restore before it switches recovery over.

### Level 4: how "wedgie + one" and "all three" work

- **The wedgie counts twice.** It's added as two owners. Preferred: the chip makes **two keys** (two slots)
  and one press signs with both. Alternative: two of Safe's passkey-signer contracts for one key, using
  different verifier settings; both settings need the precompile plus a fallback (multichain), which means
  two different audited fallback verifiers.
- **All three = instant.** The Safe needs 4 votes: wedgie (2) + burner (1) + hot (1).
- **Wedgie + one = after a short wait** (Austin 10-05). **The wait is only there to catch you being tricked**:
  a hacked screen gets you to sign something you didn't mean (the Bybit attack: the owners signed what their
  screen showed and the money was gone instantly). The signed move shows up first: "In 24 h, all your money
  goes to 0x… [Cancel]". You notice, and cancel with your keys. **It does not protect against stolen keys**:
  two stolen keys = you're in trouble. Length: **default 24 h, the user can set 1 h–48 h** (owners sign).
- **The rule (Austin 10-05): two of three keys can do anything, within the rules.** We plan for one key
  stolen or lost at a time. Two stolen keys = you're out of luck.
  - **Cancel a waiting move: any two keys**, instant (burner + hot counts). One key can't cancel, so a thief
    with one key can't block anything.
  - **Remove or replace burner or hot:** wedgie + the other one, after 24 h. The removed key can **object**
    (within the wait). An objection only delays it: the removal then runs after 7 d unless two keys cancel;
    the paper seed can approve it at once (no more wait) or reject it (it dies). A stolen key can't block
    its removal; the paper is optional, a shortcut. Remove the wedgie: see "If the wedgie is stolen".
  - **Cancel a recovery:** any two keys. So a stolen recovery address only wins if you've lost two keys.
  - **Which key is which (review F2).** Safe's owner list is just addresses; it can't tell the wedgie's two slots
    from the phone or MetaMask. So our module keeps its own on-chain map: owner address → burner, hot, wedgie
    slot 1, wedgie slot 2. Changing the map follows the same rules as changing keys. Every check counts
    *keys*, not signatures: "wedgie + one" = both wedgie slots plus burner or hot; "any two keys" for cancel
    = two different keys (both wedgie slots together = one key). After a recovery, the new owners must set
    the map before the module does anything (it refuses while the map doesn't match the Safe's owners).
  - **Dead moves stay dead (review F3).** Every queued move has its own nonce and ends as executed, cancelled
    or rejected, forever. Each signature covers the Safe, the chain, the action and an **epoch** number. The
    epoch goes up on every change to owners, threshold, the key map or the rules (including changes made by
    recovery or by plain Safe transactions; the guard sees all of them). A move from an old epoch can never
    run, even if the owners later change back.
  - Rejected: "any one key cancels". A one-key thief could block your moves, including removing them.
- **The wedgie is the big decider (Austin 10-05):** every pair must include it. Burner + hot can't spend
  beyond the budget or remove the wedgie.
- **Rejected: panic button + vault** (a second slow Safe to flee to). It only helped against two stolen
  keys, and two stolen keys = you're in trouble anyway (Austin 10-05). Not worth a second wallet.
- **If the wedgie is stolen:** the thief alone can do nothing (needs a second key; cancelling also needs two).
  You: (1) **burner + hot + paper seed together replace the wedgie, instantly**
  (everyone but the wedgie); or (2) recovery, 7 d, the thief can't cancel. To make a stolen wedgie useless:
  a **PIN on the wedgie** before it signs (firmware; check whether Trust M can enforce it on the chip).
  Wedgie + phone stolen together = a two-key thief: you're in trouble.
- Burner + hot = 2 votes: nothing beyond the burner's budget. Wedgie alone: nothing.
- **Rejected: wedgie alone after a wait.** A thief with your wedgie would get everything in a day,
  because cancelling would need the wedgie. Every delayed path needs a second signature.
- **This needs our one custom contract (phase 4).** Nothing audited does "two keys queue, any two cancel":
  Zodiac Delay's cancel needs the Safe's full threshold (all three). Optimism's TimelockGuard
  makes every move wait, with no instant path, misses 4337/module transactions, and we couldn't find its audit.
  Ours: a module that queues moves signed by wedgie + one, runs them after 24 h, and lets any two keys cancel. It checks signatures and executes as the Safe, so it has full power: it needs a full audit.
  **Until phase 4 ships, the Safe needs 3 votes and wedgie + one is instant.**

## Who can do what (level 4+)

| action | who |
|---|---|
| spend up to the daily limit | burner alone (100 USDC + 0.04 ETH), instant |
| spend up to the pair limit | wedgie + one (500 USDC + 0.2 ETH), instant |
| raise a limit | wedgie + one after 24 h, or all three |
| lower a limit | any one key, instant |
| anything | all three, instant; or wedgie + burner / wedgie + hot, after 24 h |
| change a limit, add/remove a key, change recovery | same as "anything" |
| cancel a waiting move | any two keys, instant |
| cancel a recovery | any two keys |
| stop the burner (revoke its budget) | hot alone or wedgie alone, instant ("protect" role) |
| turn on the travel lock | any one key, instant |
| replace a stolen wedgie | burner + hot + paper seed, instant; or recovery, 7 d |
| replace burner or hot | wedgie + the other, 24 h; if it objects, 7 d or the paper approves now |
| replace keys (any) | recovery, after 7 days (any two keys can cancel) |
| hand everything to your heir | death switch, after 6 months; owners can cancel |

The "protect" role: a Zodiac Roles permission that lets one key do exactly one thing, switch off the burner's
budget. **Protecting is one key and instant; weakening needs two keys and waits, or all three.**

**After a recovery, old keys lose power on chain, in the same step (review F1).** Candide only swaps the Safe's
owners; it doesn't touch Roles (the old burner's budget, protect roles). So our guard watches for owner
changes: the moment owners change (Candide's finalize included), it switches **all Roles spending off** and
bumps the epoch. Old keys can't spend even if the app is offline. The new owners then set the key map and
turn Roles back on with the new burner (one batch). Before phase 4 (no guard yet), the old burner keeps its
daily budget until that batch runs; the app sends it immediately. Exposure: one day's burner budget.

**Spending limits (Austin 10-05).** Set per token **in token amounts, not dollars**, as part of each wallet's
configuration. Default (ETH ≈ $2,700 on 10-05):

| who signs | instant, per day | more than that |
|---|---|---|
| burner alone | 100 USDC + 0.04 ETH | no |
| burner + wedgie, or hot + wedgie | 500 USDC + 0.2 ETH | waits 24 h (the trick-catching wait) |
| all three | anything | instant |

- Other tokens: no instant budget. Moving them takes wedgie + one (after the wait), or all three.
- Limits are token amounts. USDC ≈ dollars; the ETH defaults were picked to be ≈ $100 / $500 today and drift
  with the price. The app shows today's dollar value next to each limit. No price feed on chain.
- **Changing limits:** users can add tokens and change amounts. Lowering: any one key, instant. Raising:
  wedgie + one, after the 24 h wait, or all three keys, instant. (Level 1: the burner alone. Levels 2–3:
  burner + hot.)
- **Pair budget rules:** one shared daily allowance for every wedgie + one pair (burner + wedgie and hot + wedgie
  together), separate from the burner's own. Instant only for plain `transfer` of USDC or ETH to any address;
  approvals, delegatecalls and any other call, or a batch containing one, take the 24 h wait.
- Burner alone: Zodiac Roles allowances (audited). Pair limits: our phase-4 contract (it already checks
  two signatures; within the pair limit it runs now, above it waits). Before phase 4, wedgie + one is instant
  and unlimited.
- Worst cases: tricked into a pair signature, you lose at most 500 USDC + 0.2 ETH a day before you notice.
  Burner stolen: 100 USDC + 0.04 ETH a day.

## Travel lock ("French mode", Austin 10-05, decided)

"For the next week, at most $2,000 can leave, no matter who signs." Even all three keys can't go over it, and
nobody can switch it off early. Kidnappers get $2,000 at most (the 2025 France attacks: the Ledger
co-founder lost a finger).
- Any one key turns it on, with the cap the owners set in advance (one key can't pick the cap). A one-key
  lock lasts at most 7 days and can't be extended by one key. After a one-key lock ends, one key can't
  start another for 7 days (review F5). Wedgie + one can set up to 30 days. It
  ends on its own and can't be lifted early. During a lock you can remove keys but not add them. A thief
  who locks you with a stolen key is removed by your other two keys (24 h; 7 d if it objects), and the removal
  also ends that key's power to lock. Allowed during a lock: removing keys, Candide recovery, and replacing
  a stolen wedgie (burner + hot + paper; it swaps an owner, nothing leaves). Not allowed: raising limits or
  giving a new key a budget.
- **What it must block, or the cap is fake:**
  - turning the guard, modules or fallback handler off or on; delegatecalls; adding owners;
  - **signed messages** (EIP-1271). Owners could sign a permit / Permit2 message and anyone could pull tokens
    with no Safe transaction. Our fallback handler refuses to sign while locked;
  - **standing approvals.** A spender with an allowance can `transferFrom` with no Safe transaction, which the
    guard never sees. The app keeps no standing approvals (approve, use, reset in one batch). The lock only
    turns on if the allowance to every known spender (Permit2, routers) is 0, and that is checked on chain
    at the time. **Unknown spenders are the leftover risk, and the app says so**: the cap is "no more than
    $2,000 through the wallet", not a promise about approvals made before the lock;
  - **Safe's gas refund (review F4).** A Safe transaction can pay ETH or tokens to a refund receiver on the
    side, separate from what it calls. While locked, refunds must be 0 (gasPrice = 0); relay fees inside the
    batch count against the cap;
  - every outflow counted against the cap: transfers, approvals, ETH value, swaps that send to someone else.
    Simplest: while locked, only USDC `transfer` up to the cap and the protecting actions are allowed.
- Safe owners can normally do anything, and only a **guard** can stop them. It's part of our one custom
  contract and needs Safe 1.5, which also guards module transactions (Roles, recovery, our module).
- **Recovery during a lock** is the one exception to "no adding owners": the guard allows Candide's
  finalize (it swaps the owner set; nothing leaves). The cap stays until the lock ends. The reset batch
  afterwards may remove old keys from Roles, since that's protecting, but can't give a new burner a budget
  until the lock ends, since that's weakening. The guard has already switched old Roles spending off.
- Risk: a buggy guard can freeze a Safe. Ending on its own limits that.
- **Provable to an attacker:** the contract is verified on Basescan / Etherscan, `lockStatus(safe)` returns the
  cap and end time, and `TravelLocked(safe, until, cap)` is emitted. The app shows a big red "LOCKED until Fri,
  max $2,000" screen linking to the chain explorer. Anyone can check it.
- Keep the cap simple so it's easy to prove: e.g. "USDC ≤ $2,000, everything else 0". A dollar cap across
  tokens would need a price oracle.
- Gap: it only covers this wallet. An attacker will ask what else you have.

## Sending (who pays gas)

| mode | how | cost | trusts |
|---|---|---|---|
| A Our relay (default) | we submit; the last action in the batch pays us in USDC | cheapest | us |
| B 4337 | public bundlers + Circle paymaster (USDC gas) | more | no single party |
| C Self-send | your MetaMask pays ETH gas | gas only | nobody |

4337 only accepts owner signatures. From level 2 up, the burner's daily spends go through a relay or self-send,
and anyone can submit them, not only us. If our relay dies, nothing is stuck.

## Group wallets (idea, Austin 10-05)

Three buddies, one Safe, e.g. 2 of 3 must sign. **The owners of the group Safe are each member's own Instant
Wallet Safe**, not their keys. Safe supports a Safe owning a Safe (contract signatures, EIP-1271).

- A member signs for the group with their wallet's **full** threshold, not the 24 h rule. Safe checks a
  member Safe's signature against its threshold, and our module doesn't sign. At level 4 that means:
  - all three keys, instant (one signature per key); or
  - wedgie + one: through the 24 h path, the member Safe calls `approveHash` **on the group Safe** (it is an
    owner there), and the group then counts that as its signature. Not on the member Safe itself: that fails.
    A member's recovery does not take back approvals it already gave.
  (Before phase 4: wedgie + one, instant.)
- Lose your wedgie? You fix it inside your own wallet (wedgie + other key, or your recovery). The group Safe
  never changes and the others do nothing.
- The group can have its own recovery, death switch, daily limits (Roles) and travel lock, the same pieces.

To check:
- Signing a group tx = each member's Safe validating a signature. That skips the member's own 24 h wait
  and travel lock (those cover the member's moves, not their signatures). So put any wait or lock on the
  group Safe itself.
- 4337 bundlers may reject nested-Safe signatures (storage rules), so group txs go via relay or self-send.
- The app needs a "pending group transactions" view (Safe's Transaction Service already stores proposals and
  confirmations from passkey signers; see `WEDGIE-SAFE.md`).

## Many chains, same address (Austin 10-05)

Goal: the wallet on lots of chains, added as you go, at the same address. Some chains will need a different one.

- **Same address:** a Safe's address comes from Safe's factory plus its *first* setup (first owners, modules,
  a salt). Safe's contracts sit at the same addresses on most EVM chains, so the same first setup gives the
  same address everywhere. Funds sent before it's deployed on a chain are safe: deploy later, same address.
- **Different address:** chains that compute addresses differently (zkSync Era and similar). The app keeps a
  per-chain address list and shows the right one.
- **Adding a chain** = deploy with the *first* setup, then replay every change since (owners added, limits,
  recovery) in one batch. The relay does it, paid in USDC.
- **Danger: an old setup is reborn.** The first setup has the burner as the only owner. If that burner was
  stolen and later removed on Base, the thief could deploy the Safe on a new chain with the first setup and
  own it there, along with anything sent there. Nothing lets you take that chain back. So **the promise is
  limited**:
  1. At signup, deploy on every cheap supported chain while the burner is fresh.
  2. Same address on a later chain **only while the original burner is still trusted** (still yours, never
     stolen). Once it's removed or lost, a new chain gets a **new** address whose first setup is your current
     keys.
  3. The app only shows an address on chains where it's deployed with your current keys, and warns loudly
     before anyone sends to a chain where it isn't.
- **Passkey/wedgie signers must use the same settings everywhere,** or their addresses (and so the Safe's)
  change. Use the P-256 precompile *plus* a fallback verifier on every chain, because not every chain has
  the precompile. (The Base test in `WEDGIE-SAFE.md` used the precompile only; that signer won't work on a
  chain without it.)
- **Per chain, check:** Safe, passkey signer, Roles, Candide, EAS (different address off the OP Stack),
  our one custom contract (deploy it with the same deterministic deployer), USDC + Circle paymaster for 4337,
  and a funded relay.

## Finding your Safes (Austin 10-05)

Open instantwallet.io and see your wallet plus every Safe you're part of (group wallets). No indexer of our own:
1. **Safe's Transaction Service already indexes this.** `GET /api/v1/owners/{address}/safes/` per chain
   lists the Safes an address owns. Browser-callable, no key (worked 10-05, see `WEDGIE-SAFE.md`). Ask it
   for each of your addresses: your own Safe (for group Safes), burner signer, hot, wedgie signers.
2. **localStorage** caches what was found, plus anything added by hand ("add a Safe by address") for
   chains Safe doesn't index.
3. Optional: our own small indexer on Safe's `AddedOwner` / `SafeSetup` events. The app never depends on it
   (or on Safe's service): with neither, it still works from localStorage + direct chain reads (a dial in
   `LEVELS.md`).

Risk: Safe could add keys or rate limits. Cache hard; route through our relay if needed.

## Libraries (Safe SDK and friends)

Yes, still in play. All open source, run in the browser, no server trust (except calls to Safe's service).
- **@safe-global/protocol-kit**: predict the address, build/sign/execute Safe txs, passkey owners.
- **@safe-global/api-kit**: Safe's Transaction Service (find Safes, propose, collect signatures).
- **@safe-global/relay-kit** (Safe4337Pack): sending mode B (4337 + paymaster).
- **zodiac-roles-sdk**: write the burner's Roles permissions. **Candide abstractionkit**: recovery helpers.
- The wedgie's signature stays hand-rolled (`src/safe/eth.ts` from wedgie-dev, no dependencies): the SDK
  won't build our faked passkey envelope.
- Watch bundle size: the app must open instantly. Load the SDKs lazily.

## AI (Austin 10-05)

**Talk to your wallet.** "Send Bob 50 USDC", "swap half my ETH to USDC", "what's pending?". The AI answers
with a **proposed transaction**, never a sent one. You sign it like any other (Face ID, wedgie press). Start from
`clawd-talk-to-your-wallet` (denar.ai: 19 wallet tools, returns calldata).

**Bring your own AI: `instantwallet.io/skill.md`.** One comprehensive file any AI (Claude, ChatGPT, a local
model) can read to fully understand and drive a wallet:
- how it works: keys, levels, limits, waits, travel lock, recovery, death switch, groups;
- contract addresses per chain, and how to read state (owners, budgets, pending moves, locks, heir);
- how to build and propose a tx (Safe tx service), decode one, and explain it in plain words;
- what it must never do (see below). Same idea as wedgie.dev/skill.md.

**Rules:**
- The AI proposes and explains. **It never holds an owner key.** Optional: its own Roles budget (e.g. $20/day,
  or "only pay these bills") for things it does alone.
- **What you sign is decoded by the app and the wedgie screen, not by the AI's words.** An AI can be fooled
  (a token name, an ENS record, a web page can carry instructions). The 24 h wait is the backstop.
- Proposals land in Safe's queue, so every device and every co-owner sees them.

**Before you sign: three layers, from most to least trusted** (Austin 10-05):
1. **Clear signing** (the EF's push; ERC-7730 descriptors): a fixed, reviewed decode of the call into words
   ("Send 500 USDC to bob.eth"). This is what the wedgie screen shows.
2. **Simulation** (Austin's `clawd-txn-simulator`, early; we'll run it): exactly what changes. Balances in and out, approvals,
   owner/module changes. Self-hostable, like the relay.
3. **AI explanation**: plain English for the whole batch ("this swaps half your ETH and gives Uniswap
   unlimited USDC"). Most helpful and least trusted, so it's labeled as AI and checked against 1 and 2. If
   they disagree, the app says so in red.

## Decentralization dials

Everything we run is optional. Each dial goes from "easy, uses our stuff" to "you depend on nobody".

| dial | default (ours) | more decentralized |
|---|---|---|
| keys | burner only | + hot, + wedgie (levels 1, 2, 4) |
| recovery | DAO | your sharded paper seed (level 3), DAO gone (level 5) |
| sending | our relay | 4337 bundlers → self-send from MetaMask |
| finding your Safes | our indexer / Safe's service | localStorage + direct chain reads |
| simulator | ours | run your own |
| alerts | our watcher | run your own (open source) |
| AI | ours | bring your own via skill.md |
| app | instantwallet.io | IPFS / ENS → run it locally |
| chain access | our RPC | your RPC → your node |

The app shows where you are on each dial and nudges you along (by balance, by level).

**We teach you to run your own infra** (Austin 10-05). Moving along a dial is a guided lesson, not a settings
toggle: "run your own node", "run your own relay / simulator / watcher / indexer", "pin the app on IPFS". Each
lesson: why it matters, step-by-step setup (a home box, a cloud box, or one command), then the app switches
over to it and checks it works. The same skill.md helps your own AI walk you through it.

## Security model

1. **Audited code first.** Everything on chain is audited code that already holds real money, except at most
   one contract of ours (24 h wait + cancel rules + travel lock), which gets a full audit.
2. **Two of three keys can do anything; one can't** (level 2+). We plan for one key stolen or lost at a time;
   two stolen = out of luck. From level 4, two keys (one the wedgie) wait 24 h (to catch tricks, not thieves), any two cancel, all three are instant.
3. **Protecting is one key and instant; weakening is two keys and a wait, or all three.**
4. **Recovery is slow and loud.** 7 days, an alert the moment it starts, and your owners can cancel.
5. **The DAO is trusted until you replace it.** At levels 1–2 the DAO could reset your keys if you ignore
   the alert for 7 days. That's the deal for a free backup on spending money. Level 3 (paper) removes the
   7-day recovery. The DAO's death switch can still reset your keys after a 6-month wait until level 5.
6. **Alerts are required.** A wait you don't hear about protects nothing. Push, email, Telegram, and the
   watcher is open source so you can run your own. **The watcher is separate from the app** (review C1): it
   reads the queued move straight from the chain and decodes it itself, because a hacked app could lie about
   what's pending. You can cancel from another client too (a second device, the watcher's own cancel page,
   or any Safe tool with your keys).
7. **The wedgie key never leaves the chip.** You confirm by pressing A after reading the screen (no PIN). Any
   wedgie app can use the key, so a wallet wedgie only runs reviewed apps.
8. **There's a way out.** Our app is open source and pinned on IPFS, so it still runs if instantwallet.io
   disappears. Safe's own app may also work, but that's unproven: passkey owners may fail there (#8808), and
   the wedgie needs our firmware anyway.

## The goal: stronger than any single way of holding crypto (Austin 10-05)

If one seed phrase were enough, we'd just use a seed phrase. So at level 4+, with five things that matter
(burner, hot, wedgie, paper seed, the DAO death switch):
- **Any one stolen → no loss** beyond the burner's daily budget, and it can't block you.
- **Two keys stolen (wedgie + one) → lost.** Accepted: one stolen at a time is far more likely.
- **Tricked into signing → a chance to catch it** (review C1): the 24 h wait gives you time to see the alert and
  cancel. Not a guarantee: all three keys and pair spends within the 500 USDC / 0.2 ETH budget don't wait.

Every pair, checked:

| thief has | what they try | result |
|---|---|---|
| burner + hot | spend, remove the wedgie | wedgie required: the budget only. Wedgie + one remove them |
| burner + wedgie, or hot + wedgie | drain | **lost** (after the wait) |
| paper + burner | recovery to their keys (7 d) | hot + wedgie cancel it |
| paper + hot | recovery (7 d) | burner + wedgie cancel it |
| paper + wedgie | recovery (7 d) | burner + hot cancel it |
| DAO + any one key | death switch (6 mo) | two keys cancel |

Every "cancel" row depends on **the alert reaching you**. Alerts aren't optional.
Keep checking as the plan changes: no new power may let a single item win, or let a pair other than
"wedgie + one key" win.

## What happens if it leaks (stolen)

Level 4+ assumes our contract is live (phase 4). Before that, any two keys including the wedgie = everything, instantly.

| stolen | level 1 | levels 2–3 | level 4+ |
|---|---|---|---|
| burner | **everything** (spending money only) | its daily limit; hot stops it; recovery replaces it in 7 d | its daily limit; hot or wedgie stops it; wedgie + hot remove it (24 h; 7 d if it objects, or paper now) |
| hot | — | nothing alone; recovery replaces it in 7 d | nothing alone; wedgie + burner remove it (24 h; 7 d if it objects, or paper now) |
| wedgie | — | — | nothing alone; burner + hot + paper replace it now, or recovery in 7 d. PIN makes it useless |
| burner + hot | — | **everything** | its daily limit; wedgie stops it; recovery replaces both |
| burner + wedgie | — | — | **everything**, after the wait |
| hot + wedgie | — | — | **everything**, after the wait |
| all three | — | — | **everything**, instantly |
| one paper share (level 3+) | — | nothing with SLIP-39 (word cards: 16 of 24 words leak) | same |
| two paper shares / the recovery key | takeover waits 7 d; burner cancels | burner + hot cancel | any two keys cancel |
| death switch (DAO) | waits 6 mo; owners cancel | same | same (any two keys at level 4+) |

Two stolen keys including the wedgie = lost. The wait is for catching tricks, not thieves.
One stolen key = no power: it can't spend beyond the budget, can't cancel, can't block its own removal.
After a recovery, the new keys reset Roles and our module right away (see "After a recovery").
A thief holding hot or the wedgie alone can switch off your burner's budget. That's annoying, not theft.

## What happens if you lose it

| lost | level 1 | levels 2–3 | level 4+ |
|---|---|---|---|
| burner (passkey synced to iCloud/Google) | open the app on the new phone | same | same |
| burner (not synced) | recovery gives you a new one in 7 d | recovery, 7 d | wedgie + hot swap it (24 h) |
| hot | — | recovery replaces it in 7 d; burner keeps its daily limit | wedgie + burner replace it (24 h) |
| wedgie | — | — | recovery replaces it in 7 d; burner keeps its daily limit |
| any two keys | — | recovery, 7 d | recovery, 7 d |
| one paper share | — | make new shares (level 3+) | same |
| every key | recovery, 7 d | recovery, 7 d | recovery, 7 d |
| every key + recovery | death switch, 6 mo → heir | same | same |
| recovery (DAO or paper) | burner sets a new one | burner + hot | all three |
| you (death) | death switch → heir after 6 mo | same | same |

## Open decisions

1. ~~Death switch length~~ **Decided: 6 months** (Austin, 10-05).
2. ~~Death switch destination~~ **Decided (Austin, 10-05):** the user sets an heir **on chain**, public; the
   DAO can overrule it at the time, but anyone can see it did. How, with no custom contract: the Safe posts an
   **EAS attestation** "heir = 0x…" (Ethereum Attestation Service, audited, built into Base, also on Ethereum).
   Changing the heir = a new attestation (owners sign). When the DAO starts the death switch, Candide records
   the proposed new owner on chain; the app and the alert compare it with the attested heir and say loudly
   if they differ. 6-month wait; owners can cancel.
3. ~~Level 2~~ **Decided (Austin, 10-05):** with only burner + hot, the two together can do anything. Once a
   wedgie is added, anything big needs the wedgie + burner or hot. The app nudges "add a wedgie" above ~$1,000.
4. ~~Default daily limit~~ **Decided:** burner 100 USDC + 0.04 ETH a day; wedgie + one 500 USDC + 0.2 ETH a day;
   other tokens none. Token amounts, not dollars. Per wallet, configurable.
5. ~~Wait~~ **Decided:** wedgie + one waits (default 24 h, 1–48 h), all three instant, any two keys cancel
   (our contract, phase 4). The wait catches tricks, not thieves.
6. ~~Travel lock~~ **Decided:** yes, in the same contract.
7. **Paper share scheme:** SLIP-39 (recommended) vs overlapping word cards. And what the "special paper" is (printed card
   kit, steel plates).

8. **If instantwallet.io dies (review F7).** A passkey only works on the domain it was made on; a copy of the
   app on IPFS can't use it. Options: keep the domain alive for good (multi-year renewal, held by the DAO),
   and/or accept recovery as the way back (level 1: DAO, 7 d). Security model #8 overstates IPFS until decided.
9. **When the Safe is deployed (review F8).** Phase 1 says "on Base at first deposit"; the multichain plan says
   "every cheap chain at signup". Pick one, and who pays the gas.
10. **Paper format (review C2).** Native SLIP-39 (shares of ~20 words, no 24-word phrase; recommended) or a
   24-word BIP-39 phrase split by a documented method. Must restore to the same address with independent software.

## Not proven yet (Base-fork spike first)

1. Burner budget: Roles with a passkey-signer member, signed by the phone, submitted by a relay. Includes
   replay protection, and which Roles version is deployed on Base and Ethereum.
2. The "protect" role: Roles letting one key switch off the burner (a call from the Safe back into Roles).
3. The wedgie counting twice: two passkey-signer owners for one chip key, threshold 3 then 4, one press fills
   both (only threshold 1 was tested).
4. Candide with the DAO Safe as guardian; our 6-month deployment.
5. Each level change as one batched transaction.
6. 4337 + Circle paymaster with passkey owners.
7. Safe app as an escape hatch (issue #8808: passkey owners with 2+ signatures may fail there).
8. EAS heir attestation made by the Safe itself (attester = the Safe), and reading it back.
9. Group wallet: a Safe owned by members' Safes (each with a wedgie owner), 2 of 3 signing via relay.
10. Same address on a second chain (e.g. Optimism): first setup + replay, signer with precompile + fallback.
11. Safe 1.5 deployed on Base and every target chain; Safe's owners endpoint lists Safes owned by a
    passkey signer and by a Safe (for groups).
12. Ethereum mainnet: check every piece is deployed there too, not just Base.
13. Attacks to test: one stolen key trying to cancel or block anything (must fail); old keys spending right
    after a recovery, app offline (must fail); a cancelled move after owners change and change back (must
    stay dead); a lock paying out through Safe's gas refund (must fail); re-locking right after a lock ends;
    a stolen key objecting to its removal (only delays to 7 d); burner + hot + paper replacing the wedgie; a wedgie PIN; the old burner's budget after a recovery (and the reset batch); travel-lock bypasses (standing
    approvals, Permit2 / 1271 signatures, delegatecall, guard removal, swaps to outside recipients);
    deploying on a new chain after the original burner is gone; recovery finalizing during a travel lock
    (allowed) while adding a burner budget stays blocked.
14. The wedgie making two keys in two slots and signing both with one press.
15. Group signing by a member Safe at threshold 4 (all three) and via `approveHash` on the group Safe through
    the 24 h path.

## Decide before the first user

A Safe's address is fixed by its first setup, forever, on every chain. So before anyone gets a wallet:
- **Keep the first setup minimal:** the burner's signer as the only owner, plus a fallback handler. Add
  everything else (Roles, recovery, more owners) afterwards with normal transactions, so changing those plans
  never moves anyone's address.
- **Safe version: 1.5** (the travel lock / canceller guard needs it; the wedgie was tested on 1.4.1). Check
  that it's deployed on every chain we want.
- **Signer settings:** P-256 precompile + fallback verifier, the same on every chain.
- **Salt scheme:** how the address is derived from the passkey, so the app can find it again on any device.
- The app domain (instantwallet.io): passkeys are bound to it forever.

## Build order (phases)

Plan everything now (this doc); build in phases. Each phase updates `skill.md`.

0. **Decide + spike.** The list above, then prove "Not proven yet" on a Base fork. Fix the plan where it breaks.
1. **Level 1 on Base.** Face ID → Safe (created on first deposit), scan, send. Our relay with a USDC fee.
   DAO recovery (7 d). First alerts. Find your Safes (Safe's service + localStorage). Before-you-sign:
   clear signing + simulator + AI explanation. Safe SDK, loaded lazily. `skill.md` v1.
2. **Levels 2–4.** Add MetaMask (ENS). Paper seed: make, shard, practice restore, becomes recovery. Pair the
   wedgie (counts twice; wedgie + one instant until phase 4). Burner budget (Roles, 100 USDC + 0.04 ETH a day, user-set).
   Protect role. The level meter and nudges.
3. **Safety.** Death switch (6 mo, our Candide deployment) + heir on EAS. Level 5 (DAO removed). Full
   alerts (push, email, Telegram; open-source watcher).
4. **Our one custom contract:** wedgie + one waits 24 h, cancel rules, travel lock (Safe 1.5 module + guard +
   fallback handler).
   Safe goes to 4 votes. Audited before real money.
5. **More chains.** Same address, deploy + replay, Ethereum mainnet. Different-address chains last.
6. **Group wallets.** Safes owned by members' Safes, pending-transactions view.
7. **AI.** Talk to your wallet (proposals), AI Roles budget, bring-your-own-AI on the full `skill.md`.
8. **Decentralize the rest.** Sending modes B and C, app on IPFS/ENS, own RPC, self-hosted relay /
   simulator / watcher / indexer, each as a guided lesson (own node included).

Every phase: review our code (app, relay, watcher, simulator, wedgie firmware). Simulator: github.com/clawdbotatg/clawd-txn-simulator
(early, not ready yet).
