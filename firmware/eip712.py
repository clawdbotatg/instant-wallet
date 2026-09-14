# Rebuild every Instant Wallet EIP-712 digest on the device (docs/PROTOCOL.md section 3).
# If the digest the device computes from the RAW request fields does not match what the app
# sent, the app is lying about what it wants signed, and the device refuses.
#
# Struct encoding: every static field is one 32-byte big-endian word (uint8/uint64/uint128 too),
# an address is 12 zero bytes + 20, bytes32 is itself. No ABI encoder needed.
from keccak import keccak256

DOMAIN_TYPEHASH = keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
NAME_HASH = keccak256(b"InstantWallet")
VERSION_HASH = keccak256(b"1")

TRANSFER_TYPEHASH = keccak256(b"Transfer(address token,address to,uint256 amount,uint256 fee,uint256 nonce,uint256 deadline)")
EXECUTE_TYPEHASH = keccak256(b"Execute(bytes32 callsHash,uint256 nonce,uint256 deadline)")
ADD_SIGNER_TYPEHASH = keccak256(b"AddSigner(bytes32 qx,bytes32 qy,uint8 kind,uint8 role,uint128 dailyLimit,bytes32 credentialIdHash,uint256 nonce,uint256 deadline)")
UPDATE_SIGNER_TYPEHASH = keccak256(b"UpdateSigner(address signerId,uint8 role,uint128 dailyLimit,uint256 nonce,uint256 deadline)")
REMOVE_SIGNER_TYPEHASH = keccak256(b"RemoveSigner(address signerId,uint256 nonce,uint256 deadline)")
SET_RECOVERY_TYPEHASH = keccak256(b"SetRecovery(address recoveryAddress,uint64 recoveryDelay,uint256 nonce,uint256 deadline)")
CANCEL_RECOVERY_TYPEHASH = keccak256(b"CancelRecovery(uint256 nonce,uint256 deadline)")

_domain_cache = {}


def _strip(h):
    return h[2:] if h[:2] in ("0x", "0X") else h


def _addr(a):
    """'0x' + 40 hex -> 32-byte word (12 zero bytes + 20)."""
    b = bytes.fromhex(_strip(a))
    if len(b) != 20:
        raise ValueError("bad address")
    return bytes(12) + b


def _u256(n):
    n = int(n)
    if n < 0 or n >> 256:
        raise ValueError("out of range")
    return n.to_bytes(32, "big")


def _b32(h):
    """'0x' + 64 hex (or a 32-byte bytes) -> 32 bytes."""
    if isinstance(h, (bytes, bytearray)):
        b = bytes(h)
    else:
        b = bytes.fromhex(_strip(h))
    if len(b) != 32:
        raise ValueError("bad bytes32")
    return b


def hexlify(b):
    return "0x" + "".join("%02x" % c for c in b)


def domain_separator(chain_id, wallet):
    key = (int(chain_id), wallet.lower())
    if key not in _domain_cache:
        _domain_cache[key] = keccak256(DOMAIN_TYPEHASH + NAME_HASH + VERSION_HASH + _u256(chain_id) + _addr(wallet))
    return _domain_cache[key]


def _typed(chain_id, wallet, struct):
    return keccak256(b"\x19\x01" + domain_separator(chain_id, wallet) + struct)


def transfer_digest(chain_id, wallet, token, to, amount, fee, nonce, deadline):
    struct = keccak256(TRANSFER_TYPEHASH + _addr(token) + _addr(to) + _u256(amount) + _u256(fee) + _u256(nonce) + _u256(deadline))
    return _typed(chain_id, wallet, struct)


def call_hash(target, value, data):
    """callHash_i = keccak256(abi.encode(target, value, keccak256(data)))."""
    return keccak256(_addr(target) + _u256(value) + keccak256(bytes(data)))


def calls_hash(calls):
    """calls: list of (target, value, data_bytes). keccak256 of the concatenated call hashes."""
    acc = b""
    for target, value, data in calls:
        acc += call_hash(target, value, data)
    return keccak256(acc)


def execute_digest(chain_id, wallet, calls, nonce, deadline):
    struct = keccak256(EXECUTE_TYPEHASH + calls_hash(calls) + _u256(nonce) + _u256(deadline))
    return _typed(chain_id, wallet, struct)


def add_signer_digest(chain_id, wallet, qx, qy, kind, role, daily_limit, credential_id_hash, nonce, deadline):
    struct = keccak256(
        ADD_SIGNER_TYPEHASH + _b32(qx) + _b32(qy) + _u256(kind) + _u256(role) + _u256(daily_limit)
        + _b32(credential_id_hash) + _u256(nonce) + _u256(deadline)
    )
    return _typed(chain_id, wallet, struct)


def update_signer_digest(chain_id, wallet, signer_id, role, daily_limit, nonce, deadline):
    struct = keccak256(UPDATE_SIGNER_TYPEHASH + _addr(signer_id) + _u256(role) + _u256(daily_limit) + _u256(nonce) + _u256(deadline))
    return _typed(chain_id, wallet, struct)


def remove_signer_digest(chain_id, wallet, signer_id, nonce, deadline):
    struct = keccak256(REMOVE_SIGNER_TYPEHASH + _addr(signer_id) + _u256(nonce) + _u256(deadline))
    return _typed(chain_id, wallet, struct)


def set_recovery_digest(chain_id, wallet, recovery_address, recovery_delay, nonce, deadline):
    struct = keccak256(SET_RECOVERY_TYPEHASH + _addr(recovery_address) + _u256(recovery_delay) + _u256(nonce) + _u256(deadline))
    return _typed(chain_id, wallet, struct)


def cancel_recovery_digest(chain_id, wallet, nonce, deadline):
    struct = keccak256(CANCEL_RECOVERY_TYPEHASH + _u256(nonce) + _u256(deadline))
    return _typed(chain_id, wallet, struct)


def signer_id(qx, qy):
    """address(uint160(uint256(keccak256(abi.encodePacked(qx, qy))))) as '0x' + 40 lowercase hex."""
    return "0x" + "".join("%02x" % c for c in keccak256(_b32(qx) + _b32(qy))[12:])
