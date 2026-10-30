# Instant Wallet

**Read `EXPECTATIONS.md` first, before any work.** It's what the wallet must always do, in priority order. A
change that breaks one doesn't ship. The highest: I should never see memory errors coming from the wedgie.

Before pushing a UI change: `node web/tools/same-check.mjs` (seconds). When Austin gives a new "always do X" rule, add it to
EXPECTATIONS.md #2 and to that check in the same change, then fix every place it fails.
