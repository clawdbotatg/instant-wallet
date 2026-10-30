# Expectations

What Instant Wallet must always do. If a change breaks one, it doesn't ship. In this order:

## 1. You know exactly what you sign

- Every transaction says what it does in plain English. Never hex, never a function name.
- Money out is red with a −. Money in is green with a +. Dollars next to it.
- The coins come from the simulator (clear-sim, sim.wedgie.dev), its answer checked. You can point the
  wallet at your own simulator (Settings → Simulator).
- Anything that could take everything says so in red, first: a delegatecall that isn't a plain batch, a
  module, a guard, a fallback handler.
- The wedgie shows the same thing on its own screen.

Where it lives: `WhatItDoes`, `<Money>`, clear-signing-safe-kit (`dangers`, `simulate`, the explainer).

## 2. Same thing, same look, everywhere

- A feature asked for in one place goes everywhere that thing shows. Never make Austin ask twice.
- One shared component per thing: `<Money>`, `<Eject>` (always a new window), `<Who>` (an address),
  `WhatItDoes`. Signing says Sign, declining says Reject, removing is the red ✕ on the far left.
- Instant Wallet and wedgie.dev share their code through clear-signing-safe-kit, so both say the same.

## 3. A wedgie is shown as itself

- Always the address on its own screen and that blockie (`shownAs`, `wedgieHome`), never its signer
  contract, never an ENS avatar.

## 4. One green button per page

- One clear green call to action. The exception: a Sign button on each signer you hold.

## 5. Dollars first

- Show USD wherever we can. Typing an amount shows its USD value under it.

## Known gaps (2026-10-29)

- Waiting cards: each has its own green button (more than one green on home when several wait).
- `<Money>` shows the coin first, dollars after; dollars-first not decided.
- The tx page has no Reject yet (home's Waiting cards do).
