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
- Every rule below has one shared part in `web/components/bits.tsx`. Use it. Never draw the thing by hand.
- `node web/tools/same-check.mjs` fails on anything hand-drawn. A new rule from Austin goes into that check in the
  same change, or it comes back in a fourth place.
- Instant Wallet and wedgie.dev share their code through clear-signing-safe-kit, so both say the same.

| Thing | Always | Never |
|---|---|---|
| Money moving | `<Money>`: out red −, in green +, dollars after in gray | a hand-written + or − |
| Leaving the wallet (explorer, Safe{Wallet}, a tx's page) | `<Eject>`: white pill (the height of every pill), new window, as wide as its words, on the right. A whole row that leaves (a position, a connected site) says ↗ after its name. With a line of its own (under a progress bar) it is `big`: a normal button's height. On a finished screen `<DoneBar>`: Done and Explorer in one row, same height | a hand-rolled pill link, a pill stretched across the page |
| A tx's link for the other signers | `<CopyLink>`: dark gray, copies. The only way to share a tx | a pop-out, a second Share button |
| An address | `<Who>` (name over short address, avatar or blockie) | a bare `short(…)` in a list |
| A wedgie | its own screen's address + blockie (`shownAs`, `wedgieHome`) | its signer contract, an ENS avatar |
| An address in a tx's words | `<Words>`: each full address drawn as `<Who>` | bare hex, `short(…)` in the text |
| Where a tx step's words came from | `<SrcTag>`: the kit's `MARKS` emoji in place of the step number (🛡️ audited · ✅ our robot checked it · 🔏 EF · 📝 ours · 🛠️ our code · 🤖 robot · ⚠️ raw), same on wedgie.dev | a number, a pill, a word |
| What a tx does | `WhatItDoes` in plain words. Its line (clear signing's words) in bold `<WhatFor>` ABOVE the coins, as in Activity | hex, a function name, small text under the coins |
| Removing | `<RemoveX>`, the small red ✕. Far left when a green button follows it; else on the right. Wherever a waiting tx has Reject, it has the ✕ too (Home card, tx page) | a hand-drawn ✕, Reject alone |
| The passkey | `bio()` / `<BioSigner>`: Face ID, Touch ID… for this device | "Face ID" hard-coded |
| The wedgie's buttons | `<GreenButton />`, "the green button" | A / B / X / Y |
| A wait of ~5 s or more | a progress bar sized to it | a dead screen, an "Ask again" button |

Words:
- Signing says **Sign**. Declining says **Reject**. Never Yes / Approve / Confirm on a signature.
- Running a signed tx is **Execute** (Executing…, ✓ Executed). Never send.
- A finished screen says **Done**, white (the only button, nothing to compete with). Never OK.
- Fewest words (11-10). Make it obvious with less on screen. Never a sentence that explains what the screen
  already shows.
- Say it once (11-10). The Send sheet is one line: "Send $1.00 of ETH to atg.eth?". The check still runs and
  speaks only when something is wrong (`<WhatItDoes quiet>`). Never "Checked in this browser".

Button colors (10-30):
- Green = the one obvious action.
- Dark gray = copy the link (`<CopyLink>`), and Switch account. Nothing else.
- Red = it destroys something: remove (✕), delete, disconnect, sign out, cancel something onchain, or something went wrong (a bug report). Closing a window is not red: Back, Close, Done, Cancel (a form) are white.
- White = everything else: most buttons. Reject, `<Eject>`, a second choice (NFC card), Add a wedgie.

## 3. A wedgie is shown as itself

- Always the address on its own screen and that blockie (`shownAs`, `wedgieHome`), never its signer
  contract, never an ENS avatar.

## 4. One obvious green

- Green is the one thing people do next. Two greens are fine when they're in separate parts of a page. Make the
  runner-up dark gray when you can. Never change a button's color as things change.

## 5. Dollars first

- Show USD wherever we can. Typing an amount shows its USD value under it.

## Known gaps (2026-10-29)

- `<Money>` shows the coin first, dollars after; dollars-first not decided.
