# Instant Wallet protocol

The one document every piece reads: the contract, the web app (facilitator + device queue), the
firmware, and the tests. If the contract changes a digest, this file changes, and so do the app
and the firmware. Keep them in lock step.

## 1. One account, many P-256 keys

`InstantWallet` is an EIP-1167 clone (via `Factory`, CREATE2). It holds a list of **signers**.
Every signer is a P-256 public key `(qx, qy)` with:

| field | meaning |
|---|---|
| `kind` | `0` WebAuthn (a passkey: Face ID / Touch ID / Windows Hello) · `1` Raw (the ATECC608 chip in the device) |
| `role` | `0` Spender · `1` Owner |
| `dailyLimit` | for spenders: max token amount (base units, incl. fee) moved per rolling 24h window; owners ignore it |

`signerId = address(uint160(uint256(keccak256(abi.encodePacked(qx, qy)))))` — same derivation
as progressive-self-custody, so a passkey's id is stable across wallets.

**Who can do what**

| action | spender | owner |
|---|---|---|
| `metaTransfer` of the wallet's token, ≤ `dailyLimit` per 24h (amount + fee) | ✓ | ✓ (no limit) |
| `metaTransfer` of any other ERC-20 | | ✓ |
| `metaExecute` (arbitrary batch of calls) | | ✓ |
| add / update / remove signers, set recovery, cancel recovery | | ✓ |

A wallet must always keep at least one owner. Day 1 the first passkey is created as the owner.
Pairing the device is two consecutive owner-signed calls (two Face ID taps): `AddSigner(chip, owner, 0)`
then `UpdateSigner(passkey, spender, $500)`. The address never changes.

**Recovery.** `recoveryAddress` (default: the facilitator, acting as guardian; the user can set
their own EOA) can `startRecovery(qx, qy, kind)`. After `recoveryDelay` (default 1 day; owner-set,
minimum 1 hour) it can `finalizeRecovery()`, which **adds** that key as an owner. Any successful
owner-signed action cancels a pending recovery; a spender action does not. No admin, no
upgrade, no unsigned spending path. The relayer has no privilege.

## 2. Signatures

Every meta function ends with `(address signerId, uint256 deadline, bytes signature)`.

- `kind = 1` (Raw): `signature` is exactly 64 bytes, `r ‖ s`, low-s. Verified with
  `P256.verify(digest, r, s, qx, qy)` (RIP-7212 precompile on Base, Solidity fallback elsewhere).
- `kind = 0` (WebAuthn): `signature` is the flat ABI tuple
  `abi.encode(bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex, bytes authenticatorData, string clientDataJSON)`
  (what OpenZeppelin 5.7's `WebAuthn.tryDecodeAuth` reads; **not** `abi.encode(struct)`, which adds a leading offset). The
  WebAuthn **challenge is the 32 raw bytes of the digest** (`abi.encodePacked(digest)`), which the
  browser base64url-encodes into `clientDataJSON`. Verified with `WebAuthn.verify(..., requireUV = true)`.

Both signers sign the **same digest** for the same action. That is the whole trick.

## 3. Digests (EIP-712)

Domain: `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` with
`name = "InstantWallet"`, `version = "1"`, `verifyingContract = the wallet clone`.
`digest = keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)`.

```
Transfer(address token,address to,uint256 amount,uint256 fee,uint256 nonce,uint256 deadline)
Execute(bytes32 callsHash,uint256 nonce,uint256 deadline)
AddSigner(bytes32 qx,bytes32 qy,uint8 kind,uint8 role,uint128 dailyLimit,bytes32 credentialIdHash,uint256 nonce,uint256 deadline)
UpdateSigner(address signerId,uint8 role,uint128 dailyLimit,uint256 nonce,uint256 deadline)
RemoveSigner(address signerId,uint256 nonce,uint256 deadline)
SetRecovery(address recoveryAddress,uint64 recoveryDelay,uint256 nonce,uint256 deadline)
CancelRecovery(uint256 nonce,uint256 deadline)
```

- `nonce` is wallet-wide and increments on every successful meta call.
- `fee` is paid in `token` to `msg.sender` (whoever relays). It counts against a spender's limit.
- `callsHash = keccak256(concat(callHash_0, callHash_1, …))` where
  `callHash_i = keccak256(abi.encode(target_i, value_i, keccak256(data_i)))`. Defined this way so a
  240×240 device with a pure-Python keccak can rebuild it without an ABI encoder.
- The contract exposes `hashTransfer`, `hashExecute`, `hashAddSigner`, `hashUpdateSigner`,
  `hashRemoveSigner`, `hashSetRecovery`, `hashCancelRecovery` and `domainSeparator()` views. The
  app cross-checks its own digest against the contract before queueing anything; the device
  rebuilds the digest from the raw fields and refuses on mismatch.

## 4. Match code

Three tokens derived from the digest, shown on the phone/desktop **and** on the device screen,
so a swapped request is visible by eye:

```
d = digest bytes
code = WORDS[d[0]] + " " + WORDS[d[1]] + " " + str(d[2] % 100)      e.g. "amber fox 42"
```

`WORDS` is the 256-entry list in `docs/matchwords.json` (identical copy in `firmware/words.py`
and `packages/nextjs/utils/matchwords.ts`). Lowercase, ASCII, ≤ 6 letters, no two share a first
three letters.

## 4b. Pairing QR

The device shows a QR whose text is `iw1:<qx hex, no 0x>:<qy hex, no 0x>:<device name>`. The phone
scans it, shows the name and `signerIdOf(qx, qy)`, and the owner passkey signs `AddSigner`.

## 5. Device queue (HTTP, served by the app)

The device polls the app over WiFi, like picowallet. Names and formatted amounts are display
hints; the device trusts only the raw fields it hashes.

| route | who | what |
|---|---|---|
| `POST /api/device` | device, every 30 s | announce `{name, qx, qy, chipSerial, firmware}`; reply `{paired, wallet, signerId, chainId}` |
| `GET /api/device` | browser | last announce + online flag |
| `GET /api/state?wallet=0x…` | device, every 12 s | `{chain, wallet:{address, ensName, balance, balanceFormatted}, token:{address,symbol,decimals}, relayer:{address, balanceFormatted}, signers:[…], pendingRecovery}` |
| `GET /api/requests?status=pending&signerId=0x…` | device | pending requests for this signer, oldest first |
| `POST /api/requests` | browser | create a request; server recomputes and cross-checks the digest; reply `{request}` |
| `GET /api/requests/:id` | browser | poll status |
| `POST /api/requests/:id/signature` | device | `{r, s}`; server verifies with P-256, relays, sets `status` |
| `POST /api/requests/:id/reject` | device | red button |

Request shape (all kinds share the envelope):

```jsonc
{
  "id": "…", "kind": "transfer" | "execute" | "addSigner" | "updateSigner" | "removeSigner" | "setRecovery" | "cancelRecovery",
  "chainId": 8453, "wallet": "0x…", "signerId": "0x…",
  "nonce": "12", "deadline": 1757800000, "digest": "0x…", "matchCode": "amber fox 42",
  "status": "pending" | "signed" | "relaying" | "confirmed" | "failed" | "rejected" | "expired",
  "txHash": "0x…", "error": "…", "createdAt": 0, "updatedAt": 0,
  // transfer
  "token": "0x…", "tokenSymbol": "USDC", "tokenDecimals": 6, "to": "0x…", "toName": "atg.eth", "amount": "2000000000", "amountFormatted": "2000.00", "fee": "20000",
  // execute
  "calls": [{"target": "0x…", "value": "0", "data": "0x…"}], "callsHash": "0x…",
  // addSigner
  "qx": "0x…", "qy": "0x…", "signerKind": 0, "role": 0, "dailyLimit": "500000000", "credentialIdHash": "0x…", "label": "iPhone · Face ID",
  // updateSigner / removeSigner
  "targetSignerId": "0x…",
  // setRecovery
  "recoveryAddress": "0x…", "recoveryDelay": 86400
}
```

Reply shapes (pinned; the firmware depends on them):

- `POST /api/device` → `{paired, wallet, signerId, chainId}` — `paired` means `signerIdOf(qx, qy)` is a
  registered signer on the wallet the app associates with this device.
- `GET /api/requests?…` → `{requests: [...]}`, oldest first.
- `POST /api/requests/:id/signature` `{r, s}` → `{status, txHash?, error?}`.
- `POST /api/requests/:id/reject` `{by, error?}` — the device sends `error` when it refused a request
  itself (digest / chain / wallet / token / callsHash / matchCode mismatch); the app stores it.
- `GET /api/state` → `pendingRecovery` is `null` or `{qx, qy, kind, executeAfter}`; `chain` is `{id, name}`.

The device never signs `request.digest`: it rebuilds the digest from the raw fields and signs its own.
It also checks `signerId`, `callsHash` (execute) and `matchCode` against what it computes.

Status lifecycle: `pending → signed → relaying → confirmed | failed`, or `pending → rejected | expired`.
Deadline: 10 minutes from creation. Requests for a signer are signed oldest-first; the server
assigns `nonce = onchainNonce + inFlight.length` so several can queue.

## 6. Passkey path (no device)

The browser signs with `navigator.credentials.get({challenge: digestBytes})`, builds the
`WebAuthnAuth` struct, and posts `{wallet, chainId, function, args, signerId, deadline, signature}`
to `POST /api/facilitate`. The facilitator simulates, submits, pays gas, and returns `{txHash}`.
The fee inside the digest pays it back in the wallet's token.

Wallet creation: `POST /api/deploy-wallet {qx, qy, kind, credentialIdHash}` → `Factory.createWallet`.
The address is `Factory.getWalletAddress(qx, qy, salt = 0)` and is shown before deployment.

## 7. AI is optional (BYOAI)

Nothing in sections 1–6 needs a model. The chat ("talk to your wallet") turns text into a
**proposed** request card that still goes through the passkey or the device. Providers, chosen in
Settings and stored in the browser:

- `off` — no AI, plain forms only (default until the user turns it on)
- `anthropic` — the app's server key (Claude), if the operator set one
- `openai-compatible` — bring your own: base URL + key + model (OpenAI, Venice, Ollama, LM Studio, …). The key is sent per request in a header and never stored server-side.

The model never signs. It may read portfolio/activity (Zerion) and simulate (Alchemy); it may
only *propose* a transfer / execute; the human confirms on a key.
