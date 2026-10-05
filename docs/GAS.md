# Sending and gas (v3.1): ERC-4337, fees in USDC

**In one line:** every send is one signed ERC-4337 *user operation*; a public bundler puts it on chain and is paid
back in ETH by Circle's paymaster, which takes the fee from the wallet in USDC. The wallet never holds ETH for gas.

Live since 2026-10-04 on Base. Contracts: InstantWallet `0xBd1569c8978fB403079b75eBAcc369F0E7244B6F`, Factory
`0x896c8D40022A79FC1228dB800FD3aaf7f21d7469` (CREATE2, same address on every chain; only deployed on Base so far).

## Who does what

| piece | what it is | address (Base) | we run it? |
|---|---|---|---|
| the wallet | InstantWallet v3.1 behind an ERC-1967 proxy, one per passkey | `Factory.getAddress(qx, qy, kind, credentialIdHash)` | ours |
| EntryPoint v0.8 | the standard 4337 contract; checks the signature, runs the calls, settles gas | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | no (ERC-4337 singleton) |
| Circle Paymaster | pays the ETH gas, charges the wallet USDC (gas + 35k gas overhead, no markup as of 10-04) | `0x0578cFB241215b77442a541325d6A4E6dFE700Ec` | no (Circle; permissionless, no key) |
| bundler | any server that calls `EntryPoint.handleOps`; reimbursed by the EntryPoint | Pimlico public `https://public.pimlico.io/v2/8453/rpc` | optional (see "If Pimlico goes away") |
| `/api/bundler/<chainId>` | our Next route the browser talks to: a passthrough, or a bundler itself | — | ours |

Nobody in that table can move the wallet's money: the EntryPoint only calls the wallet, and the wallet only runs
calls a key signed. A bundler can refuse or delay an op (then it expires), not change it.

## One send, step by step (`web/lib/wallet.ts` → `sendCalls`)

1. **Read state:** is the wallet deployed; its 4337 nonce for this key (`EntryPoint.getNonce(wallet, signerId)`);
   the wallet's USDC allowance to the paymaster; USDC's permit nonce + domain; gas prices from the bundler.
2. **Estimate:** build the op with a *throwaway* WebAuthn signature (well-formed, fails only at the final P-256
   check, so the cost is the same) and ask the bundler to estimate. Undeployed or no allowance yet: estimate as if
   the allowance were there (a state override), then add room for the permit. Limits get 10–30 % headroom.
3. **Fee reserve:** the paymaster pulls the worst-case fee in USDC *before* running the calls and refunds the rest
   after. The app checks the wallet keeps that much USDC after the send; "Everything" sends the USDC minus it.
4. **One Face ID:** the passkey signs one digest (below). 
5. **Submit + wait:** `eth_sendUserOperation`, then poll `eth_getUserOperationReceipt` (≤ 2 min).

What a user sees: ~1.2¢ for the very first send (it also deploys the wallet and approves the paymaster), ~0.4¢
after (measured on Base 10-04, ETH $2,700).

## The first send: deploy + permit + send, still one Face ID

A brand-new wallet has no code and no USDC allowance. Its first op carries:
- `initCode` = Factory + `createWallet(...)`: the EntryPoint deploys the wallet before checking the signature;
- a **USDC permit** (EIP-2612) to the paymaster inside `paymasterData`, which USDC verifies by asking the wallet
  (ERC-1271 `isValidSignature`).

The permit and the op would normally need two signatures. Instead the passkey signs one **pair** digest:
`hashPair(opDigest, hashMessage(permitDigest))`. The op's signature and the permit's signature both carry that one
passkey signature plus the *other* half of the pair, so each can be checked on its own. To avoid a loop (the
permit signature lives inside the op), the op digest covers `paymasterAndData` only up to byte `cut`, i.e. up to
the permit signature; `cut` itself is signed.

After every op the wallet tops its paymaster allowance back up to **1 USDC** when it drops under 0.50
(`GAS_ALLOWANCE`), so later sends need no permit, and spender keys (which can't sign permits) can still pay gas.
If gas ever spikes so the fee reserve tops 1 USDC, the app adds a permit for twice the reserve.

## Formats (the contract is the spec: `InstantWallet.sol`, `hashUserOp`, `hashPair`)

- **Nonce:** `uint192(signerId) << 64 | sequence`. The key *is* the nonce lane, so each key has its own
  sequence and execution knows who signed.
- **callData:** `executeUserOp.selector ‖ abi.encode(Call[])` (`Call = (target, value, data)`).
- **signature:** `validUntil (6 bytes) ‖ cut (2) ‖ pair (32) ‖ keySig`. `pair = 0` → the key signed
  `hashUserOp(op, cut, validUntil)`; else it signed `hashPair(that, pair)`.
- **paymasterAndData (Circle):** `paymaster (20) ‖ verificationGas (16) ‖ postOpGas (16) ‖ 0x00` and, with a
  permit, `‖ USDC (20) ‖ amount (32) ‖ permitSig` where `permitSig = signerId ‖ PAIR_TYPEHASH ‖ opDigest ‖ keySig`.
- **Expiry:** `validUntil` = signing time + 3 min. The EntryPoint rejects the op after that; nobody gets paid.
- **Domain:** EIP-712 `InstantWallet`, version `"3"`, chain id, the wallet address (unchanged from v3.0).

## Rules the contract keeps

- **Owners** (the passkey, until a wedgie is paired): any calls.
- **Spenders:** only plain ETH sends and ERC-20 `transfer`s, each counted against their 24 h limit; anything else
  reverts (the fee is still paid).
- **Validation** (`validateUserOp`) reads only the wallet's own storage and never the clock (ERC-7562, the rules
  bundlers enforce); time limits go back to the EntryPoint as `validUntil`. Anything time-based (delays, freezes)
  belongs in `executeUserOp` or in `validUntil`/`validAfter`.
- **Every path that moves money** — `metaTransfer`, `metaExecute`, `executeUserOp` — must apply the same role,
  limit, and (from v3.2) delay checks. A rule added to one and not the others is a bypass.
- The old `metaExecute` / `metaTransfer` path still works (anyone can submit it, paying ETH gas).

## Site details

- Sending is **Base only** (`SENDABLE` in `web/lib/chains.ts`) until the contracts are deployed on Ethereum
  (~$20 of L1 gas). Ethereum assets show and can be received.
- **Everything** = every Base asset in one op; USDC goes last as "balance minus the fee reserve", so a few cents of
  refunded reserve stay behind.
- The stored account's address is recomputed from the key on load (the factory changed 3.0 → 3.1).
- Token logos/prices: Alchemy, then DexScreener for the long tail (`web/app/api/portfolio`).

## If Pimlico goes away

Set `BUNDLER_URL_8453` on Vercel to another bundler (Alchemy, Coinbase CDP, Candide — any v0.8 bundler), or to
`self` plus `BUNDLER_PRIVATE_KEY` (an EOA with a little ETH): then `/api/bundler` calls `handleOps` itself and the
EntryPoint refunds it from the paymaster. Circle's paymaster needs no account, so nothing else changes.

## Tests

- `packages/foundry/test/AccountAbstraction.fork.t.sol` — real EntryPoint + Circle Paymaster + USDC on a Base fork:
  first send (deploy + permit + send), later sends, spender limits, expiry, tampering, only-EntryPoint.
  `forge test --mc AccountAbstraction` (no `--network optimism`: forge crashes with it on a fork).
- `web/tools/e2e.mjs` — the website with a virtual passkey on a Base fork, our route bundling (`web/README.md`).
- `web/tools/aa-live.mjs` — one real send on Base through Pimlico with a raw P-256 test key.

## Why not something else (research, 10-04)

A "tip whoever submits it" meta-tx works on chain (`RelayTip` spike) but nobody would find it: Base has no public
mempool and no searchers watch for signed payloads. Gelato's fee-in-token relay and the Porto relay are shut down.
ERC-4337 is the one permissionless network for "someone else submits, I pay in a token".
