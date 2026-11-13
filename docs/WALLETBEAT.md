# WalletBeat (ideas, not planned)

WalletBeat (walletbeat.eth) rates Ethereum wallets in stages. As of 2026-11-13 every listed wallet is at Stage 0, and
the table sorts by stage first. Clearing Stage 0.5 would put Instant Wallet first.

This is a list of things we **could** do later. None of it is decided or scheduled.

## Done (2026-11-13)

- **Raw view** under every signing screen: the exact bytes and the hashes the keys sign (ERC-8213). `<Raw>`,
  `lib/safe/raw.ts`.
- **Sign-In with Ethereum** shown as a sign-in, red if the site or account doesn't match (ERC-4361).
- **Recovery check:** every 90 days Home asks if you can still use your own recovery addresses. `RecoveryCheck`.
- **Approvals screen** (another session, same day): Apps → Revoke shows and revokes ERC-20, collectible and Permit2
  approvals. `components/safe/Revoke.tsx`. A real revoke hasn't been signed yet.

## Where we stand

Good: open source (MIT), clear signing with simulated coins, a hardware signer (the wedgie), recovery with your own
addresses, your own node on every network, a standard Safe (opens in Safe{Wallet}), no analytics, no swap fee,
EIP-5792 batches, ENS, one balance across 14 networks.

Bad: no audit, no bug bounty, no private sends, the DAO can replace your keys after 7 days by
default, most sends need our relay, the passkey only works on instantwallet.io, our server sees IP and address
together, no changelog or signed builds, only the wedgie as a direct hardware wallet, one address for every site,
light client only on Ethereum and Gnosis and off by default.

## Things we could do

### To get listed at all

- **A PR to WalletBeat.** Their code can't rate us yet:
  - Safe-only accounts throw in their account check, and batching fails without ERC-4337 or EIP-7702.
  - Guardians with a waiting period (our recovery) throw "not implemented yet".
  - There is no web-app type (only extension, mobile, desktop).
  - Their light client list has only Helios. Add Colibri.
- **Our listing:** a data file with a link as proof for each claim, our logo, signed commits, and our affiliation
  stated. Self-listing is allowed.

### Stage 1, things we can build

- **Recovery without the DAO by default**, or an easy way to remove it. The DAO alone being able to replace the keys
  fails "no one can take your wallet".
- **Private sends:** stealth addresses, Privacy Pools or Railgun. No listed wallet has this by default.
- **Licence files** in instant-wallet-app, instant-wallet-apps, instant-wallet-dashboard.
- **EIP-2700** in the browser extension, if we're filed as an extension.
- **Address privacy:** don't send several of a user's addresses from the same IP within minutes.
- **Hardware wallets:** zero of Ledger / Trezor / Keystone / GridPlus / imKey is fine, three passes, one or two
  fails. Don't add just one.

### Stage 1, things that need money or outside people

- **An audit**, public, by an outside firm, less than a year old.
- **A bug bounty**, active, full scope, with rewards and safe harbor stated.

### Stage 2 and other ideas

- **Light client on by default**, covering balances, not only the coins before signing.
- **Helios for Base.** Tried 11-13: a16z's Base server was down and our own got no blocks. Speed would be fine
  (0.7 to 1.2 s of proofs per Safe tx). Re-check in about a month. Note in `lib/safe/light.ts`.
- **Release proof:** a changelog, tagged releases, signed or reproducible builds.
- **Per-site accounts:** a different address for each app.
- **Our own transaction path:** let a passkey-only phone send without our relay.

### Keeping the wallet alive without us

- **Local mode:** run the whole wallet on your own computer under the name instantwallet.io, so the passkey still
  works if the site is gone. Plan: `docs/LOCAL-MODE.md`. First step is a hand test on one Mac.
- **"Add a second key"** on Home for passkey-only wallets: the wedgie, a browser wallet, or a recovery address.
  These work anywhere, not only on instantwallet.io.
- **Keep the domain:** renew instantwallet.io for 10 years and turn on the registrar lock.

## Not tested yet

- Raw, the sign-in view and the recovery check have not been tried on a phone.
