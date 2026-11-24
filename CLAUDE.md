# Instant Wallet

**Read `EXPECTATIONS.md` first, before any work.** It's what the wallet must always do, in priority order. A
change that breaks one doesn't ship. The highest: I should never see memory errors coming from the wedgie.

**Clear signing:** read `../clear-descriptors/MAP.md` first (all the repos, the marks). A call no one can read gets a descriptor, never new code.

Before pushing a UI change: `node web/tools/same-check.mjs` (seconds). When Austin gives a new "always do X" rule, add it to
EXPECTATIONS.md #2 and to that check in the same change, then fix every place it fails.

**Two modes:** read `docs/MODES.md` before any CROPS, privacy, proving or rate-limit work. A copy on your own computer
is "mountain man": as CROPS as possible, on by default, whatever it costs. instantwallet.io and the app are "finance
bro": very smooth, no added waits or node calls. A setting that trades one for the other takes its default from
`web/lib/mode.ts`, never `isLocal()`.
