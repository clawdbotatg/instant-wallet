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
    uint64 public constant MIN_RECOVERY_DELAY = 1 days;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("InstantWallet");
    bytes32 private constant VERSION_HASH = keccak256("3");

    bytes32 public constant TRANSFER_TYPEHASH =
        keccak256("Transfer(address asset,address to,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 public constant EXECUTE_TYPEHASH = keccak256("Execute(bytes32 callsHash,uint256 nonce,uint256 deadline)");
    /// @notice ERC-1271: what a key signs so one key owning two wallets can't have a message replayed across them.
    bytes32 public constant MESSAGE_TYPEHASH = keccak256("InstantWalletMessage(bytes32 hash)");

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

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
        return "3.0.0";
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

    /// @notice The digest a key signs for an ERC-1271 check of `hash`.
    function hashMessage(bytes32 hash) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(MESSAGE_TYPEHASH, hash)));
    }

    /// @notice Check one key's signature over a digest (no state change). Any role.
    function verify(address signerId, bytes32 digest, bytes calldata signature) external view returns (bool) {
        if (_signerIndex[signerId] == 0) return false;
        return _verify(_signers[signerId], digest, signature);
    }

    /**
     * @notice ERC-1271. `signature = signerId (20 bytes) ‖ keySignature`, where the key signed `hashMessage(hash)`.
     *         Owners only: a spender can't sign permits or orders that move funds.
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length < 20) return 0xffffffff;
        address signerId = address(bytes20(signature[0:20]));
        if (_signerIndex[signerId] == 0) return 0xffffffff;
        Signer storage s = _signers[signerId];
        if (s.role != ROLE_OWNER) return 0xffffffff;
        return _verify(s, hashMessage(hash), signature[20:]) ? ERC1271_MAGIC : bytes4(0xffffffff);
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
        Signer storage s =
            _authorize(signerId, hashTransfer(asset, to, amount, usedNonce, deadline), deadline, signature);
        if (s.role != ROLE_OWNER) _spend(signerId, asset, amount);
        _transfer(asset, to, amount);
        emit Transferred(signerId, asset, to, amount, usedNonce);
    }

    /**
     * @notice Execute a batch of calls as the wallet, atomically (EIP-5792 `atomic`). Owners only in 3.0.0.
     *         Calls may target the wallet itself to batch admin actions.
     */
    function metaExecute(Call[] calldata calls, address signerId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (bytes[] memory results)
    {
        uint256 usedNonce = nonces[signerId];
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

    /// @dev Checks deadline + signature, bumps the signer's nonce, cancels recovery on owner actions.
    function _authorize(address signerId, bytes32 digest, uint256 deadline, bytes calldata signature)
        internal
        returns (Signer storage s)
    {
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        if (_signerIndex[signerId] == 0) revert UnknownSigner(signerId);
        s = _signers[signerId];
        if (!_verify(s, digest, signature)) revert BadSignature();
        nonces[signerId] += 1;
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
