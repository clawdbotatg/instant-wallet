// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

/// Instant Wallet on a Safe (docs/PLAN.md): the deployed, audited pieces on Base and Ethereum, and the
/// helpers every fork test shares. Same addresses on both chains (checked 2026-10-05).

enum Operation {
    Call,
    DelegateCall
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);
    function nonce() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address) external view returns (bool);
    function isModuleEnabled(address) external view returns (bool);
    function enableModule(address) external;
    function addOwnerWithThreshold(address owner, uint256 threshold) external;
    function removeOwner(address prevOwner, address owner, uint256 threshold) external;
    function swapOwner(address prevOwner, address oldOwner, address newOwner) external;
    function changeThreshold(uint256) external;
    function approveHash(bytes32) external;
    function approvedHashes(address, bytes32) external view returns (uint256);
    function getModulesPaginated(address start, uint256 pageSize) external view returns (address[] memory, address);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
    function proxyCreationCode() external pure returns (bytes memory);
}

interface IWebAuthnSignerFactory {
    function getSigner(uint256 x, uint256 y, uint176 verifiers) external view returns (address);
    function createSigner(uint256 x, uint256 y, uint176 verifiers) external returns (address);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4);
}

interface ISocialRecovery {
    function addGuardianWithThreshold(address guardian, uint256 threshold) external;
    function revokeGuardianWithThreshold(address prevGuardian, address guardian, uint256 threshold) external;
    function isGuardian(address wallet, address guardian) external view returns (bool);
    function getGuardians(address wallet) external view returns (address[] memory);
    function threshold(address wallet) external view returns (uint256);
    function nonce(address wallet) external view returns (uint256);
    function confirmRecovery(address wallet, address[] calldata newOwners, uint256 newThreshold, bool execute)
        external;
    function executeRecovery(address wallet, address[] calldata newOwners, uint256 newThreshold) external;
    function finalizeRecovery(address wallet) external;
    function cancelRecovery() external;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory);
}

abstract contract SafeBase is Test {
    // ---- deployed pieces (Base 8453 and Ethereum 1, identical addresses) ----
    address constant SAFE_FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b; // SafeProxyFactory 1.5.0
    address constant SAFE_L2 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e; // SafeL2 1.5.0
    /// MultiSendCallOnly 1.5.0: only for the first setup (its `to = 0` means "the Safe", needed before the address exists).
    address constant MULTISEND_SETUP = 0xA83c336B20401Af773B6219BA5027174338D1836;
    /// MultiSendCallOnly 1.4.1: every later batch (the wedgie's Safe app decodes this one and shows each action).
    address constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    address constant FALLBACK_HANDLER = 0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4; // CompatibilityFallbackHandler 1.5.0
    address constant PASSKEY_FACTORY = 0x1d31F259eE307358a26dFb23EB365939E8641195; // safe-modules passkey 0.2.1
    address constant DAIMO_VERIFIER = 0xc2b78104907F722DABAc4C69f826a522B2754De4; // P-256 fallback verifier
    address constant RECOVERY_7D = 0x088f6cfD8BB1dDb1BB069CCb3fc1A98927D233f2; // Candide SocialRecoveryModule, 7 days
    address constant DAO = 0xeF899e80aA814ab8D8e232f9Ed6403A633C727ec; // dao.buidlguidl.eth, same Safe on both chains
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base

    /// P-256 precompile at 0x100 (RIP-7212 / EIP-7951) first, Daimo's Solidity verifier as the fallback.
    uint176 constant VERIFIERS = uint176((uint256(0x100) << 160) | uint256(uint160(DAIMO_VERIFIER)));
    /// The wedgie's second owner slot: same key, Daimo's verifier only (no precompile), so a different signer
    /// address that still works on every chain. One press, one signature, fills both slots.
    uint176 constant VERIFIERS_SLOT2 = uint176(uint256(uint160(DAIMO_VERIFIER)));

    /// Every Instant Wallet uses this salt nonce; the owner key makes each address unique.
    uint256 constant SALT_NONCE = uint256(keccak256("instant-wallet.safe.v1"));

    uint256 constant BASE_BLOCK = 52_234_000; // pinned so the fork is cached

    address relayer = makeAddr("relayer");

    function _forkBase() internal {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"), BASE_BLOCK);
    }

    // ---------------------------------------------------------------- keys

    struct Passkey {
        uint256 pk;
        uint256 x;
        uint256 y;
        uint176 verifiers;
    }

    function _passkey(string memory name) internal returns (Passkey memory k) {
        k.pk = uint256(keccak256(bytes(name))) % 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
        (k.x, k.y) = vm.publicKeyP256(k.pk);
        k.verifiers = VERIFIERS;
        vm.label(_signerAddress(k), name);
    }

    function _signerAddress(Passkey memory k) internal view returns (address) {
        return IWebAuthnSignerFactory(PASSKEY_FACTORY).getSigner(k.x, k.y, k.verifiers);
    }

    function _deploySigner(Passkey memory k) internal returns (address) {
        return IWebAuthnSignerFactory(PASSKEY_FACTORY).createSigner(k.x, k.y, k.verifiers);
    }

    /// The WebAuthn envelope a browser (or the wedgie firmware) produces for `challenge`, ABI-encoded the way
    /// Safe's passkey signer reads it: (authenticatorData, clientDataFields, r, s).
    function _webauthn(Passkey memory k, bytes32 challenge) internal pure returns (bytes memory) {
        bytes memory authData = abi.encodePacked(sha256("instantwallet.io"), uint8(0x05), uint32(1));
        string memory fields = '"origin":"https://instantwallet.io","crossOrigin":false';
        string memory json = string.concat(
            '{"type":"webauthn.get","challenge":"', _b64url(challenge), '",', fields, "}"
        );
        bytes32 digest = sha256(abi.encodePacked(authData, sha256(bytes(json))));
        (bytes32 r, bytes32 s) = vm.signP256(k.pk, digest);
        return abi.encode(authData, fields, uint256(r), uint256(s));
    }

    /// base64url of 32 bytes, no padding (43 chars), as WebAuthn and Safe's signer use.
    function _b64url(bytes32 v) internal pure returns (string memory) {
        bytes memory b = bytes(vm.toBase64URL(abi.encodePacked(v)));
        uint256 n = b.length;
        while (n > 0 && b[n - 1] == "=") n--;
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = b[i];
        return string(out);
    }

    // ---------------------------------------------------------------- safe signatures

    struct Sig {
        address signer;
        bytes data; // contract signature payload, or a 65-byte ECDSA signature when `ecdsa`
        bool ecdsa;
    }

    /// Safe's signature bytes: owners sorted ascending; contract signatures as (r = signer, s = offset, v = 0)
    /// with their payloads appended.
    function _encodeSigs(Sig[] memory sigs) internal pure returns (bytes memory) {
        // insertion sort by signer
        for (uint256 i = 1; i < sigs.length; i++) {
            Sig memory cur = sigs[i];
            uint256 j = i;
            while (j > 0 && sigs[j - 1].signer > cur.signer) {
                sigs[j] = sigs[j - 1];
                j--;
            }
            sigs[j] = cur;
        }
        bytes memory head;
        bytes memory tail;
        uint256 headLen = sigs.length * 65;
        for (uint256 i = 0; i < sigs.length; i++) {
            if (sigs[i].ecdsa) {
                head = abi.encodePacked(head, sigs[i].data);
            } else {
                head = abi.encodePacked(
                    head, bytes32(uint256(uint160(sigs[i].signer))), bytes32(headLen + tail.length), uint8(0)
                );
                tail = abi.encodePacked(tail, uint256(sigs[i].data.length), sigs[i].data);
            }
        }
        return abi.encodePacked(head, tail);
    }

    function _passkeySig(Passkey memory k, bytes32 hash) internal view returns (Sig memory) {
        return Sig(_signerAddress(k), _webauthn(k, hash), false);
    }

    function _eoaSig(uint256 pk, bytes32 hash) internal returns (Sig memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        return Sig(vm.addr(pk), abi.encodePacked(r, s, v), true);
    }

    function _one(Sig memory a) internal pure returns (Sig[] memory s) {
        s = new Sig[](1);
        s[0] = a;
    }

    // ---------------------------------------------------------------- multisend

    function _call(address to, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, value, data.length, data);
    }

    function _multiSend(bytes memory packed) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("multiSend(bytes)", packed);
    }

    // ---------------------------------------------------------------- the first setup

    /// Level 1's first setup (fixed into the address forever): the burner's signer is the only owner, and
    /// Candide's 7-day recovery is on with the DAO as guardian. Inner call `to = 0` = the Safe itself.
    function _initializer(address burnerSigner) internal pure returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = burnerSigner;
        bytes memory setupCalls = abi.encodePacked(
            _call(address(0), 0, abi.encodeCall(ISafe.enableModule, (RECOVERY_7D))),
            _call(RECOVERY_7D, 0, abi.encodeCall(ISocialRecovery.addGuardianWithThreshold, (DAO, 1)))
        );
        return abi.encodeCall(
            ISafe.setup,
            (owners, 1, MULTISEND_SETUP, _multiSend(setupCalls), FALLBACK_HANDLER, address(0), 0, payable(0))
        );
    }

    function _predict(address burnerSigner) internal view returns (address) {
        bytes memory init = _initializer(burnerSigner);
        bytes32 salt = keccak256(abi.encodePacked(keccak256(init), SALT_NONCE));
        bytes memory code =
            abi.encodePacked(ISafeProxyFactory(SAFE_FACTORY).proxyCreationCode(), uint256(uint160(SAFE_L2)));
        return vm.computeCreate2Address(salt, keccak256(code), SAFE_FACTORY);
    }

    function _deploySafe(address burnerSigner) internal returns (ISafe) {
        return ISafe(
            ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, _initializer(burnerSigner), SALT_NONCE)
        );
    }

    // ---------------------------------------------------------------- safe tx

    struct SafeTx {
        address to;
        uint256 value;
        bytes data;
        Operation operation;
    }

    function _hash(ISafe safe, SafeTx memory t) internal view returns (bytes32) {
        return safe.getTransactionHash(t.to, t.value, t.data, t.operation, 0, 0, 0, address(0), address(0), safe.nonce());
    }

    /// Same, for a Safe that isn't deployed yet: the EIP-712 hash Safe will compute at nonce 0.
    function _hashAt(address safe, SafeTx memory t, uint256 nonce_) internal view returns (bytes32) {
        return _hashOn(block.chainid, safe, t, nonce_);
    }

    function _hashOn(uint256 chainId, address safe, SafeTx memory t, uint256 nonce_) internal pure returns (bytes32) {
        bytes32 typeHash = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;
        bytes32 domain = keccak256(
            abi.encode(
                0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218, chainId, safe
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash, t.to, t.value, keccak256(t.data), t.operation, 0, 0, 0, address(0), address(0), nonce_
            )
        );
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domain, structHash));
    }

    function _exec(ISafe safe, SafeTx memory t, bytes memory sigs) internal returns (bool) {
        return safe.execTransaction(t.to, t.value, t.data, t.operation, 0, 0, 0, address(0), payable(0), sigs);
    }

    function _batch(bytes memory packed) internal pure returns (SafeTx memory) {
        return SafeTx(MULTISEND_CALL_ONLY, 0, _multiSend(packed), Operation.DelegateCall);
    }

    function _usdcTransfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return _call(USDC, 0, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _dealUSDC(address to, uint256 amount) internal {
        deal(USDC, to, amount);
    }
}
