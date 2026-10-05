// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { P256 } from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

interface ITokenPaymaster {
    function token() external view returns (IERC20);
}

/**
 * @title InstantWallet (v3)
 * @notice One account, many P-256 keys, tiered by trust. Holds anything: ETH, any ERC-20, NFTs.
 *
 *  Every signer is a P-256 public key. A passkey (Face ID / Touch ID) signs a WebAuthn assertion whose
 *  challenge is the digest; a wedgie (wedgie.dev, Trust M chip) signs the digest raw. Both verify against the
 *  same EIP-712 digest, so the two kinds of key differ only in role.
 *
 *  Owners may do anything: move any asset, execute arbitrary batches (EIP-5792 `wallet_sendCalls` maps to one
 *  `metaExecute`), manage keys and limits, upgrade. Spenders may move an asset only up to the rolling 24h limit
 *  an owner set for them on it (`asset = address(0)` is ETH).
 *
 *  Social recovery: any one guardian (default: dao.buidlguidl.eth, a 4-of-8 Safe) can propose replacing a key
 *  (lost phone or lost wedgie) or adding an owner. An owner can cancel it, and any owner action does; if nobody
 *  does within the delay (default 7 days), anyone can finalize it.
 *
 *  Admin (keys, limits, recovery, upgrade) is self-calls only: an owner batches them in one `metaExecute`
 *  (pairing a wedgie = add it as owner + demote the passkey + set its limits, one Face ID).
 *
 *  Each signer has its own nonce, so a passkey send and a pending wedgie request never collide. Nonces are
 *  never reset, so a removed and re-added key can't replay old signatures.
 *
 *  Upgradeable (UUPS behind an ERC-1967 minimal proxy) by owner signature only. Storage is append-only:
 *  a later version adds variables after `_recovery`, never between.
 *
 *  Digests and signature encodings: docs/PROTOCOL.md.
 * @author BuidlGuidl
 */
contract InstantWallet is Initializable, UUPSUpgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice ERC-4337 (EntryPoint v0.8) user operation.
    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }

    struct Signer {
        bytes32 qx;
        bytes32 qy;
        uint8 kind; // KIND_WEBAUTHN | KIND_RAW
        uint8 role; // ROLE_SPENDER | ROLE_OWNER
        uint64 addedAt;
    }

    /// @notice A spender's rolling allowance on one asset.
    /// @notice A guardian's proposal: add (qx, qy) and, if `replaces` is set, remove that key. The new key takes
    ///         the replaced key's role, or owner if it replaces nothing.
    struct Recovery {
        address replaces;
        bytes32 qx;
        bytes32 qy;
        uint8 kind;
        bytes32 credentialIdHash;
        address proposer;
        uint64 executeAfter; // 0 = none pending
    }

    /// @notice An owner's action waiting out `coldDelay`. `executeAfter == 0`: none.
    struct Queued {
        uint64 executeAfter;
        address proposer;
        bytes32 callsHash;
    }

    struct Allowance {
        uint128 limit; // base units per WINDOW
        uint128 spent;
        uint64 windowStart;
    }

    uint8 public constant KIND_WEBAUTHN = 0;
    uint8 public constant KIND_RAW = 1;
    uint8 public constant ROLE_SPENDER = 0;
    uint8 public constant ROLE_OWNER = 1;
    /// @notice The asset address that means native ETH.
    address public constant ETH = address(0);
    uint256 public constant WINDOW = 1 days;
    /// @notice Shortest recovery / cold delay (5 minutes so test wallets can run every scenario quickly).
    uint64 public constant MIN_RECOVERY_DELAY = 5 minutes;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("InstantWallet");
    bytes32 private constant VERSION_HASH = keccak256("3");

    bytes32 public constant TRANSFER_TYPEHASH =
        keccak256("Transfer(address asset,address to,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 public constant EXECUTE_TYPEHASH = keccak256("Execute(bytes32 callsHash,uint256 nonce,uint256 deadline)");
    /// @notice ERC-1271: what a key signs so one key owning two wallets can't have a message replayed across them.
    bytes32 public constant MESSAGE_TYPEHASH = keccak256("InstantWalletMessage(bytes32 hash)");

    /// @notice ERC-4337: what a key signs for a user operation (see `hashUserOp`).
    bytes32 public constant USEROP_TYPEHASH = keccak256("UserOp(bytes32 opHash,uint48 validUntil)");
    /// @notice One key signature over two digests (a user op + an ERC-1271 message), so a send that also needs a
    ///         token permit (the first gas payment in USDC) is still one Face ID.
    bytes32 public constant PAIR_TYPEHASH = keccak256("Pair(bytes32 a,bytes32 b)");

    /// @notice ERC-4337 EntryPoint v0.8, same address on every chain.
    address public constant ENTRY_POINT = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    /// @notice Circle Paymaster (EntryPoint v0.8): gas paid in USDC. After each op it pays for, the wallet keeps
    ///         its allowance at `GAS_ALLOWANCE` so spenders can pay gas too (they can't sign permits).
    address public constant CIRCLE_PAYMASTER = 0x0578cFB241215b77442a541325d6A4E6dFE700Ec;
    uint256 public constant GAS_ALLOWANCE = 1e6; // 1 USDC

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant SIG_VALIDATION_FAILED = 1;

    // ---------------------------------------------------------------- state (append-only)

    mapping(address => uint256) public nonces; // signerId => next nonce

    mapping(address => Signer) private _signers;
    address[] private _signerIds;
    mapping(address => uint256) private _signerIndex; // index + 1, 0 = absent
    mapping(bytes32 => address) public credentialIdToSigner;
    uint256 public ownerCount;

    mapping(address => mapping(address => Allowance)) private _allowances; // signerId => asset => allowance
    mapping(address => address[]) private _limitedAssets; // signerId => assets with a limit
    mapping(address => mapping(address => uint256)) private _limitedIndex; // signerId => asset => index + 1

    address[] private _guardians;
    mapping(address => bool) public isGuardian;
    uint64 public recoveryDelay;
    Recovery private _recovery;

    // v3.2 — cold storage: an owner acting alone waits `coldDelay`; protecting is instant (docs/COLD-STORAGE.md)
    /// @notice How long an owner acting alone waits (0 = no wait: a passkey-only "Simple" wallet).
    uint64 public coldDelay;
    /// @notice While `block.timestamp < frozenUntil`, nothing leaves: no spends, no queued actions run.
    uint64 public frozenUntil;
    /// @notice true = a second key can NOT skip a queued action's wait (the "Vault" preset).
    bool public noTwoKeySkip;
    uint256 public queueCount;
    mapping(bytes32 => Queued) public queued;

    /// @dev Who signed the call being run (execution only), so self-calls know their author.
    address private transient _actor;

    // ---------------------------------------------------------------- events

    event SignerAdded(address indexed signerId, bytes32 qx, bytes32 qy, uint8 kind, uint8 role);
    event SignerUpdated(address indexed signerId, uint8 role);
    event LimitSet(address indexed signerId, address indexed asset, uint128 limit);
    event SignerRemoved(address indexed signerId);
    event Transferred(
        address indexed signerId, address indexed asset, address indexed to, uint256 amount, uint256 nonce
    );
    event Executed(address indexed signerId, bytes32 indexed callsHash, uint256 calls, uint256 nonce);
    event GuardiansSet(address[] guardians, uint64 recoveryDelay);
    event RecoveryStarted(
        address indexed proposer, address indexed replaces, address indexed newSignerId, uint64 executeAfter
    );
    event RecoveryCancelled(address indexed newSignerId);
    event RecoveryFinalized(address indexed replaces, address indexed newSignerId);
    event EtherReceived(address indexed sender, uint256 amount);
    event ActionQueued(bytes32 indexed id, address indexed proposer, uint64 executeAfter, bytes calls);
    event ActionCancelled(bytes32 indexed id, address indexed by);
    event ActionSkipped(bytes32 indexed id, address indexed by);
    event ActionExecuted(bytes32 indexed id);
    event Frozen(address indexed by, uint64 until);
    event Unfrozen();
    event ColdSettings(uint64 coldDelay, bool noTwoKeySkip);

    // ---------------------------------------------------------------- errors

    error Expired(uint256 deadline, uint256 nowTs);
    error UnknownSigner(address signerId);
    error BadSignature();
    error NotOwner(address signerId);
    error OverLimit(address signerId, address asset, uint256 wanted, uint256 remaining);
    error SignerExists(address signerId);
    error InvalidKey();
    error InvalidKind();
    error InvalidRole();
    error LastOwner();
    error ZeroAddress();
    error DelayTooShort();
    error OnlySelf();
    error OnlyGuardian();
    error TooManyGuardians();
    error RecoveryNotPending();
    error RecoveryNotReady(uint64 executeAfter, uint256 nowTs);
    error CallFailed(uint256 index);
    error EthTransferFailed();
    error OnlyEntryPoint();
    error WalletFrozen(uint64 until);
    error NotQueued(bytes32 id);
    error NotReady(uint64 executeAfter, uint256 nowTs);
    error WrongCalls();
    error SameKey();
    error SkipDisabled();

    modifier onlyEntryPoint() {
        if (msg.sender != ENTRY_POINT) revert OnlyEntryPoint();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize a fresh proxy with its first key as the owner and the factory's default guardians.
     * @param credentialIdHash keccak256 of the WebAuthn credential id (zero for a chip).
     */
    function initialize(
        bytes32 qx,
        bytes32 qy,
        uint8 kind,
        bytes32 credentialIdHash,
        address[] calldata guardians,
        uint64 _recoveryDelay
    ) external initializer {
        _addSigner(qx, qy, kind, ROLE_OWNER, credentialIdHash);
        _setGuardians(guardians, _recoveryDelay);
    }

    /// @notice Semver of this implementation; the app reads it to offer upgrades.
    function version() external pure virtual returns (string memory) {
        return "3.2.0";
    }

    // ---------------------------------------------------------------- views

    function signerIdOf(bytes32 qx, bytes32 qy) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(qx, qy)))));
    }

    function getSigner(address signerId) external view returns (Signer memory) {
        return _signers[signerId];
    }

    function isSigner(address signerId) public view returns (bool) {
        return _signerIndex[signerId] != 0;
    }

    function signerCount() external view returns (uint256) {
        return _signerIds.length;
    }

    function getSigners() external view returns (address[] memory ids, Signer[] memory list) {
        ids = _signerIds;
        list = new Signer[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            list[i] = _signers[ids[i]];
        }
    }

    /// @notice Every asset a signer has a limit on, with the live allowance. Empty for owners (unlimited).
    function getLimits(address signerId) external view returns (address[] memory assets, Allowance[] memory list) {
        assets = _limitedAssets[signerId];
        list = new Allowance[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            list[i] = _allowances[signerId][assets[i]];
        }
    }

    function getAllowance(address signerId, address asset) external view returns (Allowance memory) {
        return _allowances[signerId][asset];
    }

    /// @notice How much of `asset` a signer may still move in the current window (max for owners, 0 if no limit).
    function remainingAllowance(address signerId, address asset) public view returns (uint256) {
        if (_signerIndex[signerId] == 0) return 0;
        if (_signers[signerId].role == ROLE_OWNER) return type(uint256).max;
        Allowance storage a = _allowances[signerId][asset];
        if (block.timestamp >= uint256(a.windowStart) + WINDOW) return a.limit;
        return a.limit > a.spent ? a.limit - a.spent : 0;
    }

    function getGuardians() external view returns (address[] memory) {
        return _guardians;
    }

    function pendingRecovery() external view returns (Recovery memory) {
        return _recovery;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _typed(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function hashTransfer(address asset, address to, uint256 amount, uint256 _nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _typed(keccak256(abi.encode(TRANSFER_TYPEHASH, asset, to, amount, _nonce, deadline)));
    }

    /// @notice callsHash = keccak256(concat(keccak256(abi.encode(target, value, keccak256(data))) ...)).
    function hashCalls(Call[] memory calls) public pure returns (bytes32) {
        bytes memory acc;
        for (uint256 i; i < calls.length; ++i) {
            acc = bytes.concat(acc, keccak256(abi.encode(calls[i].target, calls[i].value, keccak256(calls[i].data))));
        }
        return keccak256(acc);
    }

    function hashExecute(bytes32 callsHash, uint256 _nonce, uint256 deadline) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(EXECUTE_TYPEHASH, callsHash, _nonce, deadline)));
    }

    /// @notice The digest a key signs for an ERC-1271 check of `hash`.
    function hashMessage(bytes32 hash) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(MESSAGE_TYPEHASH, hash)));
    }

    /**
     * @notice What a key signs for a user op. Covers every field except the signature and, past byte `cut`, the
     *         paymasterAndData (so a permit signature riding in it can come from the same key signature).
     *         `cut = paymasterAndData.length` signs all of it. The EntryPoint is fixed (`ENTRY_POINT`), and
     *         chain + wallet are in the domain.
     */
    function hashUserOp(PackedUserOperation calldata op, uint256 cut, uint48 validUntil) public view returns (bytes32) {
        bytes32 opHash = keccak256(
            abi.encode(
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                keccak256(op.paymasterAndData[:cut]),
                cut
            )
        );
        return _typed(keccak256(abi.encode(USEROP_TYPEHASH, opHash, validUntil)));
    }

    function hashPair(bytes32 a, bytes32 b) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(PAIR_TYPEHASH, a, b)));
    }

    /// @notice Check one key's signature over a digest (no state change). Any role.
    function verify(address signerId, bytes32 digest, bytes calldata signature) external view returns (bool) {
        if (_signerIndex[signerId] == 0) return false;
        return _verify(_signers[signerId], digest, signature);
    }

    /**
     * @notice ERC-1271. `signature = signerId (20 bytes) ‖ keySignature`, where the key signed `hashMessage(hash)`,
     *         or `signerId ‖ PAIR_TYPEHASH ‖ a ‖ keySignature`, where it signed `hashPair(a, hashMessage(hash))`.
     *         Owners only: a spender can't sign permits or orders that move funds. Off while a `coldDelay` is set:
     *         an owner's signature could otherwise authorize a permit and move funds without waiting.
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length < 20 || coldDelay != 0) return 0xffffffff;
        address signerId = address(bytes20(signature[0:20]));
        if (_signerIndex[signerId] == 0) return 0xffffffff;
        Signer storage s = _signers[signerId];
        if (s.role != ROLE_OWNER) return 0xffffffff;
        bytes32 digest = hashMessage(hash);
        bytes calldata keySig = signature[20:];
        if (signature.length >= 84 && bytes32(signature[20:52]) == PAIR_TYPEHASH) {
            digest = hashPair(bytes32(signature[52:84]), digest);
            keySig = signature[84:];
        }
        return _verify(s, digest, keySig) ? ERC1271_MAGIC : bytes4(0xffffffff);
    }

    // ---------------------------------------------------------------- ERC-4337 (EntryPoint v0.8)

    /**
     * @notice The signer is the nonce key: `nonce = uint192(signerId) << 64 | seq`, so each key keeps its own
     *         sequence and execution knows who signed. `signature = validUntil (6) ‖ cut (2) ‖ pair (32) ‖ keySig`:
     *         the key signed `hashUserOp(op, cut, validUntil)`, or, when `pair` is nonzero,
     *         `hashPair(hashUserOp(…), pair)` (`pair` = the hashMessage of a permit riding in the paymaster data).
     *         `callData` must be `executeUserOp` (the EntryPoint then hands the whole op to it).
     */
    function validateUserOp(PackedUserOperation calldata op, bytes32, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        validationData = _validateUserOp(op);
        if (missingAccountFunds != 0) {
            (bool ok,) = payable(msg.sender).call{ value: missingAccountFunds }("");
            (ok);
        }
    }

    /**
     * @notice Runs `callData[4:] = abi.encode(Call[])`. Owners: any calls (and recovery is cancelled, like any
     *         owner action). Spenders: only ETH sends and ERC-20 `transfer`s, each charged to their daily limit.
     */
    function executeUserOp(PackedUserOperation calldata op, bytes32) external onlyEntryPoint nonReentrant {
        address signerId = address(uint160(op.nonce >> 64));
        if (_signerIndex[signerId] == 0) revert UnknownSigner(signerId); // removed by an earlier op in the bundle
        Call[] memory calls = abi.decode(op.callData[4:], (Call[]));
        _dispatch(signerId, calls);
        if (op.paymasterAndData.length >= 20 && address(bytes20(op.paymasterAndData[0:20])) == CIRCLE_PAYMASTER) {
            IERC20 token = ITokenPaymaster(CIRCLE_PAYMASTER).token();
            if (token.allowance(address(this), CIRCLE_PAYMASTER) < GAS_ALLOWANCE / 2) {
                token.forceApprove(CIRCLE_PAYMASTER, GAS_ALLOWANCE);
            }
        }
        emit Executed(signerId, keccak256(op.callData), calls.length, op.nonce);
    }

    // ---------------------------------------------------------------- meta (anyone may submit; the key authorizes)

    /**
     * @notice Move `amount` of `asset` to `to`. `asset == ETH (address(0))` moves native ETH.
     *         Owners: any asset, no limit. Spenders: only assets an owner gave them a limit on, within the limit.
     */
    function metaTransfer(
        address asset,
        address to,
        uint256 amount,
        address signerId,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 usedNonce = nonces[signerId];
        _authorize(signerId, hashTransfer(asset, to, amount, usedNonce, deadline), deadline, signature);
        Call[] memory calls = new Call[](1);
        calls[0] = asset == ETH
            ? Call(to, amount, "")
            : Call(asset, 0, abi.encodeCall(IERC20.transfer, (to, amount)));
        _dispatch(signerId, calls);
        emit Transferred(signerId, asset, to, amount, usedNonce);
    }

    /**
     * @notice Execute a batch of calls as the wallet, atomically (EIP-5792 `atomic`), under the same rules as a
     *         user op (`_dispatch`). Calls may target the wallet itself to batch admin actions.
     */
    function metaExecute(Call[] calldata calls, address signerId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (bytes[] memory results)
    {
        uint256 usedNonce = nonces[signerId];
        bytes32 callsHash = hashCalls(calls);
        _authorize(signerId, hashExecute(callsHash, usedNonce, deadline), deadline, signature);
        results = _dispatch(signerId, calls);
        emit Executed(signerId, callsHash, calls.length, usedNonce);
    }

    // ---------------------------------------------------------------- self: admin (batched in one metaExecute)

    function addSigner(bytes32 qx, bytes32 qy, uint8 kind, uint8 role, bytes32 credentialIdHash) external onlySelf {
        _addSigner(qx, qy, kind, role, credentialIdHash);
    }

    function updateSigner(address targetSignerId, uint8 role) external onlySelf {
        _updateSigner(targetSignerId, role);
    }

    function setLimit(address targetSignerId, address asset, uint128 limit) external onlySelf {
        _setLimit(targetSignerId, asset, limit);
    }

    function removeSigner(address targetSignerId) external onlySelf {
        _removeSigner(targetSignerId);
    }

    /// @notice Replace the guardian list (empty = no recovery) and delay. Drops a pending recovery.
    function setGuardians(address[] calldata guardians, uint64 _recoveryDelay) external onlySelf {
        _cancelRecovery();
        _setGuardians(guardians, _recoveryDelay);
    }

    /// @notice Explicit cancel. (Any owner-signed call already cancels, so this is a no-op by the time it runs.)
    function cancelRecovery() external onlySelf {
        _cancelRecovery();
    }

    // ---------------------------------------------------------------- cold storage (v3.2)

    /// @notice `coldDelay = 0` turns the wait off (Simple). Longer is protecting (instant); shorter waits.
    function setColdDelay(uint64 delay) external onlySelf {
        if (delay != 0 && delay < MIN_RECOVERY_DELAY) revert DelayTooShort();
        coldDelay = delay;
        emit ColdSettings(delay, noTwoKeySkip);
    }

    /// @notice `true` = a second key can't skip a wait (Vault). Turning skipping off is protecting (instant).
    function setNoTwoKeySkip(bool off) external onlySelf {
        noTwoKeySkip = off;
        emit ColdSettings(coldDelay, off);
    }

    /// @notice Any key (self-call) cancels a queued action. Guardians: `guardianCancel`.
    function cancelQueued(bytes32 id) external onlySelf {
        _cancelQueued(id, _actor);
    }

    /// @notice A second key, other than the one that queued it, lets a queued action run now ("both keys").
    function skipWait(bytes32 id) external onlySelf {
        Queued storage q = queued[id];
        if (q.executeAfter == 0) revert NotQueued(id);
        if (noTwoKeySkip) revert SkipDisabled();
        if (_actor == address(0) || _actor == q.proposer || _signerIndex[_actor] == 0) revert SameKey();
        q.executeAfter = uint64(block.timestamp);
        emit ActionSkipped(id, _actor);
    }

    /// @notice Any key (self-call) freezes the wallet: nothing leaves until it expires or is lifted.
    function freeze() external onlySelf {
        _freeze(_actor);
    }

    /// @notice Lift a freeze. Weakening: an owner alone queues it (it may run while frozen); both keys skip.
    function unfreeze() external onlySelf {
        frozenUntil = 0;
        emit Unfrozen();
    }

    /// @notice Guardians can cancel and freeze directly (they can never spend).
    function guardianCancel(bytes32 id) external {
        if (!isGuardian[msg.sender]) revert OnlyGuardian();
        _cancelQueued(id, msg.sender);
    }

    function guardianFreeze() external {
        if (!isGuardian[msg.sender]) revert OnlyGuardian();
        _freeze(msg.sender);
    }

    /**
     * @notice Run a queued action once its wait is over. Anyone may submit it (it was signed when queued). The
     *         calls must be exactly the queued ones (the `ActionQueued` event carries them). Blocked while frozen,
     *         except a lone `unfreeze()`. Dropped if the key that queued it has since been removed.
     */
    function executeQueued(bytes32 id, Call[] calldata calls) external returns (bytes[] memory results) {
        Queued memory q = queued[id];
        if (q.executeAfter == 0) revert NotQueued(id);
        if (block.timestamp < q.executeAfter) revert NotReady(q.executeAfter, block.timestamp);
        if (hashCalls(calls) != q.callsHash) revert WrongCalls();
        if (_signerIndex[q.proposer] == 0) revert UnknownSigner(q.proposer);
        if (block.timestamp < frozenUntil && !_isUnfreezeMem(calls)) revert WalletFrozen(frozenUntil);
        delete queued[id];
        address outer = _actor;
        _actor = q.proposer;
        results = _run(calls);
        _actor = outer;
        emit ActionExecuted(id);
    }

    /// @dev UUPS: only through an owner-signed `metaExecute` targeting the wallet.
    function _authorizeUpgrade(address) internal view override onlySelf { }

    // ---------------------------------------------------------------- recovery

    /**
     * @notice A guardian proposes adding `(qx, qy)` and, if `replaces != 0`, removing that key (lost phone / lost
     *         wedgie). Replaces any pending proposal and restarts the clock.
     */
    function startRecovery(address replaces, bytes32 qx, bytes32 qy, uint8 kind, bytes32 credentialIdHash) external {
        if (!isGuardian[msg.sender]) revert OnlyGuardian();
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidKey();
        if (kind > KIND_RAW) revert InvalidKind();
        address newId = signerIdOf(qx, qy);
        if (_signerIndex[newId] != 0) revert SignerExists(newId);
        if (replaces != address(0) && _signerIndex[replaces] == 0) revert UnknownSigner(replaces);
        uint64 executeAfter = uint64(block.timestamp) + recoveryDelay;
        _recovery = Recovery(replaces, qx, qy, kind, credentialIdHash, msg.sender, executeAfter);
        emit RecoveryStarted(msg.sender, replaces, newId, executeAfter);
    }

    /// @notice After the uninterrupted delay, anyone applies the pending proposal.
    function finalizeRecovery() external nonReentrant {
        Recovery memory r = _recovery;
        if (r.executeAfter == 0) revert RecoveryNotPending();
        if (block.timestamp < r.executeAfter) revert RecoveryNotReady(r.executeAfter, block.timestamp);
        delete _recovery;
        uint8 role = ROLE_OWNER;
        // the replaced key may have been removed since the proposal; then the new key just joins as an owner
        if (r.replaces != address(0) && _signerIndex[r.replaces] != 0) {
            role = _signers[r.replaces].role;
            _addSigner(r.qx, r.qy, r.kind, role, r.credentialIdHash);
            _removeSigner(r.replaces);
        } else {
            _addSigner(r.qx, r.qy, r.kind, role, r.credentialIdHash);
        }
        emit RecoveryFinalized(r.replaces, signerIdOf(r.qx, r.qy));
    }

    // ---------------------------------------------------------------- receive

    receive() external payable {
        emit EtherReceived(msg.sender, msg.value);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    /// @notice ERC-165: ERC-165, ERC-1271, ERC-721 receiver, ERC-1155 receiver.
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x1626ba7e || id == 0x150b7a02 || id == 0x4e2312e0;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Checks deadline + signature, bumps the signer's nonce.
    function _authorize(address signerId, bytes32 digest, uint256 deadline, bytes calldata signature)
        internal
        returns (Signer storage s)
    {
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        if (_signerIndex[signerId] == 0) revert UnknownSigner(signerId);
        s = _signers[signerId];
        if (!_verify(s, digest, signature)) revert BadSignature();
        nonces[signerId] += 1;
    }

    /// @dev No TIMESTAMP and only this wallet's storage (ERC-7562): expiry goes back to the EntryPoint as validUntil.
    function _validateUserOp(PackedUserOperation calldata op) internal view returns (uint256) {
        bytes calldata sig = op.signature;
        if (sig.length < 40) return SIG_VALIDATION_FAILED;
        address signerId = address(uint160(op.nonce >> 64));
        if (_signerIndex[signerId] == 0) return SIG_VALIDATION_FAILED;
        uint48 validUntil = uint48(bytes6(sig[0:6]));
        uint256 cut = uint16(bytes2(sig[6:8]));
        if (cut > op.paymasterAndData.length) return SIG_VALIDATION_FAILED;
        bytes32 digest = hashUserOp(op, cut, validUntil);
        bytes32 pair = bytes32(sig[8:40]);
        if (pair != bytes32(0)) digest = hashPair(digest, pair);
        if (!_verify(_signers[signerId], digest, sig[40:])) return SIG_VALIDATION_FAILED;
        return uint256(validUntil) << 160;
    }

    /**
     * @dev The rules (docs/COLD-STORAGE.md). Owner: cancels a pending recovery; with a `coldDelay`, anything that
     *      isn't protecting is queued instead of run. Spender: ETH / ERC-20 sends within its limits, and protecting
     *      self-calls. Runs with `_actor = signerId` so self-calls know who signed.
     */
    function _dispatch(address signerId, Call[] memory calls) internal returns (bytes[] memory results) {
        _actor = signerId;
        if (_signers[signerId].role == ROLE_OWNER) {
            _cancelRecovery();
            bool protect = _allProtect(calls, signerId);
            if (coldDelay != 0 && !protect) {
                _queue(signerId, calls);
                _actor = address(0);
                return results;
            }
            if (!protect && block.timestamp < frozenUntil && !_isUnfreezeMem(calls)) revert WalletFrozen(frozenUntil);
        } else {
            for (uint256 i; i < calls.length; ++i) {
                (address asset, uint256 amount) = _spenderCall(signerId, calls[i]);
                _spend(signerId, asset, amount);
            }
        }
        results = _run(calls);
        _actor = address(0);
    }

    function _queue(address proposer, Call[] memory calls) internal {
        bytes memory encoded = abi.encode(calls);
        bytes32 callsHash = hashCalls(calls);
        bytes32 id = keccak256(abi.encode(callsHash, proposer, queueCount++));
        uint64 executeAfter = uint64(block.timestamp) + coldDelay;
        queued[id] = Queued(executeAfter, proposer, callsHash);
        emit ActionQueued(id, proposer, executeAfter, encoded);
    }

    function _cancelQueued(bytes32 id, address by) internal {
        if (queued[id].executeAfter == 0) revert NotQueued(id);
        delete queued[id];
        emit ActionCancelled(id, by);
    }

    function _freeze(address by) internal {
        uint64 until = uint64(block.timestamp) + (recoveryDelay == 0 ? 7 days : recoveryDelay);
        if (until > frozenUntil) frozenUntil = until;
        emit Frozen(by, frozenUntil);
    }

    function _allProtect(Call[] memory calls, address signerId) internal view returns (bool) {
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].target != address(this) || calls[i].value != 0 || !_isProtect(calls[i], signerId, true)) {
                return false;
            }
        }
        return calls.length != 0;
    }

    /**
     * @dev A self-call that only protects the wallet, so it never waits. Any key: cancel a queued action, freeze,
     *      skip a wait (needs a second key anyway), run a ready queued action, lower its own limit, remove itself.
     *      Owners also: cancel a recovery, lower anyone's limit, remove a spender, lengthen the cold delay, turn
     *      two-key skipping off.
     */
    function _isProtect(Call memory c, address signerId, bool owner) internal view returns (bool) {
        bytes memory d = c.data;
        if (d.length < 4) return false;
        bytes4 sel = bytes4(d);
        if (
            sel == this.cancelQueued.selector || sel == this.freeze.selector || sel == this.skipWait.selector
                || sel == this.executeQueued.selector
        ) return true;
        if (sel == this.setLimit.selector && d.length >= 100) {
            address who = address(uint160(_word(d, 0)));
            address asset = address(uint160(_word(d, 1)));
            uint256 limit = _word(d, 2);
            if (!owner && who != signerId) return false;
            uint256 cur = _allowances[who][asset].limit;
            return _signerIndex[who] != 0 && limit <= cur;
        }
        if (sel == this.removeSigner.selector && d.length >= 36) {
            address who = address(uint160(_word(d, 0)));
            return who == signerId || (owner && _signerIndex[who] != 0 && _signers[who].role != ROLE_OWNER);
        }
        if (!owner) return false;
        if (sel == this.cancelRecovery.selector) return true;
        if (sel == this.setColdDelay.selector && d.length >= 36) {
            return coldDelay != 0 && _word(d, 0) >= coldDelay;
        }
        if (sel == this.setNoTwoKeySkip.selector && d.length >= 36) return _word(d, 0) == 1;
        return false;
    }

    function _isUnfreezeMem(Call[] memory calls) internal view returns (bool) {
        return calls.length == 1 && calls[0].target == address(this) && calls[0].data.length == 4
            && bytes4(calls[0].data) == this.unfreeze.selector;
    }

    /// @dev Argument word `i` of an ABI-encoded call (after the 4-byte selector). Callers check the length.
    function _word(bytes memory d, uint256 i) internal pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := mload(add(d, add(36, mul(i, 32))))
        }
    }

    function _run(Call[] memory calls) internal returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{ value: calls[i].value }(calls[i].data);
            if (!ok) {
                if (ret.length > 0) Address.verifyCallResult(false, ret);
                revert CallFailed(i);
            }
            results[i] = ret;
        }
    }

    /// @dev A spender call is an ETH send (empty data), `asset.transfer(to, amount)` with no value, or a protecting
    ///      self-call (`_isProtect`, spender form); else NotOwner.
    function _spenderCall(address signerId, Call memory c) internal view returns (address asset, uint256 amount) {
        if (c.target == address(this) && c.value == 0 && _isProtect(c, signerId, false)) return (ETH, 0);
        if (c.data.length == 0) return (ETH, c.value);
        bytes memory d = c.data;
        if (c.value != 0 || d.length != 68 || bytes4(d) != IERC20.transfer.selector) revert NotOwner(signerId);
        assembly ("memory-safe") {
            amount := mload(add(d, 68))
        }
        return (c.target, amount);
    }

    function _verify(Signer storage s, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (s.kind == KIND_RAW) {
            if (signature.length != 64) return false;
            return P256.verify(digest, bytes32(signature[0:32]), bytes32(signature[32:64]), s.qx, s.qy);
        }
        (bool ok, WebAuthn.WebAuthnAuth calldata auth) = WebAuthn.tryDecodeAuth(signature);
        if (!ok) return false;
        return WebAuthn.verify(abi.encodePacked(digest), auth, s.qx, s.qy);
    }

    function _transfer(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == ETH) {
            (bool ok,) = payable(to).call{ value: amount }("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    function _spend(address signerId, address asset, uint256 amount) internal {
        if (amount == 0) return;
        if (block.timestamp < frozenUntil) revert WalletFrozen(frozenUntil);
        Allowance storage a = _allowances[signerId][asset];
        if (block.timestamp >= uint256(a.windowStart) + WINDOW) {
            a.windowStart = uint64(block.timestamp);
            a.spent = 0;
        }
        uint256 remaining = a.limit > a.spent ? a.limit - a.spent : 0;
        if (amount > remaining) revert OverLimit(signerId, asset, amount, remaining);
        // forge-lint: disable-next-line(unsafe-typecast)
        a.spent += uint128(amount); // amount <= limit (uint128) checked above
    }

    function _addSigner(bytes32 qx, bytes32 qy, uint8 kind, uint8 role, bytes32 credentialIdHash) internal {
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidKey();
        if (kind > KIND_RAW) revert InvalidKind();
        if (role > ROLE_OWNER) revert InvalidRole();
        address id = signerIdOf(qx, qy);
        if (_signerIndex[id] != 0) revert SignerExists(id);
        _signers[id] = Signer({ qx: qx, qy: qy, kind: kind, role: role, addedAt: uint64(block.timestamp) });
        _signerIds.push(id);
        _signerIndex[id] = _signerIds.length;
        if (credentialIdHash != bytes32(0)) credentialIdToSigner[credentialIdHash] = id;
        if (role == ROLE_OWNER) ownerCount += 1;
        emit SignerAdded(id, qx, qy, kind, role);
    }

    function _updateSigner(address id, uint8 role) internal {
        if (_signerIndex[id] == 0) revert UnknownSigner(id);
        if (role > ROLE_OWNER) revert InvalidRole();
        Signer storage t = _signers[id];
        if (t.role == ROLE_OWNER && role != ROLE_OWNER) {
            if (ownerCount == 1) revert LastOwner();
            ownerCount -= 1;
        } else if (t.role != ROLE_OWNER && role == ROLE_OWNER) {
            ownerCount += 1;
        }
        t.role = role;
        emit SignerUpdated(id, role);
    }

    /// @dev limit 0 removes the asset from the signer's list. Setting a limit restarts its window.
    function _setLimit(address id, address asset, uint128 limit) internal {
        if (_signerIndex[id] == 0) revert UnknownSigner(id);
        uint256 idx = _limitedIndex[id][asset];
        if (limit == 0) {
            if (idx != 0) {
                address[] storage list = _limitedAssets[id];
                uint256 last = list.length;
                if (idx != last) {
                    address moved = list[last - 1];
                    list[idx - 1] = moved;
                    _limitedIndex[id][moved] = idx;
                }
                list.pop();
                delete _limitedIndex[id][asset];
            }
            delete _allowances[id][asset];
        } else {
            if (idx == 0) {
                _limitedAssets[id].push(asset);
                _limitedIndex[id][asset] = _limitedAssets[id].length;
            }
            _allowances[id][asset] = Allowance({ limit: limit, spent: 0, windowStart: uint64(block.timestamp) });
        }
        emit LimitSet(id, asset, limit);
    }

    function _removeSigner(address id) internal {
        uint256 idx = _signerIndex[id];
        if (idx == 0) revert UnknownSigner(id);
        if (_signers[id].role == ROLE_OWNER) {
            if (ownerCount == 1) revert LastOwner();
            ownerCount -= 1;
        }
        uint256 last = _signerIds.length;
        if (idx != last) {
            address moved = _signerIds[last - 1];
            _signerIds[idx - 1] = moved;
            _signerIndex[moved] = idx;
        }
        _signerIds.pop();
        delete _signerIndex[id];
        delete _signers[id];
        address[] storage assets = _limitedAssets[id];
        for (uint256 i; i < assets.length; ++i) {
            delete _allowances[id][assets[i]];
            delete _limitedIndex[id][assets[i]];
        }
        delete _limitedAssets[id];
        emit SignerRemoved(id);
    }

    function _setGuardians(address[] calldata guardians, uint64 _recoveryDelay) internal {
        if (guardians.length > 16) revert TooManyGuardians();
        if (guardians.length != 0 && _recoveryDelay < MIN_RECOVERY_DELAY) revert DelayTooShort();
        for (uint256 i; i < _guardians.length; ++i) {
            isGuardian[_guardians[i]] = false;
        }
        delete _guardians;
        for (uint256 i; i < guardians.length; ++i) {
            address g = guardians[i];
            if (g == address(0)) revert ZeroAddress();
            if (isGuardian[g]) continue;
            isGuardian[g] = true;
            _guardians.push(g);
        }
        recoveryDelay = _recoveryDelay;
        emit GuardiansSet(_guardians, _recoveryDelay);
    }

    function _cancelRecovery() internal {
        if (_recovery.executeAfter == 0) return;
        address newId = signerIdOf(_recovery.qx, _recovery.qy);
        delete _recovery;
        emit RecoveryCancelled(newId);
    }
}
