# Levels — from burner to full self-custody

Austin, 2026-10-05. One Safe, one address for life. Each dial moves from "easy, trusts us" to
"harder, trusts nobody". The app shows where you are and nudges you up (e.g. by balance). Add dials as we
think of them. See `ROLES.md` (who can do what) and `SAFE.md` (how it's built).

## Dial 1 — keys

| level | you add | you get |
|---|---|---|
| 1 Burner | Face ID | spend right away. DAO is your backup |
| 2 Hot | MetaMask / ENS | big moves need two keys; burner drops to a daily limit |
| 3 Cold | wedgie | MetaMask + wedgie own it; burner is spending money |
| 4 Own recovery | a friend, second wedgie, your Safe | the DAO can no longer reset your keys |
| 5 Full self-custody | remove the DAO (or keep only the 6-month death switch) | nobody but you |

Changing a limit or any setting = the owners sign (burner alone at level 1, two keys after).

## Dial 2 — who sends your transactions

| level | how | cost | trusts |
|---|---|---|---|
| A Our relay | we submit; fee in USDC inside the tx | cheapest | us |
| B 4337 | public bundlers + Circle paymaster | more | no one party |
| C Self-send | your MetaMask pays ETH gas | gas only | nobody |

4337 only takes owner signatures, so after level 2 the burner's daily spends go via a relay or self-send.
Anyone can submit them, not only us.

## More dials (ideas, not decided)

- **App:** instantwallet.io → the same app on IPFS / ENS → run it yourself.
- **Chain access:** our RPC → your own RPC → your own node.
- **Alerts:** our watcher → your own watcher.
- **Escape hatch:** the Safe app (app.safe.global) or any Safe tool can still open your Safe.
