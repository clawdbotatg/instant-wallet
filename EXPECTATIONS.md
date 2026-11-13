# Expectations

What Instant Wallet must always do. If a change breaks one, it doesn't ship. In this order:

## 0. I should never see memory errors coming from the wedgie

- The highest expectation. A wedgie that runs out of memory, freezes or stops answering is a failure, on any
  transaction, from Instant Wallet or wedgie.dev.
- Short on memory, the wedgie shows less (no extras), never an error.
- Every wedgie release: test it with the memory squeezed (safechip `--frag`) and with a real Instant Wallet
  swap. A real wedgie has less memory than the virtual one.
- Never hide an error to make it go away. Find why.

## 1. You know exactly what you sign

- Every transaction says what it does in plain English. Never hex, never a function name.
- Money out is red with a −. Money in is green with a +. Dollars next to it.
- The coins come from the simulator (clear-sim, sim.wedgie.dev), its answer checked. You can point the
  wallet at your own simulator (Settings → Simulator).
- On Ethereum and Gnosis you can have this browser work the coins out itself (a light client: the node proves
  every answer). It says "Checked in this browser". If it can't prove an answer it says so in red: never the
  unchecked answer, never the simulator instead.
- Reads and transactions go to your own node on any network where you set one (Settings → Your node). Never a
  fallback to ours.
- Anything that could take everything says so in red, first: a delegatecall that isn't a plain batch, a
  module, a guard, a fallback handler.
- The wedgie shows the same thing on its own screen. Its coins come from clear-sim only (the one answer it can
  check). Turn that off (Settings → Simulator) and it shows the words, no coins, and no simulator is asked.

Where it lives: `WhatItDoes`, `<Money>`, clear-signing-safe-kit (`dangers`, `simulate`, the explainer).

## 2. Same thing, same look, everywhere

- A feature asked for in one place goes everywhere that thing shows. Never make Austin ask twice.
- Every rule below has one shared part. Use it. Never draw the thing by hand. Most are in
  `web/components/bits.tsx`; `SrcTag` is in `WhatItDoes.tsx`, `bio()` in `lib/passkey.ts`, `shownAs` and
  `wedgieHome` in `lib/safe/state.ts`.
- `node web/tools/same-check.mjs` fails on anything hand-drawn. A new rule from Austin goes into that check in the
  same change, or it comes back in a fourth place.
- Instant Wallet and wedgie.dev share their code through clear-signing-safe-kit, so both say the same.

| Thing | Always | Never |
|---|---|---|
| Money moving | `<Money>`: out red −, in green +, dollars after in gray | a hand-written + or − |
| Leaving the wallet (explorer, Safe{Wallet}, a tx's page) | `<Eject>`: white pill (the height of every pill), new window, on the right. A block explorer is the bare icon, top right, never the word (11-12). Other places say their name (Safe ↗). A whole row that leaves (a position, a connected site) says ↗ after its name. On a finished screen `<DoneBar>`: Done, and the icon in the sheet's top right | a button that says Explorer, a hand-rolled pill link, a pill stretched across the page |
| A link to give someone (a tx for the other signers, an invite, a claim, a drop) | `<CopyLink>`: dark gray, copies. We always say Copy, never Share (11-12). The link itself is never printed | a Share button, the phone's share sheet for a link, the link written out, a pop-out |
| An address | `<Who>` (name over short address, avatar or blockie). Every one, on every screen (11-11). On one line (a headline, a button, under a QR code) it is `<Who flat>`. In an error or a tx's label: the full address in the words, drawn by `<Words>` | a bare `short(…)`, a full address in mono, one shortened by hand, a `<Blockie>` placed by hand |
| A wallet's name | ONE name: its own ENS name, else its `alice.inst.eth` name, else an old private name, else no name: just its address, and the pencil says "Add a name" (11-12). We never make one up. One lookup decides, `/api/ens`, so `<Who>` says the same everywhere. The pencil edits the name on screen (the inst.eth one; none on an ENS name). The passkey is named after it and nothing else. `docs/NAMES.md` | a second lookup that picks a name its own way, a pencil that edits another name, two names in the passkey, "Spending account" / "Savings account" anywhere |
| Paying a name | `<NameMoved>` under it: red, with where it pointed last time, when it has moved (Send, Send everything, every `<AddressInput>`) | a name looked up and paid with no check |
| A send | says who to: "Send to" and their `<Who>` (Activity, a waiting tx, signing) | "Send" alone |
| A network | `<Net>`: its logo, then its name, everywhere one is named: Activity, a waiting tx, a tx page, a sentence, a button (11-12). The one place without: an asset row, whose token icon has the network's badge. Plain words only where no picture can go (an error, a toast, a `<select>`) | the name alone, a `<ChainIcon>` and a name put side by side by hand |
| Someone else's passkey (an invited signer) | their Instant Wallet, the one they know: `<Who signer>` on `passkeyHome` (blockie, name, avatar), the signer contract as the small blockie on its corner. Small under it: "signs as 0x5fD4…", the address a wedgie's screen and the chain show. `<Who>` does it by itself wherever that signer's address turns up (`homeOf`): the invite's Sent screen, Settings' signer rows, a tx's words, the signing sheet (11-12). Only in the browser that saw the invite answered: on chain an invited passkey can't be told from a wedgie | the signer contract's address or blockie alone |
| A wedgie | its own screen's address + blockie (`shownAs`, `wedgieHome`) | its signer contract, an ENS avatar |
| An address in a tx's words | `<Words>`: each full address drawn as `<Who>` | bare hex, `short(…)` in the text |
| Where a tx step's words came from | `<SrcTag>`: the kit's `MARKS` emoji in place of the step number (🛡️ audited · ✅ our robot checked it · 🔏 EF · 📝 ours · 🛠️ our code · 🤖 robot · ⚠️ raw), same on wedgie.dev | a number, a pill, a word |
| What a tx does | `WhatItDoes` in plain words. Its line (clear signing's words) in bold `<WhatFor>` ABOVE the coins, as in Activity | hex, a function name, small text under the coins |
| Removing | `<RemoveX>`, the small red ✕. Far left when a green button follows it; else on the right. Wherever a waiting tx has Reject, it has the ✕ too (Home card, tx page) | a hand-drawn ✕, Reject alone |
| The passkey | `bio()` / `<BioSigner>`: Face ID, Touch ID… for this device | "Face ID" hard-coded |
| The wedgie's buttons | `<GreenButton />`, "the green button" | A / B / X / Y |
| Typing an amount of a coin | `<AmountBox>`: dollars first, a pill switches to the coin and back (Send, Swap, Share, Request, Limits) | a box that takes tokens only, a hand-made box |
| Typing or pasting an address | ONE box, `<AddressInput>`, everywhere an address is typed: Send, the scan screen, Send everything, adding a signer or a guardian, both recover screens (11-12). It works the same in each: 0x…, a name (`nick.eth`), or a word alone (`lil` is tried as `lil.inst.eth`). The box and the cursor are never touched, so `nick` goes on to `nick.eth`; the match shows under the box with its name and address. The box keeps only the address: a dot, a space, words around it are dropped; `atg.eth.` is atg.eth (`addressIn()`, `nameIn()`). A scan pill in every one: the scanner opens as its own sheet over the page, looking like Send's scan screen (the short camera, Paste address, no WalletConnect), and closes itself with the address in the box | an `<input>` for an address by hand, a box with its own lookup, a box that swaps what you typed for a short address, a camera that opens inside the page, an error on `0x….` |
| A wait of ~5 s or more | a progress bar sized to it | a dead screen, an "Ask again" button |

Words:
- Signing says **Sign**. Declining says **Reject**. Never Yes / Approve / Confirm on a signature.
- The tap that signs says **Sign**, or "Sign to …" when the screen has no question above it (Sign to swap, Sign to fund it, Sign to reject) (11-12). Never Send / Swap / Fund it on that tap.
- Running a signed tx is **Execute** (Executing…, ✓ Executed). Never send.
- A tx that ran says **✓ Executed** the same way everywhere: `<ExecutedLine>` in a card or a row, the big ✓ and "Executed" on a sheet. Never Swapped / Funded.
- A finished screen says **Done**, white (the only button, nothing to compete with). Never OK.
- Fewest words (11-10). Make it obvious with less on screen. Never a sentence that explains what the screen
  already shows.
- Say it once (11-10). The Send sheet is one line: "Send $1.00 of ETH to atg.eth?". Send, Swap and Send
  everything show the run's coins (red −, green +) and a Fee row, no sentence (`<WhatItDoes quiet>`); a danger
  or a warning brings the full card back. Never hide the coins. Never "Checked in this browser".
- One word per thing (11-12): **recovery address** (never guardian), **coin** (never token), **signer** (never owner or key), **daily limit** (never budget), **network** (never chain), **browser wallet** (never hot wallet), **Instant Wallet**. "Gas" only where your own browser wallet pays it.
- A fee reads the same everywhere: the coin, then dollars: "Fee 0.03 USDC ($0.03)" (`feeText`, `feeWords`).
- A signer is shown the same in Settings and on a tx's page: the name you gave it, else what it is (Wedgie, Browser wallet).
- A working button says what `stageLabel` says: Getting the fee…, Signing…, Executing….
- Dollars are cents ($0.25), four places only under a cent.

Button colors (10-30):
- Green = the one obvious action.
- Dark gray = the second choice (11-12): the next thing someone might do after the green one (I already have one, NFC card). One per screen. Where a copy link (`<CopyLink>`) is on the screen, that is the second choice, and any other is a third: white. When copying the link is the only thing that works (the first page inside a wallet app's browser), it is green. Also Switch account.
- Red = it destroys something: remove (✕), delete, disconnect, sign out, cancel something onchain, or something went wrong (a bug report). Closing a window is not red: Back, Close, Done, Cancel (a form) are white.
- White = everything else: most buttons. Reject, `<Eject>`, Add a wedgie.
Button sizes (11-11):
- Two heights. The main button is 56. Every small one (a pill, `btn-sm`, `<Eject>`) is 38.

## 3. A wedgie is shown as itself

- Always the address on its own screen and that blockie (`shownAs`, `wedgieHome`), never its signer
  contract, never an ENS avatar.

## 4. One obvious green

- Green is the one thing people do next. Two greens are fine when they're in separate parts of a page. The
  other colors: #2, Button colors.
- The point is the hint (11-12): green shows what to do, dark gray the second thing, the same way on every
  screen. A rare state with two greens, or two things that matter the same and are both green, is fine.
- Green follows what's next: when the next thing changes, green moves to it. A button doesn't change color while
  it works (busy, done, failed).

## 5. Dollars first

- Show USD wherever we can. Typing an amount shows its USD value under it.

## 6. It feels alive

- The wallet is quick and never sluggish. What's on screen is what's true now.
- Something you just did shows at once: a transaction you made is in the list, a signature is counted, the coins
  you moved are read again. No wait for a timer.
- Something from outside shows within seconds: money sent to you, a signature from another device, a transaction
  someone else made. And at once when you come back to the tab.
- While you're about to sign, the numbers are live: the fee follows gas, a swap keeps getting the latest price.
- Be smart, not loud. Read what just changed (the two coins of a swap), read fast only while it matters (the
  receive code is up, a sheet is open), slow down when nobody's there, stop when the tab is hidden.
- A slow read needs a real limit: one that was checked, named in a comment next to the number. Never a slow
  number picked just in case (11-12: Home re-read its waiting transactions every 5 minutes, to save a quota it
  never touched).
- The real limits today: Safe's service (a quota shared with wedgie.dev), Zerion (positions), LI.FI (swap
  prices, no key).

`node web/tools/same-check.mjs` fails on a list re-read slower than every 30 seconds.

## Known gaps (2026-10-29)

- `<Money>` shows the coin first, dollars after; dollars-first not decided.
