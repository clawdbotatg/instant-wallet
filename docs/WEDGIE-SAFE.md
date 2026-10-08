# A wedgie as a Safe owner: what works (tested on Base, 2026-10-05)

From the wedgie-dev session. This answers SAFE.md "Still unverified" #3: **a wedgie signs the passkey envelope
and Safe's deployed passkey signer accepts it.** Only threshold 1 was tested (issue #8808 is about ≥ 2).

## The test Safe

- Safe `0xD977a783Dc079932Fe100E992C0c995b1967a953` on Base, Safe 1.4.1 (SafeL2), any 1 of 3 owners:
  the wedgie's signer `0xCC5B32A921f42d72A5Fd528f154416D458eF8342`, atg.eth, punk.austingriffith.eth.
- Transactions the wedgie signed alone, all on chain:
  - add an owner, remove an owner (`0xee5f079f…355a`), 0 USDC send (`0x1945bdae…4428`),
    a 2-action MultiSend batch (`0x85b65908…930d`).
  - nonce 5 (0 ETH to atg.eth) was proposed from a web page and is still in Safe's queue, signed, not executed.

## How it fits together

1. **The key.** The wedgie app `clawdbotatg/wedgie-safe` (on the wedgie.dev shelf) has the Trust M make a
   P-256 key in slot KEY2 (A on its screen). It never leaves the chip. Public key saved in `/saves/safe/key`.
2. **The owner.** Safe's passkey signer, safe-modules passkey v0.2.1:
   `SafeWebAuthnSignerFactory.createSigner(x, y, verifiers)` at `0x1d31F259eE307358a26dFb23EB365939E8641195`,
   `verifiers = 0x100 << 160` (the chain's P-256 precompile, no fallback). Deploy it before its first signature:
   the Safe (and Safe's API) call it to check one.
   The signer's address can be worked out with no RPC (CREATE2 with the proxy's creation code, 437 bytes taken
   from the factory's bytecode): `signerAddress()` in wedgie-dev `src/safe/eth.ts`.
3. **Signing.** The host sends the wedgie the Safe tx **fields**, not a hash. The wedgie computes the EIP-712
   safeTxHash itself (pure-Python keccak), shows the tx, and on A signs the WebAuthn message the signer rebuilds:
   `sha256(authenticatorData ‖ sha256(clientDataJSON))`, challenge = safeTxHash (base64url).
   - `authenticatorData` = `sha256("wedgie.dev") ‖ 0x05 ‖ 00000000` (flags 0x05 = user present + verified;
     the signer requires 0x04).
   - `clientDataFields` = `"origin":"https://wedgie.dev"`.
   - High s is fine: the signer uses `verifySignatureAllowMalleability`.
4. **The Safe signature** is a contract signature (v = 0): `r` = signer address, `s` = 65 (offset), `v` = 0, then
   `len ‖ abi.encode(bytes authenticatorData, string clientDataFields, uint256 r, uint256 s)`.
   `safeSignature()` in wedgie-dev `src/safe/eth.ts`.

## Wedgie USB protocol (app `safe`, one JSON line each way)

```
{"id":1,"type":"safe_sign","tx":{"chainId":8453,"safe":"0x..","to":"0x..","value":"0","data":"0x","operation":0,
 "safeTxGas":0,"baseGas":0,"gasPrice":0,"gasToken":"0x0..","refundReceiver":"0x0..","nonce":5}}
-> {"id":1,"type":"safe_sig","safeTxHash":"0x..","x","y","r","s","authenticatorData":"0x..","clientDataFields":"..."}
-> {"id":1,"type":"refused"}            Y, or no answer in 2 minutes
hello -> also "safe": {"x","y"} (null before the key is made)
```

A line is at most 6 KB (send only these fields). Bigger (a LI.FI bridge swap is ~3.5 KB of calldata, ~9 KB as a
batch line): wedgie-safe b4e86f8+ says `"safe_chunk": 4000` in hello and takes the data ahead in pieces,
`{"type":"safe_data","at":<bytes so far>,"hex":"..."}` → `{"type":"safe_data","have":n}`, then `safe_sign` with
`"data":"@"` (`lib/safe/wedgie.ts`). An older app gets "Update it at wedgie.dev".

Since b4e86f8 the wedgie also reads Instant Wallet's own transactions in plain words: the 7-day recovery module
(add/drop guardian, cancel), the daily budget (Zodiac Roles: keys, what it may use, "up to 100 USDC a day"),
modules on/off, exact approvals and their reset, Uniswap swaps (pay, at least back, "to this Safe" or red) and
LI.FI swaps ("pays this Safe" when the calldata names it, else red). Check the app against the real wedgie code:
`WEDGIE_SAFE=<checkout> npx tsx web/tools/wedgie-app-check.mts` (MicroPython, `tools/wedgie/serve.py`). The browser talks to it over Web Serial; wedgie-dev
`src/serial/` has the port handling (a wedgie's port drops and comes back once after plug-in).

What the wedgie shows: chain, nonce, Safe, and in plain words: ETH sends, known-token transfers (USDC on
Base/Ethereum), add/remove/swap owner, change threshold. A DELEGATECALL to Safe's MultiSend (1.3.0 or 1.4.1) is a
batch: one page per action, "sign all" on the last. Any other DELEGATECALL, or a call it can't read, is red.
A big tx (1 KB of data) took ~10 s from send to signature, press included.

## Next for the wedgie: every line in plain words (2026-10-08)

Rule: **the wedgie never shows text from the computer.** It decodes the calldata itself; anything it can't decode
exactly is red. A hacked computer can send any label it likes, so labels prove nothing.

What a daily-limit change shows today (wedgie-safe 6b81635, `web/tools/wedgie-app-check.mts` style run):

```
1 of 5  budget: up to 3 USDC a day          ok
2 of 5  budget: up to 0.04 ETH a day        ok
3 of 5  budget: rules for USDC              says nothing about what the rule is
4 of 5  budget: up to 1000000 units a day   unknown key
5 of 5  send 0.02 USDC to 0x4cfab3…8a2f     raw address
```

Wanted:

1. **The fee cap.** `setAllowance(KEY_FEE_USDC, …)`, KEY_FEE_USDC = keccak256("instant-wallet.burner.fee-usdc"):
   "fee cap: up to 1 USDC a day" (USDC decimals, like KEY_USDC).
2. **The USDC rule.** `scopeFunction(ROLE_BURNER, USDC, transfer, conditions, 0)`: match the exact condition tree
   from `feeAllowanceCalls` (`web/lib/safe/core.ts`):
   `Or( Matches(to == R, amount ≤ KEY_FEE_USDC), Matches(to any, amount ≤ KEY_USDC) )` →
   "USDC: fees to <R's name> from the fee cap; anyone else from the daily limit". The original tree from
   `budgetCalls` (`Matches(to any, amount ≤ KEY_USDC)`) → "USDC: anyone, from the daily limit". Any other tree: red.
3. **The relay's name.** 0x4cFaB32186e65E2A39EC0e882e11380cbf2f8A2f = "the Instant relay", built into the wedgie
   (never from the host). Used in 2 and in fee transfers: "fee 0.02 USDC to the Instant relay".
4. **This Safe's Roles.** Only call it "budget" when the target is this Safe's own Roles: the zodiac
   ModuleProxyFactory CREATE2 address (`rolesAddress()` in core.ts). Another address: red.
5. **A picture of the transaction** (for a send the phone started and the computer finishes): the wedgie draws a
   blockie of the safeTxHash (the same algorithm as the app's `Blockie`, `blo`), and the phone's "Now the wedgie" screen and the
   computer's card draw it too. Same picture on the phone and the wedgie = the computer didn't swap the
   transaction. Not a replacement for 1–4.

## Safe's Transaction Service

`https://api.safe.global/tx-service/base/api/v1/...` works from a browser: no API key, CORS open.
It accepted from the passkey signer:
- a **proposal** (`POST /safes/{safe}/multisig-transactions/`, `sender` = the signer address), and
- **confirmations** (`POST /multisig-transactions/{hash}/confirmations/`), stored as `CONTRACT_SIGNATURE`.
Addresses must be checksummed or it answers 422.

## Relay finding

Safe's own gas refund can't charge small amounts in USDC: `gasPrice` is whole token units per gas, so the
minimum is 1 millionth of a USDC per gas, about $0.10 a transaction on Base. Instead, put the fee in the batch:
the last MultiSend action is a USDC `transfer` to the relayer. The relayer checks it's there, simulates
`execTransaction`, and sends. (Written, not deployed: Austin moved relaying here.)

## Code to take

wedgie-dev (github.com/clawdbotatg/wedgie-dev, commit b730fa5):
- `src/safe/eth.ts`: keccak, safeTxHash, signer address, the Safe signature. No dependencies.
- `src/pages/safe.ts`: the page now at wedgie.dev/safe — reads the wedgie's key, shows its signer address,
  deploys it with a browser wallet, loads the Safe and its queue, signs with the wedgie, proposes, executes
  (threshold 1). It moves here; wedgie.dev drops it later.

## Later

Safe's core contract has native P-256 owners on `main` (PR #1061, signature `v = 2`, owner =
`address(keccak256(qx, qy))`, verifies the raw safeTxHash, no WebAuthn wrapping, no signer contract).
Not in a release yet (latest 1.5.0 doesn't have it).
