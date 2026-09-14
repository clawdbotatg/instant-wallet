// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { P256 } from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title InstantWallet
 * @notice One account, many P-256 keys, tiered by trust.
 *
 *  Every signer is a P-256 public key. A passkey (Face ID / Touch ID) signs a WebAuthn assertion whose
 *  challenge is the digest; the hardware device (ATECC608) signs the digest raw. Both verify against the
 *  same EIP-712 digest, so the two kinds of key are interchangeable on chain and differ only in role.
 *
 *  Spenders may move the wallet's token up to a rolling 24h limit. Owners may do anything: transfer any
 *  token, execute arbitrary calls, and manage signers. A fixed recovery address can add a new owner key
 *  after an uninterrupted delay; any owner action cancels it. No admin, no upgrade, no unsigned path.
 *
 *  Digests, signature encodings and the match code are specified in docs/PROTOCOL.md.
 * @author BuidlGuidl
 */
contract InstantWallet is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct Signer {
        bytes32 qx;
        bytes32 qy;
        uint8 kind; // KIND_WEBAUTHN | KIND_RAW
        uint8 role; // ROLE_SPENDER | ROLE_OWNER
        uint128 dailyLimit; // token base units per WINDOW, spenders only
        uint128 spentInWindow;
        uint64 windowStart;
        uint64 addedAt;
    }

    uint8 public constant KIND_WEBAUTHN = 0;
    uint8 public constant KIND_RAW = 1;
    uint8 public constant ROLE_SPENDER = 0;
    uint8 public constant ROLE_OWNER = 1;
    uint256 public constant WINDOW = 1 days;
    uint64 public constant MIN_RECOVERY_DELAY = 1 hours;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("InstantWallet");
    bytes32 private constant VERSION_HASH = keccak256("1");

    bytes32 public constant TRANSFER_TYPEHASH =
        keccak256("Transfer(address token,address to,uint256 amount,uint256 fee,uint256 nonce,uint256 deadline)");
    bytes32 public constant EXECUTE_TYPEHASH = keccak256("Execute(bytes32 callsHash,uint256 nonce,uint256 deadline)");
    bytes32 public constant ADD_SIGNER_TYPEHASH = keccak256(
        "AddSigner(bytes32 qx,bytes32 qy,uint8 kind,uint8 role,uint128 dailyLimit,bytes32 credentialIdHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant UPDATE_SIGNER_TYPEHASH =
        keccak256("UpdateSigner(address signerId,uint8 role,uint128 dailyLimit,uint256 nonce,uint256 deadline)");
    bytes32 public constant REMOVE_SIGNER_TYPEHASH =
        keccak256("RemoveSigner(address signerId,uint256 nonce,uint256 deadline)");
    bytes32 public constant SET_RECOVERY_TYPEHASH =
        keccak256("SetRecovery(address recoveryAddress,uint64 recoveryDelay,uint256 nonce,uint256 deadline)");
    bytes32 public constant CANCEL_RECOVERY_TYPEHASH = keccak256("CancelRecovery(uint256 nonce,uint256 deadline)");

    // ---------------------------------------------------------------- state

    /// @notice The stablecoin the spender limit applies to (set once at initialize).
    address public token;
    /// @notice Wallet-wide replay protection. Every successful meta call increments it.
    uint256 public nonce;

    mapping(address => Signer) private _signers;
    address[] private _signerIds;
    mapping(address => uint256) private _signerIndex; // index + 1, 0 = absent
    mapping(bytes32 => address) public credentialIdToSigner;
    uint256 public ownerCount;

    address public recoveryAddress;
    uint64 public recoveryDelay;
    bytes32 public pendingQx;
    bytes32 public pendingQy;
    uint8 public pendingKind;
    uint64 public recoveryExecuteAfter;

    // ---------------------------------------------------------------- events

    event SignerAdded(address indexed signerId, bytes32 qx, bytes32 qy, uint8 kind, uint8 role, uint128 dailyLimit);
    event SignerUpdated(address indexed signerId, uint8 role, uint128 dailyLimit);
    event SignerRemoved(address indexed signerId);
    event Transferred(
        address indexed signerId, address indexed token, address indexed to, uint256 amount, uint256 fee, uint256 nonce
    );
    event Executed(address indexed signerId, bytes32 indexed callsHash, uint256 calls, uint256 nonce);
    event RecoverySet(address indexed recoveryAddress, uint64 recoveryDelay);
    event RecoveryStarted(bytes32 indexed qx, bytes32 indexed qy, uint8 kind, uint64 executeAfter);
    event RecoveryCancelled(bytes32 indexed qx, bytes32 indexed qy);
    event RecoveryFinalized(address indexed signerId);
    event EtherReceived(address indexed sender, uint256 amount);

    // ---------------------------------------------------------------- errors

    error Expired(uint256 deadline, uint256 nowTs);
    error UnknownSigner(address signerId);
    error BadSignature();
    error NotOwner(address signerId);
    error OverLimit(address signerId, uint256 wanted, uint256 remaining);
    error TokenNotAllowed(address token);
    error SignerExists(address signerId);
    error InvalidKey();
    error InvalidKind();
    error InvalidRole();
    error LastOwner();
    error ZeroAddress();
    error DelayTooShort();
    error OnlyRecoveryAddress();
    error RecoveryNotPending();
    error RecoveryNotReady(uint64 executeAfter, uint256 nowTs);
    error CallFailed(uint256 index);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize a fresh clone with its first key as the owner.
     * @param _token The stablecoin the spender limit applies to.
     * @param qx First key x. @param qy First key y.
     * @param kind KIND_WEBAUTHN for a passkey, KIND_RAW for a chip.
     * @param credentialIdHash keccak256 of the WebAuthn credential id (zero for a chip); enables login lookup.
     * @param _recoveryAddress Who may start recovery (the facilitator by default; the user can change it).
     * @param _recoveryDelay Seconds a recovery must wait, at least MIN_RECOVERY_DELAY.
     */
    function initialize(
        address _token,
        bytes32 qx,
        bytes32 qy,
        uint8 kind,
        bytes32 credentialIdHash,
        address _recoveryAddress,
        uint64 _recoveryDelay
    ) external initializer {
        if (_token == address(0) || _recoveryAddress == address(0)) revert ZeroAddress();
        if (_recoveryDelay < MIN_RECOVERY_DELAY) revert DelayTooShort();
        token = _token;
        recoveryAddress = _recoveryAddress;
        recoveryDelay = _recoveryDelay;
        _addSigner(qx, qy, kind, ROLE_OWNER, 0, credentialIdHash);
        emit RecoverySet(_recoveryAddress, _recoveryDelay);
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

    /// @notice How much a signer may still move in the current window (type(uint256).max for owners).
    function remainingAllowance(address signerId) external view returns (uint256) {
        Signer storage s = _signers[signerId];
        if (_signerIndex[signerId] == 0) return 0;
        if (s.role == ROLE_OWNER) return type(uint256).max;
        if (block.timestamp >= uint256(s.windowStart) + WINDOW) return s.dailyLimit;
        return s.dailyLimit > s.spentInWindow ? s.dailyLimit - s.spentInWindow : 0;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _typed(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function hashTransfer(address _token, address to, uint256 amount, uint256 fee, uint256 _nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _typed(keccak256(abi.encode(TRANSFER_TYPEHASH, _token, to, amount, fee, _nonce, deadline)));
    }

    /// @notice callsHash = keccak256(concat(keccak256(abi.encode(target, value, keccak256(data))) ...)).
    function hashCalls(Call[] calldata calls) public pure returns (bytes32) {
        bytes memory acc;
        for (uint256 i; i < calls.length; ++i) {
            acc = bytes.concat(acc, keccak256(abi.encode(calls[i].target, calls[i].value, keccak256(calls[i].data))));
        }
        return keccak256(acc);
    }

    function hashExecute(bytes32 callsHash, uint256 _nonce, uint256 deadline) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(EXECUTE_TYPEHASH, callsHash, _nonce, deadline)));
    }

    function hashAddSigner(
        bytes32 qx,
        bytes32 qy,
        uint8 kind,
        uint8 role,
        uint128 dailyLimit,
        bytes32 credentialIdHash,
        uint256 _nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _typed(
            keccak256(
                abi.encode(ADD_SIGNER_TYPEHASH, qx, qy, kind, role, dailyLimit, credentialIdHash, _nonce, deadline)
            )
        );
    }

    function hashUpdateSigner(address signerId, uint8 role, uint128 dailyLimit, uint256 _nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _typed(keccak256(abi.encode(UPDATE_SIGNER_TYPEHASH, signerId, role, dailyLimit, _nonce, deadline)));
    }

    function hashRemoveSigner(address signerId, uint256 _nonce, uint256 deadline) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(REMOVE_SIGNER_TYPEHASH, signerId, _nonce, deadline)));
    }

    function hashSetRecovery(address _recoveryAddress, uint64 _recoveryDelay, uint256 _nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _typed(keccak256(abi.encode(SET_RECOVERY_TYPEHASH, _recoveryAddress, _recoveryDelay, _nonce, deadline)));
    }

    function hashCancelRecovery(uint256 _nonce, uint256 deadline) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(CANCEL_RECOVERY_TYPEHASH, _nonce, deadline)));
    }

    /// @notice Check a signature without spending gas on a transaction.
    function isValidSignature(address signerId, bytes32 digest, bytes calldata signature) external view returns (bool) {
        if (_signerIndex[signerId] == 0) return false;
        return _verify(_signers[signerId], digest, signature);
    }

    // ---------------------------------------------------------------- meta: money

    /**
     * @notice Move `amount` of `_token` to `to` and `fee` of `_token` to the relayer (msg.sender).
     * @dev Spenders may only move the wallet's own token, within their rolling limit (amount + fee).
     */
    function metaTransfer(
        address _token,
        address to,
        uint256 amount,
        uint256 fee,
        address signerId,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 usedNonce = nonce;
        Signer storage s = _authorize(signerId, hashTransfer(_token, to, amount, fee, usedNonce, deadline), deadline, signature);
        if (s.role != ROLE_OWNER) {
            if (_token != token) revert TokenNotAllowed(_token);
            _spend(s, signerId, amount + fee);
        }
        IERC20(_token).safeTransfer(to, amount);
        if (fee > 0) IERC20(_token).safeTransfer(msg.sender, fee);
        emit Transferred(signerId, _token, to, amount, fee, usedNonce);
    }

    /**
     * @notice Execute an arbitrary batch of calls. Owners only. Reverts entirely if any call fails.
     */
    function metaExecute(Call[] calldata calls, address signerId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (bytes[] memory results)
    {
        uint256 usedNonce = nonce;
        bytes32 callsHash = hashCalls(calls);
        Signer storage s = _authorize(signerId, hashExecute(callsHash, usedNonce, deadline), deadline, signature);
        if (s.role != ROLE_OWNER) revert NotOwner(signerId);
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{ value: calls[i].value }(calls[i].data);
            if (!ok) {
                if (ret.length > 0) Address.verifyCallResult(false, ret);
                revert CallFailed(i);
            }
            results[i] = ret;
        }
        emit Executed(signerId, callsHash, calls.length, usedNonce);
    }

    // ---------------------------------------------------------------- meta: keys

    function metaAddSigner(
        bytes32 qx,
        bytes32 qy,
        uint8 kind,
        uint8 role,
        uint128 dailyLimit,
        bytes32 credentialIdHash,
        address signerId,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        uint256 usedNonce = nonce;
        Signer storage s = _authorize(
            signerId, hashAddSigner(qx, qy, kind, role, dailyLimit, credentialIdHash, usedNonce, deadline), deadline, signature
        );
        if (s.role != ROLE_OWNER) revert NotOwner(signerId);
        _addSigner(qx, qy, kind, role, dailyLimit, credentialIdHash);
    }

    function metaUpdateSigner(
        address targetSignerId,
        uint8 role,
        uint128 dailyLimit,
        address signerId,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        uint256 usedNonce = nonce;
        Signer storage s =
            _authorize(signerId, hashUpdateSigner(targetSignerId, role, dailyLimit, usedNonce, deadline), deadline, signature);
        if (s.role != ROLE_OWNER) revert NotOwner(signerId);
        if (_signerIndex[targetSignerId] == 0) revert UnknownSigner(targetSignerId);
        if (role > ROLE_OWNER) revert InvalidRole();
        Signer storage t = _signers[targetSignerId];
        if (t.role == ROLE_OWNER && role != ROLE_OWNER) {
            if (ownerCount == 1) revert LastOwner();
            ownerCount -= 1;
        } else if (t.role != ROLE_OWNER && role == ROLE_OWNER) {
            ownerCount += 1;
        }
        t.role = role;
        t.dailyLimit = dailyLimit;
        t.spentInWindow = 0;
        t.windowStart = uint64(block.timestamp);
        emit SignerUpdated(targetSignerId, role, dailyLimit);
    }

    function metaRemoveSigner(address targetSignerId, address signerId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        uint256 usedNonce = nonce;
        Signer storage s = _authorize(signerId, hashRemoveSigner(targetSignerId, usedNonce, deadline), deadline, signature);
        if (s.role != ROLE_OWNER) revert NotOwner(signerId);
        _removeSigner(targetSignerId);
    }

    function metaSetRecovery(
        address _recoveryAddress,
        uint64 _recoveryDelay,
        address signerId,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        uint256 usedNonce = nonce;
        Signer storage s =
            _authorize(signerId, hashSetRecovery(_recoveryAddress, _recoveryDelay, usedNonce, deadline), deadline, signature);
        if (s.role != ROLE_OWNER) revert NotOwner(signerId);
        if (_recoveryAddress == address(0)) revert ZeroAddress();
        if (_recoveryDelay < MIN_RECOVERY_DELAY) revert DelayTooShort();
        recoveryAddress = _recoveryAddress;
        recoveryDelay = _recoveryDelay;
        emit RecoverySet(_recoveryAddress, _recoveryDelay);
    }

    /// @notice Explicit cancel (any owner action also cancels). Owners only.
    function metaCancelRecovery(address signerId, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (recoveryExecuteAfter == 0) revert RecoveryNotPending();
        uint256 usedNonce = nonce;
        Signer storage s = _authorize(signerId, hashCancelRecovery(usedNonce, deadline), deadline, signature);
        if (s.role != ROLE_OWNER) revert NotOwner(signerId);
        // _authorize already cancelled because s is an owner
    }

    // ---------------------------------------------------------------- recovery

    /// @notice Start (or restart, resetting the clock) a recovery that will add `(qx, qy)` as an owner.
    function startRecovery(bytes32 qx, bytes32 qy, uint8 kind) external {
        if (msg.sender != recoveryAddress) revert OnlyRecoveryAddress();
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidKey();
        if (kind > KIND_RAW) revert InvalidKind();
        if (_signerIndex[signerIdOf(qx, qy)] != 0) revert SignerExists(signerIdOf(qx, qy));
        pendingQx = qx;
        pendingQy = qy;
        pendingKind = kind;
        recoveryExecuteAfter = uint64(block.timestamp) + recoveryDelay;
        emit RecoveryStarted(qx, qy, kind, recoveryExecuteAfter);
    }

    /// @notice After the uninterrupted delay, add the pending key as an owner. The old keys stay until removed.
    function finalizeRecovery() external {
        if (msg.sender != recoveryAddress) revert OnlyRecoveryAddress();
        uint64 executeAfter = recoveryExecuteAfter;
        if (executeAfter == 0) revert RecoveryNotPending();
        if (block.timestamp < executeAfter) revert RecoveryNotReady(executeAfter, block.timestamp);
        bytes32 qx = pendingQx;
        bytes32 qy = pendingQy;
        uint8 kind = pendingKind;
        _clearRecovery();
        _addSigner(qx, qy, kind, ROLE_OWNER, 0, bytes32(0));
        emit RecoveryFinalized(signerIdOf(qx, qy));
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

    // ---------------------------------------------------------------- internals

    /// @dev Checks deadline + signature, bumps the nonce, cancels recovery on owner actions. Returns the signer.
    function _authorize(address signerId, bytes32 digest, uint256 deadline, bytes calldata signature)
        internal
        returns (Signer storage s)
    {
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        if (_signerIndex[signerId] == 0) revert UnknownSigner(signerId);
        s = _signers[signerId];
        if (!_verify(s, digest, signature)) revert BadSignature();
        nonce += 1;
        if (s.role == ROLE_OWNER) _cancelRecovery();
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

    function _spend(Signer storage s, address signerId, uint256 amount) internal {
        if (block.timestamp >= uint256(s.windowStart) + WINDOW) {
            s.windowStart = uint64(block.timestamp);
            s.spentInWindow = 0;
        }
        uint256 remaining = s.dailyLimit > s.spentInWindow ? s.dailyLimit - s.spentInWindow : 0;
        if (amount > remaining) revert OverLimit(signerId, amount, remaining);
        // forge-lint: disable-next-line(unsafe-typecast)
        s.spentInWindow += uint128(amount); // amount <= dailyLimit (uint128) checked above
    }

    function _addSigner(bytes32 qx, bytes32 qy, uint8 kind, uint8 role, uint128 dailyLimit, bytes32 credentialIdHash)
        internal
    {
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidKey();
        if (kind > KIND_RAW) revert InvalidKind();
        if (role > ROLE_OWNER) revert InvalidRole();
        address id = signerIdOf(qx, qy);
        if (_signerIndex[id] != 0) revert SignerExists(id);
        _signers[id] = Signer({
            qx: qx,
            qy: qy,
            kind: kind,
            role: role,
            dailyLimit: dailyLimit,
            spentInWindow: 0,
            windowStart: uint64(block.timestamp),
            addedAt: uint64(block.timestamp)
        });
        _signerIds.push(id);
        _signerIndex[id] = _signerIds.length;
        if (credentialIdHash != bytes32(0)) credentialIdToSigner[credentialIdHash] = id;
        if (role == ROLE_OWNER) ownerCount += 1;
        emit SignerAdded(id, qx, qy, kind, role, dailyLimit);
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
        emit SignerRemoved(id);
    }

    function _cancelRecovery() internal {
        if (recoveryExecuteAfter == 0) return;
        bytes32 qx = pendingQx;
        bytes32 qy = pendingQy;
        _clearRecovery();
        emit RecoveryCancelled(qx, qy);
    }

    function _clearRecovery() internal {
        pendingQx = bytes32(0);
        pendingQy = bytes32(0);
        pendingKind = 0;
        recoveryExecuteAfter = 0;
    }
}
